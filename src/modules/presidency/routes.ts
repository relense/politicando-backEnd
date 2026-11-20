import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, initiatives, presidents } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { biographyFacts, currentPresident, presidentOn } from "../../presidency/presidents.js";
import { articleColumns, articleSchema, visibleArticle } from "../articles/routes.js";
import { initiativeColumns, initiativeSummarySchema, withPlain } from "../parliament/routes.js";
import { errorSchema } from "../shared.js";

const LATEST = 10;

export const presidencyRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/president",
      {
        schema: {
          tags: ["presidency"],
          summary: "The President of the Republic, what he did with the laws parliament sent, and his news",
          response: {
            200: z.object({
              president: z.object({
                id: z.string(),
                name: z.string(),
                fullName: z.string(),
                termStart: z.string(),
                bio: z.array(z.string()).describe("Official biography from presidencia.pt, plain-text paragraphs"),
                birthDate: z.string().nullable().describe("Read from the official biography; null if it doesn't say"),
                birthPlace: z.string().nullable(),
                residence: z.string().nullable().describe("Where the biography says he lives"),
                photoUrl: z.string().nullable(),
                url: z.string(),
              }),
              legislation: z
                .object({
                  promulgated: z.number(),
                  vetoed: z.number().describe("Vetoes in his term (each time: a law can be vetoed twice), including laws parliament later passed again"),
                  pending: z.number().describe("Decrees waiting for his decision now"),
                  latestVetoes: z.array(initiativeSummarySchema),
                  latestPromulgated: z.array(initiativeSummarySchema),
                  pendingNow: z.array(initiativeSummarySchema),
                  allTime: z
                    .object({
                      since: z.string().nullable().describe("First decree sent to Belém in the data we hold (the current legislature)"),
                      promulgated: z.number(),
                      vetoed: z.number().describe("Vetoes (each time: a law can be vetoed twice), including laws later passed again"),
                      vetoedUnconstitutional: z.number().describe("Of those, after a Constitutional Court ruling"),
                      pending: z.number(),
                      byPresident: z.array(z.object({ id: z.string(), name: z.string(), promulgated: z.number(), vetoed: z.number() })),
                    })
                    .describe("Every President, over the data we hold"),
                })
                .describe("Decrees from parliament only. Government decrees aren't in the parliament's data"),
              articles: z.array(articleSchema).describe("Latest news naming him"),
              former: z.array(z.object({ id: z.string(), name: z.string(), termStart: z.string(), termEnd: z.string().nullable() })),
            }),
            404: errorSchema,
          },
        },
      },
      async () => {
        const current = currentPresident();
        const [president] = await db.select().from(presidents).where(eq(presidents.id, current.id));
        if (!president) throw notFound("President");

        // A promulgation the record skips counts on the law's publication date.
        const dateOf = (field: string) =>
          field === "promulgatedAt"
            ? sql`coalesce((initiatives.presidency->>'promulgatedAt')::date, case when initiatives.presidency->>'status' = 'promulgated' then initiatives.published_at end)`
            : sql`(initiatives.presidency->>${field})::date`;
        const inTerm = (field: string) => sql`${dateOf(field)} >= ${president.termStart}::date`;
        const list = (where: ReturnType<typeof sql>, field: string) =>
          db
            .select(initiativeColumns)
            .from(initiatives)
            .where(where)
            .orderBy(sql`${dateOf(field)} desc nulls last`, desc(initiatives.id))
            .limit(LATEST)
            .then((rows) => rows.map(withPlain));
        const [latestVetoes, latestPromulgated, pendingNow] = await Promise.all([
          list(inTerm("vetoedAt"), "vetoedAt"),
          list(inTerm("promulgatedAt"), "promulgatedAt"),
          list(sql`initiatives.presidency->>'status' = 'pending'`, "sentAt"),
        ]);
        const decided = await db
          .select({ presidency: initiatives.presidency, publishedAt: initiatives.publishedAt })
          .from(initiatives)
          .where(sql`${initiatives.presidency} is not null`);
        const tally = new Map<string, { id: string; name: string; promulgated: number; vetoed: number }>();
        const add = (date: string | null, key: "promulgated" | "vetoed") => {
          const who = date ? presidentOn(date) : null;
          if (!who) return;
          const entry = tally.get(who.id) ?? { id: who.id, name: who.name, promulgated: 0, vetoed: 0 };
          entry[key]++;
          tally.set(who.id, entry);
        };
        const allTime = { since: null as string | null, promulgated: 0, vetoed: 0, vetoedUnconstitutional: 0, pending: 0 };
        // His term, counted the same way as allTime: each veto (a decree vetoed twice counts twice,
        // each vetoed decree of a split law counts), and each law promulgated.
        const counts = { promulgated: 0, vetoed: 0, pending: 0 };
        const mine = (date: string | null) => date !== null && date >= president.termStart;
        for (const { presidency: p, publishedAt } of decided) {
          if (!p) continue;
          if (p.sentAt && (!allTime.since || p.sentAt < allTime.since)) allTime.since = p.sentAt;
          if (p.status === "pending") {
            allTime.pending++;
            counts.pending++;
          }
          // A law split in several decrees can be partly promulgated and partly vetoed.
          if (p.status === "promulgated" || p.promulgatedAt) {
            allTime.promulgated++;
            add(p.promulgatedAt ?? publishedAt, "promulgated");
            if (mine(p.promulgatedAt ?? publishedAt)) counts.promulgated++;
          }
          const vetoes = p.vetoes ?? (p.vetoedAt ? [{ date: p.vetoedAt, kind: p.vetoKind ?? "political" }] : []);
          for (const veto of vetoes) {
            allTime.vetoed++;
            if (veto.kind === "unconstitutionality") allTime.vetoedUnconstitutional++;
            add(veto.date, "vetoed");
            if (mine(veto.date)) counts.vetoed++;
          }
        }
        const byPresident = [...tally.values()].sort((a, b) => b.promulgated + b.vetoed - (a.promulgated + a.vetoed));

        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(
            and(
              visibleArticle,
              inArray(articles.id, sql`(select ap.article_id from article_presidents ap where ap.president_id = ${president.id})`),
            ),
          )
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(LATEST);
        const former = await db
          .select({ id: presidents.id, name: presidents.name, termStart: presidents.termStart, termEnd: presidents.termEnd })
          .from(presidents)
          .where(sql`${presidents.id} <> ${president.id}`)
          .orderBy(asc(presidents.termStart));

        return {
          president: {
            id: president.id,
            name: president.name,
            fullName: president.fullName,
            termStart: president.termStart,
            bio: president.bio,
            ...biographyFacts(president.bio),
            photoUrl: president.photoUrl,
            url: "https://www.presidencia.pt/presidente-da-republica/o-presidente/biografia/",
          },
          legislation: { ...counts, latestVetoes, latestPromulgated, pendingNow, allTime: { ...allTime, byPresident } },
          articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
          former: former.reverse(),
        };
      },
    );
  };
