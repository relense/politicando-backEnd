import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { cleanVerdict, linkBudgetNews, type NewsJudge } from "../src/budget/news.js";
import { cleanSummary, summarizeProposals, type ProposalSummarizer } from "../src/budget/summarize.js";
import { budgetNews, budgetProposals, budgetStatements, budgetSummaries, budgetSummaryAttempts } from "../src/db/schema.js";
import type { FetchResult } from "../src/ingestion/politeClient.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const PDF = new TextEncoder().encode("%PDF-1.7 proposta");
const proposal = (id: number, fields: Partial<typeof budgetProposals.$inferInsert> = {}) =>
  db.insert(budgetProposals).values({
    id, year: 2027, number: `${id}C`, title: `Artigo ${id}.º`, status: "Aprovado(a) em Comissão", result: "approved",
    authorLabel: "PAN", authorParties: ["pan"], documentUrl: `https://app.parlamento.pt/doc/${id}.pdf`, ...fields,
  });
const pdfClient = (answers: Record<string, FetchResult<{ status: "ok"; bytes: Uint8Array; contentType: string | null }>> = {}) => ({
  getBytes: vi.fn(async (url: string) => answers[url] ?? { status: "ok" as const, bytes: PDF, contentType: "application/pdf" }),
});
const NOW = new Date("2026-11-20T12:00:00Z");

describe("summaries of Budget proposals", () => {
  it("summarises proposals without one, latest votes first, and never replaces a person's", async () => {
    await proposal(1, { lastVotedOn: "2026-11-10" });
    await proposal(2, { lastVotedOn: "2026-11-19" });
    await proposal(3, { lastVotedOn: "2026-11-18" });
    await proposal(4, { documentUrl: null });
    await db.insert(budgetSummaries).values({ proposalId: 3, summary: "Escrito por uma pessoa.", automatic: false });
    const seen: string[] = [];
    const summarizer: ProposalSummarizer = async (_pdf, brief) => {
      seen.push(brief.number);
      return { summary: `Cria o plano ${brief.number} para estudantes.`, terms: ["alojamento estudantil"] };
    };

    const result = await summarizeProposals(db, { client: pdfClient(), summarizer, limit: 1, now: NOW });
    expect(result).toEqual({ summarized: 1, failed: 0, remaining: 1 });
    expect(seen).toEqual(["2C"]);
    await summarizeProposals(db, { client: pdfClient(), summarizer, now: NOW });
    expect(seen).toEqual(["2C", "1C"]);

    const rows = await db.select().from(budgetSummaries).orderBy(budgetSummaries.proposalId);
    expect(rows.map((r) => [r.proposalId, r.automatic, r.terms])).toEqual([
      [1, true, ["alojamento estudantil"]],
      [2, true, ["alojamento estudantil"]],
      [3, false, []],
    ]);
    const shown = await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals/2" });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ plain: { summary: "Cria o plano 2C para estudantes.", automatic: true }, news: [], statements: [] });
  });

  it("waits before trying a failed proposal again, longer each time", async () => {
    await proposal(1);
    const client = pdfClient({ "https://app.parlamento.pt/doc/1.pdf": { status: "unavailable", reason: "HTTP 503" } });
    const summarizer = vi.fn<ProposalSummarizer>(async () => ({ summary: "Cria uma coisa nova.", terms: [] }));
    expect((await summarizeProposals(db, { client, summarizer, now: NOW })).failed).toBe(1);
    expect((await db.select().from(budgetSummaryAttempts))[0]).toMatchObject({ tries: 1, lastError: "PDF unavailable: HTTP 503" });
    // Too soon: skipped.
    await summarizeProposals(db, { client, summarizer, now: new Date(NOW.getTime() + 3_600_000) });
    expect(client.getBytes).toHaveBeenCalledTimes(1);
    // Six hours later it's tried again, and works: the attempt is forgotten.
    const later = new Date(NOW.getTime() + 7 * 3_600_000);
    expect(await summarizeProposals(db, { client: pdfClient(), summarizer, now: later })).toMatchObject({ summarized: 1 });
    expect(await db.select().from(budgetSummaryAttempts)).toEqual([]);
  });

  it("refuses what isn't a PDF and answers that don't look like a summary", async () => {
    await proposal(1);
    const client = pdfClient({ "https://app.parlamento.pt/doc/1.pdf": { status: "ok", bytes: new TextEncoder().encode("<html>"), contentType: "text/html" } });
    const summarizer = vi.fn<ProposalSummarizer>();
    expect((await summarizeProposals(db, { client, summarizer, now: NOW })).failed).toBe(1);
    expect(summarizer).not.toHaveBeenCalled();
    expect(cleanSummary({ summary: "curto", terms: [] })).toBeNull();
    expect(cleanSummary({ summary: "x".repeat(500), terms: [] })).toBeNull();
    expect(cleanSummary({ summary: "  Alarga a   isenção a mais imóveis. ", terms: ["IMI", "IMI", "x", 3, "alojamento estudantil", "a", "b c d", "e f g", "h i j"] })).toEqual({
      summary: "Alarga a isenção a mais imóveis.",
      terms: ["IMI", "alojamento estudantil", "b c d", "e f g", "h i j"],
    });
  });

  it("keeps summaries, news and statements when the sync replaces the year's proposals", async () => {
    await proposal(7);
    const article = await insertArticle(db);
    await db.insert(budgetSummaries).values({ proposalId: 7, summary: "Cria uma coisa nova.", terms: ["coisa"] });
    await db.insert(budgetNews).values({ proposalId: 7, articleId: article.id, about: true });
    await db.insert(budgetStatements).values({ proposalId: 7, articleId: article.id, party: "pan", text: "O PAN defende a medida." });
    // What storeBudgetYear does when the parliament's file changes: the year's proposals go and come back.
    await db.transaction(async (tx) => {
      await tx.delete(budgetProposals);
      await tx.insert(budgetProposals).values({ id: 7, year: 2027, number: "7C", title: "Artigo 7.º", status: "Aprovado(a) em Comissão", result: "approved" });
    });
    expect(await db.select().from(budgetSummaries)).toHaveLength(1);
    expect(await db.select().from(budgetNews)).toHaveLength(1);
    expect(await db.select().from(budgetStatements)).toHaveLength(1);
  });
});

