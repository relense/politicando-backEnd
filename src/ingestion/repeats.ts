import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { isGenericHeadline } from "./extractArticle.js";

/** How far back to look, and how far apart two copies can be. */
const LOOK_BACK_DAYS = 7;
const REPEAT_WITHIN_DAYS = 3;

/**
 * Hides an outlet's second copy of an article it already published under another URL: RTP files one
 * piece under both /politica/ and /economia/, Expresso re-dates a slug or adds "-1". Same outlet and
 * same headline within a few days is the same article; the first copy stays. Placeholder headlines
 * ("As notícias das 8h") are different articles each time, so they never count. Returns how many were
 * hidden. Runs after each ingest, before stories are assigned; safe to run twice.
 */
export const hideRepeats = async (db: Db, now = new Date()) => {
  const { rows } = await db.execute<{ id: number; title: string }>(sql`
    select later.id, later.title
    from articles later
    where later.hidden_at is null
      and later.published_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${LOOK_BACK_DAYS})
      and exists (
        select 1 from articles earlier
        where earlier.source = later.source
          and earlier.id <> later.id
          and earlier.hidden_at is null
          and lower(btrim(earlier.title)) = lower(btrim(later.title))
          and (earlier.published_at, earlier.id) < (later.published_at, later.id)
          and earlier.published_at >= later.published_at - make_interval(days => ${REPEAT_WITHIN_DAYS})
      )`);
  const ids = rows.filter((r) => !isGenericHeadline(r.title)).map((r) => r.id);
  if (ids.length === 0) return 0;
  const result = await db.execute(
    sql`update articles set hidden_at = ${now.toISOString()}::timestamptz where hidden_at is null and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
  );
  return result.rowCount ?? 0;
};
