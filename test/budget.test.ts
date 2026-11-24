import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { budgetBillYear, syncCurrentBudgetBills } from "../src/budget/bills.js";
import { parseProposals, partyVotes, proposalResult } from "../src/budget/parse.js";
import { findLegislatures, findProposalFiles, syncBudget } from "../src/budget/sync.js";
import { agendaEvents, budgetBills, budgetProposals, initiatives } from "../src/db/schema.js";
import { sessionStage } from "../src/modules/budget/routes.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const KEY = "k".repeat(40);
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", publishKeys: [KEY] });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const GROUPS = ["Partido Social Democrata", "Chega", "Partido Socialista", "Iniciativa Liberal", "Livre"];
const vote = (date: string, full: string, part: string, votes: string[], extra: object = {}) => ({
  Descricoes: null, DiplomasTerceirosouPropostasDeLeiMapas: null, SubDescricao: null,
  Data: `${date} 00:00:00`, ResultadoCompleto: full, Resultado: part,
  GruposParlamentares: { GrupoParlamentar: GROUPS.slice(0, votes.length), Voto: votes }, ...extra,
});
const proposal = (id: number, number: string, fields: object) => ({
  ID: String(id), Numero: number, Data: "06/11/2026 21:26:00", Titulo: `Artigo ${id}.º (Uma alteração)`,
  Tema: "Saúde; ", Apresentada: "Comissão", Incide: "Articulado", Tipo: "Substituição", Estado: "Aguarda Voto em Comissão",
  NumeroArtigoNovo: "None", Conteudo: "None", Ficheiro: `http://app.parlamento.pt/webutils/docs/doc.pdf?path=${id}`,
  GrupoParlamentar_Partido: "L", Proponentes: { Proponente: { GP_Partido: "L", Deputado: "Rui Tavares" } },
  Iniciativas_Artigos: { Iniciativa_Artigo: { Artigo: `Artigo ${id}.º`, Titulo: "x", Texto: "None", Estado: "Entrada" } },
  Votacoes: null, ...fields,
});

const FILE = {
  PropostaDeAlteracao: [
    // By two parties, approved in committee in one vote.
    proposal(1, "10C", {
      GrupoParlamentar_Partido: "PSD, CDS-PP",
      Proponentes: { Proponente: [{ GP_Partido: "PSD", Deputado: "A" }, { GP_Partido: "CDS-P", Deputado: "B" }] },
      Estado: "Aprovado(a) em Comissão", Tema: "Habitação; Saúde; ",
      Votacoes: { Votacao: vote("18/11/2026", "Aprovado(a) em Comissão", "Aprovado(a)", ["Favor", "Contra", "Abstenção", "Contra", "Favor"]) },
    }),
    // Voted in parts, one deputy apart from his group, and a superseded part nobody voted on.
    proposal(2, "2C-1", {
      Estado: "Aprovado(a) Parcialmente em Comissão",
      Votacoes: {
        Votacao: [
          vote("19/11/2026", "Aprovado(a) Parcialmente em Comissão", "Aprovado(a)", ["Favor", "Favor", "Favor", "Favor", "Favor", "Contra"], {
            Descricoes: { Descricao: ["Alínea a), N.º 1, Artigo 2.º", "Alínea b), N.º 1, Artigo 2.º"] },
            GruposParlamentares: { GrupoParlamentar: [...GROUPS, "Pedro Coelho(PSD)"], Voto: ["Favor", "Favor", "Favor", "Favor", "Favor", "Contra"] },
          }),
          vote("19/11/2026", "Aprovado(a) Parcialmente em Comissão", "Rejeitado(a)", ["Contra", "Favor", "Contra", "Contra", "Favor"], { Descricoes: { Descricao: "N.º 2, Artigo 2.º" } }),
          { ...vote("19/11/2026", "Aprovado(a) Parcialmente em Comissão", "Prejudicado(a)", []), GruposParlamentares: null },
        ],
      },
    }),
    // The source can't be read with certainty: an unknown group, and a vote that contradicts the result.
    proposal(3, "3C", {
      GrupoParlamentar_Partido: "CH", Proponentes: { Proponente: { GP_Partido: "CH", Deputado: "C" } },
      Estado: "Rejeitado(a) em Comissão",
      Votacoes: { Votacao: { ...vote("18/11/2026", "Rejeitado(a) em Comissão", "Aprovado(a)", ["Contra"]), GruposParlamentares: { GrupoParlamentar: ["Partido Imaginário"], Voto: ["Talvez"] } } },
    }),
    // Not voted yet; called up to the plenary; by deputies without a group.
    proposal(4, "4C", {}),
    proposal(5, "5C", { Estado: "Avocado(a)" }),
    proposal(6, "6C", {
      GrupoParlamentar_Partido: "Pedro Coelho, Vânia Jesus",
      Proponentes: { Proponente: [{ GP_Partido: "PSD", Deputado: "Pedro Coelho" }, { GP_Partido: "PSD", Deputado: "Vânia Jesus" }] },
      Tema: "None", Incide: "Mapas",
    }),
  ],
};

