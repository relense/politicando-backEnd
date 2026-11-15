import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { PRESIDENTS } from "../../presidency/presidents.js";
import { errorSchema } from "../shared.js";

/*
 * Every page worth indexing, for the frontend's sitemap: ids and last-modified dates per kind.
 * The frontend maps each kind to its own routes. Aggregated news is left out on purpose (other
 * outlets' headlines are thin content); so are contracts (hundreds of thousands of near-empty
 * pages).
 */

export const SITEMAP_PAGE_SIZE = 10_000;

const kinds = ["party", "deputy", "government-member", "president", "election", "place", "initiative", "editorial", "case"] as const;
type Kind = (typeof kinds)[number];

type Entry = { id: string; lastmod: string | null; level?: string };

const ts = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

/** SQL for each kind: id, lastmod (ISO or null) and an optional level, in a stable order. */
const queries: Record<Exclude<Kind, "president">, ReturnType<typeof sql>> = {
  party: sql`select slug as id, null as lastmod from parties order by slug`,
  deputy: sql`select id::text as id, ${ts("updated_at")} as lastmod from deputies order by id`,
  "government-member": sql`select id, ${ts("updated_at")} as lastmod from government_members order by id`,
  election: sql`select id, ${ts("imported_at")} as lastmod from elections where imported_at is not null order by date desc`,
  place: sql`select key as id, null as lastmod, level from places
    where key like 'LOCAL-%' and level in ('district', 'municipality', 'parish') order by key`,
  initiative: sql`select id::text as id, ${ts("updated_at")} as lastmod from initiatives order by id`,
  editorial: sql`select slug as id, ${ts("updated_at")} as lastmod from editorial_posts where status = 'published' order by published_at desc`,
  case: sql`select id::text as id, ${ts("updated_at")} as lastmod from cases where published order by id`,
};

export const seoRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const entries = async (kind: Kind, page: number): Promise<{ items: Entry[]; total: number }> => {
      if (kind === "president") {
        const stored = await db.execute<{ id: string; lastmod: string }>(sql`select id, ${ts("updated_at")} as lastmod from presidents`);
        const lastmod = new Map(stored.rows.map((r) => [r.id, r.lastmod]));
        const items = PRESIDENTS.map((p) => ({ id: p.id, lastmod: lastmod.get(p.id) ?? null }));
        return { items: page === 1 ? items : [], total: items.length };
      }
      const query = queries[kind];
      const [rows, total] = await Promise.all([
        db.execute<Entry>(sql`${query} limit ${SITEMAP_PAGE_SIZE} offset ${(page - 1) * SITEMAP_PAGE_SIZE}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from (${query}) q`),
      ]);
      return {
        items: rows.rows.map((r) => ({ id: r.id, lastmod: r.lastmod, ...(r.level && { level: r.level }) })),
        total: total.rows[0]?.n ?? 0,
      };
    };

    app.get(
      "/sitemap",
      {
        schema: {
          tags: ["seo"],
          summary: "What the sitemap should contain: each kind of page, how many, and how many sitemap pages",
          response: {
            200: z.object({
              pageSize: z.number(),
              kinds: z.array(z.object({ kind: z.enum(kinds), count: z.number(), pages: z.number() })),
            }),
          },
        },
      },
      async () => ({
        pageSize: SITEMAP_PAGE_SIZE,
        kinds: await Promise.all(
          kinds.map(async (kind) => {
            const { total } = await entries(kind, 1);
            return { kind, count: total, pages: Math.max(1, Math.ceil(total / SITEMAP_PAGE_SIZE)) };
          }),
        ),
      }),
    );

    app.get(
      "/sitemap/:kind",
      {
        schema: {
          tags: ["seo"],
          summary: "Ids and last-modified dates of one kind of page, 10,000 at a time",
          params: z.object({ kind: z.enum(kinds) }),
          querystring: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }),
          response: {
            200: z.object({
              kind: z.enum(kinds),
              page: z.number(),
              pages: z.number(),
              items: z.array(
                z.object({
                  id: z.string().describe("Slug, id or place key, as the matching endpoint takes it"),
                  lastmod: z.string().nullable().describe("ISO date-time; null when unknown (omit <lastmod>)"),
                  level: z.string().optional().describe("Places only: district, municipality or parish"),
                }),
              ),
            }),
            400: errorSchema,
          },
        },
      },
      async (request) => {
        const { kind } = request.params;
        const { page } = request.query;
        const { items, total } = await entries(kind, page);
        return { kind, page, pages: Math.max(1, Math.ceil(total / SITEMAP_PAGE_SIZE)), items };
      },
    );
  };
