import type { BudgetVoteEntry } from "../db/schema.js";
import { PARTY_DEFINITIONS } from "../matching/parties.js";
import { foldText } from "../modules/articles/routes.js";

/*
 * Reads the parliament's file of amendment proposals to a State Budget
 * ("OEPropostasAlteracao<year>Or_json.txt" in Dados Abertos › Orçamento do Estado).
 * Everything is taken as published; whatever can't be read with certainty is marked
 * ambiguous with the reason, never guessed.
 */

export const PROPOSAL_RESULTS = [
  "pending", "sent_to_plenary", "approved", "partially_approved", "rejected", "withdrawn", "not_admitted", "superseded", "unclear",
] as const;
export type ProposalResult = (typeof PROPOSAL_RESULTS)[number];
export const VOTE_RESULTS = ["approved", "rejected", "superseded"] as const;
export type VoteResult = (typeof VOTE_RESULTS)[number];
export type Phase = "committee" | "plenary";

export interface ParsedVote {
  seq: number;
  votedOn: string;
  phase: Phase | null;
  result: VoteResult | null;
  unanimous: boolean;
  label: string | null;
  partLabel: string | null;
  parts: string[];
  subject: string | null;
  votes: BudgetVoteEntry[];
  ambiguity: string | null;
}

export interface ParsedProposal {
  id: number;
  year: number;
  number: string;
  submittedOn: string | null;
  title: string;
  article: string | null;
  topics: string[];
  target: "articles" | "tables" | null;
  kind: string | null;
  status: string;
  result: ProposalResult;
  resultPhase: Phase | null;
  unanimous: boolean;
  authorLabel: string | null;
  authorParties: string[];
  authorDeputies: string[];
  documentUrl: string | null;
  lastVotedOn: string | null;
  searchText: string;
  votes: ParsedVote[];
}

type Raw = Record<string, unknown>;

/** The source writes missing values as null or the string "None". */
const str = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "None" ? trimmed : null;
};
const list = <T>(value: T | T[] | null | undefined): T[] => (value == null || (value as unknown) === "None" ? [] : Array.isArray(value) ? value : [value]);
/** "18/11/2026 00:00:00" → "2026-11-18". */
const day = (value: unknown) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(str(value) ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

// Parties as the parliament names them: in full in votes, by acronym among the proposers.
const key = (value: string) => foldText(value).replace(/[^a-z0-9]+/g, " ").trim();
const BY_NAME = new Map<string, string>([
  ...PARTY_DEFINITIONS.map((p) => [key(p.name), p.slug] as [string, string]),
  ["chega", "chega"],
  ["livre", "livre"],
  ["centro democratico social partido popular", "cds-pp"],
  ["cds partido popular", "cds-pp"],
  // The CDS-PP's name in the parliament's files up to 2015.
  ["partido popular", "cds-pp"],
  ["partido ecologista os verdes", "pev"],
  ["os verdes", "pev"],
  ["pessoas animais natureza", "pan"],
  ["bloco de esquerda", "be"],
  ["juntos pelo povo", "jpp"],
  ["partido popular monarquico", "ppm"],
]);
const acronymKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9/]/g, "");
const BY_ACRONYM = new Map<string, string>([
  ...PARTY_DEFINITIONS.map((p) => [acronymKey(p.acronym), p.slug] as [string, string]),
  ["CH", "chega"],
  ["L", "livre"],
  ["BE", "be"],
  ["CDS", "cds-pp"],
  ["CDSP", "cds-pp"],
  ["CDSPP", "cds-pp"],
  ["PPD/PSD", "psd"],
  ["PEV", "pev"],
  ["JPP", "jpp"],
]);
export const partyByName = (name: string) => BY_NAME.get(key(name)) ?? null;
export const partyByAcronym = (acronym: string) => BY_ACRONYM.get(acronymKey(acronym)) ?? null;

const VOTE_VALUES: Record<string, BudgetVoteEntry["vote"]> = { favor: "favor", contra: "against", abstencao: "abstention", ausente: "absent" };

