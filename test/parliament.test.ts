import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articleDeputies, articleInitiatives, deputies } from "../src/db/schema.js";
import { linkStoredArticles } from "../src/parliament/linkNews.js";
import { SEATS } from "../src/parliament/seatMap.js";
import { syncParliament } from "../src/parliament/sync.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";
import { chamber, initiative, loaderFor } from "./parliamentFixtures.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

beforeEach(async () => {
  await resetDb(db);
  await syncParliament(db, loaderFor());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};

describe("syncParliament", () => {
  it("stores deputies and initiatives without warnings when the map fits", async () => {
    const stats = await syncParliament(db, loaderFor());
    expect(stats).toMatchObject({ deputies: 231, activeDeputies: 230, initiatives: 5, seatsAssigned: 0, warnings: [] });
  });

  it("is safe to re-run and marks deputies who disappear as not sitting", async () => {
    const file = chamber();
    file.Deputados = file.Deputados.filter((d) => d.DepCadId !== 817);
    file.Deputados.push({ ...file.Deputados.at(-1)!, DepCadId: 999_999, DepNomeParlamentar: "Nova PCP", DepGP: [{ gpSigla: "PCP", gpDtInicio: "2026-01-01", gpDtFim: null }] });
    await syncParliament(db, loaderFor({ deputies: file }));
    const [gone] = await db.select().from(deputies).where(eq(deputies.id, 817));
    expect(gone?.active).toBe(false);
  });

  it("warns when the chamber no longer fits the seat map", async () => {
    const file = chamber();
    const ps = file.Deputados.find((d) => d.DepGP[0]!.gpSigla === "PS" && d.DepCadId >= 100_000)!;
    ps.DepGP = [{ gpSigla: "CH", gpDtInicio: "2025-06-03", gpDtFim: null }];
    const stats = await syncParliament(db, loaderFor({ deputies: file }));
    expect(stats.warnings).toEqual([
      "Seat map has 58 seats for PS, but 57 deputies sit for it",
      "Seat map has 60 seats for CH, but 61 deputies sit for it",
    ]);
  });

  it("refuses a file that would empty the chamber", async () => {
    await expect(syncParliament(db, loaderFor({ deputies: { Deputados: [] } }))).rejects.toThrow(/refusing/);
    expect((await db.select().from(deputies)).filter((d) => d.active)).toHaveLength(230);
  });

  it("stores seats only when they are valid", async () => {
    const psSeat = SEATS.find(([, group]) => group === "PS")![0];
    await syncParliament(db, loaderFor(), { 7341: psSeat });
    const { body } = await get("/parliament");
    expect(body.deputies.find((d: { id: number }) => d.id === 7341).seat).toBe(psSeat);
    expect(body.seatMap.seats.find((s: { number: number }) => s.number === psSeat).deputyId).toBe(7341);
  });
});

describe("GET /parliament", () => {
  it("returns the seat map, groups left to right, sitting deputies and counts", async () => {
    const { status, body } = await get("/parliament");
    expect(status).toBe(200);
    expect(body.legislature).toBe("XVII");
    expect(body.seatMap.seats).toHaveLength(230);
    expect(body.seatMap.seats[0]).toEqual({
      number: 1, group: expect.any(String), party: expect.any(String), x: expect.any(Number), y: expect.any(Number), deputyId: null,
    });
    expect(body.groups.at(0).group).toBe("PS");
    expect(body.groups.at(-1)).toEqual({ group: "CH", party: { slug: "chega", acronym: "CH", name: "CHEGA" }, seats: 60 });
    expect(body.deputies).toHaveLength(230);
    expect(body.deputies.find((d: { id: number }) => d.id === 7341)).toEqual({
      id: 7341, name: "Francisco César", group: "PS", party: "ps", constituency: "Lisboa", seat: null,
      parliamentRole: null, photoUrl: "https://app.parlamento.pt/webutils/getimage.aspx?id=7341&type=deputado",
    });
    expect(body.initiativeCounts).toEqual({ approved: 1, rejected: 1, in_progress: 2, withdrawn: 1 });
  });
});

describe("GET /deputies/:id", () => {
  it("returns the profile, their initiatives and news", async () => {
    const article = await insertArticle(db, { title: "Francisco César no PS" });
    await db.insert(articleDeputies).values({ articleId: article.id, deputyId: 7341, mentionCount: 2 });

    const { status, body } = await get("/deputies/7341");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: "Francisco César",
      fullName: "Francisco César Completo",
      partyInfo: { slug: "ps", acronym: "PS", name: "Partido Socialista" },
      active: true,
      birthDate: "1978-11-11",
      pastLegislatures: ["XVI", "XV"],
      initiatives: { total: 2, approved: 1 },
    });
    expect(body.initiatives.latest.map((i: { id: number }) => i.id)).toEqual([1, 3]);
    expect(body.articles.map((a: { id: number }) => a.id)).toEqual([article.id]);
    expect(body.articles[0].deputies).toEqual([{ id: 7341, name: "Francisco César", party: "ps" }]);
  });

  it("returns 404 for an unknown deputy and 400 for a bad id", async () => {
    expect((await get("/deputies/1")).status).toBe(404);
    expect((await get("/deputies/abc")).status).toBe(400);
  });
});

