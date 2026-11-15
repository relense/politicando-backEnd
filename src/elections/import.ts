import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { electionLists, electionResults, electionTurnout, elections, places } from "../db/schema.js";
import type { FetchResult } from "../ingestion/politeClient.js";
import { sourceUrl, type ElectionDef } from "./catalog.js";
import {
  dicofreOf,
  levelOf,
  maiUrls,
  parseChildren,
  parseLists,
  parseResults,
  partiesInList,
  type PlaceResults,
} from "./mai.js";
import { parseV3Children, parseV3Election, parseV3Options, parseV3Settings, placeNameKey, v3Urls } from "./maiV3.js";

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

type Level = ReturnType<typeof levelOf>;

/** A place as the walk sees it: our key, plus the site's own id on the newest platform. */
interface Node {
  key: string;
  name: string;
  level: Level;
  dicofre: string | null;
  parent: string | null;
  ref: number | null;
}

interface ListRow {
  list: string;
  name: string;
  coalition: boolean;
  citizens: boolean;
}

/** How one results platform is read. */
interface Site {
  lists: ListRow[];
  /** Where the walk starts. If the first root has no results, the walk starts at `fallback`. */
  root: Node;
  fallback?: Node;
  results(node: Node, organ: string): Promise<PlaceResults | null>;
  children(node: Node): Promise<Node[]>;
  /** The list's local name on one ballot, when its acronym names different lists in different towns. */
  label(optionId: number | null): string | null;
  /** Places the site has that we couldn't match to a known place (newest platform). */
  unmatched: number;
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

const node = (key: string, name: string, parent: string | null, ref: number | null = null): Node => ({
  key,
  name,
  level: levelOf(key),
  dicofre: dicofreOf(key),
  parent,
  ref,
});

/** Sites up to 2025 (both older platforms): places are keyed by DICOFRE-based territory keys. */
const keyedSite = async (source: ElectionSource, election: ElectionDef): Promise<Site> => {
  const urls = maiUrls(election);
  const lists = new Map<string, ListRow>();
  for (const organ of election.organs) {
    for (const list of parseLists(await json(source, urls.lists(organ)))) lists.set(list.list, list);
    if (election.platform === "old") break; // One file for every body.
  }
  return {
    lists: [...lists.values()],
    root: node("GLOBAL-990000", "Total", null),
    // Autárquicas have no votes abroad and no global total.
    fallback: node("LOCAL-500000", "Território nacional", null),
    results: async (place, organ) => parseResults(await json(source, urls.results(place.key, organ))),
    children: async (place) =>
      place.key === "GLOBAL-990000"
        ? [node("LOCAL-500000", "Território nacional", place.key), node("FOREIGN-600000", "Estrangeiro", place.key)]
        : parseChildren(await json(source, urls.children(place.key))).map((c) => node(c.key, c.name, place.key)),
    label: () => null,
    unmatched: 0,
  };
};

/**
 * The newest platform (autárquicas 2025): numeric ids and no official codes. Each place is
 * matched by name to the places stored under the same parent by earlier elections. Places
 * that didn't exist before (the parishes restored in 2025) get a key of their own,
 * "AUTARQUICAS2025-<site id>", and no DICOFRE code.
 */
const v3Site = async (db: Db, source: ElectionSource, election: ElectionDef): Promise<Site> => {
  const urls = v3Urls(election);
  const electionId = parseV3Settings(await json(source, urls.settings));
  if (electionId === null) throw new Error(`${election.id}: no app-settings.json`);
  const { organs, topTerritory } = parseV3Election(await json(source, urls.election(electionId)));
  if (topTerritory === null || organs.length === 0) throw new Error(`${election.id}: the election file has changed shape`);
  const organIds = new Map(organs.map((o) => [o.key, o.id]));
  const options = parseV3Options(await json(source, urls.options(electionId)));

  // One row per acronym. An acronym with several names (local coalitions, citizens' groups
  // that share initials) keeps the acronym as its name, and each result gets its own label.
  const byList = new Map<string, { row: ListRow; names: Set<string> }>();
  for (const option of options.values()) {
    const seen = byList.get(option.list);
    if (seen) seen.names.add(option.name);
    else
      byList.set(option.list, {
        row: { list: option.list, name: option.name, coalition: option.kind === "coalition", citizens: option.kind === "citizens" },
        names: new Set([option.name]),
      });
  }
  const ambiguous = new Set([...byList].filter(([, v]) => v.names.size > 1).map(([list]) => list));
  const lists = [...byList.values()].map(({ row }) => (ambiguous.has(row.list) ? { ...row, name: row.list } : row));

  const site: Site = {
    lists,
    root: node("LOCAL-500000", "Território nacional", null, topTerritory),
    results: async (place, organ) => {
      const organId = organIds.get(organ);
      if (place.ref === null || organId === undefined) return null;
      return parseResults(await json(source, urls.results(electionId, place.ref, organId)));
    },
    children: async (place) => {
      if (place.ref === null) return [];
      // Official keys win over ones we made up, should both carry the same name.
      const known = new Map<string, string>();
      const stored = await db.select({ key: places.key, name: places.name }).from(places).where(eq(places.parentKey, place.key));
      for (const p of stored.sort((a, b) => Number(a.key.startsWith("LOCAL-")) - Number(b.key.startsWith("LOCAL-")))) {
        known.set(placeNameKey(p.name), p.key);
      }
      const children = parseV3Children(await json(source, urls.children(electionId, place.ref)));
      if (children.length > 0 && known.size === 0 && place.key.startsWith("LOCAL-")) {
        throw new Error(
          `${election.id}: no places stored under ${place.name} to match against. Import the previous autárquicas first (they go down to parishes).`,
        );
      }
      return children.map((child) => {
        const key = known.get(placeNameKey(child.name));
        if (key) return node(key, child.name, place.key, child.id);
        site.unmatched++;
        return { key: `${election.site.toUpperCase()}-${child.id}`, name: child.name, level: child.level, dicofre: null, parent: place.key, ref: child.id };
      });
    },
    label: (optionId) => {
      const option = optionId === null ? undefined : options.get(optionId);
      return option && ambiguous.has(option.list) ? option.name : null;
    },
    unmatched: 0,
  };
  return site;
};

/** How deep each body goes by default: its natural level. */
const deepestLevel = (organ: string, parishes: boolean) => (organ === "AF" || parishes ? "parish" : "municipality");

const ORDER: readonly Level[] = ["global", "national", "foreign", "district", "municipality", "parish"];

/**
 * Imports one election: every body, from the whole country down to municipalities (or
 * parishes). Safe to re-run and to stop: places already stored are skipped unless `refresh`.
 */
export const importElection = async (db: Db, source: ElectionSource, election: ElectionDef, options: ImportOptions = {}) => {
  const stats = { places: 0, skipped: 0, missing: 0, lists: 0, unmatched: 0 };
  const log = options.onProgress ?? (() => undefined);
  const site = election.platform === "v3" ? await v3Site(db, source, election) : await keyedSite(source, election);

  await db
    .insert(elections)
    .values({ id: election.id, type: election.type, name: election.name, date: election.date, organs: election.organs, sourceUrl: sourceUrl(election) })
    .onConflictDoUpdate({
      target: elections.id,
      set: { type: election.type, name: election.name, date: election.date, organs: election.organs, sourceUrl: sourceUrl(election) },
    });

  if (site.lists.length > 0) {
    await db
      .insert(electionLists)
      .values(site.lists.map((l) => ({ ...l, electionId: election.id, partySlugs: partiesInList(l.list) })))
      .onConflictDoUpdate({
        target: [electionLists.electionId, electionLists.list],
        set: { name: sql`excluded.name`, coalition: sql`excluded.coalition`, citizens: sql`excluded.citizens`, partySlugs: sql`excluded.party_slugs` },
      });
    stats.lists = site.lists.length;
  }

  const ensurePlace = async (place: Node) => {
    await db
      .insert(places)
      .values({ key: place.key, name: place.name, level: place.level, parentKey: place.parent, dicofre: place.dicofre })
      .onConflictDoUpdate({ target: places.key, set: { name: place.name, parentKey: sql`coalesce(excluded.parent_key, places.parent_key)` } });
  };

  const done = async (organ: string, key: string) =>
    (
      await db
        .select({ key: electionTurnout.placeKey })
        .from(electionTurnout)
        .where(and(eq(electionTurnout.electionId, election.id), eq(electionTurnout.organ, organ), eq(electionTurnout.placeKey, key)))
    ).length > 0;

  const importPlace = async (organ: string, place: Node) => {
    if (!options.refresh && (await done(organ, place.key))) {
      stats.skipped++;
      return true;
    }
    const results = await site.results(place, organ);
    if (!results) {
      stats.missing++;
      return false;
    }
    // The same acronym twice on one ballot would collide: keep the bigger one.
    const rows = new Map<string, PlaceResults["lists"][number]>();
    for (const l of results.lists) if ((rows.get(l.list)?.votes ?? -1) < l.votes) rows.set(l.list, l);
    await db.transaction(async (tx) => {
      const where = and(eq(electionResults.electionId, election.id), eq(electionResults.organ, organ), eq(electionResults.placeKey, place.key));
      await tx.delete(electionResults).where(where);
      if (rows.size > 0) {
        await tx.insert(electionResults).values(
          [...rows.values()].map(({ optionId, ...l }) => ({ ...l, label: site.label(optionId), electionId: election.id, organ, placeKey: place.key })),
        );
      }
      await tx
        .insert(electionTurnout)
        .values({ ...results.turnout, electionId: election.id, organ, placeKey: place.key })
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

  // Children are the same for every body, so fetch each once.
  const childrenCache = new Map<string, Node[]>();
  const childrenOf = async (place: Node) => {
    let children = childrenCache.get(place.key);
    if (!children) {
      children = await site.children(place);
      childrenCache.set(place.key, children);
    }
    return children;
  };

  for (const organ of election.organs) {
    const deepest = ORDER.indexOf(deepestLevel(organ, options.parishes ?? false));
    const queue: Node[] = [site.root];
    let first = true;
    while (queue.length > 0) {
      const place = queue.shift()!;
      await ensurePlace(place);
      const found = await importPlace(organ, place);
      if (first && !found && site.fallback) queue.push(site.fallback);
      first = false;
      if (!found) continue;
      // Abroad stops at Europe / outside Europe.
      if (place.level === "foreign" && place.key !== "FOREIGN-600000") continue;
      if (place.level !== "foreign" && place.level !== "global" && ORDER.indexOf(place.level) + 1 > deepest) continue;
      for (const child of await childrenOf(place)) {
        if (ORDER.indexOf(child.level) <= deepest) queue.push(child);
      }
    }
    log(`${election.id} ${organ}: ${stats.places} imported, ${stats.skipped} already there, ${stats.missing} missing`);
  }

  stats.unmatched = site.unmatched;
  if (site.unmatched > 0) log(`${election.id}: ${site.unmatched} places not found in earlier elections (stored without a DICOFRE code)`);
  await db.update(elections).set({ importedAt: new Date() }).where(eq(elections.id, election.id));
  return stats;
};
