import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { articles, budgetNews, budgetProposals, budgetStatements, budgetSummaries, folded, parties } from "../db/schema.js";
import { extractArticle } from "../ingestion/extractArticle.js";
import { PARTY_DEFINITIONS } from "../matching/parties.js";
import type { PoliteClient } from "../ingestion/politeClient.js";

/*
 * The news about a Budget proposal, and what parties and deputies said about it there
 * (docs/budget-api.md). Candidates are articles from around the proposal's dates that use the
 * words its summary gave (src/budget/summarize.ts) and read like Budget news; a model then reads
 * each one and says whether it's about this proposal, and who it reports saying what about it.
 * Every pair is judged once (budget_news). A statement is only ever what an article reports,
 * always kept with that article; the article's text itself isn't stored.
 */

export interface StatementFound {
  /** The party as the article names it (acronym or name), if any. */
  party: string | null;
  speaker: string | null;
  text: string;
}

export interface NewsVerdict {
  about: boolean;
  statements: StatementFound[];
}

export interface ProposalForNews {
  number: string;
  title: string;
  authors: string | null;
  summary: string;
}

export interface ArticleForNews {
  source: string;
  publishedAt: Date;
  title: string;
  text: string;
}

/** Null when the model can't give a usable answer (tried again on a later run). */
export type NewsJudge = (proposal: ProposalForNews, article: ArticleForNews) => Promise<NewsVerdict | null>;

const PROMPT = `Trabalhas num site português de informação política, neutro.
Recebes uma proposta de alteração ao Orçamento do Estado e uma notícia.

"about": true só se a notícia fala desta medida em concreto (o que a proposta muda), não apenas
do Orçamento em geral ou de outra medida parecida. Na dúvida, false.

"statements": se "about" for true, o que a notícia atribui a partidos ou a políticos sobre esta
medida (a favor, contra, críticas, condições). Uma entrada por pessoa ou partido:
- "party": a sigla ou nome do partido como aparece na notícia, ou "" se não houver;
- "speaker": o nome da pessoa como aparece na notícia, ou "" se for o partido;
- "text": o que disse, numa frase em português de Portugal (no máximo 220 caracteres): uma
  citação curta entre aspas tal como está na notícia, ou uma paráfrase fiel. Nada que a notícia
  não diga; nada do jornalista.
Sem declarações sobre esta medida: lista vazia. Se "about" for false: lista vazia.`;

const MAX_ARTICLE_CHARS = 12_000;
const MAX_STATEMENT = 300;

export const claudeNewsJudge = (apiKey: string, model = "claude-haiku-5-5"): NewsJudge => {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return async (proposal, article) => {
    const response = await client.messages.create({
      model,
      max_tokens: 1_200,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              about: { type: "boolean" },
              statements: {
                type: "array",
                items: {
                  type: "object",
                  properties: { party: { type: "string" }, speaker: { type: "string" }, text: { type: "string" } },
                  required: ["party", "speaker", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["about", "statements"],
            additionalProperties: false,
          },
        },
      },
      system: PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `PROPOSTA ${proposal.number}${proposal.authors ? ` (${proposal.authors})` : ""}: ${proposal.title}`,
            `O que muda: ${proposal.summary}`,
            "",
            `NOTÍCIA (${article.source}, ${article.publishedAt.toISOString().slice(0, 10)}): ${article.title}`,
            article.text.slice(0, MAX_ARTICLE_CHARS),
          ].join("\n"),
        },
      ],
    });
    if (response.stop_reason !== "end_turn") return null;
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return null;
    try {
      return cleanVerdict(JSON.parse(text.text));
    } catch {
      return null;
    }
  };
};

const tidy = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) || null : null);

/** Checks a model's answer; statements only come with "about". */
export const cleanVerdict = (value: unknown): NewsVerdict | null => {
  const answer = value as { about?: unknown; statements?: unknown } | null;
  if (typeof answer?.about !== "boolean") return null;
  if (!answer.about) return { about: false, statements: [] };
  const statements = (Array.isArray(answer.statements) ? answer.statements : [])
    .map((s: { party?: unknown; speaker?: unknown; text?: unknown }) => ({
      party: tidy(s?.party, 80),
      speaker: tidy(s?.speaker, 120),
      text: tidy(s?.text, MAX_STATEMENT),
    }))
    .filter((s): s is StatementFound => s.text !== null && s.text.length >= 10 && (s.party !== null || s.speaker !== null))
    .slice(0, 10);
  return { about: true, statements };
};

