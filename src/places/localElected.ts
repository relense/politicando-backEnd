import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { localElected, localElectedSources } from "../db/schema.js";
import { placeNameKey } from "../elections/maiV3.js";

/*
 * Everyone elected to each câmara (CM), assembleia municipal (AM) and assembleia de freguesia
 * (AF), by name and in list order, from the CNE's official results map ("III - Eleitos").
 * The map shows who was elected on election night, not later substitutions.
 *
 * The spreadsheet is converted once into data/<election>-eleitos.json (npm run
 * local-elected:fetch) and loaded by the seed on every deploy, which does nothing unless the
 * file changed.
 */

export type ElectedOrgan = "CM" | "AM" | "AF";

/** One body as the map prints it: a row of list codes, then each list's names down its column. */
export interface ElectedBody {
  /** The map's code: DDMM00 for a municipality, DDMMFF for a parish (leading zero dropped; a few parishes have letters, "0302FA"). */
  code: string;
  municipality: string;
  parish: string | null;
  organ: ElectedOrgan;
  /** Raw rows, empty cells as null. A body with more than four lists has a second row of codes. */
  rows: (string | null)[][];
}

export interface LocalElectedFile {
  election: string;
  source: { name: string; url: string; asOf: string };
  bodies: ElectedBody[];
}

export const LOCAL_ELECTED_FILES = ["data/autarquicas-2025-eleitos.json"];

const ORGANS = new Set(["CM", "AM", "AF"]);

/** The "III - ELEITOS" sheet: a header row per body (code, municipality, parish, organ), then its rows. */
export const parseElectedSheet = (rows: (string | null)[][]): ElectedBody[] => {
  const bodies: ElectedBody[] = [];
  let current: ElectedBody | null = null;
  for (const row of rows) {
    const [code, municipality, parish, organ] = row;
    if (code && /^[0-9A-Z]{4,6}$/.test(code) && municipality && organ && ORGANS.has(organ)) {
      current = { code, municipality, parish: parish ?? null, organ: organ as ElectedOrgan, rows: [] };
      bodies.push(current);
      continue;
    }
    if (!current) continue;
    const cells = [...row];
    while (cells.length && cells.at(-1) == null) cells.pop();
    if (cells.length) current.rows.push(cells);
  }
  return bodies;
};

export interface ElectedMember {
  list: string;
  position: number;
  name: string;
}

/** "MTG 2030" and "MTG2030" are the same list: codes compared without spaces or case. */
const codeKey = (code: string) => code.replace(/\s+/g, "").toUpperCase();

/**
 * The members of one body, given the lists that won seats there (our codes). The first row
 * is always a row of lists; a later row starts a new group of columns when every cell in it
 * is one of those lists, not yet seen; other rows are names. Names under a list we don't
 * know are dropped. Returns null for a body with no rows.
 */
