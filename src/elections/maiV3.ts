import { MAI_ORIGIN, type ElectionDef } from "./catalog.js";

/*
 * The results site's newest platform (autárquicas 2025 onwards). The app reads static files
 * named after the request: `assets/static/<endpoint>-<param>=<value>-….json`. Places have
 * numeric ids and names but no official (DICOFRE) codes, so the importer matches them to
 * places we already know by name.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const data = (v: unknown) => obj(v).data;

export const v3Urls = (election: ElectionDef) => {
  const base = `${MAI_ORIGIN}/${election.site}`;
  const file = (endpoint: string, params: Record<string, number>) =>
    `${base}/assets/static/${endpoint}-${Object.entries(params).map(([k, v]) => `${k}=${v}`).join("-")}.json`;
  return {
    settings: `${base}/app-settings.json`,
    election: (electionId: number) => file("election/data", { electionId }),
    options: (electionId: number) => file("votingOptions/votingOptions", { electionId }),
    results: (electionId: number, territoryId: number, organId: number) =>
      file("result/territory", { electionId, territoryId, organId }),
    children: (electionId: number, territoryId: number) => file("territory/children", { electionId, territoryId }),
    /** Head candidates of every câmara list in a district (votingOptionName=null: all lists). */
    mayors: (electionId: number, territoryId: number, page: number) =>
      `${base}/assets/static/candidate/candidates-electionId=${electionId}-territoryId=${territoryId}-votingOptionName=null-candidatesElected=false-page=${page}.json`,
  };
};

/** app-settings.json: which election the site shows. */
export const parseV3Settings = (raw: unknown) => num(obj(raw).electionId);

/** The election file: its bodies, as numeric ids with the usual codes (CM, AM, AF). */
export const parseV3Election = (raw: unknown) => {
  const election = obj(data(raw));
  const organs = (Array.isArray(election.organs) ? election.organs : []).flatMap((o) => {
    const id = num(obj(o).id);
    const key = str(obj(o).key);
    return id !== null && key ? [{ id, key }] : [];
  });
  const top = obj((Array.isArray(election.mainTerritories) ? election.mainTerritories : [])[0]);
  return { organs, topTerritory: num(top.id) };
};

const LIST_TYPES: Record<number, "party" | "coalition" | "citizens"> = { 1: "party", 2: "coalition", 3: "citizens" };

/**
 * Every list on every ballot. The same acronym can name different lists in different towns
 * (the PSD/CDS coalition runs as "Viva Cascais", "MAIA EM PRIMEIRO"…), so results point at
 * these by id.
 */
export const parseV3Options = (raw: unknown) => {
  const options = new Map<number, { list: string; name: string; kind: "party" | "coalition" | "citizens" }>();
  for (const o of Array.isArray(data(raw)) ? (data(raw) as unknown[]) : []) {
    const id = num(obj(o).id);
    const list = str(obj(o).name);
    const kind = LIST_TYPES[num(obj(o).typeId) ?? 0];
    if (id !== null && list && kind) options.set(id, { list, name: str(obj(o).description) ?? list, kind });
  }
  return options;
};

const LEVELS: Record<number, "district" | "municipality" | "parish"> = { 5: "district", 6: "municipality", 7: "parish" };

/** A children file: places inside a place. */
export const parseV3Children = (raw: unknown) =>
  (Array.isArray(data(raw)) ? (data(raw) as unknown[]) : []).flatMap((c) => {
    const id = num(obj(c).id);
    const name = str(obj(c).descriptionShort);
    const level = LEVELS[num(obj(c).typeId) ?? 0];
    return id !== null && name && level ? [{ id, name, level }] : [];
  });

/**
 * For matching place names across sources: no accents, case or punctuation, and no trailing
 * qualifier in brackets ("Lagoa (R.A.A)", "Calheta (R.A.M.)"), which only some sources add.
 */
export const placeNameKey = (name: string) =>
  name
    .replace(/\s*\([^)]*\)\s*$/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export interface MayoralList {
  district: string;
  municipality: string;
  list: string;
  candidates: { position: number; name: string; elected: boolean }[];
}

/**
 * A candidates file: for each municipality, the head of each câmara list. The winner has
 * state "President". The site publishes no other candidates for autárquicas.
 */
export const parseV3Mayors = (raw: unknown) => {
  const body = obj(data(raw));
  const lists: MayoralList[] = [];
  for (const d of Array.isArray(body.territories) ? body.territories : []) {
    const district = str(obj(d).description);
    for (const m of Array.isArray(obj(d).territories) ? (obj(d).territories as unknown[]) : []) {
      const municipality = str(obj(m).description);
      if (!district || !municipality || num(obj(m).territoryType) !== 6) continue;
      for (const vo of Array.isArray(obj(m).votingOptions) ? (obj(m).votingOptions as unknown[]) : []) {
        const list = str(obj(obj(vo).votingOption).name);
        if (!list) continue;
        const candidates = (Array.isArray(obj(vo).candidates) ? (obj(vo).candidates as unknown[]) : []).flatMap((c) => {
          const name = str(obj(c).name);
          const position = num(obj(c).position);
          return name && position !== null && str(obj(c).type) === "Efetivo"
            ? [{ position, name, elected: str(obj(c).state)?.toUpperCase() === "PRESIDENT" }]
            : [];
        });
        if (candidates.length) lists.push({ district, municipality, list, candidates });
      }
    }
  }
  return { pages: num(body.numberOfPages) ?? 1, lists };
};
