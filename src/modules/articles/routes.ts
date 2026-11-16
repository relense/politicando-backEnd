import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, deputies, initiatives, parties } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
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
const encodeOffset = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString("base64url");
const decodeOffset = (value: string) => {
  try {
    return offsetSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString())).offset;
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

/** Lowercase, without accents: "Habitação" → "habitacao". The SQL below folds the stored text the same way. */
export const foldText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const searchWords = (q: string) => [...new Set(foldText(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean))].slice(0, 10);
const escapeLike = (word: string) => word.replace(/[\\%_]/g, (c) => `\\${c}`);
// translate() instead of the unaccent extension: no extension to install, and it covers Portuguese.
const FOLDED_TEXT = sql`translate(lower(articles.title || ' ' || articles.excerpt),
  'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny')`;

const articlePartySchema = z.object({
  slug: z.string(),
  acronym: z.string(),
  name: z.string(),
});

const articleDeputySchema = z.object({
  id: z.number(),
  name: z.string(),
  party: z.string().nullable().describe("Party slug"),
});

const articleInitiativeSchema = z.object({
  id: z.number(),
  type: z.string(),
  number: z.string(),
  title: z.string(),
});

const articleGovernmentSchema = z.object({ id: z.string(), name: z.string() });

export const articleSchema = z.object({
  id: z.number(),
  title: z.string(),
  excerpt: z.string(),
  url: z.string(),
  source: z.string(),
  imageUrl: z.string().nullable(),
  publishedAt: z.string(),
  commentCount: z.number(),
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
    json_build_object('id', i.id, 'type', i.type, 'number', i.number, 'title', i.title)
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
  commentCount: commentCountSql,
  parties: partiesSql,
  deputies: deputiesSql,
  government: governmentSql,
  president: presidentSql,
  initiatives: initiativesSql,
};

export const articleRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/articles",
      {
        schema: {
          tags: ["articles"],
          querystring: z.object({
            party: z.string().optional().describe("Party slug"),
            deputy: z.coerce.number().int().positive().max(2_147_483_647).optional().describe("Deputy ID"),
            initiative: z.coerce.number().int().positive().max(2_147_483_647).optional().describe("Initiative ID"),
            governmentMember: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("Government member ID"),
            president: z.string().regex(/^[a-z-]+$/).optional().describe('President ID, e.g. "antonio-jose-seguro"'),
            q: z.string().trim().max(200).optional().describe("Words in the title or excerpt; all must match, ignoring accents and case"),
            source: z.string().max(100).optional().describe("Outlet, exactly as in article.source (see /articles/sources)"),
            sort: z.enum(["newest", "comments"]).default("newest").describe("comments: most commented first, only articles with comments"),
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
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { party, deputy, initiative, governmentMember, president, q, source, sort, since, cursor, limit } = request.query;
        const conditions: SQL[] = [];

        // Newest first pages by (publishedAt, id); most commented by position, since counts change.
        let offset = 0;
        if (cursor !== undefined) {
          if (sort === "comments") offset = decodeOffset(cursor);
          else {
            const { publishedAt, id } = decodeCursor(cursor);
            conditions.push(sql`(articles.published_at, articles.id) < (${publishedAt}::timestamptz, ${id}::int)`);
          }
        }
        for (const word of searchWords(q ?? "")) {
          conditions.push(sql`${FOLDED_TEXT} like ${`%${escapeLike(word)}%`}`);
        }
        if (source !== undefined) conditions.push(eq(articles.source, source));
        if (since !== undefined) conditions.push(sql`articles.published_at >= now() - make_interval(hours => ${since})`);
        if (sort === "comments") conditions.push(sql`${commentCountSql} > 0`);
        if (party !== undefined) {
          const [found] = await db
            .select({ id: parties.id })
            .from(parties)
            .where(eq(parties.slug, party));
          if (!found) throw notFound("Party");
          conditions.push(sql`exists (
            select 1 from article_parties ap
            where ap.article_id = articles.id and ap.party_id = ${found.id}
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

        const order = sort === "comments" ? [desc(commentCountSql), desc(articles.publishedAt), desc(articles.id)] : [desc(articles.publishedAt), desc(articles.id)];
        const rows = await db
          .select(articleColumns)
          .from(articles)
          .where(and(...conditions))
          .orderBy(...order)
          .limit(limit + 1)
          .offset(offset);

        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const more = rows.length > limit && last;
        return {
          items: page.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() })),
          nextCursor: !more
            ? null
            : sort === "comments"
              ? encodeOffset(offset + limit)
              : encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id }),
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
          .where(eq(articles.id, request.params.id));
        if (!article) throw notFound("Article");
        return { ...article, publishedAt: article.publishedAt.toISOString() };
      },
    );
  };