describe("reading the parliament's Budget file", () => {
  const parsed = parseProposals(FILE, 2027);
  const byNumber = (n: string) => parsed.find((p) => p.number === n)!;

  it("takes authors, results and votes as published", () => {
    expect(byNumber("10C")).toMatchObject({
      id: 1, year: 2027, submittedOn: "2026-11-06", authorParties: ["psd", "cds-pp"], authorLabel: "PSD, CDS-PP",
      result: "approved", resultPhase: "committee", topics: ["Habitação", "Saúde"], target: "articles", lastVotedOn: "2026-11-18",
      documentUrl: "https://app.parlamento.pt/webutils/docs/doc.pdf?path=1",
    });
    expect(byNumber("10C").votes[0]).toMatchObject({
      votedOn: "2026-11-18", phase: "committee", result: "approved", ambiguity: null,
      votes: [
        { party: "psd", vote: "favor", deputy: null }, { party: "chega", vote: "against" }, { party: "ps", vote: "abstention" },
        { party: "il", vote: "against" }, { party: "livre", vote: "favor" },
      ],
    });
  });

  it("keeps each part of a split vote, and a deputy voting apart from his group", () => {
    const p = byNumber("2C-1");
    expect(p.result).toBe("partially_approved");
    expect(p.votes.map((v) => [v.parts, v.result, v.ambiguity])).toEqual([
      [["Alínea a), N.º 1, Artigo 2.º", "Alínea b), N.º 1, Artigo 2.º"], "approved", null],
      [["N.º 2, Artigo 2.º"], "rejected", null],
      [[], "superseded", null],
    ]);
    expect(p.votes[0]!.votes.at(-1)).toEqual({ party: "psd", group: "Pedro Coelho(PSD)", deputy: "Pedro Coelho", vote: "against" });
  });

  it("marks what it can't read as ambiguous instead of guessing", () => {
    const v = byNumber("3C").votes[0]!;
    expect(v.votes).toEqual([{ party: null, group: "Partido Imaginário", deputy: null, vote: null }]);
    expect(v.ambiguity).toContain('unknown group "Partido Imaginário"');
    expect(v.ambiguity).toContain('unknown vote "Talvez"');
    expect(v.ambiguity).toContain("the result says");
    expect(partyVotes(null).problems).toEqual(["no party votes in the source"]);
    // Older files name the CDS-PP "Partido Popular"; an independent deputy belongs to no party, and that's not a doubt.
    expect(partyVotes({ GrupoParlamentar: ["Partido Popular", "Não Inscrito"], Voto: ["Abstenção", "Favor"] })).toEqual({
      votes: [
        { party: "cds-pp", group: "Partido Popular", deputy: null, vote: "abstention" },
        { party: null, group: "Não Inscrito", deputy: null, vote: "favor" },
      ],
      problems: [],
    });
  });

  it("reads every status", () => {
    expect(byNumber("4C").result).toBe("pending");
    expect(byNumber("5C").result).toBe("sent_to_plenary");
    expect(byNumber("6C")).toMatchObject({ authorParties: ["psd"], authorDeputies: ["Pedro Coelho", "Vânia Jesus"], topics: [], target: "tables" });
    expect(proposalResult("Aprovado(a) por Unanimidade em Plenário")).toEqual({ result: "approved", phase: "plenary", unanimous: true });
    expect(proposalResult("Retirado(a)").result).toBe("withdrawn");
    expect(proposalResult("Não Admitida").result).toBe("not_admitted");
    expect(proposalResult("Algo novo").result).toBe("unclear");
  });
});

