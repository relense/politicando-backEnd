import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, parties } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { articleParamsSchema, errorSchema } from "../shared.js";

const EXCERPT_LENGTH = 300;

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

const articlePartySchema = z.object({
  slug: z.string(),
  acronym: z.string(),
  name: z.string(),
});

const articleBaseSchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  imageUrl: z.string().nullable(),
  publishedAt: z.string(),
  commentCount: z.number(),
  parties: z.array(articlePartySchema),
});
const articleListItemSchema = articleBaseSchema.extend({ excerpt: z.string() });
const articleDetailSchema = articleBaseSchema.extend({ content: z.string() });

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

const baseColumns = {
  id: articles.id,
  title: articles.title,
  url: articles.url,
  source: articles.source,
  imageUrl: articles.imageUrl,
  publishedAt: articles.publishedAt,
  commentCount: commentCountSql,
  parties: partiesSql,
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
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: {
            200: z.object({
              items: z.array(articleListItemSchema),
              nextCursor: z.string().nullable(),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { party, cursor, limit } = request.query;
        const conditions: SQL[] = [];

        if (cursor !== undefined) {
          const { publishedAt, id } = decodeCursor(cursor);
          conditions.push(
            sql`(articles.published_at, articles.id) < (${publishedAt}::timestamptz, ${id}::int)`,
          );
        }
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

        const rows = await db
          .select({
            ...baseColumns,
            excerpt: sql<string>`left(articles.content, ${sql.raw(String(EXCERPT_LENGTH))})`,
          })
          .from(articles)
          .where(and(...conditions))
          .orderBy(desc(articles.publishedAt), desc(articles.id))
          .limit(limit + 1);

        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString() })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id })
              : null,
        };
      },
    );

    app.get(
      "/articles/:id",
      {
        schema: {
          tags: ["articles"],
          params: articleParamsSchema,
          response: { 200: articleDetailSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const [article] = await db
          .select({ ...baseColumns, content: articles.content })
          .from(articles)
          .where(eq(articles.id, request.params.id));
        if (!article) throw notFound("Article");
        return { ...article, publishedAt: article.publishedAt.toISOString() };
      },
    );
  };