export const newsJudgeFromEnv = (env: NodeJS.ProcessEnv = process.env): NewsJudge | null =>
  env.ANTHROPIC_API_KEY ? claudeNewsJudge(env.ANTHROPIC_API_KEY) : null;

/** Upper case without accents, as `folded()` does in SQL. */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reads like Budget news (on the folded headline and excerpt). */
const BUDGET_WORDS = String.raw`(ORCAMENT|\mOE ?20[0-9]{2}\M|PROPOST|ESPECIALIDADE|VOTA|APROVAD|CHUMB|PARLAMENTO|DEPUTAD)`;

/** Days of news before a proposal was submitted, and after its last vote, that can be about it. */
const DAYS_BEFORE = 7;
const DAYS_AFTER = 30;
/** Newest candidates looked at per proposal and run. */
const CANDIDATES_PER_PROPOSAL = 5;

export interface NewsResult {
  checked: number;
  linked: number;
  statements: number;
  unreadable: number;
}

/** Party names, acronyms and the other names the press uses, folded, to their slugs. A name two parties share ("AD") maps to none. */
const loadPartyIndex = async (db: Db) => {
  const rows = await db.select({ slug: parties.slug, acronym: parties.acronym, name: parties.name }).from(parties);
  const key = (value: string) => fold(value).replace(/[^A-Z0-9]/g, "");
  const index = new Map<string, string | null>();
  const add = (name: string | null | undefined, slug: string) => {
    if (!name || !key(name)) return;
    const known = index.get(key(name));
    index.set(key(name), known === undefined || known === slug ? slug : null);
  };
  for (const row of rows) for (const name of [row.acronym, row.name, row.slug]) add(name, row.slug);
  for (const d of PARTY_DEFINITIONS) for (const name of [d.acronym, d.name, d.slug, ...d.terms]) add(name, d.slug);
  return (named: string | null) => (named ? (index.get(key(named)) ?? null) : null);
};

/**
 * Checks up to `limit` new (proposal, article) pairs, most recently voted proposals first.
 * Safe to run twice: a pair already judged is skipped, and its row is written with its statements.
 */
