import { topicsOf } from "./plain.js";
import type { InitiativeStatus, PartyVote, PresidencyRecord, VoteRecord } from "../db/schema.js";
import { partySlugForGroup } from "./groups.js";

/*
 * Turns the parliament's open data files (parlamento.pt › Dados Abertos) into rows.
 * The files are loosely typed and fields are often null, so everything is read
 * defensively and anything unrecognisable is skipped rather than guessed.
 */

type Json = Record<string, unknown>;

const asArray = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => typeof item === "object" && item !== null) : [];
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const int = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
};
const isoDate = (value: unknown): string | null => {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

// --- Deputies ---

export interface ParsedDeputy {
  id: number;
  name: string;
  fullName: string;
  parliamentaryGroup: string | null;
  partySlug: string | null;
  constituency: string;
  situation: string;
  active: boolean;
  sittingPeriods: { from: string; to: string | null }[];
  parliamentRole: string | null;
  gender: string | null;
  birthDate: string | null;
  profession: string | null;
  education: { course: string; completed: boolean }[];
  roles: { title: string; current: boolean }[];
  committees: { name: string; acronym: string; membership: string; role: string | null }[];
  pastLegislatures: string[];
}

/** The entry with no end date, or else the one that started last. */
const current = (entries: Json[], start: string, end: string) =>
  entries.find((entry) => !str(entry[end])) ??
  [...entries].sort((a, b) => String(a[start] ?? "").localeCompare(String(b[start] ?? ""))).at(-1);

/** Committee roles come as codes. Unknown codes are kept as they are. */
const COMMITTEE_ROLES: Record<string, string> = {
  P: "Presidente",
  VP: "Vice-Presidente",
  CGP: "Coordenador do grupo parlamentar",
  S: "Secretário",
};

/**
 * Everyone who has sat in this legislature, including those who later left or were
 * replaced. Substitutes who never took a seat are left out.
 *
 * @param base InformacaoBase<Leg>_json.txt
 * @param biographies RegistoBiografico<Leg>_json.txt
 */
export const parseDeputies = (base: unknown, biographies: unknown): ParsedDeputy[] => {
  const bioById = new Map<number, Json>();
  for (const bio of asArray(biographies)) {
    const id = int(bio.CadId);
    if (id) bioById.set(id, bio);
  }

  const byId = new Map<number, ParsedDeputy>();
  for (const entry of asArray((base as Json | null)?.Deputados)) {
    const id = int(entry.DepCadId);
    const name = str(entry.DepNomeParlamentar);
    const situations = asArray(entry.DepSituacao);
    if (!id || !name) continue;
    if (!situations.some((s) => str(s.sioDes)?.startsWith("Efetivo"))) continue;

    const situation = str(current(situations, "sioDtInicio", "sioDtFim")?.sioDes) ?? "Desconhecida";
    const active = situation.startsWith("Efetivo");
    // A person can be listed more than once. Keep the record where they are sitting.
    const existing = byId.get(id);
    if (existing?.active && !active) continue;

    const group = str(current(asArray(entry.DepGP), "gpDtInicio", "gpDtFim")?.gpSigla);
    const role = current(asArray(entry.DepCargo), "carDtInicio", "carDtFim");
    const bio = bioById.get(id) ?? {};
    const activity = (bio.CadActividadeOrgaos ?? {}) as Json;
    const legislature = str(entry.LegDes);

    byId.set(id, {
      id,
      name,
      fullName: str(entry.DepNomeCompleto) ?? str(bio.CadNomeCompleto) ?? name,
      parliamentaryGroup: group,
      partySlug: partySlugForGroup(group),
      constituency: str(entry.DepCPDes) ?? "Desconhecido",
      situation,
      active,
      sittingPeriods: situations
        .filter((s) => str(s.sioDes)?.startsWith("Efetivo"))
        .flatMap((s) => {
          const from = isoDate(s.sioDtInicio);
          return from ? [{ from, to: isoDate(s.sioDtFim) }] : [];
        })
        .sort((a, b) => a.from.localeCompare(b.from)),
      parliamentRole: role && !str(role.carDtFim) ? str(role.carDes) : null,
      gender: str(bio.CadSexo),
      birthDate: isoDate(bio.CadDtNascimento),
      profession: str(bio.CadProfissao),
      education: asArray(bio.CadHabilitacoes).flatMap((h) => {
        const course = str(h.HabDes);
        return course ? [{ course, completed: h.HabEstado === "C" }] : [];
      }),
      roles: asArray(bio.CadCargosFuncoes)
        .sort((a, b) => Number(a.FunOrdem ?? 0) - Number(b.FunOrdem ?? 0))
        .flatMap((f) => {
          const title = str(f.FunDes);
          return title ? [{ title, current: f.FunAntiga !== "S" }] : [];
        }),
      committees: [...asArray(activity.actividadeCom), ...asArray(activity.actividadeSCom)]
        .filter((c) => !legislature || str(c.legDes) === legislature)
        .flatMap((c) => {
          const committee = str(c.orgDes);
          if (!committee) return [];
          const code = str(asArray(c.cargoDes)[0]?.tiaDes);
          return [{
            name: committee,
            acronym: str(c.orgSigla) ?? "",
            membership: str(c.timDes) ?? "",
            role: code ? (COMMITTEE_ROLES[code] ?? code) : null,
          }];
        }),
      pastLegislatures: [
        ...new Set(
          asArray(bio.CadDeputadoLegis)
            .map((l) => str(l.LegDes))
            .filter((l): l is string => l !== null && l !== legislature),
        ),
      ],
    });
  }
  return [...byId.values()];
};

// --- Initiatives ---

export interface ParsedInitiative {
  id: number;
  legislature: string;
  type: string;
  number: string;
  title: string;
  status: InitiativeStatus;
  phase: string;
  phaseDate: string;
  submittedAt: string | null;
  publishedAt: string | null;
  otherAuthor: string | null;
  textUrl: string | null;
  votes: VoteRecord[];
  presidency: PresidencyRecord | null;
  topics: string[];
  authorGroups: string[];
  authorDeputyIds: number[];
}

/** Votes that decide an initiative's fate, as opposed to procedural ones. */
const DECIDING_VOTES = new Set([
  "Votação na generalidade",
  "Votação final global",
  "Votação final",
  "Votação global",
  "Votação Deliberação",
  "Votação novo decreto",
  "Confirmação do decreto",
  "Apreciação",
]);
/** A deciding vote that, if passed, means the initiative was adopted. */
const FINAL_VOTES = new Set([...DECIDING_VOTES].filter((phase) => phase !== "Votação na generalidade"));
const PUBLICATION = /\(Publicação (DR|DAR)\)$/;
const WITHDRAWN = "Retirada da iniciativa";

const POSITIONS = { "A Favor": "favor", Contra: "against", "Abstenção": "abstention" } as const;
type Position = (typeof POSITIONS)[keyof typeof POSITIONS];

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/**
 * Reads "A Favor: <I>PSD</I>, <I> 3-PS</I>, <I> Pedro Vaz (PS)</I><BR>Contra: ..."
 * Plain acronyms are whole groups, "3-PS" is part of a group, and "Name (PS)" is a
 * deputy who voted apart from their group.
 */
export const parseVoteDetail = (detail: string) => {
  const result: Pick<VoteRecord, "favor" | "against" | "abstention" | "named"> = {
    favor: [], against: [], abstention: [], named: [],
  };
  for (const line of detail.split(/<br\s*\/?>/i)) {
    const [label, ...rest] = stripTags(line).split(":");
    const position: Position | undefined = POSITIONS[label?.trim() as keyof typeof POSITIONS];
    if (!position) continue;
    for (const raw of rest.join(":").split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const deputy = /^(.+?)\s*\(([^)]+)\)$/.exec(item);
      if (deputy) {
        result.named.push({ name: deputy[1]!.trim(), group: deputy[2]!.trim(), position });
        continue;
      }
      const part = /^(\d+)-(.+)$/.exec(item);
      const group = (part ? part[2]! : item).trim();
      const vote: PartyVote = { party: partySlugForGroup(group) ?? group, count: part ? Number(part[1]) : null };
      result[position].push(vote);
    }
  }
  return result;
};

