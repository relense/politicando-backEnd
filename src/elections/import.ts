import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { electionLists, electionResults, electionTurnout, elections, places } from "../db/schema.js";
import type { FetchResult } from "../ingestion/politeClient.js";
import { sourceUrl, type ElectionDef } from "./catalog.js";
import { dicofreOf, levelOf, maiUrls, parseChildren, parseLists, parseResults, partiesInList } from "./mai.js";

export interface ElectionSource {
  get(url: string): Promise<FetchResult>;
}

export interface ImportOptions {
  /** Go down to parishes for every body. Juntas (AF) always go to parishes. */
  parishes?: boolean;
  /** Re-download places already stored. */
  refresh?: boolean;
  onProgress?: (message: string) => void;
}

const json = async (source: ElectionSource, url: string): Promise<unknown | null> => {
  const response = await source.get(url);
  if (response.status !== "ok") return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
};

/** How deep each body goes by default: its natural level. */
const deepestLevel = (organ: string, parishes: boolean) =>
  organ === "AF" || parishes ? "parish" : "municipality";

/**
 * Imports one election: every body, from the whole country down to municipalities (or
 * parishes). Safe to re-run and to stop: places already stored are skipped unless `refresh`.
 */
export const importElection = async (db: Db, source: ElectionSource, election: ElectionDef, options: ImportOptions = {}) => {
  const urls = maiUrls(election);
  const stats = { places: 0, skipped: 0, missing: 0, lists: 0 };
  const log = options.onProgress ?? (() => undefined);

  await db
    .insert(elections)
    .values({ id: election.id, type: election.type, name: election.name, date: election.date, organs: election.organs, sourceUrl: sourceUrl(election) })
    .onConflictDoUpdate({
      target: elections.id,
      set: { type: election.type, name: election.name, date: election.date, organs: election.organs, sourceUrl: sourceUrl(election) },
    });

  // Lists, with full names and our parties.
  const seenLists = new Map<string, ReturnType<typeof parseLists>[number]>();
  for (const organ of election.organs) {
    for (const list of parseLists(await json(source, urls.lists(organ)))) seenLists.set(list.list, list);
    if (election.platform === "old") break; // One file for every body.
  }
  if (seenLists.size > 0) {
    await db
      .insert(electionLists)
      .values([...seenLists.values()].map((l) => ({ ...l, electionId: election.id, partySlugs: partiesInList(l.list) })))
      .onConflictDoUpdate({
        target: [electionLists.electionId, electionLists.list],
        set: { name: sql`excluded.name`, coalition: sql`excluded.coalition`, citizens: sql`excluded.citizens`, partySlugs: sql`excluded.party_slugs` },
      });
    stats.lists = seenLists.size;
  }

  const ensurePlace = async (key: string, name: string, parentKey: string | null) => {
    await db
      .insert(places)
      .values({ key, name, level: levelOf(key), parentKey, dicofre: dicofreOf(key) })
      .onConflictDoUpdate({ target: places.key, set: { name, parentKey: sql`coalesce(excluded.parent_key, places.parent_key)` } });
  };

  const done = async (organ: string, key: string) =>
    (
      await db
        .select({ key: electionTurnout.placeKey })
        .from(electionTurnout)
        .where(and(eq(electionTurnout.electionId, election.id), eq(electionTurnout.organ, organ), eq(electionTurnout.placeKey, key)))
    ).length > 0;

  const importPlace = async (organ: string, key: string) => {
    if (!options.refresh && (await done(organ, key))) {
      stats.skipped++;
      return true;
    }
    const results = parseResults(await json(source, urls.results(key, organ)));
    if (!results) {
      stats.missing++;
      return false;
    }
    await db.transaction(async (tx) => {
      const where = and(eq(electionResults.electionId, election.id), eq(electionResults.organ, organ), eq(electionResults.placeKey, key));
      await tx.delete(electionResults).where(where);
      if (results.lists.length > 0) {
        await tx.insert(electionResults).values(results.lists.map((l) => ({ ...l, electionId: election.id, organ, placeKey: key })));
      }
      await tx
        .insert(electionTurnout)
        .values({ ...results.turnout, electionId: election.id, organ, placeKey: key })
        .onConflictDoUpdate({
          target: [electionTurnout.electionId, electionTurnout.organ, electionTurnout.placeKey],
          set: {
            registered: results.turnout.registered,
            voters: results.turnout.voters,
            turnoutPct: results.turnout.turnoutPct,
            blank: results.turnout.blank,
            null: results.turnout.null,
            totalMandates: results.turnout.totalMandates,
          },
        });
    });
    stats.places++;
    return true;
  };

  // Children lists are the same for every body, so fetch each once.
  const childrenCache = new Map<string, { key: string; name: string }[]>();
  const childrenOf = async (key: string) => {
    let children = childrenCache.get(key);
    if (!children) {
      children = parseChildren(await json(source, urls.children(key)));
      childrenCache.set(key, children);
    }
    return children;
  };

  const ORDER = ["global", "national", "foreign", "district", "municipality", "parish"] as const;
  for (const organ of election.organs) {
    const deepest = ORDER.indexOf(deepestLevel(organ, options.parishes ?? false));
    const queue: { key: string; name: string; parent: string | null }[] = [];
    await ensurePlace("GLOBAL-990000", "Total", null);
    if (await importPlace(organ, "GLOBAL-990000")) {
      queue.push({ key: "LOCAL-500000", name: "Território nacional", parent: "GLOBAL-990000" });
      queue.push({ key: "FOREIGN-600000", name: "Estrangeiro", parent: "GLOBAL-990000" });
    } else {
      // Autárquicas have no votes abroad and no global total.
      queue.push({ key: "LOCAL-500000", name: "Território nacional", parent: null });
    }
    while (queue.length > 0) {
      const place = queue.shift()!;
      await ensurePlace(place.key, place.name, place.parent);
      if (!(await importPlace(organ, place.key))) continue;
      const level = levelOf(place.key);
      // Abroad stops at Europe / outside Europe.
      if (level === "foreign" && place.key !== "FOREIGN-600000") continue;
      const nextLevel = ORDER.indexOf(level) + 1;
      if (level !== "foreign" && nextLevel > deepest) continue;
      for (const child of await childrenOf(place.key)) {
        if (ORDER.indexOf(levelOf(child.key)) <= deepest) queue.push({ ...child, parent: place.key });
      }
    }
    log(`${election.id} ${organ}: ${stats.places} imported, ${stats.skipped} already there, ${stats.missing} missing`);
  }

  await db.update(elections).set({ importedAt: new Date() }).where(eq(elections.id, election.id));
  return stats;
};
