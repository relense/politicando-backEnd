/*
 * Vocabulary and rules for the corruption record and declared interests. Everything here is
 * shown to readers, so the wording is careful: a status is the stage a case has reached in
 * the courts, never our verdict, and everyone not finally convicted is presumed innocent.
 */

import { z } from "zod";

interface Term<K extends string> {
  key: K;
  label: string;
  plain: string;
}

const terms = <K extends string>(list: Term<K>[]) => list;

export const CASE_CRIMES = terms([
  { key: "corruption", label: "Corrupção", plain: "Pedir ou aceitar vantagens em troca de um ato ou omissão no exercício de funções públicas, ou oferecê-las." },
  { key: "influence_peddling", label: "Tráfico de influência", plain: "Pedir ou aceitar vantagens para usar influência, real ou suposta, junto de entidades públicas." },
  { key: "embezzlement", label: "Peculato", plain: "Um titular de cargo público apropriar-se de dinheiro ou bens públicos a que tem acesso por causa das funções." },
  { key: "economic_participation", label: "Participação económica em negócio", plain: "Lesar intencionalmente o interesse público num negócio em que se intervém, para obter benefício próprio ou de terceiros." },
  { key: "abuse_of_power", label: "Abuso de poder", plain: "Usar os poderes do cargo para obter benefícios ou causar prejuízo a alguém." },
  { key: "prevarication", label: "Prevaricação", plain: "Um titular de cargo político conduzir ou decidir um processo contra o direito, para beneficiar ou prejudicar alguém." },
  { key: "money_laundering", label: "Branqueamento", plain: "Dissimular a origem ilícita de dinheiro ou bens." },
  { key: "tax_fraud", label: "Fraude fiscal", plain: "Enganar o Estado para não pagar impostos devidos." },
  { key: "illegal_financing", label: "Financiamento ilícito", plain: "Financiamento de partidos ou campanhas fora das regras legais." },
  { key: "other", label: "Outro", plain: "Outro crime relacionado com o exercício de funções públicas." },
] as const);

export const CASE_STATUSES = terms([
  { key: "investigation", label: "Em investigação", plain: "O Ministério Público está a investigar (inquérito). Ainda ninguém foi acusado." },
  { key: "accusation", label: "Acusação deduzida", plain: "O Ministério Público acusou formalmente. Uma acusação não é uma condenação." },
  { key: "pre_trial", label: "Em instrução", plain: "Um juiz está a decidir se há indícios suficientes para levar o caso a julgamento." },
  { key: "trial", label: "Em julgamento", plain: "O caso está a ser julgado em tribunal." },
  { key: "ruled", label: "Decisão em 1.ª instância", plain: "O tribunal decidiu, mas ainda pode haver recurso. Ninguém é culpado até a decisão transitar em julgado." },
  { key: "appeal", label: "Em recurso", plain: "A decisão foi contestada num tribunal superior." },
  { key: "final", label: "Decisão definitiva", plain: "A decisão transitou em julgado: já não admite recurso." },
  { key: "archived", label: "Arquivado", plain: "O Ministério Público arquivou o inquérito, sem acusação." },
  { key: "prescribed", label: "Prescrito", plain: "O processo acabou porque passou o prazo legal, sem decisão sobre o mérito." },
] as const);

export const PERSON_STATUSES = terms([
  { key: "arguido", label: "Arguido", plain: "Constituído arguido: é formalmente suspeito e tem direitos de defesa. Não é uma acusação." },
  { key: "accused", label: "Acusado", plain: "O Ministério Público acusou-o formalmente. Presume-se inocente." },
  { key: "sent_to_trial", label: "Pronunciado", plain: "Um juiz decidiu que vai a julgamento. Presume-se inocente." },
  { key: "convicted", label: "Condenado", plain: "Condenado por um tribunal. Se a decisão não transitou em julgado, presume-se inocente até lá." },
  { key: "acquitted", label: "Absolvido", plain: "O tribunal absolveu-o." },
  { key: "archived", label: "Arquivado", plain: "O inquérito foi arquivado quanto a esta pessoa." },
  { key: "not_sent_to_trial", label: "Não pronunciado", plain: "Um juiz decidiu que não vai a julgamento." },
  { key: "prescribed", label: "Prescrito", plain: "O procedimento prescreveu quanto a esta pessoa." },
] as const);

