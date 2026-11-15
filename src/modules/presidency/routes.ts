import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, initiatives, presidents } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { currentPresident } from "../../presidency/presidents.js";
import { articleColumns, articleSchema } from "../articles/routes.js";
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
                photoUrl: z.string().nullable(),
                url: z.string(),
              }),
              legislation: z
                .object({
                  promulgated: z.number(),
                  vetoed: z.number().describe("Vetoes in his term, including laws parliament later passed again"),
                  pending: z.number().describe("Decrees waiting for his decision now"),
                  latestVetoes: z.array(initiativeSummarySchema),
                  latestPromulgated: z.array(initiativeSummarySchema),
                  pendingNow: z.array(initiativeSummarySchema),
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

        const inTerm = (field: string) =>
          sql`(initiatives.presidency->>${field})::date >= ${president.termStart}::date`;
        const [counts] = await db
          .select({
            promulgated: sql<number>`count(*) filter (where ${inTerm("promulgatedAt")})::int`,
            vetoed: sql<number>`count(*) filter (where ${inTerm("vetoedAt")})::int`,
            pending: sql<number>`count(*) filter (where initiatives.presidency->>'status' = 'pending')::int`,
          })
          .from(initiatives);
        const list = (where: ReturnType<typeof sql>, field: string) =>
          db
            .select(initiativeColumns)
            .from(initiatives)
            .where(where)
            .orderBy(sql`(initiatives.presidency->>${field})::date desc nulls last`, desc(initiatives.id))
            .limit(LATEST)
            .then((rows) => rows.map(withPlain));
        const [latestVetoes, latestPromulgated, pendingNow] = await Promise.all([
          list(inTerm("vetoedAt"), "vetoedAt"),
          list(inTerm("promulgatedAt"), "promulgatedAt"),
          list(sql`initiatives.presidency->>'status' = 'pending'`, "sentAt"),
        ]);
        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(
            inArray(
              articles.id,
              sql`(select ap.article_id from article_presidents ap where ap.president_id = ${president.id})`,
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
            photoUrl: president.photoUrl,
            url: "https://www.presidencia.pt/presidente-da-republica/o-presidente/biografia/",
          },
          legislation: { ...counts!, latestVetoes, latestPromulgated, pendingNow },
          articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
          former: former.reverse(),
        };
      },
    );
  };
