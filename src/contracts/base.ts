/*
 * Public contracts from BASE (base.gov.pt), the portal where public bodies must publish the
 * contracts they sign. IMPIC publishes it as open data on dados.gov.pt: one zip per year with
 * one JSON array, refreshed weekly, public domain. Contract fields are in Portuguese, as
 * published; see docs/contracts-api.md.
 */

import { placeNameKey } from "../elections/maiV3.js";

export const CONTRACTS_DATASET = "66d72d488ca4b7cb2de28712";
export const CONTRACTS_DATASET_URL = `https://dados.gov.pt/pt/datasets/${CONTRACTS_DATASET}/`;
export const baseContractUrl = (id: string) => `https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=${id}`;

export type ProcedureKind =
  | "direct_award"
  | "direct_award_simplified"
  | "prior_consultation"
  | "public_tender"
  | "limited_tender"
  | "framework_agreement"
  | "excluded"
  | "special_sectors"
  | "negotiation"
  | "other";

/** Procedure kinds, with what each means in plain Portuguese. */
export const PROCEDURES: readonly { kind: ProcedureKind; label: string; plain: string }[] = [
  {
    kind: "direct_award",
    label: "Ajuste direto",
    plain: "A entidade pública escolhe a empresa e convida-a diretamente, sem concorrência aberta. A lei só o permite abaixo de certos valores ou em casos previstos, como urgência imperiosa ou quando só uma empresa pode fazer o trabalho.",
  },
  {
    kind: "direct_award_simplified",
    label: "Ajuste direto simplificado",
    plain: "Ajuste direto para compras de valor muito baixo, com menos formalidades.",
  },
  {
    kind: "prior_consultation",
    label: "Consulta prévia",
    plain: "A entidade convida pelo menos três empresas à sua escolha a apresentar propostas. Há alguma concorrência, mas só entre as convidadas.",
  },
  {
    kind: "public_tender",
    label: "Concurso público",
    plain: "Qualquer empresa pode concorrer. O anúncio é público e ganha a melhor proposta segundo critérios definidos à partida.",
  },
  {
    kind: "limited_tender",
    label: "Concurso limitado",
    plain: "Concurso em duas fases: primeiro escolhem-se as empresas qualificadas, depois só essas apresentam propostas.",
  },
  {
    kind: "framework_agreement",
    label: "Ao abrigo de acordo-quadro",
    plain: "Compra feita a empresas já selecionadas num concurso anterior (um acordo-quadro), muitas vezes centralizado para vários organismos.",
  },
  {
    kind: "excluded",
    label: "Contratação excluída",
    plain: "Contratos a que as regras normais da contratação pública não se aplicam, por exemplo entre entidades públicas ou com regras próprias.",
  },
  {
    kind: "special_sectors",
    label: "Setores especiais",
    plain: "Contratos de água, energia, transportes e serviços postais, que têm regras próprias.",
  },
  {
    kind: "negotiation",
    label: "Negociação",
    plain: "Procedimento em que a entidade negoceia as propostas com as empresas qualificadas.",
  },
  { kind: "other", label: "Outro procedimento", plain: "Outros procedimentos previstos no Código dos Contratos Públicos." },
];

export const procedureKind = (procedure: string): ProcedureKind => {
  const p = procedure.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/^ajuste direto simplificado/.test(p)) return "direct_award_simplified";
  if (/^ajuste direto/.test(p)) return "direct_award";
  if (/^consulta previa/.test(p)) return "prior_consultation";
  if (/^concurso publico/.test(p)) return "public_tender";
  if (/^concurso limitado/.test(p)) return "limited_tender";
  if (/acordo-quadro/.test(p)) return "framework_agreement";
  if (/^contratacao excluida/.test(p)) return "excluded";
  if (/^setores especiais/.test(p)) return "special_sectors";
  if (/negociacao/.test(p)) return "negotiation";
  return "other";
};

export interface ContractParty {
  role: "entity" | "supplier";
  position: number;
  nif: string;
  name: string;
  country: string | null;
}

export interface ParsedContract {
  id: string;
  procedureId: string | null;
  procedure: string;
  procedureKind: ProcedureKind;
  contractTypes: string[];
  object: string;
  description: string | null;
  price: number;
  basePrice: number | null;
  effectivePrice: number | null;
  publishedAt: string;
  signedAt: string | null;
  cpv: string | null;
  cpvDescription: string | null;
  deadlineDays: number | null;
  places: string[];
  legalBasis: string | null;
  directAwardReason: string | null;
  frameworkAgreement: string | null;
  centralized: boolean | null;
  invited: number | null;
  documentsUrl: string | null;
  status: string | null;
  parties: ContractParty[];
}

type Raw = Record<string, unknown>;

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
/** Some fields come with HTML entities ("I&amp;D") and invisible characters. */
const decodeText = (value: string) =>
  value
    .replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec?: string, hex?: string, name?: string) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[name!.toLowerCase()] ?? whole),
    )
    .replace(/[\u200b-\u200d\ufeff]/g, "");