const statusOf = (events: Json[]): { status: InitiativeStatus; publishedAt: string | null } => {
  const published = events.find((event) => PUBLICATION.test(str(event.Fase) ?? ""));
  const publishedAt = published ? isoDate(published.DataFase) : null;
  if (events.some((event) => str(event.Fase) === WITHDRAWN)) return { status: "withdrawn", publishedAt };
  if (published) return { status: "approved", publishedAt };

  let status: InitiativeStatus = "in_progress";
  for (const event of events) {
    const phase = str(event.Fase) ?? "";
    if (!DECIDING_VOTES.has(phase)) continue;
    for (const vote of asArray(event.Votacao)) {
      const result = str(vote.resultado);
      if (result === "Rejeitado") status = "rejected";
      else if (result === "Aprovado") status = FINAL_VOTES.has(phase) ? "approved" : "in_progress";
    }
  }
  return { status, publishedAt };
};

/**
 * The President's decision from the stages, latest event winning: a vetoed decree that
 * parliament passes again ("2ª versão") is sent and promulgated anew.
 */
export const presidencyOf = (events: Json[]): PresidencyRecord | null => {
  const latest = (pattern: RegExp) =>
    events
      .filter((event) => pattern.test(str(event.Fase) ?? ""))
      .map((event) => isoDate(event.DataFase))
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1) ?? null;
  const sentAt = latest(/^Envio para promulgação/);
  const promulgatedAt = latest(/^Promulgação/);
  const vetoedAt = latest(/^Veto/);
  if (!sentAt && !promulgatedAt && !vetoedAt) return null;
  const status =
    promulgatedAt && (!vetoedAt || promulgatedAt >= vetoedAt)
      ? "promulgated"
      : vetoedAt && (!sentAt || vetoedAt >= sentAt)
        ? "vetoed"
        : "pending";
  return { status, sentAt, promulgatedAt, vetoedAt };
};

