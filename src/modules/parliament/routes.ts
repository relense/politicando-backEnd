import { and, asc, count, desc, eq, gt, max, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { STAGE_GROUP, STAGE_GROUP_SQL, STAGE_GROUPS, TOPICS, plainStatus, plainTitle, plainType, type PlainStatusInput } from "../../parliament/plain.js";
import type { Db } from "../../db/client.js";
import { articles, deputies, initiatives, parties } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { deputyVote, wasSitting } from "../../parliament/deputyVotes.js";
import { partySlugForGroup } from "../../parliament/groups.js";
import { PRESIDENTS } from "../../presidency/presidents.js";
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
  seat: z.number().nullable().describe("Seat number in seatMap"),
  seatEstimated: z.boolean().describe("True when the seat is estimated by importance within the party, not known"),
  positions: z.array(z.string()).describe('Official positions, most important first, e.g. "Líder do grupo parlamentar"'),
  parliamentRole: z.string().nullable(),
  gender: z.enum(["M", "F"]).nullable().describe('From the parliament\'s records: "Deputada" / "eleita" for F'),
  photoUrl: z.string(),
});

export const initiativeSummarySchema = z.object({
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
  presidency: z
    .object({
      status: z.enum(["pending", "promulgated", "vetoed"]),
      sentAt: z.string().nullable(),
      promulgatedAt: z.string().nullable().describe("Null if promulgated but the record skips the date: see promulgationRecorded"),
      promulgationRecorded: z
        .boolean()
        .describe("False when parliament's record skips the promulgation and we infer it from the law's publication in the Diário da República"),
      vetoedAt: z.string().nullable(),
      vetoKind: z
        .enum(["political", "unconstitutionality"])
        .nullable()
        .describe("political: the President's own objection (parliament can confirm it); unconstitutionality: after a Constitutional Court ruling"),
      constitutionalCourt: z
        .array(z.object({ ruling: z.string().describe('e.g. "1133/2025"'), url: z.string() }))
        .describe("Constitutional Court rulings behind the latest veto"),
      vetoes: z
        .array(
          z.object({
            date: z.string(),
            kind: z.enum(["political", "unconstitutionality"]),
            constitutionalCourt: z.array(z.object({ ruling: z.string(), url: z.string() })),
          }),
        )
        .describe("Every veto, oldest first: a decree can be vetoed, passed again and vetoed again"),
      by: z.string().nullable().describe("President who decided (or is deciding, if pending)"),
    })
    .nullable()
    .describe("What the President of the Republic did with it. Null until parliament sends it to Belém"),
  coverage: z
    .object({
      articles: z.number(),
      sources: z.number().describe("Distinct news outlets"),
      lastAt: z.string().nullable().describe("Latest article about it"),
      latest: z
        .array(z.object({ id: z.number(), title: z.string(), source: z.string().describe("The outlet's domain, as on articles"), publishedAt: z.string() }))
        .describe("Up to 3 visible articles about it, newest first (for the headline and the outlets' logos)"),
    })
    .describe("News about it, found by keywords among the outlets we scan. Approximate"),
  topics: z
    .array(z.object({ slug: z.string(), label: z.string() }))
    .describe("Topics found in the title by keyword; see GET /initiatives/topics. Empty when none fits"),
  plain: z
    .object({
      title: z
        .string()
        .nullable()
        .describe("The title without legal boilerplate (laws cited, \"procedendo à n.ª alteração…\"). Null when there's nothing to simplify: show the official title"),
      type: z.object({
        label: z.string().describe('e.g. "Recomendação" for a Projeto de Resolução'),
        explainer: z.string().describe("One or two sentences on what this kind of initiative is"),
        makesLaw: z.boolean().describe("False for recommendations and internal decisions"),
      }),
      status: z.object({
        label: z.string().describe('e.g. "Aprovada, à espera do Presidente da República"'),
        stage: z.enum([
          "submitted", "committee", "consultation", "debate", "approved_in_principle", "approved",
          "awaiting_president", "vetoed", "promulgated", "published", "rejected", "not_admitted", "withdrawn",
        ]),
        group: z.enum(STAGE_GROUPS.map((g) => g.key)).describe("The step on the law's path, as in ?stage= on GET /initiatives"),
      }),
    })
    .describe("Plain-language reading, by fixed rules (no AI)"),
});