describe("GET /deputies/:id/votes", () => {
  it("lists their votes with how each is known, only while they sat", async () => {
    const { status, body } = await get("/deputies/7341/votes");
    expect(status).toBe(200);
    // v2: PS abstained as a group (the 3 for are not all named). v1, v4: no breakdown.
    expect(body.items.map((i: { vote: { id: string }; position: string | null; basis: string }) => [i.vote.id, i.position, i.basis])).toEqual([
      ["v2", null, "unknown"],
      ["v4", "favor", "unanimous"],
      ["v3", null, "unknown"],
      ["v1", null, "unknown"],
    ]);
    expect(body.summary).toEqual({ favor: 1, against: 0, abstention: 0, absent: 0, unknown: 3, brokeRanks: 0 });
  });

  it("skips votes from before a deputy sat, and pages", async () => {
    const pcp = await get("/deputies/817/votes?limit=1");
    expect(pcp.body.items).toHaveLength(1);
    const next = await get(`/deputies/817/votes?limit=1&cursor=${pcp.body.nextCursor}`);
    expect(next.body.items[0].vote.id).not.toBe(pcp.body.items[0].vote.id);
    // Ana Saída sat until 2025-09-01; all fixture votes are later.
    expect((await get("/deputies/9001/votes")).body.items).toEqual([]);
    expect((await get("/deputies/1/votes")).status).toBe(404);
    expect((await get("/deputies/817/votes?cursor=nope")).status).toBe(400);
  });
});

describe("GET /initiatives", () => {
  it("lists newest activity first with authors and the last vote", async () => {
    const { body } = await get("/initiatives");
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([5, 1, 3, 2, 4]);
    expect(body.items[1]).toMatchObject({
      status: "approved",
      publishedAt: "2025-10-20",
      authors: {
        parties: [{ slug: "ps", acronym: "PS", name: "Partido Socialista" }],
        deputies: [{ id: 7341, name: "Francisco César", party: "ps" }],
        other: null,
      },
      lastVote: { date: "2025-10-01", phase: "Votação final global", result: "Aprovado", unanimous: false },
    });
    expect(body.items[0]).toMatchObject({ authors: { parties: [], deputies: [], other: "Governo" }, lastVote: null });
  });

  it("filters by status, party, deputy and type", async () => {
    const ids = async (query: string) => (await get(`/initiatives?${query}`)).body.items.map((i: { id: number }) => i.id);
    expect(await ids("status=in_progress")).toEqual([5, 3]);
    expect(await ids("party=livre")).toEqual([3]);
    expect(await ids("deputy=817")).toEqual([2]);
    expect(await ids("type=Proposta%20de%20Lei")).toEqual([]);
    expect((await get("/initiatives?party=nope")).status).toBe(404);
    expect((await get("/initiatives?deputy=1")).status).toBe(404);
    expect((await get("/initiatives?status=maybe")).status).toBe(400);
  });

  it("pages with a cursor, including same-day ties", async () => {
    await syncParliament(db, loaderFor({
      initiatives: [1, 2, 3].map((n) => initiative(10 + n, `Mesmo dia ${n}`, [{ Fase: "Entrada", DataFase: "2025-01-01", Votacao: null }])),
    }));
    const first = await get("/initiatives?limit=2&type=Projeto%20de%20Lei&status=in_progress");
    const second = await get(`/initiatives?limit=2&type=Projeto%20de%20Lei&status=in_progress&cursor=${first.body.nextCursor}`);
    const all = [...first.body.items, ...second.body.items].map((i: { id: number }) => i.id);
    // 11-13 share a date, so the id breaks the tie.
    expect(all).toEqual([5, 3, 13, 12]);
    expect((await get("/initiatives?cursor=bad")).status).toBe(400);
  });
});

describe("GET /initiatives/:id", () => {
  it("returns every vote with party positions and named exceptions", async () => {
    const { status, body } = await get("/initiatives/1");
    expect(status).toBe(200);
    expect(body.votes).toHaveLength(2);
    expect(body.votes[1]).toEqual({
      id: "v2", date: "2025-10-01", phase: "Votação final global", result: "Aprovado", unanimous: false,
      favor: [{ party: "psd", count: null }, { party: "ps", count: 3 }],
      against: [{ party: "chega", count: null }],
      abstention: [{ party: "ps", count: null }, { party: "pcp", count: null }],
      absent: [],
      named: [{ name: "Pedro Vaz", group: "PS", position: "favor" }],
    });
    expect((await get("/initiatives/999")).status).toBe(404);
  });
});