export const membersOf = (rows: (string | null)[][], winners: Set<string>): ElectedMember[] | null => {
  const ours = new Map([...winners].map((w) => [codeKey(w), w]));
  const members: ElectedMember[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  let columns: (string | null)[] | null = null;
  for (const row of rows) {
    const filled = row.filter((c): c is string => c !== null);
    const known = filled.length > 0 && filled.every((c) => ours.has(codeKey(c)) && !seen.has(ours.get(codeKey(c))!));
    if (!columns || known) {
      columns = row.map((c) => (c === null ? null : (ours.get(codeKey(c)) ?? null)));
      for (const c of columns) if (c) seen.add(c);
      continue;
    }
    row.forEach((name, i) => {
      const list = columns?.[i];
      if (!name || !list) return;
      const position = (counts.get(list) ?? 0) + 1;
      counts.set(list, position);
      members.push({ list, position, name });
    });
  }
  return columns ? members : null;
};

const municipalityKey = (code: string) => `LOCAL-${code.padStart(6, "0").slice(0, 4)}00`;

/** Loads one converted map into local_elected; skipped when this exact file is already loaded. */
export const importLocalElected = async (db: Db, file: LocalElectedFile) => {
  const hash = createHash("sha256").update(JSON.stringify(file)).digest("hex");
  const election = (await db.execute<{ id: string }>(sql`select id from elections where id = ${file.election} and imported_at is not null`)).rows[0];
  if (!election) return { election: file.election, skipped: "election not imported" };
  const [loaded] = await db.select({ hash: localElectedSources.hash }).from(localElectedSources).where(eq(localElectedSources.electionId, file.election));
  if (loaded?.hash === hash) return { election: file.election, skipped: "unchanged" };

  // Lists that won seats in each body, and the places that have them.
  const seats = await db.execute<{ place_key: string; organ: string; list: string; mandates: number }>(sql`
    select place_key, organ, list, mandates from election_results where election_id = ${file.election} and mandates > 0`);
  const winners = new Map<string, Map<string, number>>();
  for (const r of seats.rows) {
    const k = `${r.place_key}|${r.organ}`;
    if (!winners.has(k)) winners.set(k, new Map());
    winners.get(k)!.set(r.list, r.mandates);
  }
  // Parishes by name within their municipality: those created in 2025 have keys of our own.
  const parishes = await db.execute<{ key: string; name: string; parent_key: string }>(sql`
    select key, name, parent_key from places where level = 'parish' and parent_key is not null`);
  const byName = new Map<string, string[]>();
  for (const p of parishes.rows) {
    if (!winners.has(`${p.key}|AF`)) continue;
    const k = `${p.parent_key}|${placeNameKey(p.name)}`;
    byName.set(k, [...(byName.get(k) ?? []), p.key]);
  }
  const placeOf = (body: ElectedBody) => {
    if (body.organ !== "AF") return municipalityKey(body.code);
    const named = byName.get(`${municipalityKey(body.code)}|${placeNameKey(body.parish ?? "")}`);
    if (named?.length === 1) return named[0]!;
    const coded = `LOCAL-${body.code.padStart(6, "0")}`;
    return winners.has(`${coded}|AF`) ? coded : null;
  };

  const rows: (typeof localElected.$inferInsert)[] = [];
  const unmatched: string[] = [];
  const unreadable: string[] = [];
  const mismatched: string[] = [];
  for (const body of file.bodies) {
    const label = `${body.organ} ${body.municipality}${body.parish ? ` / ${body.parish}` : ""}`;
    const placeKey = placeOf(body);
    const lists = placeKey ? winners.get(`${placeKey}|${body.organ}`) : undefined;
    if (!placeKey || !lists) {
      unmatched.push(label);
      continue;
    }
    const members = membersOf(body.rows, new Set(lists.keys()));
    if (!members) {
      unreadable.push(label);
      continue;
    }
    for (const [list, mandates] of lists) {
      const named = members.filter((m) => m.list === list).length;
      if (named !== mandates) mismatched.push(`${label}: ${list} ${named}/${mandates}`);
    }
    rows.push(...members.map((m) => ({ electionId: file.election, placeKey, organ: body.organ, list: m.list, position: m.position, name: m.name })));
  }

  await db.transaction(async (tx) => {
    await tx.delete(localElected).where(eq(localElected.electionId, file.election));
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(localElected).values(rows.slice(i, i + 1000)).onConflictDoNothing();
    await tx
      .insert(localElectedSources)
      .values({ electionId: file.election, name: file.source.name, url: file.source.url, asOf: file.source.asOf, hash, importedAt: new Date() })
      .onConflictDoUpdate({
        target: localElectedSources.electionId,
        set: { name: file.source.name, url: file.source.url, asOf: file.source.asOf, hash, importedAt: new Date() },
      });
  });
  const stored = await db.select({ n: sql<number>`count(*)::int` }).from(localElected).where(eq(localElected.electionId, file.election));
  return { election: file.election, bodies: file.bodies.length, members: stored[0]?.n ?? 0, unmatched, unreadable, mismatched };
};

/** Every converted map in the repo; run by the seed. */
export const importLocalElectedFiles = async (db: Db, files = LOCAL_ELECTED_FILES) => {
  const results = [];
  for (const path of files) {
    const file = JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), "utf8")) as LocalElectedFile;
    const result = await importLocalElected(db, file);
    // Long lists of names only matter when something didn't line up; keep the deploy log short.
    results.push(
      "skipped" in result
        ? result
        : {
            ...result,
            unmatched: { count: result.unmatched.length, first: result.unmatched.slice(0, 10) },
            unreadable: { count: result.unreadable.length, first: result.unreadable.slice(0, 10) },
            mismatched: { count: result.mismatched.length, first: result.mismatched.slice(0, 10) },
          },
    );
  }
  return results;
};