export const TOPIC_LABELS = new Map(TOPICS.map((t) => [t.slug, t.label]));

/** Adds the plain-language reading and topic labels to a summary row. */
export const withPlain = <
  T extends PlainStatusInput & { title: string; topics: string[] },
>({ topics, ...row }: T) => ({
  ...row,
  topics: topics.map((slug) => ({ slug, label: TOPIC_LABELS.get(slug) ?? slug })),
  plain: { title: simplerTitle(row.title), type: plainType(row.type), status: withGroup(plainStatus(row)) },
});

const withGroup = (status: ReturnType<typeof plainStatus>) => ({ ...status, group: STAGE_GROUP[status.stage] });

/** The plain title, or null when it says the same as the official one. */
export const simplerTitle = (title: string) => {
  const simple = plainTitle(title);
  const same = (a: string) => a.replace(/[\s.,;:]+/g, " ").trim().toLowerCase();
  return same(simple) === same(title) ? null : simple;
};

export const partyVoteSchema = z.object({
  party: z.string().describe("Party slug, or the parliament's acronym for groups we don't list"),
  count: z.number().nullable().describe("Set when only part of the group voted this way"),
});
export const voteSchema = z.object({
  id: z.string(),
  date: z.string(),
  phase: z.string(),
  result: z.string(),
  unanimous: z.boolean(),
  favor: z.array(partyVoteSchema),
  against: z.array(partyVoteSchema),
  abstention: z.array(partyVoteSchema),
  absent: z.array(z.string()).describe("Groups recorded as absent (party slugs)"),
  named: z
    .array(z.object({ name: z.string(), group: z.string(), position: positionSchema }))
    .describe("Deputies named because they voted differently from their group"),
});

const cursorSchema = z.object({ phaseDate: z.iso.date(), id: z.number().int().positive().max(2_147_483_647) });
const encodeCursor = (cursor: z.infer<typeof cursorSchema>) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (value: string) => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

const decodeVoteCursor = (value: string) => Buffer.from(value, "base64url").toString();

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

/** The President on the decision date: promulgation or veto, else today for pending ones. */
const presidentOnSql = (date: SQL) =>
  sql.join(
    [
      sql`case`,
      ...PRESIDENTS.map(
        (p) =>
          sql`when ${date} >= ${p.termStart}::date ${p.termEnd ? sql`and ${date} < ${p.termEnd}::date` : sql``} then ${p.name}`,
      ),
      sql`end`,
    ],
    sql` `,
  );
const presidencySql = sql<z.infer<typeof initiativeSummarySchema>["presidency"]>`(
  case when initiatives.presidency is null then null else
  jsonb_build_object('promulgationRecorded', true, 'vetoKind', null, 'constitutionalCourt', '[]'::jsonb, 'vetoes', '[]'::jsonb)
    || initiatives.presidency || jsonb_build_object('by', ${presidentOnSql(sql`coalesce(
    case initiatives.presidency->>'status'
      when 'promulgated' then coalesce((initiatives.presidency->>'promulgatedAt')::date, initiatives.published_at)
      when 'vetoed' then (initiatives.presidency->>'vetoedAt')::date
    end, current_date)`)})
  end
)`;