// The parliament's pages as the sync sees them.
const PAGE = `<a title="Pasta XVI Legislatura" href="/Cidadania/Paginas/DAOE.aspx?t=16&amp;Path=a">XVI</a>
  <a title="Pasta XVII Legislatura" href="/Cidadania/Paginas/DAOE.aspx?t=17&amp;Path=b">XVII</a>`;
const FOLDER = `<a href="https://app.parlamento.pt/webutils/docs/doc.txt?path=oe27">OEPropostasAlteracao2027Or_json.txt</a>
  <a href="https://app.parlamento.pt/webutils/docs/doc.txt?path=x">OE2027Or_json.txt</a>`;
const site = (file: () => string) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("DAOE.aspx?t=17")) return new Response(FOLDER);
    if (url.endsWith("DAOE.aspx")) return new Response(PAGE);
    if (url.includes("path=oe27")) return new Response(file());
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

describe("syncing a Budget", () => {
  it("finds the legislatures and the proposal files", () => {
    expect(findLegislatures(PAGE)).toEqual(["XVI", "XVII"]);
    expect(findProposalFiles(FOLDER)).toEqual([{ year: 2027, url: "https://app.parlamento.pt/webutils/docs/doc.txt?path=oe27" }]);
  });

  it("stores the year, skips an unchanged file, replaces on change, and never wipes on an empty file", async () => {
    let text = `﻿${JSON.stringify(FILE)}`;
    const first = await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => text) });
    expect(first.results).toEqual([{ year: 2027, proposals: 6, votes: 5, ambiguous: 1, changed: true }]);
    expect((await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => text) })).results[0]!.changed).toBe(false);

    text = JSON.stringify({ PropostaDeAlteracao: FILE.PropostaDeAlteracao.slice(0, 2) });
    expect((await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => text) })).results[0]).toMatchObject({ proposals: 2, changed: true });
    expect(await db.select().from(budgetProposals)).toHaveLength(2);

    text = JSON.stringify({ PropostaDeAlteracao: [] });
    expect((await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => text) })).results[0]!.changed).toBe(false);
    expect(await db.select().from(budgetProposals)).toHaveLength(2);

    expect((await syncBudget(db, { legislatures: ["IX"], fetchFn: site(() => text) })).warnings).toEqual(["No IX folder on the Budget dataset page"]);
  });
});

