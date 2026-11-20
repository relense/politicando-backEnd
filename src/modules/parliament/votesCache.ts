import { gt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { type InitiativeStatus, type VoteRecord, initiatives } from "../../db/schema.js";
import { createVersionedCache } from "../contracts/cache.js";

/*
 * Every vote of the legislature, for the deputies' and parties' vote records. Reading them all
 * (a jsonb array per initiative) on each request is slow, and they only change when the
 * parliament sync runs: keep them, and whatever is worked out from them, until the
 * initiatives table changes (the sync rewrites every row, which changes its xmin and updated_at).
 */

export interface VotedInitiative {
  id: number;
  type: string;
  number: string;
  title: string;
  status: InitiativeStatus;
  legislature: string;
  votes: VoteRecord[];
}

type Cache = ReturnType<typeof createVersionedCache<unknown>>;
const caches = new WeakMap<Db, Cache>();

const cacheFor = (db: Db): Cache => {
  let cache = caches.get(db);
  if (!cache) {
    cache = createVersionedCache<unknown>({
      // A few thousand rows, without reading the votes themselves: cheap enough for every request.
      version: async () =>
        (
          await db.execute<{ v: string }>(sql`
            select count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(max(xmin::text::bigint), 0) as v
            from initiatives`)
        ).rows[0]?.v ?? "none",
      max: 200,
      checkEveryMs: 0,
    });
    caches.set(db, cache);
  }
  return cache;
};

/** Initiatives with at least one vote, as stored. Shared: don't change what comes back. */
export const votedInitiatives = (db: Db) =>
  cacheFor(db).get("initiatives", () =>
    db
      .select({
        id: initiatives.id,
        type: initiatives.type,
        number: initiatives.number,
        title: initiatives.title,
        status: initiatives.status,
        legislature: initiatives.legislature,
        votes: initiatives.votes,
      })
      .from(initiatives)
      .where(gt(sql`jsonb_array_length(${initiatives.votes})`, 0)),
  ) as Promise<VotedInitiative[]>;

/** Something worked out from the votes, kept as long as they don't change. Shared: don't change it. */
export const fromVotes = <T>(db: Db, key: string, compute: () => Promise<T>) => cacheFor(db).get(key, compute) as Promise<T>;
