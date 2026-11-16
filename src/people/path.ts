import { legislatureDates } from "../parliament/legislatures.js";

/*
 * Career paths: one timeline per person from the records we hold (the parliament's data,
 * the Government portal, the Presidency). Only what the sources say; nothing written by hand
 * beyond legislature dates.
 */

export type StepKind = "election" | "parliament" | "government" | "presidency" | "party" | "local" | "other";

export interface PathStep {
  from: string | null;
  to: string | null;
  /** "day": exact dates. "legislature": they sat at some point in this legislature, whose dates these are. */
  precision: "day" | "legislature";
  title: string;
  detail: string | null;
  kind: StepKind;
  current: boolean;
  source: string | null;
}

export interface DeputyRecord {
  id: number;
  constituency: string;
  sittingPeriods: { from: string; to: string | null }[];
  pastLegislatures: string[];
  positions: string[];
  roles: { title: string; current: boolean }[];
  gender: string | null;
  /** The legislature their sitting periods belong to (the current one). */
  legislature: string;
}

export interface GovernmentPost {
  title: string;
  areaName: string;
  startDate: string | null;
  endDate: string | null;
  url: string;
}

export const deputyPage = (id: number) => `https://www.parlamento.pt/DeputadoGP/Paginas/Biografia.aspx?BID=${id}`;

const PARTY_POSITION = /^(Presidente d[oa] (?!Comiss|Assembleia|Grupo)|Secretári[oa]-Geral|Porta-voz)/;
const LOCAL_ROLE = /Assembleia Municipal|Câmara Municipal|Vereador|Freguesia|Presidente da Junta/i;

/** Their time in parliament: earlier legislatures, then each sitting period in this one. */
export const deputySteps = (d: DeputyRecord): PathStep[] => {
  const source = deputyPage(d.id);
  const title = d.gender === "F" ? "Deputada à Assembleia da República" : "Deputado à Assembleia da República";
  const past = d.pastLegislatures.flatMap((id): PathStep[] => {
    const dates = legislatureDates(id);
    if (!dates || id === d.legislature) return [];
    return [{
      from: dates.start, to: dates.end, precision: "legislature",
      title, detail: `${id} legislatura`,
      kind: "parliament", current: false, source,
    }];
  });
  const now = d.sittingPeriods.map((p): PathStep => ({
    from: p.from, to: p.to, precision: "day",
    title, detail: `${d.legislature} legislatura, ${d.gender === "F" ? "eleita" : "eleito"} por ${d.constituency}`,
    kind: "parliament", current: p.to === null, source,
  }));
  return [...past, ...now];
};

/** Positions they hold now (no dates in the source): party leadership, group and committee roles. */
export const deputyCurrentRoles = (d: DeputyRecord): PathStep[] =>
  d.positions.map((title) => ({
    from: null, to: null, precision: "day" as const, title, detail: null,
    kind: PARTY_POSITION.test(title) ? ("party" as const) : ("parliament" as const),
    current: true, source: deputyPage(d.id),
  }));

/** Other roles from their parliament biography (local office, associations…), undated. */
export const deputyOtherRoles = (d: DeputyRecord): PathStep[] =>
  d.roles.map((r) => ({
    from: null, to: null, precision: "day" as const, title: r.title, detail: null,
    kind: LOCAL_ROLE.test(r.title) ? ("local" as const) : ("other" as const),
    current: r.current, source: deputyPage(d.id),
  }));

export const governmentSteps = (posts: GovernmentPost[]): PathStep[] =>
  posts.map((p) => ({
    from: p.startDate, to: p.endDate, precision: "day", title: p.title, detail: p.areaName === p.title ? null : p.areaName,
    kind: "government", current: p.endDate === null, source: p.url,
  }));

export const presidencySteps = (p: { termStart: string; termEnd: string | null }, source: string): PathStep[] => [{
  from: p.termStart, to: p.termEnd, precision: "day", title: "Presidente da República", detail: null,
  kind: "presidency", current: p.termEnd === null, source,
}];

export interface Candidacy {
  electionId: string;
  electionName: string;
  date: string;
  place: string;
  list: string;
  kind: string;
  position: number;
  elected: boolean;
}

/** Where they stood on a list: "nº 3 da lista PS no círculo de Porto". */
export const candidacySteps = (rows: Candidacy[], gender: string | null): PathStep[] =>
  rows.map((c) => ({
    from: c.date, to: c.date, precision: "day",
    title: `${gender === "F" ? "Candidata" : "Candidato"} nas ${c.electionName}`,
    detail: `${c.kind === "alternate" ? "suplente nº" : "nº"} ${c.position} da lista ${c.list}, círculo de ${c.place}${
      c.elected ? ` (${gender === "F" ? "eleita" : "eleito"})` : ""
    }`,
    kind: "election", current: false, source: `/elections/${c.electionId}/candidates`,
  }));

/** Newest first: ongoing steps on top, then by end date, then by start date. */
export const sortPath = (steps: PathStep[]) =>
  [...steps].sort(
    (a, b) =>
      Number(b.to === null) - Number(a.to === null) ||
      (b.to ?? "").localeCompare(a.to ?? "") ||
      (b.from ?? "").localeCompare(a.from ?? ""),
  );