describe("the Budget API", () => {
  const get = (url: string) => app.inject({ method: "GET", url: `/api/v2${url}` });
  beforeEach(async () => {
    await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => JSON.stringify(FILE)) });
  });

  it("lists the years we have", async () => {
    const response = await get("/budget");
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.json().items).toEqual([expect.objectContaining({ year: 2027, proposals: 6, voted: 3, pending: 3, lastVotedOn: "2026-11-19" })]);
  });

  it("counts a proposal the source gives a result for but no vote as voted, so voted matches the results", async () => {
    // As 111C-2 in 2027: "Rejeitado(a) em Comissão" with no vote recorded.
    await db.update(budgetProposals).set({ result: "rejected", status: "Rejeitado(a) em Comissão" }).where(eq(budgetProposals.number, "4C"));
    const [year] = (await get("/budget")).json().items;
    const { results } = (await get("/budget/2027/summary")).json();
    expect(year.voted).toBe(results.approved + results.partially_approved + results.rejected);
  });

  it("lists proposals with their votes, latest vote first, with filters and paging", async () => {
    const all = (await get("/budget/2027/proposals?limit=2")).json();
    expect(all.total).toBe(6);
    expect(all.items.map((p: { number: string }) => p.number)).toEqual(["2C-1", "3C"]);
    const next = (await get(`/budget/2027/proposals?limit=2&cursor=${all.nextCursor}`)).json();
    expect(next.items.map((p: { number: string }) => p.number)).toEqual(["10C", "4C"]);

    const numbers = async (query: string) => (await get(`/budget/2027/proposals?${query}`)).json().items.map((p: { number: string }) => p.number);
    expect(await numbers("party=cds-pp")).toEqual(["10C"]);
    expect(await numbers("result=partially_approved")).toEqual(["2C-1"]);
    expect(await numbers("topic=Habita%C3%A7%C3%A3o")).toEqual(["10C"]);
    expect(await numbers("q=habitacao")).toEqual(["10C"]);
    expect(await numbers("votedFrom=2026-11-19&votedTo=2026-11-19")).toEqual(["2C-1"]);
    expect(await numbers("sort=number")).toEqual(["2C-1", "3C", "4C", "5C", "6C", "10C"]);

    const [first] = all.items;
    expect(first.authors).toEqual({ parties: [{ slug: "livre", acronym: "L", name: "LIVRE" }], deputies: [], label: "L" });
    expect(first.votes[0].parties.at(-1)).toEqual({ party: { slug: "psd", acronym: "PSD", name: "Partido Social Democrata" }, group: "Pedro Coelho(PSD)", deputy: "Pedro Coelho", vote: "against" });
    expect(all.items[1].votes[0]).toMatchObject({ ambiguous: true, parties: [{ party: null, group: "Partido Imaginário", vote: null }] });
  });

  it("shows one proposal, and 404s for unknown ones and years", async () => {
    expect((await get("/budget/2027/proposals/1")).json()).toMatchObject({ number: "10C", sourceUrl: "https://www.parlamento.pt/Cidadania/Paginas/DAOE.aspx" });
    expect((await get("/budget/2026/proposals/1")).statusCode).toBe(404);
    expect((await get("/budget/2027/proposals/99")).statusCode).toBe(404);
    expect((await get("/budget/2025/proposals")).statusCode).toBe(404);
    expect((await get("/budget/2027/proposals?cursor=nope")).json().error.code).toBe("invalid_cursor");
    expect((await get("/budget/2027/proposals?votedFrom=2026-13-01")).statusCode).toBe(400);
  });

  it("sums each party's proposals and its votes on the others'", async () => {
    const summary = (await get("/budget/2027/summary")).json();
    expect(summary).toMatchObject({ proposals: 6, votes: 5, ambiguousVotes: 1, lastVotedOn: "2026-11-19" });
    expect(summary.results).toMatchObject({ approved: 1, partially_approved: 1, rejected: 1, pending: 2, sent_to_plenary: 1 });
    const of = (slug: string) => summary.parties.find((p: { party: { slug: string } }) => p.party.slug === slug);
    expect(of("psd")).toMatchObject({ proposals: 2, results: { approved: 1, pending: 1 } });
    // PSD on others' proposals: favor on 2C-1's first part (its deputy's own line doesn't count), against on the second.
    expect(of("psd").votesOnOthers).toEqual({ favor: 1, against: 1, abstention: 0, absent: 0 });
    // Livre authored 2C-1, so only its vote on 10C counts.
    expect(of("livre")).toMatchObject({ proposals: 3, votesOnOthers: { favor: 1, against: 0, abstention: 0, absent: 0 } });
    expect(summary.topics[0]).toEqual({ topic: "Saúde", proposals: 5 });

    const day = (await get("/budget/2027/summary?votedFrom=2026-11-18&votedTo=2026-11-18")).json();
    expect(day).toMatchObject({ proposals: 2, votes: 2, lastVotedOn: "2026-11-18" });
  });
});

