import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articles, articleViews, comments, editorialPosts } from "../src/db/schema.js";
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

const HOUR = 3_600_000;
let n = 0;
const article = (title: string, hoursAgo: number) =>
  insertArticle(db, { title, sourceUri: `r${++n}`, url: `https://example.pt/${n}`, publishedAt: new Date(Date.now() - hoursAgo * HOUR) }, []);
const call = async (method: "GET" | "POST", url: string, payload?: object | string, ip = "10.0.0.1") => {
  const response = await app.inject({ method, url: `/api/v2${url}`, ...(payload !== undefined && { payload }), remoteAddress: ip });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const titles = async (query: string) => (await call("GET", `/articles?${query}`)).body.items.map((a: { title: string }) => a.title);
const reads = (articleId: number, views: number, daysAgo = 0) =>
  db.insert(articleViews).values({ articleId, views, day: sql`(now() at time zone 'Europe/Lisbon')::date - ${daysAgo}::int` });

describe("Importa on blog posts", () => {
  it("keeps one mark per reader and shows the count on posts", async () => {
    await db.insert(editorialPosts).values([
      { slug: "orcamento", title: "Orçamento", kind: "article", body: "texto", authorName: "Ana", status: "published", publishedAt: new Date() },
      { slug: "rascunho", title: "Rascunho", kind: "article", body: "texto", authorName: "Ana", status: "draft" },
    ]);
    expect((await call("POST", "/editorial/orcamento/vote", { value: 1 })).body).toEqual({ importa: 1, mine: 1, up: 1, down: 0 });
    expect((await call("POST", "/editorial/orcamento/vote", { value: 1 })).body).toMatchObject({ importa: 1 });
    expect((await call("POST", "/editorial/orcamento/vote", { value: 1 }, "10.0.0.2")).body).toMatchObject({ importa: 2, mine: 1 });
    expect((await call("POST", "/editorial/orcamento/vote", { value: 0 })).body).toEqual({ importa: 1, mine: 0, up: 1, down: 0 });
    // The old "down" button takes the mark back instead.
    expect((await call("POST", "/editorial/orcamento/vote", { value: -1 }, "10.0.0.2")).body).toMatchObject({ importa: 0, mine: 0 });
    await call("POST", "/editorial/orcamento/vote", { value: 1 });
    expect((await call("POST", "/editorial/rascunho/vote", { value: 1 })).status).toBe(404);
    expect((await call("POST", "/editorial/orcamento/vote", { value: 2 })).status).toBe(400);

    expect((await call("GET", "/editorial/orcamento")).body).toMatchObject({ importa: 1, upvotes: 1, downvotes: 0 });
    expect((await call("GET", "/editorial")).body.items[0]).toMatchObject({ importa: 1, commentCount: 0 });
  });
});

describe("reads of news articles", () => {
  it("counts a read once per reader per day, whatever the beacon sends, and shows views", async () => {
    const a = await article("Lida", 2);
    const beacon = (ip: string) => app.inject({ method: "POST", url: `/api/v2/articles/${a.id}/view`, remoteAddress: ip, headers: { "content-type": "text/plain" }, payload: "x" });
    expect((await beacon("10.0.0.1")).statusCode).toBe(204);
    await beacon("10.0.0.1");
    await beacon("10.0.0.2");
    expect((await call("GET", `/articles/${a.id}`)).body.views).toBe(2);
    expect((await call("POST", "/articles/999999/view")).status).toBe(404);
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, a.id));
    expect((await call("POST", `/articles/${a.id}/view`)).status).toBe(404);
  });

  it("sorts the most read in the last days, with their recent reads", async () => {
    const a = await article("A", 50);
    const b = await article("B", 30);
    await article("Nunca lida", 1);
    await reads(a.id, 3);
    await reads(b.id, 5, 1);
    await reads(a.id, 100, 20);
    const week = (await call("GET", "/articles?sort=views&days=7")).body;
    expect(week.items.map((i: { title: string; recentViews: number; views: number }) => [i.title, i.recentViews, i.views])).toEqual([
      ["B", 5, 5],
      ["A", 3, 103],
    ]);
    expect(week.total).toBe(2);
    expect(await titles("sort=views&days=30")).toEqual(["A", "B"]);
    expect((await call("GET", "/articles")).body.items[0].recentViews).toBeUndefined();
    expect((await call("GET", "/articles?sort=views&days=91")).status).toBe(400);
  });
});

describe("trending", () => {
  it("favours fresh activity over old, and leaves out last week's news", async () => {
    const fresh = await article("Fresca com votos", 2);
    const old = await article("Antiga com mais votos", 60);
    const quiet = await article("Fresca sem nada", 1);
    const ancient = await article("De há 10 dias", 240);
    await db.update(articles).set({ upvotes: 5 }).where(eq(articles.id, fresh.id));
    // (5 + 1) / (2 + 2)^1.5 = 0.75; (100 + 1) / (60 + 2)^1.5 ≈ 0.21; (0 + 1) / (1 + 2)^1.5 ≈ 0.19.
    await db.update(articles).set({ upvotes: 100 }).where(eq(articles.id, old.id));
    await db.update(articles).set({ upvotes: 500 }).where(eq(articles.id, ancient.id));
    expect(await titles("sort=trending")).toEqual(["Fresca com votos", "Antiga com mais votos", "Fresca sem nada"]);

    // Comments and reads count too: 3 comments (6 points) and 40 reads (4) lift the quiet one.
    await db.insert(comments).values([1, 2, 3].map((i) => ({ articleId: quiet.id, body: `c${i}` })));
    await reads(quiet.id, 40);
    expect((await titles("sort=trending"))[0]).toBe("Fresca sem nada");
  });
});
