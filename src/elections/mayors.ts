import { and, eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { electionCandidates, places } from "../db/schema.js";
import { syncLocalOfficials } from "../places/localOfficials.js";
import type { ElectionDef } from "./catalog.js";
import type { ElectionSource } from "./import.js";
import { type MayoralList, parseV3Children, parseV3Election, parseV3Mayors, parseV3Settings, placeNameKey, v3Urls } from "./maiV3.js";

/*
 * Mayors and the other câmara candidates (autárquicas 2025 on). The site lists only the head
 * of each câmara list; the winner is the mayor (presidente da câmara). Stored as candidates
 * at position 1 of each list, in the municipality.
 */

const json = async (source: ElectionSource, url: string): Promise<unknown | null> => {
  const response = await source.get(url);
  if (response.status !== "ok") return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
};

export const hasMayors = (election: ElectionDef) => election.platform === "v3" && election.type === "autarquicas";

export const importMayors = async (db: Db, source: ElectionSource, election: ElectionDef) => {
  if (!hasMayors(election)) return { municipalities: 0, candidates: 0, mayors: 0, unmatched: [] as string[] };
  const urls = v3Urls(election);
  const electionId = parseV3Settings(await json(source, urls.settings));
  if (electionId === null) throw new Error(`${election.id}: no app-settings.json`);
  const { topTerritory } = parseV3Election(await json(source, urls.election(electionId)));
  if (topTerritory === null) throw new Error(`${election.id}: the election file has changed shape`);

  const lists: MayoralList[] = [];
  for (const district of parseV3Children(await json(source, urls.children(electionId, topTerritory)))) {
    if (district.level !== "district") continue;
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const parsed = parseV3Mayors(await json(source, urls.mayors(electionId, district.id, page)));
      pages = parsed.pages;
      lists.push(...parsed.lists);
    }
  }

  // Our places: districts and their municipalities, by name (the site has no official codes).
  const stored = await db
    .select({ key: places.key, name: places.name, level: places.level, parentKey: places.parentKey })
    .from(places)
    .where(like(places.key, "LOCAL-%"));
  // The islands come as "Região Autónoma dos Açores" here, "Açores" elsewhere.
  const districtName = (name: string) => placeNameKey(name).replace(/^regiao autonoma d[aeo]s? /, "");
  const districts = new Map(stored.filter((p) => p.level === "district").map((p) => [districtName(p.name), p.key]));
  const municipalityKey = (district: string, municipality: string) => {
    const parent = districts.get(districtName(district));
    return stored.find((p) => p.level === "municipality" && p.parentKey === parent && placeNameKey(p.name) === placeNameKey(municipality))?.key ?? null;
  };

  const unmatched = new Set<string>();
  const rows = lists.flatMap((l) => {
    const placeKey = municipalityKey(l.district, l.municipality);
    if (!placeKey) {
      unmatched.add(`${l.municipality} (${l.district})`);
      return [];
    }
    return l.candidates.map((c) => ({
      electionId: election.id, placeKey, list: l.list, kind: "effective" as const, position: c.position, name: c.name,
      elected: c.elected, deputyId: null,
    }));
  });

  await db.transaction(async (tx) => {
    await tx.delete(electionCandidates).where(eq(electionCandidates.electionId, election.id));
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(electionCandidates).values(rows.slice(i, i + 1000)).onConflictDoNothing();
  });
  const stats = await db
    .select({ placeKey: electionCandidates.placeKey })
    .from(electionCandidates)
    .where(and(eq(electionCandidates.electionId, election.id), eq(electionCandidates.elected, true)));
  await syncLocalOfficials(db);
  return {
    municipalities: new Set(rows.map((r) => r.placeKey)).size,
    candidates: rows.length,
    mayors: stats.length,
    unmatched: [...unmatched],
  };
};