describe("news and statements about Budget proposals", () => {
  const page = (text: string) => `<html><body><article><p>${text}</p></article></body></html>`;
  const pages = (byUrl: Record<string, FetchResult>) => ({ get: vi.fn(async (url: string) => byUrl[url] ?? ({ status: "blocked", reason: "HTTP 404" } as const)) });

  const setUp = async () => {
    await proposal(11, { submittedOn: "2026-10-29", lastVotedOn: "2026-11-19" });
    await db.insert(budgetSummaries).values({ proposalId: 11, summary: "Cria um novo plano de alojamento para estudantes.", terms: ["alojamento estudantil", "PNAES"] });
    const about = await insertArticle(db, {
      title: "Parlamento aprova PNAES 2.0 proposto pelo PAN", excerpt: "Proposta de alteração ao Orçamento aprovada.", url: "https://x.pt/pnaes",
      sourceUri: "x-pnaes", publishedAt: new Date("2026-11-19T15:00:00Z"),
    });
    const unrelated = await insertArticle(db, {
      title: "Alojamento estudantil: preços sobem", excerpt: "Estudo sobre rendas em Lisboa.", url: "https://x.pt/rendas",
      sourceUri: "x-rendas", publishedAt: new Date("2026-11-15T10:00:00Z"),
    });
    const outOfWindow = await insertArticle(db, {
      title: "PNAES: proposta antiga chumbada", excerpt: "Em 2024.", url: "https://x.pt/old", sourceUri: "x-old", publishedAt: new Date("2024-11-01T10:00:00Z"),
    });
    return { about, unrelated, outOfWindow };
  };

  it("links the articles about a proposal, with who said what, and judges each pair once", async () => {
    const { about } = await setUp();
    const client = pages({ "https://x.pt/pnaes": { status: "ok", body: page("A deputada Inês de Sousa Real disse que o plano é urgente. O PS absteve-se e o Chega votou contra.") } });
    const judged: string[] = [];
    const judge: NewsJudge = async (_p, article) => {
      judged.push(article.title);
      return article.title.includes("PNAES")
        ? {
            about: true,
            statements: [
              { party: "PAN", speaker: "Inês de Sousa Real", text: "Diz que o plano é «urgente» para os estudantes deslocados." },
              { party: "Partido Socialista", speaker: null, text: "Absteve-se por considerar o prazo pouco realista." },
              { party: "AD", speaker: "Alguém", text: "Uma frase de alguém de uma coligação." },
            ],
          }
        : { about: false, statements: [] };
    };

    const result = await linkBudgetNews(db, { client, judge, now: NOW });
    expect(result).toEqual({ checked: 1, linked: 1, statements: 3, unreadable: 0 });
    // The rent study has no Budget words and the 2024 one is out of the proposal's dates: never sent.
    expect(judged).toEqual(["Parlamento aprova PNAES 2.0 proposto pelo PAN"]);
    expect(await linkBudgetNews(db, { client, judge, now: NOW })).toMatchObject({ checked: 0 });

    const shown = await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals/11" });
    expect(shown.statusCode).toBe(200);
    const body = shown.json();
    expect(body.news).toEqual([expect.objectContaining({ id: about.id, title: "Parlamento aprova PNAES 2.0 proposto pelo PAN" })]);
    expect(body.statements.map((s: { party: { slug: string } | null; speaker: string | null }) => [s.party?.slug ?? null, s.speaker])).toEqual([
      ["pan", "Inês de Sousa Real"],
      ["ps", null],
      [null, "Alguém"],
    ]);
    expect(body.statements[0]).toMatchObject({ articleId: about.id, source: about.source, text: "Diz que o plano é «urgente» para os estudantes deslocados." });
  });

  it("tries an unreachable article again later, and reads the excerpt when the page is closed", async () => {
    await setUp();
    const judge = vi.fn<NewsJudge>(async () => ({ about: true, statements: [] }));
    expect(await linkBudgetNews(db, { client: pages({ "https://x.pt/pnaes": { status: "unavailable", reason: "timeout" } }), judge, now: NOW })).toMatchObject({
      checked: 0,
      unreadable: 1,
    });
    expect(judge).not.toHaveBeenCalled();
    // A paywall or a refusal: the headline and excerpt are enough to judge.
    expect(await linkBudgetNews(db, { client: pages({}), judge, now: NOW })).toMatchObject({ checked: 1, linked: 1 });
    expect(judge.mock.calls[0]![1].text).toBe("Proposta de alteração ao Orçamento aprovada.");
  });

  it("keeps only statements with a speaker or party, and none without 'about'", () => {
    expect(cleanVerdict({ about: false, statements: [{ party: "PS", speaker: "", text: "Uma coisa qualquer dita." }] })).toEqual({ about: false, statements: [] });
    expect(cleanVerdict({ about: true, statements: [{ party: "", speaker: "", text: "Ninguém disse isto." }, { party: "PS", speaker: "", text: "curto" }] })).toEqual({
      about: true,
      statements: [],
    });
    expect(cleanVerdict({ about: "sim" })).toBeNull();
  });
});