/** One vote's party lines. A deputy voting apart from their group appears as "Pedro Coelho(PSD)". */
export const partyVotes = (groups: unknown): { votes: BudgetVoteEntry[]; problems: string[] } => {
  const g = (groups ?? null) as { GrupoParlamentar?: unknown; Voto?: unknown } | null;
  if (!g || (g as unknown) === "None") return { votes: [], problems: ["no party votes in the source"] };
  const names = list(g.GrupoParlamentar as string | string[]);
  const values = list(g.Voto as string | string[]);
  const problems: string[] = [];
  if (names.length !== values.length) problems.push(`${names.length} groups but ${values.length} votes`);
  const votes = names.map((raw, i): BudgetVoteEntry => {
    const group = String(raw).trim();
    const deputyMatch = /^(.+?)\s*\(([^)]+)\)$/.exec(group);
    const party = deputyMatch ? partyByAcronym(deputyMatch[2]!) : partyByName(group);
    // An independent deputy ("Não Inscrito"): a vote of its own, belonging to no party.
    const independent = !deputyMatch && key(group).startsWith("nao inscrit");
    const rawVote = values[i] === undefined ? null : String(values[i]).trim();
    const vote = rawVote === null ? null : (VOTE_VALUES[key(rawVote)] ?? null);
    if (!party && !independent) problems.push(`unknown group "${group}"`);
    if (rawVote !== null && vote === null) problems.push(`unknown vote "${rawVote}" for ${group}`);
    return { party, group, deputy: deputyMatch ? deputyMatch[1]!.trim() : null, vote };
  });
  return { votes, problems };
};

const phaseOf = (label: string | null): Phase | null =>
  label === null ? null : /em comiss/i.test(foldText(label)) ? "committee" : /em plenario/i.test(foldText(label)) ? "plenary" : null;

/** A part's result: "Aprovado(a)", "Aprovado(a) por Unanimidade", "Rejeitado(a)", "Prejudicado(a)". */
const voteResult = (label: string | null): { result: VoteResult | null; unanimous: boolean } => {
  const f = foldText(label ?? "");
  if (f.startsWith("aprovad")) return { result: "approved", unanimous: f.includes("unanimidade") };
  if (f.startsWith("rejeitad")) return { result: "rejected", unanimous: false };
  if (f.startsWith("prejudicad")) return { result: "superseded", unanimous: false };
  return { result: null, unanimous: false };
};

/** The proposal's standing, from its status ("Aprovado(a) Parcialmente em Comissão"). */
export const proposalResult = (status: string): { result: ProposalResult; phase: Phase | null; unanimous: boolean } => {
  const f = foldText(status);
  const phase = phaseOf(status);
  if (f.startsWith("aguarda")) return { result: "pending", phase, unanimous: false };
  // "Remetido(a) a Plenário" or "Avocado(a)": called up to a plenary vote, not yet held.
  if (f.startsWith("remetid") || f.startsWith("avocad")) return { result: "sent_to_plenary", phase: "plenary", unanimous: false };
  if (f.startsWith("aprovad")) return { result: f.includes("parcialmente") ? "partially_approved" : "approved", phase, unanimous: f.includes("unanimidade") };
  if (f.startsWith("rejeitad")) return { result: "rejected", phase, unanimous: false };
  if (f.startsWith("retirad")) return { result: "withdrawn", phase, unanimous: false };
  if (f.startsWith("nao admitid")) return { result: "not_admitted", phase, unanimous: false };
  if (f.startsWith("prejudicad")) return { result: "superseded", phase, unanimous: false };
  return { result: "unclear", phase, unanimous: false };
};