export const INTEREST_KINDS = terms([
  { key: "company", label: "Empresa própria", plain: "Empresa que detém ou fundou." },
  { key: "shareholding", label: "Participação social", plain: "Quota ou ações numa empresa." },
  { key: "role", label: "Cargo", plain: "Cargo em órgãos de empresas, associações ou fundações." },
  { key: "activity", label: "Atividade", plain: "Atividade profissional, remunerada ou não." },
  { key: "client", label: "Cliente", plain: "Cliente de uma empresa ou atividade sua, declarado." },
] as const);

type Keys<T extends readonly Term<string>[]> = T[number]["key"];
const keysOf = <T extends readonly Term<string>[]>(list: T) => list.map((t) => t.key) as [Keys<T>, ...Keys<T>[]];

export const crimeSchema = z.enum(keysOf(CASE_CRIMES));
export const caseStatusSchema = z.enum(keysOf(CASE_STATUSES));
export const personStatusSchema = z.enum(keysOf(PERSON_STATUSES));
export const interestKindSchema = z.enum(keysOf(INTEREST_KINDS));

const httpUrl = z.url({ protocol: /^https?$/ }).max(1000);
const text = (max: number) => z.string().trim().min(1).max(max);

/** A case as editors write it in the admin: the whole document at once. */
export const caseInputSchema = z.object({
  title: text(200),
  summary: text(5000),
  crimes: z.array(crimeSchema).min(1).max(10),
  status: caseStatusSchema,
  statusDate: z.iso.date().nullable(),
  startedAt: z.iso.date().nullable(),
  reviewedAt: z.iso.date().nullable().describe("When you last checked it against the sources"),
  people: z
    .array(
      z.object({
        name: text(200),
        roleAtTime: text(200).nullable(),
        party: z.string().max(50).nullable().describe("Party slug at the time"),
        deputyId: z.number().int().positive().nullable(),
        governmentMemberId: z.string().max(64).nullable(),
        status: personStatusSchema,
        outcome: text(1000).nullable(),
        final: z.boolean().describe("The decision on them can no longer be appealed"),
      }),
    )
    .min(1)
    .max(100),
  events: z
    .array(
      z.object({
        date: z.iso.date(),
        description: text(1000),
        sources: z.array(z.number().int().min(1)).min(1).describe("Positions (from 1) in `sources`"),
      }),
    )
    .max(200),
  sources: z
    .array(
      z.object({
        url: httpUrl,
        title: text(300),
        publisher: text(200),
        publishedAt: z.iso.date().nullable(),
        kind: z.enum(["court", "official", "news"]),
      }),
    )
    .max(200),
});
export type CaseInput = z.infer<typeof caseInputSchema>;

/**
 * Why a case can't be published yet; empty when it can. Drafts can be saved incomplete, but
 * what readers see must be sourced, reviewed and consistent.
 */
export const publishProblems = (c: CaseInput): string[] => {
  const problems: string[] = [];
  if (c.sources.length === 0) problems.push("Add at least one source.");
  if (!c.reviewedAt) problems.push("Set reviewedAt: when you last checked it against the sources.");
  c.events.forEach((e, i) => {
    if (e.sources.some((s) => s > c.sources.length)) problems.push(`Event ${i + 1} cites a source that doesn't exist.`);
  });
  const ruled = c.status === "ruled" || c.status === "appeal" || c.status === "final";
  const verdicts = c.people.some((p) => p.status === "convicted" || p.status === "acquitted");
  if ((ruled || verdicts) && !c.sources.some((s) => s.kind === "court" || s.kind === "official")) {
    problems.push("A court decision needs a court or official source, not only news.");
  }
  if (c.status === "final" && c.people.some((p) => (p.status === "convicted" || p.status === "acquitted") && !p.final)) {
    problems.push("The case is final, but someone's decision isn't marked final.");
  }
  c.people.forEach((p) => {
    if (p.final && !["convicted", "acquitted", "not_sent_to_trial", "archived", "prescribed"].includes(p.status)) {
      problems.push(`${p.name}: only a decision can be final.`);
    }
  });
  return problems;
};

export const interestInputSchema = z.object({
  personName: text(200),
  deputyId: z.number().int().positive().nullable(),
  governmentMemberId: z.string().max(64).nullable(),
  kind: interestKindSchema,
  entityName: text(300),
  nif: z.string().regex(/^\d{9}$/).nullable().describe("Portuguese NIF/NIPC, 9 digits"),
  description: text(1000).nullable(),
  startDate: z.iso.date().nullable(),
  endDate: z.iso.date().nullable(),
  declaredAt: z.iso.date().nullable(),
  sourceUrl: httpUrl,
  sourceTitle: text(300),
  published: z.boolean(),
});
export type InterestInput = z.infer<typeof interestInputSchema>;
