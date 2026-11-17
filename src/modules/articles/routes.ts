import { and, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, articleVotes, deputies, initiatives, parties } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { articleVoterKey } from "../../forums/identity.js";
import { articleParamsSchema, errorSchema } from "../shared.js";

const cursorSchema = z.object({
  publishedAt: z.iso.datetime(),
  id: z.number().int().positive(),
});
type Cursor = z.infer<typeof cursorSchema>;

export const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (value: string): Cursor => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

const offsetSchema = z.object({ offset: z.number().int().min(0).max(100_000) });
export const encodeOffset = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString("base64url");
export const decodeOffset = (value: string) => {
  try {
    return offsetSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString())).offset;
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

/** Lowercase, without accents: "Habitação" → "habitacao". The SQL below folds the stored text the same way. */
export const foldText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const searchWords = (q: string) => [...new Set(foldText(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean))].slice(0, 10);
export const escapeLike = (word: string) => word.replace(/[\\%_]/g, (c) => `\\${c}`);
// translate() instead of the unaccent extension: no extension to install, and it covers Portuguese.
export const FOLDED_TEXT = sql`translate(lower(articles.title || ' ' || articles.excerpt),
  'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny')`;

export const articlePartySchema = z.object({
  slug: z.string(),
  acronym: z.string(),
  name: z.string(),
});

export const articleDeputySchema = z.object({
  id: z.number(),
  name: z.string(),
  party: z.string().nullable().describe("Party slug"),
});

export const articleInitiativeSchema = z.object({
  id: z.number(),
  type: z.string(),
  number: z.string(),
  title: z.string(),
  status: z.enum(["approved", "rejected", "in_progress", "withdrawn"]),
  lastVote: z
    .object({ date: z.string(), phase: z.string(), result: z.string(), unanimous: z.boolean() })
    .nullable()
    .describe('Its latest vote in parliament, if any: show "Ver como votou cada partido" only then'),
});

export const articleGovernmentSchema = z.object({ id: z.string(), name: z.string() });

export const articleSchema = z.object({
  id: z.number(),
  title: z.string(),
  excerpt: z.string(),
  url: z.string(),
  source: z.string(),
  imageUrl: z.string().nullable(),
  publishedAt: z.string(),
  storyId: z.number().nullable().describe("The story it belongs to, with the other outlets' versions (null for a few minutes after it's found)"),
  commentCount: z.number(),
  upvotes: z.number(),
  downvotes: z.number(),
  parties: z.array(articlePartySchema),
  deputies: z.array(articleDeputySchema),
  government: z.array(articleGovernmentSchema).describe("Members of the Government named in it"),
  president: z.object({ id: z.string(), name: z.string() }).nullable().describe("The President of the Republic, if named"),
  initiatives: z
    .array(articleInitiativeSchema)
    .describe("Initiatives it seems to be about. Found by keywords, so approximate"),
});

// Written as plain SQL because Drizzle drops table names from columns in
// single-table selects, which would make these correlated subqueries ambiguous.
const commentCountSql = sql<number>`(
  select count(*)::int from comments c
  where c.article_id = articles.id and c.hidden_at is null
)`;
const partiesSql = sql<z.infer<typeof articlePartySchema>[]>`coalesce((
  select json_agg(
    json_build_object('slug', p.slug, 'acronym', p.acronym, 'name', p.name)
    order by ap.mention_count desc, p.acronym
  )
  from article_parties ap
  join parties p on p.id = ap.party_id
  where ap.article_id = articles.id
), '[]'::json)`;

const deputiesSql = sql<z.infer<typeof articleDeputySchema>[]>`coalesce((
  select json_agg(
    json_build_object('id', d.id, 'name', d.name, 'party', p.slug)
    order by ad.mention_count desc, d.name
  )
  from article_deputies ad
  join deputies d on d.id = ad.deputy_id
  left join parties p on p.id = d.party_id
  where ad.article_id = articles.id
), '[]'::json)`;

const governmentSql = sql<z.infer<typeof articleGovernmentSchema>[]>`coalesce((
  select json_agg(json_build_object('id', g.id, 'name', g.name) order by agm.mention_count desc, g.name)
  from article_government_members agm
  join government_members g on g.id = agm.member_id
  where agm.article_id = articles.id
), '[]'::json)`;

