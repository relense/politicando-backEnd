import { and, asc, count, desc, eq, max, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, deputies, initiatives, parties } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { partySlugForGroup } from "../../parliament/groups.js";
import { SEAT_MAP_HEIGHT, SEAT_MAP_LEGISLATURE, SEAT_MAP_SOURCE, SEATS } from "../../parliament/seatMap.js";
import { articleColumns, articleSchema } from "../articles/routes.js";
import { errorSchema } from "../shared.js";

const MAX_POSTGRES_INT = 2_147_483_647;
const idParams = z.object({ id: z.coerce.number().int().positive().max(MAX_POSTGRES_INT) });

/** Official portrait. Large (often 0.5 MB), so load it only when a deputy is opened. */
export const photoUrl = (id: number) =>
  `https://app.parlamento.pt/webutils/getimage.aspx?id=${id}&type=deputado`;

const partySchema = z.object({ slug: z.string(), acronym: z.string(), name: z.string() });
const statusSchema = z.enum(["approved", "rejected", "in_progress", "withdrawn"]);
const positionSchema = z.enum(["favor", "against", "abstention"]);

const deputySummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  group: z.string().nullable().describe("Parliamentary group as the parliament writes it, e.g. CH"),
  party: z.string().nullable().describe("Party slug"),
  constituency: z.string(),
  seat: z.number().nullable().describe("Seat number in seatMap, or null while unknown"),
  parliamentRole: z.string().nullable(),
  photoUrl: z.string(),
});

