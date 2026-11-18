import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { deputies, electionCandidates, elections, governmentMembers, localOfficials, places } from "../src/db/schema.js";
import { matchNames } from "../src/matching/matchParties.js";
import { linkStoredArticles } from "../src/parliament/linkNews.js";
import { loadMatchableLocalOfficials, localOfficialId, shortName, syncLocalOfficials } from "../src/places/localOfficials.js";
import { linksOf, mergeLinks, syncWikidataLinks } from "../src/people/wikidata.js";
import { changedPages, pingIndexNow } from "../src/seo/indexNow.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000 });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};

/** Lisboa with its mayor, elected in the 2025 autárquicas, who also ran in the 2024 legislativas. */
const lisbon = async () => {
  await db.insert(places).values([
    { key: "LOCAL-110000", name: "Lisboa", level: "district", parentKey: null, dicofre: "11" },
    { key: "LOCAL-110600", name: "Lisboa", level: "municipality", parentKey: "LOCAL-110000", dicofre: "1106" },
  ]);
  await db.insert(elections).values([
    { id: "autarquicas-2025", type: "autarquicas", name: "Autárquicas 2025", date: "2025-10-12", organs: ["CM"], sourceUrl: "https://example.org" },
    { id: "legislativas-2024", type: "legislativas", name: "Legislativas 2024", date: "2024-03-10", organs: ["AR"], sourceUrl: "https://example.org" },
  ]);
  await db.insert(electionCandidates).values([
    { electionId: "autarquicas-2025", placeKey: "LOCAL-110600", list: "PPD/PSD.CDS-PP", kind: "effective", position: 1, name: "Carlos Manuel Félix Moedas", elected: true },
    { electionId: "autarquicas-2025", placeKey: "LOCAL-110600", list: "PS", kind: "effective", position: 1, name: "Alexandra Leitão", elected: false },
    { electionId: "legislativas-2024", placeKey: "LOCAL-110000", list: "PPD/PSD.CDS-PP", kind: "effective", position: 7, name: "CARLOS MANUEL FÉLIX MOEDAS", elected: true },
  ]);
  return syncLocalOfficials(db);
};

describe("local officials", () => {
  it("names them as the news does, with readable ids", () => {
    expect(shortName("Carlos Manuel Félix Moedas")).toBe("Carlos Moedas");
    expect(shortName("Isaltino Afonso Morais")).toBe("Isaltino Morais");
    expect(shortName("Ana da Silva")).toBe("Ana Silva");
    expect(localOfficialId("Bárbara Pereira Torres de Medeiros", "Vila do Porto")).toBe("barbara-medeiros-vila-do-porto");
  });

  it("keeps a page per mayor, with their term, list, other roles and news", async () => {
    expect(await lisbon()).toEqual({ officials: 1 });
    expect(await syncLocalOfficials(db)).toEqual({ officials: 1 });
    const [mayor] = await db.select().from(localOfficials);
    expect(mayor).toMatchObject({ id: "carlos-moedas-lisboa", termStart: "2025-10-12", termEnd: "2029-10-12", current: true });

    const article = await insertArticle(db, {
      title: "Carlos Moedas apresenta orçamento", excerpt: "O presidente da Câmara de Lisboa quer mais habitação.",
      source: "x.pt", sourceUri: "a1", url: "https://x.pt/1", publishedAt: new Date(),
    });
    await linkStoredArticles(db);

    const page = await get("/local-officials/carlos-moedas-lisboa");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      name: "Carlos Manuel Félix Moedas", shortName: "Carlos Moedas", role: "mayor", title: "Presidente da Câmara Municipal de Lisboa",
      place: { key: "LOCAL-110600" }, district: { key: "LOCAL-110000" }, parties: ["psd", "cds-pp"], election: "autarquicas-2025",
      term: { start: "2025-10-12", end: "2029-10-12" }, current: true,
      otherRoles: [{ kind: "candidate", title: "Candidatura às Legislativas 2024", elected: true, link: "/elections/legislativas-2024/candidates" }],
    });
    expect(page.body.articles.map((a: { id: number }) => a.id)).toEqual([article.id]);
    expect((await get("/local-officials/nobody-nowhere")).status).toBe(404);

    expect((await get(`/articles/${article.id}`)).body.people).toEqual([
      { kind: "local", id: "carlos-moedas-lisboa", name: "Carlos Manuel Félix Moedas" },
    ]);
    expect((await get("/places/LOCAL-110600")).body.mayor).toMatchObject({ id: "carlos-moedas-lisboa" });
    expect((await get("/sitemap/local-official")).body.items).toEqual([{ id: "carlos-moedas-lisboa", lastmod: expect.any(String) }]);
  });

  it("links the short name only next to their municipality and local government", async () => {
    await lisbon();
    const people = await loadMatchableLocalOfficials(db);
    const match = (title: string, content = "") => matchNames({ title, content }, people).map((m) => m.id);
    expect(match("Carlos Manuel Félix Moedas visita escola")).toEqual(["carlos-moedas-lisboa"]);
    expect(match("Carlos Moedas critica Governo", "O autarca de Lisboa falou ontem.")).toEqual(["carlos-moedas-lisboa"]);
    expect(match("Carlos Moedas vence torneio de xadrez", "O jogador de Braga ganhou.")).toEqual([]);
  });
});