describe("news and deputies", () => {
  it("filters articles by deputy", async () => {
    const a = await insertArticle(db, { sourceUri: "a", title: "Francisco César" });
    await insertArticle(db, { sourceUri: "b", title: "Outro" });
    await db.insert(articleDeputies).values({ articleId: a.id, deputyId: 7341, mentionCount: 1 });
    const { body } = await get("/articles?deputy=7341");
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([a.id]);
    expect((await get("/articles?deputy=1")).status).toBe(404);
  });

  it("links stored articles from headline and excerpt, keeping manual links", async () => {
    const a = await insertArticle(db, { sourceUri: "a", title: "Francisco César responde", excerpt: "E Alfredo Maia também." });
    const b = await insertArticle(db, { sourceUri: "b", title: "Sem deputados", excerpt: "Nada." });
    await db.insert(articleDeputies).values({ articleId: b.id, deputyId: 817, mentionCount: 1, linkedBy: "manual" });

    expect(await linkStoredArticles(db)).toEqual({ scanned: 2, deputyLinks: 2, initiativeLinks: 0 });
    const links = await db.select().from(articleDeputies);
    expect(links.map((l) => [l.articleId, l.deputyId, l.linkedBy]).sort()).toEqual(
      [[a.id, 7341, "auto"], [a.id, 817, "auto"], [b.id, 817, "manual"]].sort(),
    );
    // Re-running adds nothing new, and --replace recomputes without duplicating.
    expect(await linkStoredArticles(db)).toMatchObject({ deputyLinks: 0 });
    await linkStoredArticles(db, { replace: true });
    expect(await db.select().from(articleDeputies)).toHaveLength(3);
  });

  it("by default keeps automatic links it wouldn't find itself, and replaces them on request", async () => {
    const a = await insertArticle(db, { sourceUri: "a", title: "Sem nomes", excerpt: "Nada." });
    await db.insert(articleDeputies).values({ articleId: a.id, deputyId: 7341, mentionCount: 1 });
    await linkStoredArticles(db);
    expect(await db.select().from(articleDeputies)).toHaveLength(1);
    await linkStoredArticles(db, { replace: true });
    expect(await db.select().from(articleDeputies)).toHaveLength(0);
  });
});

describe("news and initiatives", () => {
  const budget = () =>
    initiative(377352, "Orçamento do Estado para 2027", [{ Fase: "Entrada", DataFase: "2026-10-10", Votacao: null }], {
      other: "Governo",
    });

  it("links stored articles to initiatives and reports coverage", async () => {
    // Rarity needs a realistic number of titles to compare against.
    const others = Array.from({ length: 300 }, (_, i) =>
      initiative(500_000 + i, `Recomenda ao Governo medidas para o setor ${i}`, [{ Fase: "Entrada", DataFase: "2026-10-01", Votacao: null }]),
    );
    await syncParliament(db, loaderFor({ initiatives: [budget(), ...others] }));
    const a = await insertArticle(db, {
      sourceUri: "a", source: "publico.pt", title: "OE2027: Chega apresenta 22 propostas",
      excerpt: "O partido entregou propostas de alteração.", publishedAt: new Date("2026-11-10T10:00:00Z"),
    });
    await insertArticle(db, {
      sourceUri: "b", source: "expresso.pt", title: "PS viabiliza Orçamento do Estado",
      excerpt: "Abstenção na votação do orçamento.", publishedAt: new Date("2026-11-12T10:00:00Z"),
    });
    await insertArticle(db, { sourceUri: "c", title: "Futebol", excerpt: "Jogo.", publishedAt: new Date("2026-11-12T10:00:00Z") });

    expect(await linkStoredArticles(db)).toMatchObject({ initiativeLinks: 2 });
    const detail = await get("/initiatives/377352");
    expect(detail.body.coverage).toEqual({ articles: 2, sources: 2, lastAt: "2026-11-12T10:00:00.000Z" });
    expect(detail.body.articles).toHaveLength(2);

    const { body } = await get("/articles?initiative=377352");
    expect(body.items.map((i: { id: number }) => i.id)).toContain(a.id);
    expect(body.items[0].initiatives).toEqual([
      { id: 377352, type: "Projeto de Lei", number: "352", title: "Orçamento do Estado para 2027" },
    ]);
    expect((await get("/articles?initiative=999")).status).toBe(404);
  });

  it("filters initiatives by coverage", async () => {
    const a = await insertArticle(db, { sourceUri: "a" });
    await db.insert(articleInitiatives).values({ articleId: a.id, initiativeId: 2, score: 20 });
    const ids = async (q: string) => (await get(`/initiatives?${q}`)).body.items.map((i: { id: number }) => i.id);
    expect(await ids("coverage=some")).toEqual([2]);
    expect(await ids("coverage=none")).toEqual([5, 1, 3, 4]);
    const [item] = (await get("/initiatives?coverage=some")).body.items;
    expect(item.coverage).toEqual({ articles: 1, sources: 1, lastAt: "2026-10-01T10:00:00.000Z" });
  });
});
