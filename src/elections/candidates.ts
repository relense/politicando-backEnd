import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { deputies, electionCandidates, parties, places } from "../db/schema.js";
import { nameKey } from "../government/sync.js";
import { MAI_ORIGIN, type ElectionDef } from "./catalog.js";
import type { ElectionSource } from "./import.js";
import { levelOf, maiUrls, parseChildren, partiesInList } from "./mai.js";

/*
 * Candidate lists from the results site (2021-2025 platform): for each círculo, every list's
 * effective candidates in order and its alternates. Legislativas have one file per círculo;
 * europeias one national list, split into pages.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Bodies with published lists that we import: parliament and the European Parliament. */
export const hasCandidates = (election: ElectionDef) =>
  election.platform === "new" && (election.organs[0] === "AR" || election.organs[0] === "PE");

export const candidatesUrl = (election: ElectionDef, territoryKey: string | null, page: number) =>
  `${MAI_ORIGIN}/${election.site}/assets/static/candidates/parties-candidates-${[election.organs[0], territoryKey, page, false]
    .filter((v) => v !== null)
    .join("-")}.json`;

export interface ParsedCircle {
  territoryKey: string;
  territoryName: string;
  lists: { list: string; seats: number; effective: string[]; alternates: string[] }[];
}

export const parseCandidates = (raw: unknown): { pages: number; circles: ParsedCircle[] } => {
  const data = obj(raw);
  const circles = arr(data.electionCandidates).flatMap((c): ParsedCircle[] => {
    const circle = obj(c);
    const territoryKey = str(circle.territoryKey);
    if (!territoryKey) return [];
    const names = (v: unknown) => arr(v).map(str).filter((n): n is string => n !== null);
    return [{
      territoryKey,
      territoryName: str(circle.territoryName) ?? territoryKey,
      lists: arr(circle.candidates).flatMap((l) => {
        const list = obj(l);
        const acronym = str(list.party);
        return acronym
          ? [{ list: acronym, seats: num(list.mandates) ?? 0, effective: names(list.effectiveCandidates), alternates: names(list.alternateCandidates) }]
          : [];
      }),
    }];
  });
  return { pages: num(data.numberOfPages) ?? 1, circles };
};

const json = async (source: ElectionSource, url: string): Promise<unknown | null> => {
  const response = await source.get(url);
  if (response.status !== "ok") return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
};

/**
 * Replaces an election's candidates with the site's. Links each to a deputy record by full
 * name when exactly one deputy has it. Run after the election's results (it needs the places).
 */
