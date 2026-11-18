import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { localOfficials } from "../db/schema.js";
import type { MatchablePerson } from "../matching/matchParties.js";

/*
 * Local officials with a page of their own: the mayors elected in the autárquicas (the
 * results site names no one else). Rebuilt from election_candidates, so it follows each
 * import; safe to run at any time.
 */

const PARTICLES = new Set(["de", "da", "do", "das", "dos", "e"]);
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const slug = (text: string) => fold(text).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** "Carlos Manuel Félix Moedas" → "Carlos Moedas": how the news names people. */
export const shortName = (fullName: string) => {
  const words = fullName.trim().split(/\s+/).filter((w) => !PARTICLES.has(w.toLowerCase()));
  return words.length <= 2 ? words.join(" ") : `${words[0]} ${words.at(-1)}`;
};

/** "carlos-moedas-lisboa": short name and municipality, readable in a URL and stable across elections. */
export const localOfficialId = (fullName: string, municipality: string) => slug(`${shortName(fullName)} ${municipality}`);

/** Mayors are elected for four years. */
const TERM_YEARS = 4;

/** Upserts the mayors of every autárquicas with candidates; only the latest election's are `current`. */
export const syncLocalOfficials = async (db: Db) => {
  const rows = await db.execute<{ name: string; place_key: string; place_name: string; election_id: string; date: string; list: string; latest: boolean }>(sql`
    with autarquicas as (
      select e.id, e.date, e.date = max(e.date) over () as latest from elections e
      where e.type = 'autarquicas' and exists (select 1 from election_candidates c where c.election_id = e.id)
    )
    select c.name, c.place_key, p.name as place_name, a.id as election_id, a.date::text as date, c.list, a.latest
    from election_candidates c
    join autarquicas a on a.id = c.election_id
    join places p on p.key = c.place_key and p.level = 'municipality'
    where c.elected
    order by a.date`);
  // Oldest first, so a mayor re-elected keeps one row with the latest term.
  const byId = new Map<string, typeof localOfficials.$inferInsert>();
  for (const r of rows.rows) {
    const start = new Date(`${r.date}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + TERM_YEARS);
    byId.set(localOfficialId(r.name, r.place_name), {
      id: localOfficialId(r.name, r.place_name),
      name: r.name,
      role: "mayor",
      placeKey: r.place_key,
      electionId: r.election_id,
      list: r.list,
      termStart: r.date,
      termEnd: end.toISOString().slice(0, 10),
      current: r.latest,
      updatedAt: new Date(),
    });
  }
  const values = [...byId.values()];
  const latest = values.find((v) => v.current)?.electionId;
  if (!latest) return { officials: 0 };
  await db.transaction(async (tx) => {
    // Mayors no longer in the latest election stop being current (the upsert below sets the rest).
    await tx
      .update(localOfficials)
      .set({ current: false, updatedAt: new Date() })
      .where(and(eq(localOfficials.current, true), ne(localOfficials.electionId, latest)));
    for (let i = 0; i < values.length; i += 500) {
      await tx
        .insert(localOfficials)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({
          target: localOfficials.id,
          set: {
            name: sql`excluded.name`,
            placeKey: sql`excluded.place_key`,
            electionId: sql`excluded.election_id`,
            list: sql`excluded.list`,
            termStart: sql`excluded.term_start`,
            termEnd: sql`excluded.term_end`,
            current: sql`excluded.current`,
            updatedAt: sql`excluded.updated_at`,
          },
          // Unchanged rows keep their date, so sitemaps and IndexNow only see real changes.
          setWhere: sql`(${localOfficials.name}, ${localOfficials.placeKey}, ${localOfficials.electionId}, ${localOfficials.list},
            ${localOfficials.termStart}, ${localOfficials.termEnd}, ${localOfficials.current})
            is distinct from (excluded.name, excluded.place_key, excluded.election_id, excluded.list,
            excluded.term_start, excluded.term_end, excluded.current)`,
        });
    }
  });
  return { officials: values.length };
};

/** Whole words, accents included ("\\b" treats "Á" as a boundary). */
const word = (pattern: string) => `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/**
 * Current mayors for news matching: the full name always counts; the short name ("Carlos
 * Moedas") only in an article that also names their municipality next to a word about local
 * government, so a namesake elsewhere isn't linked. Short names shared with another mayor,
 * a sitting deputy or a member of the Government are left out.
 */
export const loadMatchableLocalOfficials = async (db: Db): Promise<MatchablePerson<string>[]> => {
  const rows = await db.execute<{ id: string; name: string; municipality: string }>(sql`
    select o.id, o.name, p.name as municipality from local_officials o join places p on p.key = o.place_key where o.current`);
  const others = await db.execute<{ name: string }>(sql`
    select name from deputies where active union all select name from government_members`);
  const taken = new Set(others.rows.map((r) => fold(r.name)));
  const shortCount = new Map<string, number>();
  for (const r of rows.rows) shortCount.set(fold(shortName(r.name)), (shortCount.get(fold(shortName(r.name))) ?? 0) + 1);
  const LOCAL = "(?:c[âa]mara|autarca|autarquia|munic[íi]pio|municipal|presidente|edil|autarqu[íi]c)";
  return rows.rows.map((r) => {
    const short = shortName(r.name);
    const unique = shortCount.get(fold(short)) === 1 && !taken.has(fold(short)) && short.split(" ").length === 2;
    if (!unique || short === r.name) return { id: r.id, terms: [r.name] };
    const place = escape(r.municipality);
    return {
      id: r.id,
      terms: [r.name],
      contextTerms: [r.name, short],
      context: new RegExp(`${LOCAL}[^.\\n]{0,80}${word(place)}|${word(place)}[^.\\n]{0,80}${LOCAL}`, "iu"),
    };
  });
};
