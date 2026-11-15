import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, deputies, governmentMembers, governmentPositions, governments, parties } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { articleColumns, articleSchema } from "../articles/routes.js";
import { errorSchema } from "../shared.js";

const kindSchema = z.enum(["prime_minister", "minister", "secretary_of_state"]);

const memberSummarySchema = z.object({
  id: z.string().describe("The portal's ID for the person"),
  name: z.string(),
  title: z.string().describe('e.g. "Secretária de Estado dos Assuntos Fiscais"'),
  kind: kindSchema,
  gender: z.enum(["M", "F"]).nullable(),
  photoUrl: z.string().nullable().describe("Portrait from portugal.gov.pt"),
  startDate: z.string().nullable(),
  endDate: z.string().nullable().describe("Null while in office"),
  deputyId: z.number().nullable().describe("Their deputy record, when they were elected to this legislature"),
  party: z.string().nullable().describe("Party slug, known only through their deputy record"),
});

const ministrySchema = z.object({
  area: z.string().describe('Portal slug, e.g. "financas"; "primeiro-ministro" for the PM\'s office'),
  name: z.string(),
  minister: memberSummarySchema.nullable().describe("The Prime Minister for the PM's office"),
  secretaries: z.array(memberSummarySchema),
});

const memberColumns = {
  id: governmentMembers.id,
  name: governmentMembers.name,
  title: governmentPositions.title,
  kind: governmentPositions.kind,
  gender: governmentMembers.gender,
  photoUrl: governmentMembers.photoUrl,
  startDate: governmentPositions.startDate,
  endDate: governmentPositions.endDate,
  deputyId: governmentMembers.deputyId,
  party: parties.slug,
  area: governmentPositions.area,
  areaName: governmentPositions.areaName,
};

type Row = { [K in keyof typeof memberColumns]: unknown } & { area: string; areaName: string };
const summary = ({ area: _area, areaName: _areaName, ...member }: Row) => member as z.infer<typeof memberSummarySchema>;

export const governmentRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const positionsOf = (code: string, current: boolean) =>
      db
        .select(memberColumns)
        .from(governmentPositions)
        .innerJoin(governmentMembers, eq(governmentMembers.id, governmentPositions.memberId))
        .leftJoin(deputies, eq(deputies.id, governmentMembers.deputyId))
        .leftJoin(parties, eq(parties.id, deputies.partyId))
        .where(
          and(
            eq(governmentPositions.government, code),
            current ? isNull(governmentPositions.endDate) : isNotNull(governmentPositions.endDate),
          ),
        )
        .orderBy(
          ...(current
            ? [asc(governmentPositions.areaRank), asc(governmentPositions.rank)]
            : [desc(governmentPositions.endDate)]),
          asc(governmentMembers.name),
        );

    app.get(
      "/government",
      {
        schema: {
          tags: ["government"],
          summary: "The Government in office, by ministry in protocol order",
          response: {
            200: z.object({
              government: z.object({
                code: z.string(),
                name: z.string(),
                startDate: z.string().nullable(),
                updatedAt: z.string().describe("Last sync with portugal.gov.pt"),
              }),
              primeMinister: memberSummarySchema.nullable(),
              ministries: z.array(ministrySchema),
              former: z.array(memberSummarySchema.extend({ areaName: z.string() })).describe(
                "People who left this government, with their last post, latest first",
              ),
            }),
            404: errorSchema,
          },
        },
      },
      async () => {
        const [government] = await db.select().from(governments).orderBy(desc(governments.startDate)).limit(1);
        if (!government) throw notFound("Government");
        const current = (await positionsOf(government.code, true)) as Row[];
        const ministries = new Map<string, z.infer<typeof ministrySchema>>();
        for (const row of current) {
          const ministry = ministries.get(row.area) ?? { area: row.area, name: row.areaName, minister: null, secretaries: [] };
          ministries.set(row.area, ministry);
          if (row.kind === "secretary_of_state") ministry.secretaries.push(summary(row));
          else ministry.minister = summary(row);
        }
        // People who left the Government: their latest post, once each. Someone who moved
        // between posts and is still in office isn't former.
        const inOffice = new Set(current.map((row) => row.id));
        const former = new Map<unknown, z.infer<typeof memberSummarySchema> & { areaName: string }>();
        for (const row of (await positionsOf(government.code, false)) as Row[]) {
          if (!inOffice.has(row.id) && !former.has(row.id)) former.set(row.id, { ...summary(row), areaName: row.areaName });
        }
        return {
          government: {
            code: government.code,
            name: government.name,
            startDate: government.startDate,
            updatedAt: government.updatedAt.toISOString(),
          },
          primeMinister: ministries.get("primeiro-ministro")?.minister ?? null,
          ministries: [...ministries.values()],
          former: [...former.values()],
        };
      },
    );

    app.get(
      "/government/members/:id",
      {
        schema: {
          tags: ["government"],
          params: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
          response: {
            200: z.object({
              id: z.string(),
              name: z.string(),
              gender: z.enum(["M", "F"]).nullable(),
              photoUrl: z.string().nullable(),
              bio: z.array(z.string()).describe("Official biography, as plain-text paragraphs"),
              links: z.array(z.object({ network: z.string(), url: z.string() })),
              inOffice: z.boolean(),
              deputy: z
                .object({ id: z.number(), name: z.string(), party: z.string().nullable() })
                .nullable()
                .describe("Their deputy record; see GET /deputies/:id"),
              positions: z.array(
                z.object({
                  title: z.string(),
                  kind: kindSchema,
                  area: z.string(),
                  areaName: z.string(),
                  government: z.string(),
                  startDate: z.string().nullable(),
                  endDate: z.string().nullable(),
                  url: z.string().describe("Their page on portugal.gov.pt"),
                }),
              ).describe("Latest first"),
              articles: z.array(articleSchema).describe("Latest news naming them"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params;
        const [member] = await db
          .select({
            id: governmentMembers.id,
            name: governmentMembers.name,
            gender: governmentMembers.gender,
            photoUrl: governmentMembers.photoUrl,
            bio: governmentMembers.bio,
            links: governmentMembers.links,
            deputyId: deputies.id,
            deputyName: deputies.name,
            party: parties.slug,
          })
          .from(governmentMembers)
          .leftJoin(deputies, eq(deputies.id, governmentMembers.deputyId))
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(eq(governmentMembers.id, id));
        if (!member) throw notFound("Government member");
        const positions = await db
          .select({
            title: governmentPositions.title,
            kind: governmentPositions.kind,
            area: governmentPositions.area,
            areaName: governmentPositions.areaName,
            government: governmentPositions.government,
            startDate: governmentPositions.startDate,
            endDate: governmentPositions.endDate,
            url: governmentPositions.url,
          })
          .from(governmentPositions)
          .where(eq(governmentPositions.memberId, id))
          .orderBy(sql`${governmentPositions.endDate} desc nulls first`, desc(governmentPositions.startDate));
        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(
            inArray(
              articles.id,
              sql`(select agm.article_id from article_government_members agm where agm.member_id = ${id})`,
            ),
          )
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(10);
        const { deputyId, deputyName, party, ...profile } = member;
        return {
          ...profile,
          inOffice: positions.some((p) => p.endDate === null),
          deputy: deputyId !== null && deputyName !== null ? { id: deputyId, name: deputyName, party } : null,
          positions,
          articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
        };
      },
    );
  };
