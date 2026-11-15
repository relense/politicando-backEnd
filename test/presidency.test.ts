import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GovernmentSource } from "../src/government/sync.js";
import { loadMatchablePresident } from "../src/ingestion/ingest.js";
import { matchNames } from "../src/matching/matchParties.js";
import { linkStoredArticles } from "../src/parliament/linkNews.js";
import { syncParliament } from "../src/parliament/sync.js";
import { BIOGRAPHY_URL, presidentOn } from "../src/presidency/presidents.js";
import { parseBiography, syncPresidency } from "../src/presidency/sync.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";
import { event, initiative, initiativesFile, loaderFor, vote } from "./parliamentFixtures.js";

const long = (text: string) => `${text} ${"com mais texto para contar como parágrafo. ".repeat(2)}`;
const biographyPage = (name = "António José Seguro") => `<html><body>
  <div class="tab-pane active" data-url="/presidente-da-republica/o-presidente/biografia/">
    <p class="sr-only">Atualizado em: 09 de março de 2026</p>
    <div class="article-content">
      <p>${long(`${name} nasceu em Penamacor.`)}</p>
      <p>${long("Estudou Relações Internacionais.")}<br>${long("Foi deputado e secretário-geral.")}</p>
      <p>${long("Foi eleito em 2026.")}</p>
    </div>
  </div>
  <div class="tab-pane" data-url="/presidente-da-republica/o-presidente/fotografias/">
    <img src="/media/abc/260309-foto.jpg?anchor=center&amp;width=600&amp;height=400" />
  </div>
</body></html>`;

const sourceFor = (html: string | null): GovernmentSource => ({
  get: async (url) =>
    url === BIOGRAPHY_URL && html !== null ? { status: "ok", body: html } : { status: "unavailable", reason: "HTTP 503" },
});

describe("presidents", () => {
  it("knows who was President on a date", () => {
    expect(presidentOn("2025-10-15")?.name).toBe("Marcelo Rebelo de Sousa");
    expect(presidentOn("2026-03-09")?.name).toBe("António José Seguro");
    expect(presidentOn("2010-01-01")?.name).toBe("Aníbal Cavaco Silva");
    expect(presidentOn("1976-07-14")?.name).toBe("António Ramalho Eanes");
    expect(presidentOn("1975-01-01")).toBeNull();
  });

  it("reads the biography, splitting paragraphs joined by <br>, and the first photo", () => {
    const { bio, photoUrl } = parseBiography(biographyPage());
    expect(bio.map((p) => p.split(" com mais")[0])).toEqual([
      "António José Seguro nasceu em Penamacor.",
      "Estudou Relações Internacionais.",
      "Foi deputado e secretário-geral.",
      "Foi eleito em 2026.",
    ]);
    expect(photoUrl).toBe("https://www.presidencia.pt/media/abc/260309-foto.jpg?anchor=center&width=800&height=533");
  });
});

describe("matching the President in the news", () => {
  const seguro = { id: "antonio-jose-seguro", terms: ["António José Seguro"], contextTerms: ["António José Seguro", "Seguro"], context: /Presidente da República|Belém|promulg/i, exclude: /Seguro(?=\s+(?:de|do|da)(?![\p{L}]))/gu };
  const mentions = (title: string, content = "") => matchNames({ title, content }, [seguro])[0]?.mentions ?? 0;

  it("counts \"Seguro\" in stories about the presidency, not insurance", () => {
    expect(mentions("Seguro promulga lei das rendas", "O Presidente da República decidiu.")).toBe(2);
    expect(mentions("Seguro de saúde fica mais caro", "Belém não comentou.")).toBe(0);
    expect(mentions("Seguro insiste nos consensos")).toBe(0);
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

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

describe("syncPresidency", () => {
  it("stores the Presidents with the current one's biography and photo", async () => {
    expect(await syncPresidency(db, sourceFor(biographyPage()))).toEqual({
      president: "António José Seguro", bioParagraphs: 4, photo: true, warnings: [],
    });
  });

  it("keeps the stored biography when the page is down or names someone else", async () => {
    await syncPresidency(db, sourceFor(biographyPage()));
    const down = await syncPresidency(db, sourceFor(null));
    expect(down).toMatchObject({ bioParagraphs: 4, warnings: [expect.stringMatching(/Could not read/)] });
    const other = await syncPresidency(db, sourceFor(biographyPage("Fulano de Tal Novo")));
    expect(other).toMatchObject({ bioParagraphs: 4, warnings: [expect.stringMatching(/add the new President/)] });
  });

  it("isn't matched in the news until stored", async () => {
    expect(await loadMatchablePresident(db)).toEqual([]);
    await syncPresidency(db, sourceFor(biographyPage()));
    expect((await loadMatchablePresident(db))[0]?.id).toBe("antonio-jose-seguro");
  });
});

describe("GET /president", () => {
  it("returns 404 before the first sync", async () => {
    expect((await get("/president")).status).toBe(404);
  });

  it("returns his profile, what he did with the laws in his term, and his news", async () => {
    const vetoed = initiative(10, "Lei vetada", [
      event("Entrada", "2026-03-01"),
      event("Votação final global", "2026-04-01", [vote("v10", "Aprovado")]),
      event("Envio para promulgação", "2026-04-05"),
      event("Veto (Receção)", "2026-04-20"),
    ]);
    const waiting = initiative(11, "Lei em Belém", [event("Entrada", "2026-03-01"), event("Envio para promulgação", "2026-10-01")]);
    await syncParliament(db, loaderFor({ initiatives: [...initiativesFile(), vetoed, waiting] }));
    await syncPresidency(db, sourceFor(biographyPage()));
    const article = await insertArticle(db, { title: "Seguro veta lei do PS", excerpt: "O Presidente da República vetou." });
    expect((await linkStoredArticles(db)).presidentLinks).toBe(1);

    const { status, body } = await get("/president");
    expect(status).toBe(200);
    expect(body.president).toMatchObject({ name: "António José Seguro", termStart: "2026-03-09", photoUrl: expect.any(String) });
    // Initiative 1 was promulgated by Marcelo in 2025, so it isn't counted.
    expect(body.legislation).toMatchObject({ promulgated: 0, vetoed: 1, pending: 1 });
    expect(body.legislation.latestVetoes.map((i: { id: number }) => i.id)).toEqual([10]);
    expect(body.legislation.latestVetoes[0].presidency.by).toBe("António José Seguro");
    expect(body.legislation.pendingNow.map((i: { id: number }) => i.id)).toEqual([11]);
    expect(body.articles.map((a: { id: number }) => a.id)).toEqual([article.id]);
    expect(body.articles[0].president).toEqual({ id: "antonio-jose-seguro", name: "António José Seguro" });
    expect(body.former.map((p: { name: string }) => p.name)).toEqual([
      "Marcelo Rebelo de Sousa", "Aníbal Cavaco Silva", "Jorge Sampaio", "Mário Soares", "António Ramalho Eanes",
    ]);

    const filtered = await get("/articles?president=antonio-jose-seguro");
    expect(filtered.body.items.map((a: { id: number }) => a.id)).toEqual([article.id]);
  });
});
