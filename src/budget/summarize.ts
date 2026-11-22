import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgetProposals, budgetSummaries, budgetSummaryAttempts } from "../db/schema.js";
import type { PoliteClient } from "../ingestion/politeClient.js";

/*
 * "O que muda" for the Budget's amendment proposals (docs/budget-api.md): a model reads each
 * proposal's official PDF and writes one or two neutral sentences, plus the words the press
 * would use for it (they find its news, src/budget/news.ts). Latest votes first; each proposal
 * once. A summary written by a person (through the publish key) is never replaced.
 */

export interface ProposalBrief {
  number: string;
  title: string;
  authors: string | null;
}

export interface ProposalSummary {
  summary: string;
  terms: string[];
}

/** Reads a proposal's PDF. Null when the model can't give a usable answer. */
export type ProposalSummarizer = (pdf: Uint8Array, brief: ProposalBrief) => Promise<ProposalSummary | null>;

const PROMPT = `És redator de um site português de informação política, neutro e sem opinião.
Recebes uma proposta de alteração ao Orçamento do Estado (o PDF oficial do Parlamento).

Escreve "summary": o que a proposta muda, em uma ou duas frases curtas (no máximo 280 caracteres),
em português de Portugal, para um leitor comum.
- Começa pelo verbo do que muda ("Alarga…", "Cria…", "Elimina…", "Reduz…"). Não repitas o número
  da proposta, o partido nem o artigo.
- Diz quem é afetado e o que concretamente muda (valores, prazos, abrangência), se o texto o disser.
- Só o que está no texto. Não avalies, não uses as justificações do partido como factos, não
  especules sobre efeitos.
- Se a proposta só elimina ou altera um número ou alínea sem que se perceba o efeito, diz isso de
  forma simples ("Elimina a alínea que…").

Escreve "terms": 2 a 5 expressões curtas que um jornalista usaria para falar deste assunto
(ex.: "propinas", "IRS Jovem", "alojamento estudantil", "PNAES"). Nada genérico como
"orçamento", "proposta", "Governo" ou nomes de partidos.`;

const MAX_SUMMARY = 400;

/** The summarizer backed by Claude. Fails soft: an error or odd answer is null, tried again later. */
export const claudeSummarizer = (apiKey: string, model = "claude-haiku-5-5"): ProposalSummarizer => {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return async (pdf, brief) => {
    const response = await client.messages.create({
      model,
      max_tokens: 600,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { summary: { type: "string" }, terms: { type: "array", items: { type: "string" } } },
            required: ["summary", "terms"],
            additionalProperties: false,
          },
        },
      },
      system: PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
            { type: "text", text: `Proposta ${brief.number}${brief.authors ? ` (${brief.authors})` : ""}: ${brief.title}` },
          ],
        },
      ],
    });
    if (response.stop_reason !== "end_turn") return null;
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return null;
    try {
      return cleanSummary(JSON.parse(text.text));
    } catch {
      return null;
    }
  };
};

/** Checks a model's answer: a sentence of sensible length, a few short terms. */
export const cleanSummary = (value: unknown): ProposalSummary | null => {
  const answer = value as { summary?: unknown; terms?: unknown } | null;
  if (typeof answer?.summary !== "string") return null;
  const summary = answer.summary.replace(/\s+/g, " ").trim();
  if (summary.length < 15 || summary.length > MAX_SUMMARY) return null;
  const terms = Array.isArray(answer.terms)
    ? [...new Set(answer.terms.filter((t): t is string => typeof t === "string").map((t) => t.replace(/\s+/g, " ").trim()))]
        .filter((t) => t.length >= 3 && t.length <= 60)
        .slice(0, 5)
    : [];
  return { summary, terms };
};

export const summarizerFromEnv = (env: NodeJS.ProcessEnv = process.env): ProposalSummarizer | null =>
  env.ANTHROPIC_API_KEY ? claudeSummarizer(env.ANTHROPIC_API_KEY) : null;

/**
 * Only Budgets from this year on get automatic summaries: older ones aren't worth the model calls
 * for now. Lower it (or pass `fromYear`) to fill them in.
 */