export const importCandidates = async (db: Db, source: ElectionSource, election: ElectionDef) => {
  if (!hasCandidates(election)) return { circles: 0, candidates: 0, linked: 0, missing: 0 };

  // Legislativas: one file per círculo (districts, the islands, Europe, outside Europe).
  const children = election.organs[0] === "AR" ? await json(source, maiUrls(election).children("LOCAL-500000")) : null;
  if (election.organs[0] === "AR" && children === null) throw new Error(`${election.id}: could not download the list of círculos; nothing was changed`);
  const territories: (string | null)[] =
    election.organs[0] === "AR"
      ? [
          ...parseChildren(children).map((c) => c.key),
          "FOREIGN-800000",
          "FOREIGN-900000",
        ].filter((key) => levelOf(key) === "district" || key.startsWith("FOREIGN-"))
      : [null];

  const circles: ParsedCircle[] = [];
  let missing = 0;
  for (const territory of territories) {
    // A círculo counts only when all its pages came through; a partial one keeps its old lists.
    const own: ParsedCircle[] = [];
    let complete = true;
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const raw = await json(source, candidatesUrl(election, territory, page));
      if (raw === null) {
        missing++;
        complete = false;
        break;
      }
      const parsed = parseCandidates(raw);
      pages = parsed.pages;
      own.push(...parsed.circles);
    }
    if (!complete) continue;
    for (const circle of own) {
      const seen = circles.find((c) => c.territoryKey === circle.territoryKey);
      if (seen) seen.lists.push(...circle.lists);
      else circles.push(circle);
    }
  }

  const known = await db
    .select({ id: deputies.id, fullName: deputies.fullName, constituency: deputies.constituency, party: parties.slug })
    .from(deputies)
    .leftJoin(parties, eq(parties.id, deputies.partyId));
  // One deputy per full name; names shared by two deputies aren't linked.
  const byName = new Map<string, number | null>();
  for (const d of known) {
    const key = nameKey(d.fullName);
    byName.set(key, byName.has(key) ? null : d.id);
  }

  const rows = circles.flatMap((circle) =>
    circle.lists.flatMap((l) => {
      const candidates = [
        ...l.effective.map((name, i) => ({ list: l.list, kind: "effective" as const, position: i + 1, name, elected: i < l.seats })),
        ...l.alternates.map((name, i) => ({ list: l.list, kind: "alternate" as const, position: i + 1, name, elected: false })),
      ];
      // The two sources spell names differently ("dos Santos" / "Santos", an extra surname), so
      // a second pass compares loosely, but only with deputies elected here for a party on this list.
      const slugs = partiesInList(l.list);
      const local = known.filter((d) => d.constituency === circle.territoryName && d.party !== null && slugs.includes(d.party));
      return candidates.map((c) => {
        let deputyId = byName.get(nameKey(c.name)) ?? null;
        if (deputyId === null) {
          const matches = local.filter((d) => looselySame(c.name, d.fullName));
          const others = candidates.filter((o) => o !== c && matches.some((d) => looselySame(o.name, d.fullName)));
          if (matches.length === 1 && others.length === 0) deputyId = matches[0]!.id;
        }
        return { ...c, electionId: election.id, placeKey: circle.territoryKey, deputyId };
      });
    }),
  );

  await db.transaction(async (tx) => {
    for (const circle of circles) {
      await tx
        .insert(places)
        .values({ key: circle.territoryKey, name: circle.territoryName, level: levelOf(circle.territoryKey), parentKey: null })
        .onConflictDoNothing();
    }
    // A círculo whose file didn't come through keeps the lists it had.
    const read = circles.map((c) => c.territoryKey);
    if (missing === 0) await tx.delete(electionCandidates).where(eq(electionCandidates.electionId, election.id));
    else if (read.length > 0) await tx.delete(electionCandidates).where(and(eq(electionCandidates.electionId, election.id), inArray(electionCandidates.placeKey, read)));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(electionCandidates).values(rows.slice(i, i + 1000)).onConflictDoNothing();
    }
  });
  const linked = rows.filter((r) => r.deputyId !== null).length;
  return { circles: circles.length, candidates: rows.length, linked, missing };
};

const PARTICLES = new Set(["de", "da", "do", "das", "dos"]);
const words = (name: string) => nameKey(name).split(" ").filter((w) => !PARTICLES.has(w));

/** Same first name, and every name of the shorter spelling appears in the longer one. */
export const looselySame = (a: string, b: string) => {
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length) as [string[], string[]];
  return short.length >= 2 && short[0] === long[0] && short.every((w) => long.includes(w));
};

/** "MARIA JOSÉ DE AGUIAR" → "Maria José de Aguiar". */
export const properName = (name: string) =>
  name
    .toLocaleLowerCase("pt")
    .split(/(\s+|-)/)
    .map((word, i) => (i > 0 && /^(de|da|do|das|dos|e|d')$/.test(word) ? word : word.charAt(0).toLocaleUpperCase("pt") + word.slice(1)))
    .join("");

/** Candidates linked to a deputy, for their career path. */
export const candidaciesOf = (db: Db, deputyId: number) =>
  db.execute<{ election_id: string; election_name: string; date: string; place: string; list: string; kind: string; position: number; elected: boolean }>(sql`
    select c.election_id, e.name as election_name, e.date::text as date, p.name as place, c.list, c.kind, c.position, c.elected
    from election_candidates c
    join elections e on e.id = c.election_id
    join places p on p.key = c.place_key
    where c.deputy_id = ${deputyId}
    order by e.date desc`);
