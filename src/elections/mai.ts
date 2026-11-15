import { partySlugForGroup } from "../parliament/groups.js";
import { MAI_ORIGIN, type ElectionDef } from "./catalog.js";

/** Where each file lives on the two platforms. */
export const maiUrls = (election: ElectionDef) => {
  const base = `${MAI_ORIGIN}/${election.site}`;
  return election.platform === "old"
    ? {
        results: (key: string, organ: string) => `${base}/static-data/territory-results/TERRITORY-RESULTS-${key}-${organ}.json`,
        children: (key: string) => `${base}/static-data/territory-children/TERRITORY-CHILDREN-${key}.json`,
        // One file for every body on the old platform.
        lists: () => `${base}/static-data/PARTIES.json`,
      }
    : {
        results: (key: string, organ: string) => `${base}/assets/static/territory-results/territory-results-${key}-${organ}.json`,
        children: (key: string) => `${base}/assets/static/territory-children/territory-children-${key}.json`,
        lists: (organ: string) => `${base}/assets/static/parties/parties-${organ}.json`,
      };
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export interface PlaceResults {
  turnout: {
    registered: number | null;
    voters: number;
    turnoutPct: number | null;
    blank: number;
    null: number;
    totalMandates: number | null;
  };
  lists: { list: string; votes: number; pct: number; validPct: number | null; mandates: number | null; presidents: number | null }[];
}

/** One TERRITORY-RESULTS file (same shape on both platforms). Null if it has no count. */
export const parseResults = (data: unknown): PlaceResults | null => {
  const current = obj(obj(data).currentResults);
  const voters = num(current.numberVoters);
  if (voters === null || !Array.isArray(current.resultsParty)) return null;
  return {
    turnout: {
      registered: num(current.subscribedVoters),
      voters,
      turnoutPct: num(current.percentageVoters),
      blank: num(current.blankVotes) ?? 0,
      null: num(current.nullVotes) ?? 0,
      totalMandates: num(current.totalMandates) || null,
    },
    lists: current.resultsParty.flatMap((raw) => {
      const party = obj(raw);
      const list = str(party.acronym);
      const votes = num(party.votes);
      if (!list || votes === null) return [];
      return [{
        list,
        votes,
        pct: num(party.percentage) ?? 0,
        validPct: num(party.validVotesPercentage),
        mandates: num(party.mandates),
        presidents: num(party.presidents),
      }];
    }),
  };
};

/** A TERRITORY-CHILDREN file: [{ name, territoryKey }]. */
export const parseChildren = (data: unknown) =>
  (Array.isArray(data) ? data : []).flatMap((raw) => {
    const child = obj(raw);
    const key = str(child.territoryKey);
    const name = str(child.name);
    return key && name ? [{ key, name }] : [];
  });

/** The PARTIES file: every list that ran, with its full name. */
export const parseLists = (data: unknown) =>
  (Array.isArray(data) ? data : []).flatMap((raw) => {
    const list = obj(raw);
    const acronym = str(list.acronym);
    const name = str(list.name);
    return acronym && name
      ? [{ list: acronym, name, coalition: list.coalition === true, citizens: list.groupOfCitizens === true }]
      : [];
  });

/** Ballot acronyms that differ from the parliament's group names. */
const BALLOT_TO_GROUP: Record<string, string> = { "PPD/PSD": "PSD", "B.E.": "BE", "PCP-PEV": "PCP", CDS: "CDS-PP", "P.N.R.": "PNR" };

/**
 * Our parties in a ballot list. Coalitions join members with dots ("PPD/PSD.CDS-PP");
 * "B.E." also has dots, so known acronyms are matched whole first.
 */
export const partiesInList = (list: string): string[] => {
  const whole = partySlugForGroup(BALLOT_TO_GROUP[list] ?? list);
  if (whole) return [whole];
  const slugs = list
    .split(".")
    .map((part) => partySlugForGroup(BALLOT_TO_GROUP[part] ?? part))
    .filter((slug): slug is string => slug !== null);
  return [...new Set(slugs)];
};

/** Level of a place from its key. */
export const levelOf = (key: string) => {
  if (key.startsWith("GLOBAL")) return "global" as const;
  if (key.startsWith("FOREIGN")) return "foreign" as const;
  const code = key.replace(/^LOCAL-/, "");
  if (code === "500000") return "national" as const;
  if (code.endsWith("0000")) return "district" as const;
  if (code.endsWith("00")) return "municipality" as const;
  return "parish" as const;
};

/** DICOFRE code for places in Portugal: "LOCAL-010100" → "0101". */
export const dicofreOf = (key: string) => {
  const level = levelOf(key);
  const code = key.replace(/^LOCAL-/, "");
  if (level === "district") return code.slice(0, 2);
  if (level === "municipality") return code.slice(0, 4);
  if (level === "parish") return code;
  return null;
};
