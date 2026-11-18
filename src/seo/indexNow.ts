import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/*
 * IndexNow: tells Bing, Yandex and the other engines that take it (not Google) which pages
 * are new or changed, so they're crawled in minutes instead of days. The hourly ingest
 * calls it with what changed since the previous run. Off unless INDEXNOW_KEY is set; the
 * frontend serves the same key at https://www.politicando.pt/<key>.txt.
 */

const ENDPOINT = "https://api.indexnow.org/indexnow";
/** The protocol's limit per request. */
const MAX_URLS = 10_000;

/** The frontend's routes for each kind of page. */
export const pagePath = {
  article: (id: number) => `/article/${id}`,
  editorial: (slug: string) => `/editorial/${slug}`,
  localOfficial: (id: string) => `/autarcas/${id}`,
};

/** Pages created or changed since `since`: news (with their story), published blog posts, local officials. */
export const changedPages = async (db: Db, since: Date): Promise<string[]> => {
  const iso = since.toISOString();
  const rows = await db.execute<{ kind: "article" | "editorial" | "local"; id: string }>(sql`
    select 'article' as kind, id::text as id from articles where created_at >= ${iso} and hidden_at is null
    union all
    select 'editorial', slug from editorial_posts where status = 'published' and updated_at >= ${iso}
    union all
    select 'local', id from local_officials where updated_at >= ${iso}`);
  return rows.rows.map((r) =>
    r.kind === "article" ? pagePath.article(Number(r.id)) : r.kind === "editorial" ? pagePath.editorial(r.id) : pagePath.localOfficial(r.id),
  );
};

/** Sends the pages to IndexNow. Never throws: a failed ping only means slower discovery. */
export const pingIndexNow = async ({
  key,
  siteUrl,
  paths,
  fetchFn = fetch,
}: {
  key: string;
  siteUrl: string;
  paths: string[];
  fetchFn?: typeof fetch;
}): Promise<{ submitted: number; status: number | null; error?: string }> => {
  if (paths.length === 0) return { submitted: 0, status: null };
  const site = new URL(siteUrl);
  const urlList = [...new Set(paths)].slice(0, MAX_URLS).map((path) => new URL(path, site).href);
  try {
    const response = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: site.host, key, keyLocation: new URL(`/${key}.txt`, site).href, urlList }),
      signal: AbortSignal.timeout(30_000),
    });
    // 200 and 202 are both success (202: the key is still being checked).
    return { submitted: response.ok ? urlList.length : 0, status: response.status };
  } catch (error) {
    return { submitted: 0, status: null, error: error instanceof Error ? error.message : String(error) };
  }
};