const parseVote = (raw: Raw, seq: number, alone: boolean): ParsedVote | null => {
  const votedOn = day(raw.Data);
  if (!votedOn) return null;
  const label = str(raw.ResultadoCompleto);
  const partLabel = str(raw.Resultado);
  const { result, unanimous } = voteResult(partLabel ?? label);
  const parsed = partyVotes(raw.GruposParlamentares);
  // A superseded part isn't voted: no party votes is what the source should say.
  const { votes, problems } = result === "superseded" && parsed.votes.length === 0 ? { votes: [], problems: [] as string[] } : parsed;
  if (result === null) problems.push(`unknown result "${partLabel ?? label ?? ""}"`);
  // Voted in one go, the part's result is the proposal's: when they disagree, the source contradicts itself.
  if (alone && result && label) {
    const overall = proposalResult(label).result;
    if ((overall === "approved" && result !== "approved") || (overall === "rejected" && result !== "rejected"))
      problems.push(`the result says "${label}" but the vote says "${partLabel}"`);
  }
  const parts = list((raw.Descricoes as { Descricao?: string | string[] } | null)?.Descricao).map(String).map((p) => p.trim()).filter(Boolean);
  return {
    seq, votedOn, phase: phaseOf(label), result, unanimous, label, partLabel, parts,
    subject: str(raw.SubDescricao), votes, ambiguity: problems.length ? problems.join("; ") : null,
  };
};

const https = (url: string | null) => url?.replace(/^http:\/\/(app\.)?parlamento\.pt/, "https://$1parlamento.pt") ?? null;

export const parseProposal = (raw: Raw, year: number): ParsedProposal | null => {
  const id = Number(str(raw.ID));
  const number = str(raw.Numero);
  const status = str(raw.Estado);
  if (!Number.isInteger(id) || id <= 0 || !number || !status) return null;
  const articleRow = list((raw.Iniciativas_Artigos as { Iniciativa_Artigo?: Raw | Raw[] } | null)?.Iniciativa_Artigo)[0];
  const article = str(raw.NumeroArtigoNovo) ?? str(articleRow?.Artigo);
  const title = str(raw.Titulo) ?? article ?? `Proposta ${number}`;
  const topics = (str(raw.Tema) ?? "").split(";").map((t) => t.trim()).filter((t) => t && t !== "None");
  const incide = foldText(str(raw.Incide) ?? "");
  // Authors: the proposers' groups, else the label ("PSD, CDS-PP"); deputies without a group by name.
  const proposers = list((raw.Proponentes as { Proponente?: Raw | Raw[] } | null)?.Proponente);
  const authorLabel = str(raw.GrupoParlamentar_Partido);
  const fromProposers = proposers.map((p) => str(p.GP_Partido)).filter((a): a is string => !!a).map(partyByAcronym);
  const fromLabel = (authorLabel ?? "").split(",").map((a) => partyByAcronym(a.trim()));
  const authorParties = [...new Set([...fromProposers, ...fromLabel].filter((s): s is string => !!s))];
  const labelNames = (authorLabel ?? "").split(",").map((a) => a.trim()).filter((a) => a && !partyByAcronym(a));
  const authorDeputies = labelNames.length ? labelNames : [];
  const rawVotes = list((raw.Votacoes as { Votacao?: Raw | Raw[] } | null)?.Votacao);
  const votes = rawVotes.map((v, i) => parseVote(v, i, rawVotes.length === 1)).filter((v): v is ParsedVote => v !== null);
  const standing = proposalResult(status);
  const lastVotedOn = votes.reduce<string | null>((max, v) => (max === null || v.votedOn > max ? v.votedOn : max), null);
  return {
    id, year, number, submittedOn: day(raw.Data), title, article, topics,
    target: incide.startsWith("articulado") ? "articles" : incide.startsWith("mapa") ? "tables" : null,
    kind: str(raw.Tipo), status, result: standing.result, resultPhase: standing.phase, unanimous: standing.unanimous,
    authorLabel, authorParties, authorDeputies, documentUrl: https(str(raw.Ficheiro)), lastVotedOn,
    searchText: foldText([number, title, article ?? "", ...topics].join(" ")),
    votes,
  };
};

export const parseProposals = (json: unknown, year: number): ParsedProposal[] => {
  const items = list((json as { PropostaDeAlteracao?: Raw | Raw[] } | null)?.PropostaDeAlteracao);
  const seen = new Set<number>();
  return items.flatMap((raw) => {
    const p = parseProposal(raw, year);
    if (!p || seen.has(p.id)) return [];
    seen.add(p.id);
    return [p];
  });
};