export const SUMMARIES_FROM_YEAR = 2027;

/** After a failure, wait this many hours times the number of tries (up to a week) before trying again. */
const RETRY_HOURS = 6;
const MAX_RETRY_HOURS = 7 * 24;
/** PDFs bigger than this aren't sent (a proposal is a page or two; a budget map can be huge). */
const MAX_PDF_BYTES = 5 * 1024 * 1024;

export interface SummarizeResult {
  summarized: number;
  failed: number;
  remaining: number;
}

/**
 * Summarises up to `limit` proposals from `fromYear`'s Budget on that have none, latest votes first. Safe to run twice: a
 * proposal summarised meanwhile (or by a person) is left as it is.
 */
export const summarizeProposals = async (
  db: Db,
  {
    client,
    summarizer,
    limit = 200,
    fromYear = SUMMARIES_FROM_YEAR,
    now = new Date(),
  }: { client: Pick<PoliteClient, "getBytes">; summarizer: ProposalSummarizer; limit?: number; fromYear?: number; now?: Date },
): Promise<SummarizeResult> => {
  const wanted = and(isNull(budgetSummaries.proposalId), isNotNull(budgetProposals.documentUrl), gte(budgetProposals.year, fromYear));
  const due = and(
    wanted,
    or(
      isNull(budgetSummaryAttempts.proposalId),
      lt(budgetSummaryAttempts.triedAt, sql`${now.toISOString()}::timestamptz - least(${RETRY_HOURS} * ${budgetSummaryAttempts.tries}, ${MAX_RETRY_HOURS}) * interval '1 hour'`),
    ),
  );
  const from = () =>
    db
      .select({
        id: budgetProposals.id,
        number: budgetProposals.number,
        title: budgetProposals.title,
        authors: budgetProposals.authorLabel,
        documentUrl: budgetProposals.documentUrl,
      })
      .from(budgetProposals)
      .leftJoin(budgetSummaries, eq(budgetSummaries.proposalId, budgetProposals.id))
      .leftJoin(budgetSummaryAttempts, eq(budgetSummaryAttempts.proposalId, budgetProposals.id))
      .where(due);
  const rows = await from()
    .orderBy(desc(budgetProposals.year), sql`${budgetProposals.lastVotedOn} desc nulls last`, desc(budgetProposals.id))
    .limit(limit);

  let summarized = 0;
  let failed = 0;
  const fail = async (proposalId: number, error: string) => {
    failed++;
    await db
      .insert(budgetSummaryAttempts)
      .values({ proposalId, lastError: error.slice(0, 500), triedAt: now })
      .onConflictDoUpdate({
        target: budgetSummaryAttempts.proposalId,
        set: { tries: sql`${budgetSummaryAttempts.tries} + 1`, lastError: error.slice(0, 500), triedAt: now },
      });
  };
  for (const row of rows) {
    const fetched = await client.getBytes(row.documentUrl!);
    if (fetched.status !== "ok") {
      await fail(row.id, `PDF ${fetched.status}: ${fetched.reason}`);
      continue;
    }
    if (fetched.bytes.length > MAX_PDF_BYTES || !String.fromCharCode(...fetched.bytes.slice(0, 5)).startsWith("%PDF")) {
      await fail(row.id, "not a PDF, or too large");
      continue;
    }
    let answer: ProposalSummary | null;
    try {
      answer = await summarizer(fetched.bytes, { number: row.number, title: row.title, authors: row.authors });
    } catch (error) {
      await fail(row.id, `model: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!answer) {
      await fail(row.id, "model: no usable answer");
      continue;
    }
    // A person's summary written meanwhile wins.
    await db.insert(budgetSummaries).values({ proposalId: row.id, summary: answer.summary, terms: answer.terms, automatic: true }).onConflictDoNothing();
    await db.delete(budgetSummaryAttempts).where(eq(budgetSummaryAttempts.proposalId, row.id));
    summarized++;
  }
  const [{ remaining } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(budgetProposals)
    .leftJoin(budgetSummaries, eq(budgetSummaries.proposalId, budgetProposals.id))
    .where(wanted);
  return { summarized, failed, remaining };
};