const presidentSql = sql<{ id: string; name: string } | null>`(
  select json_build_object('id', pr.id, 'name', pr.name)
  from article_presidents ap join presidents pr on pr.id = ap.president_id
  where ap.article_id = articles.id
  order by ap.mention_count desc limit 1
)`;

const initiativesSql = sql<z.infer<typeof articleInitiativeSchema>[]>`coalesce((
  select json_agg(
    json_build_object('id', i.id, 'type', i.type, 'number', i.number, 'title', i.title, 'status', i.status,
      'lastVote', (
        select json_build_object('date', v->>'date', 'phase', v->>'phase', 'result', v->>'result', 'unanimous', (v->>'unanimous')::boolean)
        from jsonb_array_elements(i.votes) v order by v->>'date' desc limit 1
      ))
    order by ai.score desc nulls first, i.id
  )
  from article_initiatives ai
  join initiatives i on i.id = ai.initiative_id
  where ai.article_id = articles.id
), '[]'::json)`;

export const articleColumns = {
  id: articles.id,
  title: articles.title,
  excerpt: articles.excerpt,
  url: articles.url,
  source: articles.source,
  imageUrl: articles.imageUrl,
  publishedAt: articles.publishedAt,
  storyId: articles.storyId,
  commentCount: commentCountSql,
  upvotes: articles.upvotes,
  downvotes: articles.downvotes,
  parties: partiesSql,
  deputies: deputiesSql,
  government: governmentSql,
  president: presidentSql,
  initiatives: initiativesSql,
};

/** Reddit's: many votes on both sides first. Only used where both counts are above 0. */
const controversySql = sql`power((articles.upvotes + articles.downvotes)::float8,
  least(articles.upvotes, articles.downvotes)::float8 / greatest(articles.upvotes, articles.downvotes))`;

/** Midnight in Lisbon, `days` days before today, as a timestamp. */
export const lisbonMidnight = (days: number) =>
  sql`((date_trunc('day', now() at time zone 'Europe/Lisbon') - make_interval(days => ${days})) at time zone 'Europe/Lisbon')`;

/** Published in the period, in Lisbon days: today since midnight, yesterday whole, week and month today included. */
const PERIODS = {
  today: () => sql`articles.published_at >= ${lisbonMidnight(0)}`,
  yesterday: () => sql`articles.published_at >= ${lisbonMidnight(1)} and articles.published_at < ${lisbonMidnight(0)}`,
  week: () => sql`articles.published_at >= ${lisbonMidnight(6)}`,
  month: () => sql`articles.published_at >= ${lisbonMidnight(29)}`,
} as const;

/** Articles readers can see: not hidden by a moderator. */
export const visibleArticle = isNull(articles.hiddenAt);

/** "1,2,3" → [1, 2, 3]: article ids, no repeats, at most `max`. */
export const idList = (max: number) =>
  z
    .string()
    .max(max * 11)
    .transform((value) => [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647))).min(1).max(max));

/** "a,b,c" → ["a", "b", "c"]: trimmed, no empties or repeats, at most `max` values. */
export const commaList = (max: number) =>
  z
    .string()
    .max(2_000)
    .transform((value) => [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(100)).min(1).max(max));