export const linkBudgetNews = async (
  db: Db,
  { client, judge, limit = 150, now = new Date() }: { client: Pick<PoliteClient, "get">; judge: NewsJudge; limit?: number; now?: Date },
): Promise<NewsResult> => {
  const result: NewsResult = { checked: 0, linked: 0, statements: 0, unreadable: 0 };
  const partyOf = await loadPartyIndex(db);
  // Proposals with words to look for, newest votes first, from Budgets whose news we still have.
  const proposals = await db
    .select({
      id: budgetProposals.id,
      number: budgetProposals.number,
      title: budgetProposals.title,
      authors: budgetProposals.authorLabel,
      year: budgetProposals.year,
      submittedOn: budgetProposals.submittedOn,
      lastVotedOn: budgetProposals.lastVotedOn,
      summary: budgetSummaries.summary,
      terms: budgetSummaries.terms,
    })
    .from(budgetProposals)
    .innerJoin(budgetSummaries, eq(budgetSummaries.proposalId, budgetProposals.id))
    .where(and(sql`cardinality(${budgetSummaries.terms}) > 0`, gt(budgetProposals.year, now.getUTCFullYear() - 2)))
    .orderBy(desc(budgetProposals.year), sql`${budgetProposals.lastVotedOn} desc nulls last`, desc(budgetProposals.id));

  for (const proposal of proposals) {
    if (result.checked >= limit) break;
    // The Budget is debated from October of the year before.
    const start = new Date(proposal.submittedOn ?? `${proposal.year - 1}-10-01`);
    start.setUTCDate(start.getUTCDate() - DAYS_BEFORE);
    const end = new Date(proposal.lastVotedOn ?? now);
    end.setUTCDate(end.getUTCDate() + DAYS_AFTER);
    const terms = proposal.terms.map((t) => String.raw`\m${escapeRegex(fold(t))}\M`).join("|");
    const text = folded(sql`${articles.title} || ' ' || ${articles.excerpt}`);
    const candidates = await db
      .select({ id: articles.id, title: articles.title, excerpt: articles.excerpt, url: articles.url, source: articles.source, publishedAt: articles.publishedAt })
      .from(articles)
      .leftJoin(budgetNews, and(eq(budgetNews.articleId, articles.id), eq(budgetNews.proposalId, proposal.id)))
      .where(
        and(
          isNull(budgetNews.articleId),
          isNull(articles.hiddenAt),
          // News only: a column's view isn't what a party said, nor news about the proposal.
          eq(articles.kind, "news"),
          sql`${articles.publishedAt} between ${start.toISOString()}::timestamptz and ${(end < now ? end : now).toISOString()}::timestamptz`,
          sql`${text} ~ ${terms}`,
          sql`${text} ~ ${BUDGET_WORDS}`,
        ),
      )
      .orderBy(desc(articles.publishedAt))
      .limit(CANDIDATES_PER_PROPOSAL);

    for (const candidate of candidates) {
      if (result.checked >= limit) break;
      // The full text, read now and not kept; a paywalled or unreachable page falls back to the excerpt.
      const page = await client.get(candidate.url);
      if (page.status === "unavailable") {
        result.unreadable++;
        continue; // Tried again on a later run.
      }
      const body = page.status === "ok" ? extractArticle(page.body).text : "";
      let verdict: NewsVerdict | null;
      try {
        verdict = await judge(
          { number: proposal.number, title: proposal.title, authors: proposal.authors, summary: proposal.summary },
          { source: candidate.source, publishedAt: candidate.publishedAt, title: candidate.title, text: body || candidate.excerpt },
        );
      } catch {
        verdict = null;
      }
      if (!verdict) continue;
      result.checked++;
      await db.transaction(async (tx) => {
        const [judged] = await tx
          .insert(budgetNews)
          .values({ proposalId: proposal.id, articleId: candidate.id, about: verdict.about, checkedAt: now })
          .onConflictDoNothing()
          .returning({ articleId: budgetNews.articleId });
        if (!judged || !verdict.about) return;
        result.linked++;
        if (verdict.statements.length === 0) return;
        await tx.insert(budgetStatements).values(
          verdict.statements.map((s) => ({ proposalId: proposal.id, articleId: candidate.id, party: partyOf(s.party), speaker: s.speaker, text: s.text })),
        );
        result.statements += verdict.statements.length;
      });
    }
  }
  return result;
};

/** The news and statements of some proposals, for the API. */
export const budgetNewsFor = async (db: Db, proposalIds: number[]) => {
  const newsRows = await db
    .select({ proposalId: budgetNews.proposalId, id: articles.id, title: articles.title, source: articles.source, url: articles.url, publishedAt: articles.publishedAt })
    .from(budgetNews)
    .innerJoin(articles, eq(articles.id, budgetNews.articleId))
    .where(and(inArray(budgetNews.proposalId, [...proposalIds, -1]), eq(budgetNews.about, true), isNull(articles.hiddenAt)))
    .orderBy(desc(articles.publishedAt), desc(articles.id));
  const statementRows = await db
    .select({
      proposalId: budgetStatements.proposalId,
      party: budgetStatements.party,
      speaker: budgetStatements.speaker,
      text: budgetStatements.text,
      articleId: articles.id,
      articleTitle: articles.title,
      source: articles.source,
      publishedAt: articles.publishedAt,
    })
    .from(budgetStatements)
    .innerJoin(articles, eq(articles.id, budgetStatements.articleId))
    .where(and(inArray(budgetStatements.proposalId, [...proposalIds, -1]), isNull(articles.hiddenAt)))
    .orderBy(desc(articles.publishedAt), budgetStatements.id);
  const group = <T extends { proposalId: number }>(rows: T[]) => {
    const map = new Map<number, Omit<T, "proposalId">[]>();
    for (const { proposalId, ...rest } of rows) map.set(proposalId, [...(map.get(proposalId) ?? []), rest]);
    return map;
  };
  return { news: group(newsRows), statements: group(statementRows) };
};