const coverageSql = sql<z.infer<typeof initiativeSummarySchema>["coverage"]>`(
  select json_build_object(
    'articles', count(*)::int,
    'sources', count(distinct a.source)::int,
    'lastAt', to_char(max(a.published_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'latest', (
      select coalesce(json_agg(json_build_object('id', l.id, 'title', l.title, 'source', l.source,
        'publishedAt', to_char(l.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by l.published_at desc, l.id desc), '[]'::json)
      from (
        select a2.id, a2.title, a2.source, a2.published_at
        from article_initiatives ai2 join articles a2 on a2.id = ai2.article_id
        where ai2.initiative_id = initiatives.id and a2.hidden_at is null
        order by a2.published_at desc, a2.id desc limit 3
      ) l
    )
  )
  from article_initiatives ai join articles a on a.id = ai.article_id
  where ai.initiative_id = initiatives.id and a.hidden_at is null
)`;

export const initiativeColumns = {
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
  presidency: presidencySql,
  coverage: coverageSql,
  topics: initiatives.topics,
};

const deputyColumns = {
  id: deputies.id,
  name: deputies.name,
  group: deputies.parliamentaryGroup,
  party: parties.slug,
  constituency: deputies.constituency,
  seat: deputies.seat,
  seatEstimated: deputies.seatEstimated,
  positions: deputies.positions,
  parliamentRole: deputies.parliamentRole,
  gender: sql<"M" | "F" | null>`${deputies.gender}`,
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
                    deputyId: z.number().nullable(),
                    estimated: z.boolean().describe("True when the deputy in this seat is estimated, not known"),
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
        const bySeat = new Map(rows.filter((r) => r.seat !== null).map((r) => [r.seat, r]));

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
              deputyId: bySeat.get(number)?.id ?? null,
              estimated: bySeat.get(number)?.seatEstimated ?? false,
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
              birthDate: z.string().nullable(),
              profession: z.string().nullable(),
              education: z.array(z.object({ course: z.string(), completed: z.boolean() })),
              roles: z.array(z.object({ title: z.string(), current: z.boolean() })),
              committees: z.array(
                z.object({ name: z.string(), acronym: z.string(), membership: z.string(), role: z.string().nullable() }),
              ),
              pastLegislatures: z.array(z.string()),
              links: z
                .array(z.object({ network: z.string(), url: z.string() }))
                .describe('Official site, Wikipedia, X, Instagram, Facebook and Wikidata (network: "Website", "Wikipedia", "X"…), from Wikidata. For schema.org sameAs'),
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
            birthDate: deputies.birthDate,
            profession: deputies.profession,
            education: deputies.education,
            roles: deputies.roles,
            committees: deputies.committees,
            pastLegislatures: deputies.pastLegislatures,
            links: deputies.wikidataLinks,
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
          .limit(10)
          .then((rows) => rows.map(withPlain));
        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(sql`articles.hidden_at is null and exists (
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
      "/deputies/:id/votes",
      {
        schema: {
          tags: ["parliament"],
          description:
            "How a deputy voted, newest first, as far as the record shows. The parliament records votes by " +
            "group, so `basis` says how each position is known; `position` is null when it isn't.",
          params: idParams,
          querystring: z.object({
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
          response: {
            200: z.object({
              summary: z.object({
                favor: z.number(), against: z.number(), abstention: z.number(),
                absent: z.number(), unknown: z.number(),
                brokeRanks: z.number().describe("Votes where they were named voting apart from their group"),
              }),
              items: z.array(
                z.object({
                  initiative: z.object({
                    id: z.number(), type: z.string(), number: z.string(), title: z.string(), status: statusSchema,
                  }),
                  vote: z.object({ id: z.string(), date: z.string(), phase: z.string(), result: z.string() }),
                  position: positionSchema.nullable(),
                  basis: z.enum(["named", "group", "unanimous", "absent", "unknown"]),
                }),
              ),
              nextCursor: z.string().nullable(),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params;
        const { cursor, limit } = request.query;
        const [deputy] = await db
          .select({
            name: deputies.name,
            group: deputies.parliamentaryGroup,
            party: parties.slug,
            periods: deputies.sittingPeriods,
          })
          .from(deputies)
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(eq(deputies.id, id));
        if (!deputy) throw notFound("Deputy");
        const group = deputy.group ?? "";
        const who = { name: deputy.name, group, party: deputy.party ?? group };

        const rows = await db
          .select({
            id: initiatives.id, type: initiatives.type, number: initiatives.number,
            title: initiatives.title, status: initiatives.status, votes: initiatives.votes,
          })
          .from(initiatives)
          .where(gt(sql`jsonb_array_length(${initiatives.votes})`, 0));

        const all = rows
          .flatMap(({ votes, ...initiative }) =>
            votes
              .filter((vote) => wasSitting(deputy.periods, vote.date))
              .map((vote) => ({
                initiative,
                vote: { id: vote.id, date: vote.date, phase: vote.phase, result: vote.result },
                ...deputyVote(vote, who),
              })),
          )
          // A total order (the same vote can be recorded under several initiatives), so pages never repeat.
          .sort((a, b) => b.vote.date.localeCompare(a.vote.date) || String(b.vote.id).localeCompare(String(a.vote.id), "en", { numeric: true }) || b.initiative.id - a.initiative.id);

        const summary = { favor: 0, against: 0, abstention: 0, absent: 0, unknown: 0, brokeRanks: 0 };
        for (const item of all) {
          if (item.position) summary[item.position]++;
          else summary[item.basis === "absent" ? "absent" : "unknown"]++;
          if (item.basis === "named") summary.brokeRanks++;
        }

        let start = 0;
        if (cursor !== undefined) {
          // date:voteId:initiativeId; date:voteId from before is still read (the first match).
          const key = decodeVoteCursor(cursor);
          const after = all.findIndex((item) => `${item.vote.date}:${item.vote.id}:${item.initiative.id}` === key || `${item.vote.date}:${item.vote.id}` === key);
          if (after === -1) throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
          start = after + 1;
        }
        const page = all.slice(start, start + limit);
        const last = page.at(-1);
        return {
          summary,
          items: page,
          nextCursor:
            start + limit < all.length && last
              ? Buffer.from(`${last.vote.date}:${last.vote.id}:${last.initiative.id}`).toString("base64url")
              : null,
        };
      },
    );

    app.get(
      "/initiatives",
      {
        schema: {
          tags: ["parliament"],
          description:
            "Newest activity first (sort=oldest for the reverse). `total` and `stages` count everything matching the filters, " +
            "`stages` ignoring the stage filter itself so tabs can show their numbers.",
          querystring: z.object({
            stage: z.enum(STAGE_GROUPS.map((g) => g.key)).optional().describe("Step on the law's path; see `stages` in the response"),
            q: z.string().trim().min(2).max(200).optional().describe("Words in the title, or the initiative's number"),
            sort: z.enum(["newest", "oldest"]).default("newest").describe("By latest activity"),
            status: statusSchema.optional(),
            party: z.string().optional().describe("Author party slug"),
            deputy: z.coerce.number().int().positive().max(MAX_POSTGRES_INT).optional().describe("Author deputy ID"),
            type: z.string().optional().describe('Exact type, e.g. "Projeto de Lei"'),
            presidency: z
              .enum(["pending", "promulgated", "vetoed"])
              .optional()
              .describe("What the President did: pending (in Belém), promulgated or vetoed"),
            topic: z
              .enum(TOPICS.map((t) => t.slug) as [string, ...string[]])
              .optional()
              .describe("Topic slug; see GET /initiatives/topics"),
            coverage: z
              .enum(["none", "some"])
              .optional()
              .describe("none: no news found about it; some: at least one article"),
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: {
            200: z.object({
              items: z.array(initiativeSummarySchema),
              nextCursor: z.string().nullable(),
              total: z.number().describe("Initiatives matching every filter"),
              stages: z
                .array(z.object({ key: z.string(), label: z.string(), plain: z.string(), count: z.number() }))
                .describe("Counts per step, with every filter except stage"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { status, party, deputy, type, presidency, topic, coverage, cursor, limit, stage, q, sort } = request.query;
        const conditions: SQL[] = [];
        if (topic) conditions.push(sql`${initiatives.topics} @> array[${topic}]::text[]`);
        if (coverage) {
          const covered = sql`exists (
            select 1 from article_initiatives ai join articles a on a.id = ai.article_id
            where ai.initiative_id = initiatives.id and a.hidden_at is null
          )`;
          conditions.push(coverage === "some" ? covered : sql`not ${covered}`);
        }
        if (status) conditions.push(eq(initiatives.status, status));
        if (presidency) conditions.push(sql`initiatives.presidency->>'status' = ${presidency}`);
        if (type) conditions.push(eq(initiatives.type, type));
        if (q) {
          const words = sql`to_tsvector('portuguese', initiatives.title) @@ websearch_to_tsquery('portuguese', ${q})`;
          conditions.push(sql`(${words} or initiatives.title ilike ${`%${q.replace(/[\\%_]/g, "\\$&")}%`} or initiatives.number = ${q})`);
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

        const stageOf = sql.raw(STAGE_GROUP_SQL);
        const counted = await db
          .select({ stage: sql<string>`${stageOf}`, n: sql<number>`count(*)::int` })
          .from(initiatives)
          .where(and(...conditions))
          .groupBy(sql`1`);
        const counts = new Map(counted.map((r) => [r.stage, r.n]));
        if (stage) conditions.push(sql`${stageOf} = ${stage}`);
        const total = stage ? (counts.get(stage) ?? 0) : counted.reduce((sum, r) => sum + r.n, 0);

        const newest = sort === "newest";
        if (cursor !== undefined) {
          const c = decodeCursor(cursor);
          conditions.push(
            newest
              ? sql`(initiatives.phase_date, initiatives.id) < (${c.phaseDate}::date, ${c.id}::int)`
              : sql`(initiatives.phase_date, initiatives.id) > (${c.phaseDate}::date, ${c.id}::int)`,
          );
        }
        const rows = await db
          .select(initiativeColumns)
          .from(initiatives)
          .where(and(...conditions))
          .orderBy(...(newest ? [desc(initiatives.phaseDate), desc(initiatives.id)] : [asc(initiatives.phaseDate), asc(initiatives.id)]))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(withPlain),
          nextCursor: rows.length > limit && last ? encodeCursor({ phaseDate: last.phaseDate, id: last.id }) : null,
          total,
          stages: STAGE_GROUPS.map((g) => ({ ...g, count: counts.get(g.key) ?? 0 })),
        };
      },
    );

    app.get(
      "/initiatives/topics",
      {
        schema: {
          tags: ["parliament"],
          summary: "Topics initiatives are filed under, with how many of each",
          response: {
            200: z.object({
              items: z.array(z.object({ slug: z.string(), label: z.string(), count: z.number() })),
              untagged: z.number().describe("Initiatives that fit no topic"),
            }),
          },
        },
      },
      async () => {
        const rows = await db.execute<{ slug: string; count: number }>(sql`
          select slug, count(*)::int as count from initiatives, unnest(initiatives.topics) as slug group by slug`);
        const counts = new Map(rows.rows.map((r) => [r.slug, r.count]));
        const [untagged] = await db
          .select({ n: count() })
          .from(initiatives)
          .where(sql`cardinality(${initiatives.topics}) = 0`);
        return {
          items: TOPICS.map((t) => ({ slug: t.slug, label: t.label, count: counts.get(t.slug) ?? 0 })),
          untagged: untagged?.n ?? 0,
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
            200: initiativeSummarySchema.extend({
              legislature: z.string(),
              votes: z.array(voteSchema),
              articles: z.array(articleSchema).describe("Latest 10 news articles about it (approximate)"),
            }),
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
        const news = await db
          .select(articleColumns)
          .from(articles)
          .where(sql`articles.hidden_at is null and exists (
            select 1 from article_initiatives ai where ai.article_id = articles.id and ai.initiative_id = ${row.id}
          )`)
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(10);
        return { ...withPlain(row), articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })) };
      },
    );
  };
