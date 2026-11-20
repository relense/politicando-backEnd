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
  /** Every group they sat for this legislature, oldest first. */
  groupPeriods: { group: string; from: string; to: string | null }[];
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

/** Both lists' periods, once each, oldest first. */
const mergePeriods = <T extends { from: string; to: string | null }>(a: T[], b: T[]): T[] =>
  [...new Map([...a, ...b].map((p) => [JSON.stringify(p), p])).values()].sort(
    (x, y) => x.from.localeCompare(y.from) || (x.to ?? "9999").localeCompare(y.to ?? "9999"),
  );

/**
 * The kept record's periods (groups, or sitting), plus the other record's that don't clash with them: an old
 * record can still show a group spell as open that the current one has closed.
 */
const mergeGroups = <T extends { from: string; to: string | null }>(kept: T[], other: T[]): T[] =>
  mergePeriods(
    kept,
    // End dates are exclusive (one spell ends the day the next starts): touching isn't clashing.
    other.filter((p) => !kept.some((k) => k.from < (p.to ?? "9999") && p.from < (k.to ?? "9999"))),
  );

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
    const existing = byId.get(id);

    const group = str(current(asArray(entry.DepGP), "gpDtInicio", "gpDtFim")?.gpSigla);
    const role = current(asArray(entry.DepCargo), "carDtInicio", "carDtFim");
    const bio = bioById.get(id) ?? {};
    const activity = (bio.CadActividadeOrgaos ?? {}) as Json;
    const legislature = str(entry.LegDes);

    const parsed: ParsedDeputy = {
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
      groupPeriods: asArray(entry.DepGP)
        .flatMap((g) => {
          const sigla = str(g.gpSigla);
          const from = isoDate(g.gpDtInicio);
          return sigla && from ? [{ group: sigla, from, to: isoDate(g.gpDtFim) }] : [];
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
    };
    // A person can be listed more than once: keep the most recent record (the one with the
    // latest date; when equal, the one where they are sitting, else the later one), with the
    // other's periods where they don't clash: an old record can still show a spell as open.
    if (!existing) byId.set(id, parsed);
    else {
      const latest = (d: typeof parsed) =>
        [...d.sittingPeriods, ...d.groupPeriods].flatMap((p) => [p.from, p.to ?? ""]).reduce((a, b) => (b > a ? b : a), "");
      const [le, lp] = [latest(existing), latest(parsed)];
      const keepExisting = le > lp || (le === lp && existing.active && !active);
      const [kept, other] = keepExisting ? [existing, parsed] : [parsed, existing];
      byId.set(id, {
        ...kept,
        sittingPeriods: mergeGroups(kept.sittingPeriods, other.sittingPeriods),
        groupPeriods: mergeGroups(kept.groupPeriods, other.groupPeriods),
      });
    }
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
export const DECIDING_VOTES: ReadonlySet<string> = new Set([
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
/** "Acórdão do Tribunal Constitucional n.º 1133/2025" → ruling 1133/2025 and its page. */
export const constitutionalRulings = (text: string) =>
  [...text.matchAll(/Ac[óo]rd[ãa]o do Tribunal Constitucional n\.?\s*[ºo°]?\s*(\d+)\s*\/\s*(\d{4})/gi)].map(([, n, year]) => ({
    ruling: `${Number(n)}/${year}`,
    url: `https://www.tribunalconstitucional.pt/tc/acordaos/${year}${n!.padStart(4, "0")}.html`,
  }));

/** "Decreto n.º 48/XVII", "Decreto da Assembleia da República n.º 49/XVII/1.ª" → "48/XVII". */
export const decreeOf = (text: string) => {
  const match = /Decreto(?: da Assembleia da Rep[úu]blica)?\s+n\.?\s*[ºo°]?\s*(\d+)\s*\/\s*([IVXLC]+)/i.exec(text);
  return match ? `${Number(match[1])}/${match[2]!.toUpperCase()}` : null;
};

type Decision = "pending" | "promulgated" | "vetoed";
/** One decree's fate from its own events: the latest of sent, promulgated and vetoed wins. */
const decide = (sentAt: string | null, promulgatedAt: string | null, vetoedAt: string | null, lawAt: string | null) => {
  // The record sometimes skips "Promulgação": a law published after it was sent was promulgated.
  const inferred = !promulgatedAt && lawAt !== null && sentAt !== null && lawAt >= sentAt && (!vetoedAt || lawAt >= vetoedAt);
  const status: Decision =
    inferred || (promulgatedAt && (!vetoedAt || promulgatedAt >= vetoedAt))
      ? "promulgated"
      : vetoedAt && (!sentAt || vetoedAt >= sentAt)
        ? "vetoed"
        : "pending";
  return { status, inferred };
};

export const presidencyOf = (events: Json[]): PresidencyRecord | null => {
  const matching = (pattern: RegExp, decree?: string) =>
    events
      .filter((event) => pattern.test(str(event.Fase) ?? "") && isoDate(event.DataFase) !== null)
      .filter((event) => decree === undefined || decreeOf(str(event.ObsFase) ?? "") === decree)
      .sort((a, b) => isoDate(a.DataFase)!.localeCompare(isoDate(b.DataFase)!));
  const latest = (pattern: RegExp, decree?: string) => {
    const found = matching(pattern, decree);
    return found.length ? isoDate(found.at(-1)!.DataFase) : null;
  };
  const SENT = /^Envio para promulgação/;
  const PROMULGATED = /^Promulgação/;
  const VETOED = /^Veto/;
  // A veto's date is when Belém sent it ("Veto (Receção)", as in `vetoes`), not when parliament read or published it.
  const vetoDate = (decree?: string) => latest(/^Veto \(Rece/, decree) ?? latest(VETOED, decree);
  const sentAt = latest(SENT);
  let promulgatedAt = latest(PROMULGATED);
  const vetoedAt = vetoDate();
  const lawAt = latest(/^Lei .*\(Publicação DR\)/);
  if (!sentAt && !promulgatedAt && !vetoedAt) return null;

  // One initiative can become several decrees (the Nationality Law and a Penal Code change):
  // each goes through Belém on its own, so one's veto mustn't hide another's promulgation.
  // With a single current decree, the initiative's latest event decides, as before.
  const numbers = [
    ...new Set(
      matching(new RegExp(`${SENT.source}|${PROMULGATED.source}|${VETOED.source}`))
        .map((event) => decreeOf(str(event.ObsFase) ?? ""))
        .filter((n): n is string => n !== null),
    ),
  ];
  const all = numbers.map((number) => {
    const own = { sent: latest(SENT, number), promulgated: latest(PROMULGATED, number), vetoed: vetoDate(number) };
    // A published law can't be pinned on one decree: it only stands in for a missing promulgation on one never vetoed.
    const decision = decide(own.sent, own.promulgated, own.vetoed, own.vetoed ? null : lawAt);
    return { number, status: decision.status, sentAt: own.sent, promulgatedAt: own.promulgated, vetoedAt: own.vetoed, inferred: decision.inferred };
  });
  // A vetoed decree passed again comes back under a new number: the old one is replaced once another is sent after its veto.
  const current = all.filter((d) => d.status !== "vetoed" || !all.some((other) => other.sentAt !== null && other.sentAt > d.vetoedAt!));
  let status: Decision;
  let inferred: boolean;
  let decrees: typeof all | undefined;
  if (current.length > 1) {
    decrees = current;
    // Promulgated if any part became law; otherwise waiting if any part is still in Belém.
    status = decrees.some((d) => d.status === "promulgated") ? "promulgated" : decrees.some((d) => d.status === "pending") ? "pending" : "vetoed";
    inferred = status === "promulgated" && decrees.every((d) => d.status !== "promulgated" || d.inferred);
    promulgatedAt = decrees.map((d) => d.promulgatedAt).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  } else {
    ({ status, inferred } = decide(sentAt, promulgatedAt, vetoedAt, lawAt));
  }
  // "Veto (Receção)", "(Leitura)" and "(Publicação)" are steps of one veto: group them by the first.
  const vetoes = matching(/^Veto \(Rece/).reduce<NonNullable<PresidencyRecord["vetoes"]>>((list, event) => {
    const date = isoDate(event.DataFase)!;
    const found = constitutionalRulings(str(event.ObsFase) ?? "");
    const same = list.find((v) => v.date === date);
    const target = same ?? { date, kind: "political" as const, constitutionalCourt: [] };
    for (const r of found) if (!target.constitutionalCourt.some((c) => c.ruling === r.ruling)) target.constitutionalCourt.push(r);
    target.kind = target.constitutionalCourt.length ? "unconstitutionality" : "political";
    if (!same) list.push(target);
    return list;
  }, []);
  if (vetoedAt && vetoes.length === 0) vetoes.push({ date: vetoedAt, kind: "political", constitutionalCourt: [] });
  const rulings = vetoes.at(-1)?.constitutionalCourt ?? [];
  if (inferred) promulgatedAt = null;
  return {
    status,
    sentAt,
    promulgatedAt,
    promulgationRecorded: !inferred,
    vetoedAt,
    vetoKind: vetoedAt ? (rulings.length ? "unconstitutionality" : "political") : null,
    constitutionalCourt: rulings,
    vetoes,
    ...(decrees && {
      decrees: decrees.map(({ inferred: _inferred, ...d }) => d),
      partial: new Set(decrees.map((d) => d.status)).size > 1,
    }),
  };
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
