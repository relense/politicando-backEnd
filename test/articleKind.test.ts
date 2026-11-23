import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articleKind } from "../src/ingestion/kind.js";
import { assignStories } from "../src/stories/assign.js";
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

describe("articleKind", () => {
  // Real URLs from the outlets' listings, November 2026.
  it.each([
    ["https://observador.pt/2026/11/23/30-comboios-suprimidos-devido-a-greve-dos-maquinistas-da-cp/", "news"],
    ["https://observador.pt/liveblogs/hoje-ha-greve-dos-maquinistas-da-cp-e-preve-se-a-supressoes-de-comboios/", "news"],
    ["https://observador.pt/programas/momentos-de-glria/a-matematica-magica-do-chega-para-governar-o-pais/", "podcast"],
    ["https://observador.pt/programas/o-bom-o-mau-e-o-vilao/ficou-mais-uma-vez-provado-nao-se-pode-confiar-no-estado/", "podcast"],
    ["https://observador.pt/newsletters/360/as-empresas-da-filha-de-isaltino/", "newsletter"],
    ["https://observador.pt/opiniao/quem-criou-o-sns/", "opinion"],
    ["https://www.publico.pt/2026/11/23/ciencia/opiniao/defesa-ciencia-futuro-pais-2195890", "opinion"],
    ["https://www.publico.pt/2026/11/23/p3/cronica/assembleias-populares-inutilidade-seculos-historia-2195524", "opinion"],
    ["https://www.publico.pt/2026/11/23/impar/podcast/coracao-bate-tolos-2195913", "podcast"],
    ["https://www.publico.pt/2026/11/23/politica/noticia/orcamento-2195000", "news"],
    ["https://www.dn.pt/opiniao-dn/algum-lhe-pagou-ou-a-fronteira-entre-guerra-hbrida-e-terrorismo", "opinion"],
    ["https://sol.iol.pt/opiniao/noticias/jose-fragata-reforma-da-saude/20261122/6b02d4ee0cf22114c9128738", "opinion"],
    ["https://eco.sapo.pt/opiniao/a-pobreza-e-um-ativo/", "opinion"],
    ["https://expresso.pt/podcasts/a-beleza-das-pequenas-coisas/2026-11-23-x", "podcast"],
    ["https://sicnoticias.pt/programas/eixo-do-mal/2026-11-22-x", "podcast"],
    // A word in the slug isn't a section.
    ["https://www.rtp.pt/noticias/economia/portugal-vai-dar-1-milhao-de-euros-para-programa-energetico_n1780186", "news"],
    ["https://www.jn.pt/nacional/editorial-polemica-na-rtp/123", "news"],
  ] as const)("%s is %s", (url, kind) => {
    expect(articleKind(url)).toBe(kind);
  });

  it("falls back to the page's section, and survives odd URLs", () => {
    expect(articleKind("https://www.dn.pt/2026/x", "Opinião DN")).toBe("opinion");
    expect(articleKind("https://www.dn.pt/2026/x", "Política")).toBe("news");
    expect(articleKind("https://a.pt/Opini%C3%A3o/x")).toBe("opinion");
    expect(articleKind("https://a.pt/%E0%A4%A/x")).toBe("news");
    expect(articleKind("not a url")).toBe("news");
  });
});

describe("articles that aren't news", () => {
  it("never make stories, and are labelled and filterable in /articles", async () => {
    const at = new Date(Date.now() - 3_600_000);
    const fields = { title: "Orçamento do Estado aprovado na generalidade", excerpt: "O Orçamento passou com a abstenção do PS", publishedAt: at };
    const news = await insertArticle(db, { ...fields, sourceUri: "a", url: "https://a.pt/1", source: "a.pt" });
    const opinion = await insertArticle(db, { ...fields, sourceUri: "b", url: "https://b.pt/opiniao/1", source: "b.pt", kind: "opinion" });
    expect(await assignStories(db)).toMatchObject({ assigned: 1, created: 1 });

    const items = (await app.inject({ url: "/api/v2/articles" })).json().items;
    expect(items.map((a: { id: number; kind: string; storyId: number | null }) => [a.id, a.kind, a.storyId !== null])).toEqual([
      [opinion.id, "opinion", false],
      [news.id, "news", true],
    ]);
    expect((await app.inject({ url: "/api/v2/articles?kind=opinion,podcast" })).json().items.map((a: { id: number }) => a.id)).toEqual([opinion.id]);
    expect((await app.inject({ url: "/api/v2/articles?kind=news" })).json().total).toBe(1);
    expect((await app.inject({ url: "/api/v2/articles?kind=gossip" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v2/stories" })).json().items).toHaveLength(1);
  });
});