const initiativeSummarySchema = z.object({
  id: z.number(),
  type: z.string(),
  number: z.string(),
  title: z.string(),
  status: statusSchema,
  phase: z.string(),
  phaseDate: z.string(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  textUrl: z.string().nullable(),
  authors: z.object({
    parties: z.array(partySchema),
    deputies: z.array(z.object({ id: z.number(), name: z.string(), party: z.string().nullable() })),
    other: z.string().nullable().describe('"Governo", a regional assembly, citizens...'),
  }),
  lastVote: z
    .object({ date: z.string(), phase: z.string(), result: z.string(), unanimous: z.boolean() })
    .nullable(),
});

const partyVoteSchema = z.object({
  party: z.string().describe("Party slug, or the parliament's acronym for groups we don't list"),
  count: z.number().nullable().describe("Set when only part of the group voted this way"),
});
const voteSchema = z.object({
  id: z.string(),
  date: z.string(),
  phase: z.string(),
  result: z.string(),
  unanimous: z.boolean(),
  favor: z.array(partyVoteSchema),
  against: z.array(partyVoteSchema),
  abstention: z.array(partyVoteSchema),
  named: z
    .array(z.object({ name: z.string(), group: z.string(), position: positionSchema }))
    .describe("Deputies named because they voted differently from their group"),
});

const cursorSchema = z.object({ phaseDate: z.iso.date(), id: z.number().int().positive() });
const encodeCursor = (cursor: z.infer<typeof cursorSchema>) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (value: string) => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

// Plain SQL for the same reason as in the articles module: correlated subqueries need table names.
const authorsSql = sql<z.infer<typeof initiativeSummarySchema>["authors"]>`json_build_object(
  'parties', coalesce((
    select json_agg(json_build_object('slug', p.slug, 'acronym', p.acronym, 'name', p.name) order by p.acronym)
    from initiative_parties ip join parties p on p.id = ip.party_id
    where ip.initiative_id = initiatives.id
  ), '[]'::json),
  'deputies', coalesce((
    select json_agg(json_build_object('id', d.id, 'name', d.name, 'party', p.slug) order by d.name)
    from initiative_deputies idp join deputies d on d.id = idp.deputy_id
    left join parties p on p.id = d.party_id
    where idp.initiative_id = initiatives.id
  ), '[]'::json),
  'other', initiatives.other_author
)`;
const lastVoteSql = sql<z.infer<typeof initiativeSummarySchema>["lastVote"]>`(
  select json_build_object('date', v->>'date', 'phase', v->>'phase', 'result', v->>'result',
    'unanimous', (v->>'unanimous')::boolean)
  from jsonb_array_elements(initiatives.votes) with ordinality as e(v, n)
  order by n desc limit 1
)`;

const initiativeColumns = {
  id: initiatives.id,
  type: initiatives.type,
  number: initiatives.number,
  title: initiatives.title,
  status: initiatives.status,
  phase: initiatives.phase,
  phaseDate: initiatives.phaseDate,
  submittedAt: initiatives.submittedAt,
  publishedAt: initiatives.publishedAt,
  textUrl: initiatives.textUrl,
  authors: authorsSql,
  lastVote: lastVoteSql,
};

const deputyColumns = {
  id: deputies.id,
  name: deputies.name,
  group: deputies.parliamentaryGroup,
  party: parties.slug,
  constituency: deputies.constituency,
  seat: deputies.seat,
  parliamentRole: deputies.parliamentRole,
};

/** Groups ordered left to right by where their seats are on the official map. */
const GROUP_ORDER = (() => {
  const xs = new Map<string, number[]>();
  for (const [, group, x] of SEATS) xs.set(group, [...(xs.get(group) ?? []), x]);
  return [...xs.entries()]
    .map(([group, values]) => ({ group, seats: values.length, x: values.reduce((a, b) => a + b, 0) / values.length }))
    .sort((a, b) => a.x - b.x);
})();

export const parliamentRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/parliament",
      {
        schema: {
          tags: ["parliament"],
          description: "Everything the hemicycle needs in one call: seats, groups and sitting deputies.",
          response: {
            200: z.object({
              legislature: z.string(),
              updatedAt: z.string().nullable(),
              seatMap: z.object({
                source: z.string(),
                width: z.literal(1),
                height: z.number(),
                seats: z.array(
                  z.object({
                    number: z.number(),
                    group: z.string(),
                    party: z.string().nullable(),
                    x: z.number(),
                    y: z.number(),
                    deputyId: z.number().nullable().describe("Null while who sits where is unknown"),
                  }),
                ),
              }),
              groups: z.array(
                z.object({ group: z.string(), party: partySchema.nullable(), seats: z.number() }),
              ),
              deputies: z.array(deputySummarySchema),
              initiativeCounts: z.record(statusSchema, z.number()),
            }),
          },
        },
      },
      async () => {
        const rows = await db
          .select(deputyColumns)
          .from(deputies)
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(eq(deputies.active, true))
          .orderBy(asc(deputies.name));
        const [updated] = await db.select({ at: max(deputies.updatedAt) }).from(deputies);
        const partyRows = await db
          .select({ slug: parties.slug, acronym: parties.acronym, name: parties.name })
          .from(parties);
        const partyBySlug = new Map(partyRows.map((p) => [p.slug, p]));
        const counts = await db
          .select({ status: initiatives.status, total: count() })
          .from(initiatives)
          .where(eq(initiatives.legislature, SEAT_MAP_LEGISLATURE))
          .groupBy(initiatives.status);
        const bySeat = new Map(rows.filter((r) => r.seat !== null).map((r) => [r.seat, r.id]));

        return {
          legislature: SEAT_MAP_LEGISLATURE,
          updatedAt: updated?.at?.toISOString() ?? null,
          seatMap: {
            source: SEAT_MAP_SOURCE,
            width: 1 as const,
            height: SEAT_MAP_HEIGHT,
            seats: SEATS.map(([number, group, x, y]) => ({
              number,
              group,
              party: partySlugForGroup(group),
              x,
              y,
              deputyId: bySeat.get(number) ?? null,
            })),
          },
          groups: GROUP_ORDER.map(({ group, seats }) => {
            const slug = partySlugForGroup(group);
            return { group, party: (slug && partyBySlug.get(slug)) || null, seats };
          }),
          deputies: rows.map((row) => ({ ...row, photoUrl: photoUrl(row.id) })),
          initiativeCounts: {
            approved: 0, rejected: 0, in_progress: 0, withdrawn: 0,
            ...Object.fromEntries(counts.map((c) => [c.status, c.total])),
          },
        };
      },
    );

    app.get(
      "/deputies/:id",
      {
        schema: {
          tags: ["parliament"],
          params: idParams,
          response: {
            200: deputySummarySchema.extend({
              fullName: z.string(),
              partyInfo: partySchema.nullable(),
              situation: z.string(),
              active: z.boolean(),
              gender: z.string().nullable(),
              birthDate: z.string().nullable(),
              profession: z.string().nullable(),
              education: z.array(z.object({ course: z.string(), completed: z.boolean() })),
              roles: z.array(z.object({ title: z.string(), current: z.boolean() })),
              committees: z.array(
                z.object({ name: z.string(), acronym: z.string(), membership: z.string(), role: z.string().nullable() }),
              ),
              pastLegislatures: z.array(z.string()),
              initiatives: z.object({
                total: z.number(),
                approved: z.number(),
                latest: z.array(initiativeSummarySchema),
              }),
              articles: z.array(articleSchema).describe("Latest news mentioning them"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params;
        const [row] = await db
          .select({
            ...deputyColumns,
            fullName: deputies.fullName,
            partyAcronym: parties.acronym,
            partyName: parties.name,
            situation: deputies.situation,
            active: deputies.active,
            gender: deputies.gender,
            birthDate: deputies.birthDate,
            profession: deputies.profession,
            education: deputies.education,
            roles: deputies.roles,
            committees: deputies.committees,
            pastLegislatures: deputies.pastLegislatures,
          })
          .from(deputies)
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(eq(deputies.id, id));
        if (!row) throw notFound("Deputy");

        const authored = sql`exists (
          select 1 from initiative_deputies idp
          where idp.initiative_id = initiatives.id and idp.deputy_id = ${id}
        )`;
        const [totals] = await db
          .select({
            total: count(),
            approved: sql<number>`count(*) filter (where ${initiatives.status} = 'approved')::int`,
          })
          .from(initiatives)
          .where(authored);
        const latest = await db
          .select(initiativeColumns)
          .from(initiatives)
          .where(authored)
          .orderBy(desc(initiatives.phaseDate), desc(initiatives.id))
          .limit(10);
        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(sql`exists (
            select 1 from article_deputies ad where ad.article_id = articles.id and ad.deputy_id = ${id}
          )`)
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(10);

        const { partyAcronym, partyName, ...deputy } = row;
        return {
          ...deputy,
          photoUrl: photoUrl(deputy.id),
          partyInfo:
            deputy.party && partyAcronym && partyName
              ? { slug: deputy.party, acronym: partyAcronym, name: partyName }
              : null,
          initiatives: { total: totals?.total ?? 0, approved: totals?.approved ?? 0, latest },
          articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
        };
      },
    );

    app.get(
      "/initiatives",
      {
        schema: {
          tags: ["parliament"],
          description: "Newest activity first. Use status=in_progress for what is up for discussion.",
          querystring: z.object({
            status: statusSchema.optional(),
            party: z.string().optional().describe("Author party slug"),
            deputy: z.coerce.number().int().positive().max(MAX_POSTGRES_INT).optional().describe("Author deputy ID"),
            type: z.string().optional().describe('Exact type, e.g. "Projeto de Lei"'),
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: {
            200: z.object({ items: z.array(initiativeSummarySchema), nextCursor: z.string().nullable() }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { status, party, deputy, type, cursor, limit } = request.query;
        const conditions: SQL[] = [];
        if (status) conditions.push(eq(initiatives.status, status));
        if (type) conditions.push(eq(initiatives.type, type));
        if (cursor !== undefined) {
          const c = decodeCursor(cursor);
          conditions.push(sql`(initiatives.phase_date, initiatives.id) < (${c.phaseDate}::date, ${c.id}::int)`);
        }
        if (party !== undefined) {
          const [found] = await db.select({ id: parties.id }).from(parties).where(eq(parties.slug, party));
          if (!found) throw notFound("Party");
          conditions.push(sql`exists (
            select 1 from initiative_parties ip where ip.initiative_id = initiatives.id and ip.party_id = ${found.id}
          )`);
        }
        if (deputy !== undefined) {
          const [found] = await db.select({ id: deputies.id }).from(deputies).where(eq(deputies.id, deputy));
          if (!found) throw notFound("Deputy");
          conditions.push(sql`exists (
            select 1 from initiative_deputies idp where idp.initiative_id = initiatives.id and idp.deputy_id = ${found.id}
          )`);
        }

        const rows = await db
          .select(initiativeColumns)
          .from(initiatives)
          .where(and(...conditions))
          .orderBy(desc(initiatives.phaseDate), desc(initiatives.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page,
          nextCursor: rows.length > limit && last ? encodeCursor({ phaseDate: last.phaseDate, id: last.id }) : null,
        };
      },
    );

    app.get(
      "/initiatives/:id",
      {
        schema: {
          tags: ["parliament"],
          params: idParams,
          response: {
            200: initiativeSummarySchema.extend({ legislature: z.string(), votes: z.array(voteSchema) }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const [row] = await db
          .select({ ...initiativeColumns, legislature: initiatives.legislature, votes: initiatives.votes })
          .from(initiatives)
          .where(eq(initiatives.id, request.params.id));
        if (!row) throw notFound("Initiative");
        return row;
      },
    );
  };