describe("each Budget's own bill", () => {
  const get = (url: string) => app.inject({ method: "GET", url: `/api/v2${url}` });
  const generalidade = {
    id: "v1", date: "2026-10-28", phase: "Votação na generalidade", result: "Aprovado", unanimous: false,
    favor: [{ party: "psd", count: null }, { party: "cds-pp", count: null }], against: [{ party: "chega", count: null }],
    abstention: [{ party: "ps", count: null }], absent: [], named: [],
  };

  it("knows a Budget bill by its title, old and new", () => {
    expect(budgetBillYear("Proposta de Lei", "Orçamento do Estado para 2010.")).toBe(2010);
    expect(budgetBillYear("Proposta de Lei", "Aprova o Orçamento do Estado para 2027")).toBe(2027);
    expect(budgetBillYear("Projeto de Lei", "Orçamento do Estado para 2027")).toBeNull();
    expect(budgetBillYear("Proposta de Lei", "Procede à primeira alteração à Lei (Orçamento do Estado para 2005)")).toBeNull();
  });

  it("comes with its votes on each year, and a year with only a bill is listed too", async () => {
    await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => JSON.stringify(FILE)) });
    await db.insert(initiatives).values({
      id: 377999, legislature: "XVII", type: "Proposta de Lei", number: "110", title: "Orçamento do Estado para 2027",
      status: "in_progress", phase: "Votação na generalidade", phaseDate: "2026-10-28", votes: [generalidade],
    });
    expect(await syncCurrentBudgetBills(db)).toBe(1);
    expect(await syncCurrentBudgetBills(db)).toBe(0); // unchanged: nothing to refresh
    await db.insert(budgetBills).values({ initiativeId: 1, year: 2005, legislature: "IX", number: "146", title: "Orçamento do Estado para 2005.", status: "approved", votes: [] });

    const years = (await get("/budget")).json().items;
    expect(years.map((y: { year: number }) => y.year)).toEqual([2027, 2005]);
    expect(years[0].bills).toEqual([expect.objectContaining({ initiativeId: 377999, number: "110", status: "in_progress", votes: [generalidade] })]);
    expect(years[1]).toMatchObject({ proposals: 0, syncedAt: null, bills: [expect.objectContaining({ legislature: "IX" })] });
    expect((await get("/budget/2027/summary")).json().bills[0].votes[0].phase).toBe("Votação na generalidade");
  });
});

describe("what is still to be voted", () => {
  const get = (url: string) => app.inject({ method: "GET", url: `/api/v2${url}` });
  beforeEach(async () => {
    await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => JSON.stringify(FILE)) });
  });
  const session = (id: string, title: string, days: number, source: "parliament" | "editorial" = "parliament", summary: string | null = null) =>
    db.insert(agendaEvents).values({
      id, source, kind: title.startsWith("Comissão") ? "committee" : "parliament", title, summary, allDay: false,
      startsAt: new Date(Date.now() + days * 86_400_000), until: new Date(Date.now() + days * 86_400_000 + 3_600_000), startDay: "2030-01-01",
      attend: { open: false, how: null, url: null },
    } as typeof agendaEvents.$inferInsert);

  it("lists several results at once, and refuses unknown ones", async () => {
    const list = (await get("/budget/2027/proposals?result=pending,sent_to_plenary&sort=number")).json();
    expect(list.items.map((p: { number: string }) => p.number)).toEqual(["4C", "5C", "6C"]);
    expect((await get("/budget/2027/proposals?result=pending,lost")).statusCode).toBe(400);
  });

  it("gives the coming Budget voting sessions while proposals wait", async () => {
    await session("a", "Comissão de Orçamento, Finanças e Administração Pública", 1);
    await session("b", "Discussão de artigos remetidos a Plenário e normas avocadas", 2);
    await session("c", "Comissão de Saúde", 1);
    await session("d", "Comissão de Orçamento, Finanças e Administração Pública", 20);
    await session("e", "Comissão de Orçamento, Finanças e Administração Pública", -3);
    const { schedule } = (await get("/budget/2027/summary")).json();
    expect(schedule.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
    // A day's summary is about what happened: no schedule.
    expect((await get("/budget/2027/summary?votedFrom=2026-11-18")).json().schedule).toEqual([]);
  });

  it("marks the session with the final overall vote, and the ones already under way", async () => {
    await session("now", "Comissão de Orçamento, Finanças e Administração Pública", -0.01);
    await session("avoc", "Discussão de artigos remetidos a Plenário e normas avocadas", 1, "parliament", "1 - Discussão de artigos remetidos a Plenário e normas avocadas\n2 - Votações");
    await session("end", "Discussão de artigos remetidos a Plenário e normas avocadas", 2, "parliament",
      "3- Encerramento do debate na especialidade do Orçamento do Estado para 2027\n4 - Votações");
    const { schedule } = (await get("/budget/2027/summary")).json();
    expect(schedule.map((e: { id: string; stage: string; started: boolean; endsAt: string | null }) => [e.id, e.stage, e.started, e.endsAt])).toEqual([
      ["now", "committee", true, null],
      ["avoc", "plenary", false, null],
      ["end", "final_vote", false, null],
    ]);
    expect(schedule[0]).not.toHaveProperty("summary");
  });

  it("tells a Budget session's stage from its agenda", () => {
    expect(sessionStage("parliament", "Votação final global da Proposta de Lei n.º 110/XVII")).toBe("final_vote");
    expect(sessionStage("parliament", "Sessão plenária\nDebate na generalidade da Proposta de Lei 110/XVII – Orçamento do Estado para 2027")).toBe("general_vote");
    expect(sessionStage("parliament", "Debate na especialidade do Orçamento do Estado para 2027")).toBe("plenary");
    expect(sessionStage("committee", "Comissão de Orçamento, Finanças e Administração Pública")).toBe("committee");
    expect(sessionStage("parliament", "Sessão plenária")).toBeNull();
  });
});

