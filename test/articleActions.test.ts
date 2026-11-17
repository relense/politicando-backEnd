import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins } from "../src/db/schema.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000, loginLimitPerMinute: 1000,
});

beforeEach(async () => {
  await resetDb(db);
  await db.insert(admins).values({ email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash: await hashPassword("correct horse battery") });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = async (method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const titles = async (query: string) => (await call("GET", `/articles?${query}`)).body.items.map((a: { title: string }) => a.title);
const modCookie = async () => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email: "mod@example.pt", password: "correct horse battery" } });
  return { cookie: `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}` };
};
let n = 0;
const article = (title: string, source = "publico.pt", partySlugs: string[] = []) =>
  insertArticle(db, { title, source, sourceUri: `u${++n}`, url: `https://example.pt/${n}`, publishedAt: new Date(Date.UTC(2026, 9, 1, n)) }, partySlugs);

describe("reader filters on /articles", () => {
  it("fetches saved articles by id and leaves hidden ones out", async () => {
    const a = await article("A");
    const b = await article("B");
    const c = await article("C");
    expect(await titles(`ids=${a.id},${c.id}`)).toEqual(["C", "A"]);
    expect(await titles(`exclude=${b.id}`)).toEqual(["C", "A"]);
    expect(await titles(`ids=${a.id},${b.id}&exclude=${b.id}`)).toEqual(["A"]);
    expect((await call("GET", "/articles?ids=abc")).status).toBe(400);
    expect((await call("GET", `/articles?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(",")}`)).status).toBe(400);
  });

  it("shows fewer from muted outlets and parties", async () => {
    await article("Público sobre o PS", "publico.pt", ["ps"]);
    await article("Expresso sobre o PSD", "expresso.pt", ["psd"]);
    await article("Expresso sobre PS e PSD", "expresso.pt", ["ps", "psd"]);
    await article("Expresso sem partidos", "expresso.pt");
    expect(await titles("excludeSource=publico.pt")).toEqual(["Expresso sem partidos", "Expresso sobre PS e PSD", "Expresso sobre o PSD"]);
    expect(await titles("excludeParty=ps,nao-existe")).toEqual(["Expresso sem partidos", "Expresso sobre o PSD"]);
    expect(await titles("excludeParty=psd&excludeSource=publico.pt")).toEqual(["Expresso sem partidos"]);
  });
});

describe("reporting and hiding news articles", () => {
  it("takes article reports with news reasons only", async () => {
    const a = await article("A");
    expect((await call("POST", "/reports", { kind: "article", id: a.id, reason: "wrong_tags", details: "Não fala do PS" })).status).toBe(202);
    expect((await call("POST", "/reports", { kind: "article", id: a.id, reason: "insult" })).status).toBe(400);
    expect((await call("POST", "/reports", { kind: "comment", id: 1, reason: "duplicate" })).status).toBe(400);
    expect((await call("POST", "/reports", { kind: "article", id: 999_999, reason: "broken_link" })).status).toBe(404);

    const queue = await call("GET", "/admin/reports", undefined, await modCookie());
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        kind: "article", targetId: a.id, reports: 1, reasons: ["wrong_tags"], details: ["Não fala do PS"],
        target: expect.objectContaining({ articleId: a.id, hidden: false, text: expect.stringContaining("A") }),
      }),
    ]);
  });

  it("hides an article everywhere when a moderator resolves its report by hiding it, and shows it again", async () => {
    const a = await article("Duplicada", "publico.pt", ["ps"]);
    await article("Original", "publico.pt", ["ps"]);
    await call("POST", "/reports", { kind: "article", id: a.id, reason: "duplicate" });
    const mod = await modCookie();
    expect((await call("POST", "/admin/reports/resolve", { kind: "article", targetId: a.id, action: "hide" }, mod)).body).toEqual({ resolved: 1 });

    expect(await titles("")).toEqual(["Original"]);
    expect((await call("GET", "/articles")).body.total).toBe(1);
    expect((await call("GET", `/articles/${a.id}`)).status).toBe(404);
    expect((await call("POST", `/articles/${a.id}/vote`, { value: 1 })).status).toBe(404);
    expect((await call("GET", `/articles/${a.id}/comments`)).status).toBe(404);
    expect((await call("POST", "/reports", { kind: "article", id: a.id, reason: "duplicate" })).status).toBe(404);

    expect((await call("POST", `/admin/articles/${a.id}/unhide`, undefined, mod)).status).toBe(204);
    expect(await titles("")).toEqual(["Original", "Duplicada"]);
    expect((await call("POST", `/admin/articles/${a.id}/hide`, undefined, mod)).status).toBe(204);
    expect((await call("GET", `/articles/${a.id}`)).status).toBe(404);
    expect((await call("POST", "/admin/articles/999999/hide", undefined, mod)).status).toBe(404);
    expect((await call("POST", `/admin/articles/${a.id}/hide`)).status).toBe(401);
  });
});
