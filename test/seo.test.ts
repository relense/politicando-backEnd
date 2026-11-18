import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { editorialPosts, places } from "../src/db/schema.js";
import { PRESIDENTS } from "../src/presidency/presidents.js";
import { createTestDb, resetDb } from "./helpers.js";

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

describe("sitemap", () => {
  it("counts every kind of indexable page", async () => {
    const { body } = await get("/sitemap");
    expect(body.pageSize).toBe(10_000);
    expect(body.kinds.map((k: { kind: string }) => k.kind)).toEqual([
      "party", "deputy", "government-member", "president", "election", "place", "local-official", "initiative", "editorial", "case",
    ]);
    expect(body.kinds.find((k: { kind: string }) => k.kind === "president")).toEqual({ kind: "president", count: PRESIDENTS.length, pages: 1 });
  });

  it("lists published posts and local places only, with last-modified dates", async () => {
    await db.insert(places).values([
      { key: "LOCAL-010000", name: "Aveiro", level: "district", parentKey: null, dicofre: "01" },
      { key: "GLOBAL-990000", name: "Total", level: "global", parentKey: null, dicofre: null },
    ]);
    await db.insert(editorialPosts).values([
      { slug: "publicado", kind: "article", title: "A", body: "x", authorName: "Ana", status: "published", publishedAt: new Date() },
      { slug: "rascunho", kind: "article", title: "B", body: "x", authorName: "Ana" },
    ]);
    expect((await get("/sitemap/place")).body.items).toEqual([{ id: "LOCAL-010000", lastmod: null, level: "district" }]);
    const editorial = (await get("/sitemap/editorial")).body;
    expect(editorial.items.map((i: { id: string }) => i.id)).toEqual(["publicado"]);
    expect(editorial.items[0].lastmod).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect((await get("/sitemap/party")).body.items.length).toBeGreaterThan(5);
    expect((await get("/sitemap/news")).status).toBe(400);
  });
});