/** @param data Iniciativas<Leg>_json.txt */
export const parseInitiatives = (data: unknown): ParsedInitiative[] => asArray(data).flatMap(parseInitiative);

/** One element of the initiatives file, or [] if it can't be used. */
export const parseInitiative = (raw: unknown): ParsedInitiative[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const item = raw as Json;
    const id = int(item.IniId);
    const title = str(item.IniTitulo);
    const type = str(item.IniDescTipo);
    if (!id || !title || !type) return [];

    // Events come in order; sort by date anyway, keeping that order for same-day events.
    const events = asArray(item.IniEventos)
      .map((event, index) => ({ event, index }))
      .sort((a, b) =>
        String(a.event.DataFase ?? "").localeCompare(String(b.event.DataFase ?? "")) || a.index - b.index,
      )
      .map(({ event }) => event);
    const last = events.at(-1);
    const phase = str(last?.Fase);
    const phaseDate = isoDate(last?.DataFase);
    // Every real initiative has at least its entry stage; one without is unusable.
    if (!phase || !phaseDate) return [];
    const { status, publishedAt } = statusOf(events);

    const votes: VoteRecord[] = events.flatMap((event) =>
      asArray(event.Votacao).flatMap((vote) => {
        const voteId = str(vote.id);
        const date = isoDate(vote.data) ?? isoDate(event.DataFase);
        if (!voteId || !date) return [];
        return [{
          id: voteId,
          date,
          phase: str(event.Fase) ?? "",
          result: str(vote.resultado) ?? "",
          unanimous: str(vote.unanime) === "unanime",
          ...parseVoteDetail(str(vote.detalhe) ?? ""),
          absent: (Array.isArray(vote.ausencias) ? vote.ausencias : [])
            .map((group) => str(group))
            .filter((group): group is string => group !== null)
            .map((group) => partySlugForGroup(group) ?? group),
        }];
      }),
    );

    const other = item.IniAutorOutros as Json | null;
    const otherName = str(other?.nome);
    return [{
      id,
      legislature: str(item.IniLeg) ?? "",
      type,
      number: str(item.IniNr) ?? "",
      title,
      status,
      phase,
      phaseDate,
      submittedAt: isoDate(events[0]?.DataFase),
      publishedAt,
      // "Grupos Parlamentares" and "Deputados" are already covered by the author lists.
      otherAuthor: otherName && !["Grupos Parlamentares", "Deputados"].includes(otherName) ? otherName : null,
      textUrl: str(item.IniLinkTexto)?.replace(/^http:/, "https:") ?? null,
      votes,
      presidency: presidencyOf(events),
      topics: topicsOf(title),
      authorGroups: [
        ...new Set(asArray(item.IniAutorGruposParlamentares).map((g) => str(g.GP)).filter((g): g is string => !!g)),
      ],
      authorDeputyIds: [
        ...new Set(asArray(item.IniAutorDeputados).map((d) => int(d.idCadastro)).filter((d): d is number => !!d)),
      ],
    }];
};