describe("plain summaries (\"O que muda\")", () => {
  const get = (url: string) => app.inject({ method: "GET", url: `/api/v2${url}` });
  const call = (method: "GET" | "PUT" | "DELETE", url: string, payload?: object, key: string | null = KEY) =>
    app.inject({ method, url: `/api/v2/publish/budget${url}`, payload, headers: key ? { authorization: `Bearer ${key}` } : {} });
  beforeEach(async () => {
    await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => JSON.stringify(FILE)) });
  });

  it("are written with the publish key, shown on the proposal, and survive a sync that replaces the year", async () => {
    const summary = "Alarga a isenção a mais imóveis destinados a alojamento de estudantes.";
    expect((await call("PUT", "/1/summary", { summary }, null)).statusCode).toBe(401);
    expect((await call("PUT", "/99/summary", { summary })).statusCode).toBe(404);
    expect((await call("PUT", "/1/summary", { summary: "curto" })).statusCode).toBe(400);
    expect((await call("PUT", "/1/summary", { summary })).json()).toEqual({ id: 1, summary, automatic: true, changed: true });
    expect((await call("PUT", "/1/summary", { summary })).json().changed).toBe(false);

    expect((await get("/budget/2027/proposals/1")).json().plain).toMatchObject({ summary, automatic: true });
    expect((await get("/budget/2027/proposals/4")).json().plain).toBeNull();

    // The parliament's file changes: the year is replaced, the summary stays.
    await syncBudget(db, { legislatures: ["XVII"], fetchFn: site(() => JSON.stringify({ PropostaDeAlteracao: [...FILE.PropostaDeAlteracao].reverse() })) });
    expect((await get("/budget/2027/proposals/1")).json().plain.summary).toBe(summary);

    expect((await call("DELETE", "/1/summary")).statusCode).toBe(204);
    expect((await get("/budget/2027/proposals/1")).json().plain).toBeNull();
    expect((await call("DELETE", "/1/summary")).statusCode).toBe(404);
  });

  it("lists what still needs one, latest votes first", async () => {
    await call("PUT", "/2/summary", { summary: "Uma frase que chega para o teste.", automatic: false });
    const missing = (await call("GET", "/missing?year=2027&voted=true")).json();
    // 2C-1 has one; 10C and 3C were voted the same day.
    expect(missing.items.map((p: { number: string }) => p.number)).toEqual(["10C", "3C"]);
    expect(missing.items[1]).toMatchObject({ documentUrl: "https://app.parlamento.pt/webutils/docs/doc.pdf?path=3" });
    expect((await call("GET", "/missing?voted=false")).json().total).toBe(3);
    expect((await call("GET", "/missing", undefined, null)).statusCode).toBe(401);
  });
});
