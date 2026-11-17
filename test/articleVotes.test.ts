import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articles, articleVotes } from "../src/db/schema.js";
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

const vote = async (id: number, value: number, ip = "10.0.0.1") => {
  const response = await app.inject({ method: "POST", url: `/api/v2/articles/${id}/vote`, payload: { value }, remoteAddress: ip });
  return { status: response.statusCode, body: response.json() };
};
const list = async (query: string) => (await app.inject({ method: "GET", url: `/api/v2/articles?${query}` })).json();
const titles = (page: { items: { title: string }[] }) => page.items.map((item) => item.title);
const article = (title: string, publishedAt = new Date()) =>
  insertArticle(db, { title, sourceUri: title, url: `https://example.pt/${encodeURIComponent(title)}`, publishedAt }, []);
/** Sets an article's counts directly, for the sorting tests. */
const setVotes = (id: number, upvotes: number, downvotes: number) => db.update(articles).set({ upvotes, downvotes }).where(sql`id = ${id}`);

describe("POST /articles/:id/vote", () => {
  it("keeps one vote per reader, which they can switch or remove", async () => {
    const { id } = await article("Voto");
    expect(await vote(id, 1)).toEqual({ status: 200, body: { up: 1, down: 0, mine: 1 } });
    expect((await vote(id, 1)).body).toEqual({ up: 1, down: 0, mine: 1 });
    expect((await vote(id, -1)).body).toEqual({ up: 0, down: 1, mine: -1 });
    expect((await vote(id, 1, "10.0.0.2")).body).toEqual({ up: 1, down: 1, mine: 1 });
    expect((await vote(id, 0)).body).toEqual({ up: 1, down: 0, mine: 0 });
    expect((await vote(id, 0)).body).toEqual({ up: 1, down: 0, mine: 0 });

    const detail = (await app.inject({ method: "GET", url: `/api/v2/articles/${id}` })).json();
    expect(detail).toMatchObject({ upvotes: 1, downvotes: 0 });
    expect((await list("")).items[0]).toMatchObject({ upvotes: 1, downvotes: 0 });
  });

  it("never stores the IP", async () => {
    const { id } = await article("Voto");
    await vote(id, 1, "203.0.113.7");
    const [row] = await db.select().from(articleVotes);
    expect(row!.voter).not.toContain("203.0.113.7");
    expect(row!.voter).toHaveLength(16);
  });

  it("keeps exact totals when many readers vote at once", async () => {
    const { id } = await article("Voto");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => vote(id, i % 4 === 0 ? -1 : 1, `10.0.1.${i}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await vote(id, 1, "10.0.2.1")).body).toMatchObject({ up: 16, down: 5 });
  });

  it("rejects unknown articles and other values", async () => {
    const { id } = await article("Voto");
    expect((await vote(999_999, 1)).status).toBe(404);
    expect((await vote(id, 2)).body.error.code).toBe("invalid_request");
    const noBody = await app.inject({ method: "POST", url: `/api/v2/articles/${id}/vote`, payload: {} });
    expect(noBody.statusCode).toBe(400);
  });

  it("limits votes to 30 a minute per IP", async () => {
    const { id } = await article("Voto");
    for (let i = 0; i < 30; i++) expect((await vote(id, i % 2 ? 1 : -1, "10.9.9.9")).status).toBe(200);
    const limited = await vote(id, 1, "10.9.9.9");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
  });
});

describe("sorting and periods", () => {
  it("sorts top by upvotes − downvotes, newest first on ties", async () => {
    const old = await article("Antiga", new Date(Date.now() - 3 * 3600_000));
    const recent = await article("Recente", new Date(Date.now() - 3600_000));
    const best = await article("Melhor", new Date(Date.now() - 5 * 3600_000));
    await setVotes(old.id, 3, 1);
    await setVotes(recent.id, 2, 0);
    await setVotes(best.id, 10, 2);
    await article("Sem votos", new Date(Date.now() - 2 * 3600_000));
    expect(titles(await list("sort=top"))).toEqual(["Melhor", "Recente", "Antiga", "Sem votos"]);
    const first = await list("sort=top&limit=2");
    expect(titles(first)).toEqual(["Melhor", "Recente"]);
    expect(titles(await list(`sort=top&limit=2&cursor=${first.nextCursor}`))).toEqual(["Antiga", "Sem votos"]);
  });

  it("puts many votes on both sides first for controversial, leaving out one-sided ones", async () => {
    const even = await article("Equilibrada");
    const bigEven = await article("Muito votada");
    const lopsided = await article("Desequilibrada");
    const oneSided = await article("Só a favor");
    await setVotes(even.id, 5, 5);
    await setVotes(bigEven.id, 40, 30);
    await setVotes(lopsided.id, 50, 1);
    await setVotes(oneSided.id, 100, 0);
    const page = await list("sort=controversial");
    expect(titles(page)).toEqual(["Muito votada", "Equilibrada", "Desequilibrada"]);
    expect(page.total).toBe(3);
  });

  it("filters by Lisbon day periods, with any sort", async () => {
    const result = await db.execute<{ midnight: Date }>(
      sql`select (date_trunc('day', now() at time zone 'Europe/Lisbon') at time zone 'Europe/Lisbon') as midnight`,
    );
    const today = new Date(result.rows[0]!.midnight).getTime();
    const day = 24 * 3600_000;
    await article("Hoje", new Date(today + 60_000));
    await article("Ontem", new Date(today - 60_000));
    await article("Anteontem", new Date(today - day - 60_000));
    await article("Há 6 dias", new Date(today - 6 * day + 60_000));
    await article("Há 7 dias", new Date(today - 6 * day - 60_000));
    await article("Há 29 dias", new Date(today - 29 * day + 60_000));
    await article("Há 31 dias", new Date(today - 30 * day - 60_000));

    expect(titles(await list("period=today"))).toEqual(["Hoje"]);
    expect(titles(await list("period=yesterday"))).toEqual(["Ontem"]);
    expect(titles(await list("period=week"))).toEqual(["Hoje", "Ontem", "Anteontem", "Há 6 dias"]);
    expect((await list("period=month")).total).toBe(6);
    expect((await list("period=week&sort=top")).total).toBe(4);
    expect((await list("period=week&sort=comments")).total).toBe(0);
    const bad = await app.inject({ method: "GET", url: "/api/v2/articles?period=year" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_request");
  });
});