export const articleRoutes =
  (db: Db, { voteSecret }: { voteSecret: string }): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/articles",
      {
        schema: {
          tags: ["articles"],
          querystring: z.object({
            party: commaList(30).optional().describe('Party slug, or several separated by commas ("ps,psd,livre"): articles about any of them'),
            deputy: z.coerce.number().int().positive().max(2_147_483_647).optional().describe("Deputy ID"),
            initiative: z.coerce.number().int().positive().max(2_147_483_647).optional().describe("Initiative ID"),
            governmentMember: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("Government member ID"),
            president: z.string().regex(/^[a-z-]+$/).optional().describe('President ID, e.g. "antonio-jose-seguro"'),
            q: z.string().trim().max(200).optional().describe("Words in the title or excerpt; all must match, ignoring accents and case"),
            source: commaList(30)
              .optional()
              .describe('Outlet as in article.source (see /articles/sources), or several separated by commas: articles from any of them'),
            ids: idList(100).optional().describe("Only these articles (up to 100), e.g. the reader's saved ones"),
            exclude: idList(500).optional().describe("Leave these articles out (up to 500), e.g. the ones the reader hid"),
            excludeSource: commaList(30).optional().describe("Leave out articles from these outlets (\"show fewer like this\")"),
            excludeParty: commaList(30)
              .optional()
              .describe("Leave out articles about any of these parties (\"show fewer like this\"). Unknown slugs are ignored"),
            sort: z
              .enum(["newest", "comments", "top", "controversial"])
              .default("newest")
              .describe(
                "comments: most commented first, only articles with comments. top: upvotes − downvotes, highest first. " +
                  "controversial: many votes on both sides first, only articles with at least one of each. Ties: newest first",
              ),
            period: z
              .enum(["today", "yesterday", "week", "month"])
              .optional()
              .describe("Only articles published then, in Lisbon days: week and month are the last 7 and 30 days, today included"),
            since: z
              .string()
              .regex(/^\d{1,4}h?$/)
              .transform((value) => Number.parseInt(value, 10))
              .pipe(z.number().int().min(1).max(8760))
              .optional()
              .describe('Only articles published in the last N hours, e.g. "24h"'),
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: {
            200: z.object({
              items: z.array(articleSchema),
              nextCursor: z.string().nullable(),
              total: z.number().describe("Articles matching the filters, across all pages"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { party, deputy, initiative, governmentMember, president, q, source, ids, exclude, excludeSource, excludeParty, sort, period, since, cursor, limit } =
          request.query;
        // Only newest pages by (publishedAt, id); the others by position, since counts change.
        const byPosition = sort !== "newest";
        const conditions: SQL[] = [visibleArticle];

        let offset = 0;
        let after: SQL | undefined;
        if (cursor !== undefined) {
          if (byPosition) offset = decodeOffset(cursor);
          else {
            const { publishedAt, id } = decodeCursor(cursor);
            after = sql`(articles.published_at, articles.id) < (${publishedAt}::timestamptz, ${id}::int)`;
          }
        }
        for (const word of searchWords(q ?? "")) {
          conditions.push(sql`${FOLDED_TEXT} like ${`%${escapeLike(word)}%`}`);
        }
        if (source !== undefined) conditions.push(inArray(articles.source, source));
        if (ids !== undefined) conditions.push(inArray(articles.id, ids));
        if (exclude !== undefined) conditions.push(notInArray(articles.id, exclude));
        if (excludeSource !== undefined) conditions.push(notInArray(articles.source, excludeSource));
        if (excludeParty !== undefined) {
          conditions.push(sql`not exists (
            select 1 from article_parties ap join parties p on p.id = ap.party_id
            where ap.article_id = articles.id and p.slug in (${sql.join(excludeParty.map((slug) => sql`${slug}`), sql`, `)})
          )`);
        }
        if (since !== undefined) conditions.push(sql`articles.published_at >= now() - make_interval(hours => ${since})`);
        if (period !== undefined) conditions.push(PERIODS[period]());
        if (sort === "comments") conditions.push(sql`${commentCountSql} > 0`);
        if (sort === "controversial") conditions.push(sql`articles.upvotes > 0 and articles.downvotes > 0`);
        if (party !== undefined) {
          const found = await db.select({ id: parties.id, slug: parties.slug }).from(parties).where(inArray(parties.slug, party));
          const unknown = party.filter((slug) => !found.some((p) => p.slug === slug));
          if (unknown.length > 0) throw new ApiError(404, "not_found", `Party not found: ${unknown.join(", ")}`);
          conditions.push(sql`exists (
            select 1 from article_parties ap
            where ap.article_id = articles.id and ap.party_id in (${sql.join(found.map((p) => sql`${p.id}`), sql`, `)})
          )`);
        }
        if (deputy !== undefined) {
          const [found] = await db.select({ id: deputies.id }).from(deputies).where(eq(deputies.id, deputy));
          if (!found) throw notFound("Deputy");
          conditions.push(sql`exists (
            select 1 from article_deputies ad
            where ad.article_id = articles.id and ad.deputy_id = ${found.id}
          )`);
        }
        if (president !== undefined) {
          conditions.push(sql`exists (
            select 1 from article_presidents ap
            where ap.article_id = articles.id and ap.president_id = ${president}
          )`);
        }
        if (governmentMember !== undefined) {
          conditions.push(sql`exists (
            select 1 from article_government_members agm
            where agm.article_id = articles.id and agm.member_id = ${governmentMember}
          )`);
        }
        if (initiative !== undefined) {
          const [found] = await db
            .select({ id: initiatives.id })
            .from(initiatives)
            .where(eq(initiatives.id, initiative));
          if (!found) throw notFound("Initiative");
          conditions.push(sql`exists (
            select 1 from article_initiatives ai
            where ai.article_id = articles.id and ai.initiative_id = ${found.id}
          )`);
        }

        const first = { newest: [], comments: [desc(commentCountSql)], top: [desc(sql`articles.upvotes - articles.downvotes`)], controversial: [desc(controversySql)] }[sort];
        const order = [...first, desc(articles.publishedAt), desc(articles.id)];
        const [rows, [counted]] = await Promise.all([
          db
            .select(articleColumns)
            .from(articles)
            .where(and(...conditions, after))
            .orderBy(...order)
            .limit(limit + 1)
            .offset(offset),
          db.select({ total: sql<number>`count(*)::int` }).from(articles).where(and(...conditions)),
        ]);

        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const more = rows.length > limit && last;
        return {
          items: page.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() })),
          nextCursor: !more
            ? null
            : byPosition
              ? encodeOffset(offset + limit)
              : encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id }),
          total: counted?.total ?? 0,
        };
      },
    );

    app.get(
      "/articles/sources",
      {
        schema: {
          tags: ["articles"],
          summary: "Every news outlet we have articles from, most articles first (for the source filter)",
          response: { 200: z.object({ items: z.array(z.object({ name: z.string(), count: z.number() })) }) },
        },
      },
      async () => {
        const rows = await db
          .select({ name: articles.source, count: sql<number>`count(*)::int` })
          .from(articles)
          .where(visibleArticle)
          .groupBy(articles.source)
          .orderBy(desc(sql`count(*)`), articles.source);
        return { items: rows };
      },
    );

    app.get(
      "/articles/:id",
      {
        schema: {
          tags: ["articles"],
          params: articleParamsSchema,
          response: { 200: articleSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const [article] = await db
          .select(articleColumns)
          .from(articles)
          .where(and(eq(articles.id, request.params.id), visibleArticle));
        if (!article) throw notFound("Article");
        return { ...article, publishedAt: article.publishedAt.toISOString() };
      },
    );
    app.post(
      "/articles/:id/vote",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["articles"],
          summary: "Vote a news article up (1) or down (-1), or remove the vote (0). One vote per reader; voting again replaces it",
          params: articleParamsSchema,
          body: z.strictObject({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
          response: {
            200: z.object({ up: z.number(), down: z.number(), mine: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
            400: errorSchema,
            404: errorSchema,
            429: errorSchema,
          },
        },
      },
      async (request) => {
        const articleId = request.params.id;
        const { value } = request.body;
        const voter = articleVoterKey(voteSecret, request.ip, articleId);
        return db.transaction(async (tx) => {
          // Locks the article, so votes on it count one at a time and the totals stay exact.
          const [article] = await tx.select({ id: articles.id }).from(articles).where(and(eq(articles.id, articleId), visibleArticle)).for("update");
          if (!article) throw notFound("Article");
          const mine = and(eq(articleVotes.articleId, articleId), eq(articleVotes.voter, voter));
          if (value === 0) await tx.delete(articleVotes).where(mine);
          else {
            await tx
              .insert(articleVotes)
              .values({ articleId, voter, value })
              .onConflictDoUpdate({ target: [articleVotes.articleId, articleVotes.voter], set: { value, updatedAt: sql`now()` } });
          }
          const [counts] = await tx
            .update(articles)
            .set({
              upvotes: sql`(select count(*)::int from article_votes v where v.article_id = ${articleId} and v.value = 1)`,
              downvotes: sql`(select count(*)::int from article_votes v where v.article_id = ${articleId} and v.value = -1)`,
            })
            .where(eq(articles.id, articleId))
            .returning({ up: articles.upvotes, down: articles.downvotes });
          return { up: counts!.up, down: counts!.down, mine: value };
        });
      },
    );
  };
