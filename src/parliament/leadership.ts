/*
 * Who holds which position in the Assembleia, from the "Composição dos Órgãos" open data
 * file (OrgaoComposicao<Leg>_json.txt), and a rough importance score built from it. The
 * score only orders deputies within their own party, to estimate who sits in front.
 */

import { PARTY_LEADERS_LIST } from "../parties/leaders.js";

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => typeof item === "object" && item !== null) : [];
const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const int = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Party leaders who sit as deputies (from the curated list), with their title. */
export const PARTY_LEADERS: Readonly<Record<number, string>> = Object.fromEntries(
  PARTY_LEADERS_LIST.flatMap((l) => (l.deputyId === null ? [] : [[l.deputyId, l.title]])),
);

const WEIGHTS = {
  partyLeader: 110,
  groupLeader: 100,
  assemblyPresident: 95,
  assemblyVicePresident: 70,
  mesaSecretary: 50,
  mesaViceSecretary: 40,
  committeePresident: 45,
  committeeVicePresident: 20,
  committeeCoordinator: 10,
  standingCommittee: 25,
  perPastLegislature: 3,
  maxSeniority: 24,
  temporarySubstitute: -15,
};

const MESA_ROLES: Record<string, { title: string; weight: number }> = {
  Presidente: { title: "Presidente da Assembleia da República", weight: WEIGHTS.assemblyPresident },
  "Vice-Presidente": { title: "Vice-Presidente da Assembleia da República", weight: WEIGHTS.assemblyVicePresident },
  "Secretário": { title: "Secretário da Mesa da Assembleia", weight: WEIGHTS.mesaSecretary },
  "Vice-Secretário": { title: "Vice-Secretário da Mesa da Assembleia", weight: WEIGHTS.mesaViceSecretary },
};

/** Current roles of a member entry: those with no end date. */
const currentRoles = (member: Json) =>
  asArray(member.depCargo)
    .filter((role) => !str(role.carDtFim))
    .map((role) => str(role.carDes))
    .filter((role): role is string => role !== null);

/**
 * Still a member: the situation with no end date is an active one. Situations aren't
 * listed in date order, so this looks for the open one rather than the last.
 */
const isCurrentMember = (member: Json) => {
  const situations = asArray(member.depSituacao);
  if (situations.length === 0) return true; // The Mesa lists members without a situation.
  const open = situations.find((situation) => !str(situation.sioDtFim));
  return open !== undefined && !/^(Inativ|Cessou|Substitu)/i.test(str(open.sioDes) ?? "");
};

/** Members of a body. The Mesa keeps them under its own key. */
const membersOf = (organ: unknown) => {
  const node = (organ ?? {}) as Json;
  return asArray(node.HistoricoComposicao ?? node.HistoricoComposicaoMesa);
};

export interface Leadership {
  /** Official positions, most important first, e.g. "Líder do grupo parlamentar". */
  positions: string[];
  score: number;
}

export const parseLeadership = (data: unknown): Map<number, Leadership> => {
  const root = (data ?? {}) as Json;
  const found = new Map<number, { positions: { title: string; weight: number }[]; extra: number }>();
  const entry = (id: number) => {
    let value = found.get(id);
    if (!value) found.set(id, (value = { positions: [], extra: 0 }));
    return value;
  };
  const add = (member: Json, title: string, weight: number) => {
    const id = int(member.depCadId);
    if (id && !entry(id).positions.some((p) => p.title === title)) entry(id).positions.push({ title, weight });
  };

  for (const member of membersOf(root.ConferenciaLideres)) {
    if (isCurrentMember(member) && currentRoles(member).includes("Líder de Grupo Parlamentar")) {
      add(member, "Líder do grupo parlamentar", WEIGHTS.groupLeader);
    }
  }
  for (const member of membersOf(root.MesaAR)) {
    for (const role of currentRoles(member)) {
      const mesa = MESA_ROLES[role];
      if (mesa) add(member, mesa.title, mesa.weight);
    }
  }
  for (const member of membersOf(root.ComissaoPermanente)) {
    if (isCurrentMember(member)) add(member, "Membro da Comissão Permanente", WEIGHTS.standingCommittee);
  }
  for (const committee of asArray(root.Comissoes)) {
    const name = str((committee.DetalheOrgao as Json | null)?.nomeSigla);
    if (!name) continue;
    for (const member of membersOf(committee)) {
      if (!isCurrentMember(member)) continue;
      const roles = currentRoles(member);
      if (roles.includes("Presidente")) add(member, `Presidente da ${name}`, WEIGHTS.committeePresident);
      else if (roles.includes("Vice-Presidente")) add(member, `Vice-Presidente da ${name}`, WEIGHTS.committeeVicePresident);
      if (roles.includes("CGP")) {
        const id = int(member.depCadId);
        // Coordinating counts once, however many committees.
        if (id) entry(id).extra = Math.max(entry(id).extra, WEIGHTS.committeeCoordinator);
      }
    }
  }

  return new Map(
    [...found].map(([id, { positions, extra }]) => {
      const sorted = positions.sort((a, b) => b.weight - a.weight);
      return [id, { positions: sorted.map((p) => p.title), score: sorted.reduce((sum, p) => sum + p.weight, 0) + extra }];
    }),
  );
};

/** Importance used to order a party's deputies from the front row back. */
export const importanceOf = (
  deputy: { id: number; situation: string; pastLegislatures: string[] },
  leadership: Map<number, Leadership>,
) => {
  const leader = PARTY_LEADERS[deputy.id];
  const positions = [...(leader ? [leader] : []), ...(leadership.get(deputy.id)?.positions ?? [])];
  const score =
    (leader ? WEIGHTS.partyLeader : 0) +
    (leadership.get(deputy.id)?.score ?? 0) +
    Math.min(deputy.pastLegislatures.length * WEIGHTS.perPastLegislature, WEIGHTS.maxSeniority) +
    (deputy.situation === "Efetivo Temporário" ? WEIGHTS.temporarySubstitute : 0);
  return { positions, score };
};