describe("people on news", () => {
  it("lists deputies, the Government and mayors once each, most mentioned first", async () => {
    await lisbon();
    await db.insert(deputies).values({ id: 1, name: "Ana Deputada", fullName: "Ana Maria Deputada", constituency: "Lisboa", situation: "Efetivo", active: true, gender: "F" });
    await db.insert(governmentMembers).values([
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Rui Ministro" },
      { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Ana Deputada", deputyId: 1 },
    ]);
    const article = await insertArticle(db, {
      title: "Ana Deputada e Rui Ministro discutem", excerpt: "Ana Deputada respondeu a Rui Ministro e a Carlos Manuel Félix Moedas.",
      source: "x.pt", sourceUri: "a2", url: "https://x.pt/2", publishedAt: new Date(),
    }, []);
    await linkStoredArticles(db);
    const { people } = (await get(`/articles/${article.id}`)).body;
    expect(people.map((p: { kind: string; id: string }) => `${p.kind}:${p.id}`)).toEqual(["deputy:1", "government:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "local:carlos-moedas-lisboa"]);
  });
});

describe("deputies' gender and official links", () => {
  it("builds links from Wikidata, in a fixed order, and merges them after the portal's", () => {
    const links = linksOf({
      item: { value: "http://www.wikidata.org/entity/Q1" }, website: { value: "https://exemplo.pt" }, x: { value: "exemplo" },
      instagram: { value: "bad handle!" }, facebook: { value: "Exemplo-123" }, wikipedia: { value: "https://pt.wikipedia.org/wiki/Exemplo" },
    });
    expect(links).toEqual([
      { network: "Website", url: "https://exemplo.pt" },
      { network: "Wikipedia", url: "https://pt.wikipedia.org/wiki/Exemplo" },
      { network: "X", url: "https://x.com/exemplo" },
      { network: "Facebook", url: "https://www.facebook.com/Exemplo-123" },
      { network: "Wikidata", url: "https://www.wikidata.org/wiki/Q1" },
    ]);
    expect(mergeLinks([{ network: "X", url: "https://x.com/own" }], links).map((l) => l.url)).toEqual([
      "https://x.com/own", "https://exemplo.pt", "https://pt.wikipedia.org/wiki/Exemplo", "https://www.facebook.com/Exemplo-123", "https://www.wikidata.org/wiki/Q1",
    ]);
  });

  it("stores links by the parliament's ID, and for the Government only by a unique name", async () => {
    await db.insert(deputies).values({ id: 1, name: "Ana Deputada", fullName: "Ana Maria Deputada", constituency: "Lisboa", situation: "Efetivo", active: true, gender: "F" });
    await db.insert(governmentMembers).values([
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Rui Ministro", links: [{ network: "X", url: "https://x.com/rui" }] },
      { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Nome Repetido" },
    ]);
    const answers = [
      [{ id: { value: "1" }, item: { value: "http://www.wikidata.org/entity/Q1" }, x: { value: "ana" } }],
      [
        { name: { value: "Rui Ministro" }, item: { value: "http://www.wikidata.org/entity/Q2" }, website: { value: "https://rui.pt" } },
        { name: { value: "Nome Repetido" }, item: { value: "http://www.wikidata.org/entity/Q3" } },
        { name: { value: "Nome Repetido" }, item: { value: "http://www.wikidata.org/entity/Q4" } },
      ],
    ];
    const fakeFetch = (async () => new Response(JSON.stringify({ results: { bindings: answers.shift() } }))) as unknown as typeof fetch;
    expect(await syncWikidataLinks(db, fakeFetch)).toEqual({ deputies: 1, governmentMembers: 1 });

    const deputy = (await get("/deputies/1")).body;
    expect(deputy.gender).toBe("F");
    expect(deputy.links).toEqual([{ network: "X", url: "https://x.com/ana" }, { network: "Wikidata", url: "https://www.wikidata.org/wiki/Q1" }]);
    const member = await get("/government/members/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(member.body, JSON.stringify(member.body)).toHaveProperty("links");
    expect(member.body.links).toEqual([
      { network: "X", url: "https://x.com/rui" },
      { network: "Website", url: "https://rui.pt" },
      { network: "Wikidata", url: "https://www.wikidata.org/wiki/Q2" },
    ]);
    expect((await db.select().from(governmentMembers).where(eq(governmentMembers.id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")))[0]!.wikidataLinks).toEqual([]);
  });
});

describe("IndexNow", () => {
  it("announces new news, blog posts and local officials, and never throws", async () => {
    const before = new Date(Date.now() - 1000);
    await lisbon();
    const article = await insertArticle(db, { title: "Notícia", source: "x.pt", sourceUri: "a3", url: "https://x.pt/3", publishedAt: new Date() });
    const paths = await changedPages(db, before);
    expect(paths.sort()).toEqual([`/article/${article.id}`, "/autarcas/carlos-moedas-lisboa"].sort());
    expect(await changedPages(db, new Date(Date.now() + 60_000))).toEqual([]);

    let sent: { url: string; body: unknown } | null = null;
    const okFetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    expect(await pingIndexNow({ key: "abcdef123456", siteUrl: "https://www.politicando.pt", paths: ["/article/1", "/article/1"], fetchFn: okFetch }))
      .toEqual({ submitted: 1, status: 202 });
    expect(sent).toEqual({
      url: "https://api.indexnow.org/indexnow",
      body: { host: "www.politicando.pt", key: "abcdef123456", keyLocation: "https://www.politicando.pt/abcdef123456.txt", urlList: ["https://www.politicando.pt/article/1"] },
    });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await pingIndexNow({ key: "abcdef123456", siteUrl: "https://www.politicando.pt", paths: ["/x"], fetchFn: failing }))
      .toEqual({ submitted: 0, status: null, error: "offline" });
  });
});