const str = (value: unknown) => {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = decodeText(value).replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
};
const num = (value: unknown) => {
  // "1234.56", "1234,56" and the Portuguese "1.234,56" (dots group thousands when a comma follows).
  const n = typeof value === "string" ? Number((value.includes(",") ? value.replace(/\./g, "") : value).replace(",", ".")) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
/** Whole days for the integer column (a "30.5" would fail the whole batch). */
const days = (value: unknown) => {
  const n = num(value);
  return n === null || n < 0 || n > 2_147_483_647 ? null : Math.round(n);
};
const isoDate = (value: unknown) => {
  const s = str(value);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const yesNo = (value: unknown) => (value === "Sim" ? true : value === "Não" ? false : null);

const partiesOf = (value: unknown, role: ContractParty["role"]): ContractParty[] => {
  const seen = new Set<string>();
  const parties: ContractParty[] = [];
  for (const item of array(value)) {
    if (!item || typeof item !== "object") continue;
    const p = item as Raw;
    const name = str(p.descEntContrato);
    // Private individuals are often published without a NIF ("-", "0"); keep them, unnumbered.
    const given = str(p.nifEntContrato)?.replace(/\s/g, "") ?? null;
    const nif = given && /\d{5}/.test(given) ? given : null;
    if (!name && !nif) continue;
    const key = nif ?? `name:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parties.push({ role, position: parties.length + 1, nif: nif ?? "", name: name ?? nif!, country: str(p.codPaisEntContrato) });
  }
  return parties;
};

/** One record of a BASE contracts file; null when it lacks what every contract has (id, date, price, object). */
export const parseContract = (value: unknown): ParsedContract | null => {
  if (!value || typeof value !== "object") return null;
  const r = value as Raw;
  const id = str(r.idcontrato);
  const publishedAt = isoDate(r.dataPublicacao);
  const price = num(r.precoContratual);
  const object = str(r.objectoContrato) ?? str(r.descContrato);
  const procedure = str(r.tipoprocedimento);
  if (!id || !publishedAt || price === null || !object || !procedure) return null;

  const cpvs = array(r.CPV).filter((c): c is Raw => !!c && typeof c === "object");
  const mainCpv = cpvs.find((c) => c.CPVObjeto === "Principal") ?? cpvs[0];
  const description = str(r.descContrato);
  const effective = num(r.PrecoTotalEfetivo);

  return {
    id,
    procedureId: str(r.idprocedimento),
    procedure,
    procedureKind: procedureKind(procedure),
    contractTypes: array(r.tipoContrato).flatMap((t) => str(t) ?? []),
    object,
    description: description && description !== object ? description : null,
    price,
    basePrice: num(r.precoBaseProcedimento) || null,
    // Zero until the contract is closed and the effective price reported.
    effectivePrice: effective && isoDate(r.dataFechoContrato) ? effective : null,
    publishedAt,
    signedAt: isoDate(r.dataCelebracaoContrato),
    cpv: mainCpv ? str(mainCpv.cpvID) : null,
    cpvDescription: mainCpv ? str(mainCpv.cpvdescricao) : null,
    deadlineDays: days(r.prazoExecucao),
    places: [...new Set(array(r.localExecucao).flatMap((p) => str(p) ?? []))],
    legalBasis: str(r.fundamentacao),
    directAwardReason: str(r.fundamentAjusteDireto),
    frameworkAgreement: str(r.DescrAcordoQuadro),
    centralized: yesNo(r.ProcedimentoCentralizado),
    invited: array(r.entidadesConvidadas).length || null,
    documentsUrl: str(r.linkPecasProc),
    status: str(r.estadoContrato),
    parties: [...partiesOf(r.adjudicante, "entity"), ...partiesOf(r.adjudicatarios, "supplier")],
  };
};

export interface StoredPlace {
  key: string;
  name: string;
  level: string;
  parentKey: string | null;
}

/**
 * Matches "Portugal, Coimbra, Coimbra" (country, district, municipality) to our places: the
 * municipality and its district, or just the district. The autonomous regions come as
 * "Região Autónoma dos Açores"; names shared by two municipalities (Lagoa, Calheta) are told
 * apart by the district.
 */
export const placeMatcher = (stored: StoredPlace[]) => {
  const districts = new Map<string, StoredPlace>();
  const municipalities = new Map<string, StoredPlace[]>();
  for (const p of stored) {
    if (!p.key.startsWith("LOCAL-")) continue;
    if (p.level === "district") districts.set(placeNameKey(p.name), p);
    if (p.level === "municipality") {
      const list = municipalities.get(placeNameKey(p.name)) ?? [];
      list.push(p);
      municipalities.set(placeNameKey(p.name), list);
    }
  }
  const districtKey = (name: string) => {
    const key = placeNameKey(name).replace(/^regiao autonoma d[aeo]s? /, "");
    return districts.get(key) ?? null;
  };

  return (place: string): string[] => {
    const [country, district, municipality] = place.split(",").map((s) => s.trim());
    if (!country || placeNameKey(country) !== "portugal" || !district) return [];
    const d = districtKey(district);
    if (!municipality) return d ? [d.key] : [];
    const candidates = municipalities.get(placeNameKey(municipality)) ?? [];
    const m = candidates.length === 1 ? candidates[0]! : candidates.find((c) => c.parentKey === d?.key);
    if (m) return m.parentKey ? [m.key, m.parentKey] : [m.key];
    return d ? [d.key] : [];
  };
};

/** The yearly zip files of the contracts dataset, from the dados.gov.pt API. */
export const parseResources = (dataset: unknown) => {
  const resources = (dataset as { resources?: unknown })?.resources;
  return array(resources).flatMap((r) => {
    const { title, latest, last_modified: modified } = (r ?? {}) as Raw;
    const year = typeof title === "string" ? /^contratos(\d{4})\.zip$/i.exec(title)?.[1] : undefined;
    if (!year || typeof latest !== "string" || typeof modified !== "string") return [];
    return [{ year: Number(year), url: latest, modified }];
  });
};
