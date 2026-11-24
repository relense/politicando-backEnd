import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, comments, users } from "../src/db/schema.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
  loginLimitPerMinute: 1000, registerLimitPerHour: 1000, loginRequired: ["comments", "forum", "votes", "reports"],
});

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url: `/api/v2${url}`, payload, headers: cookie ? { cookie } : {} });

const register = async (username: string, signupFrom?: unknown) => {
  const response = await call("POST", "/auth/register", undefined, { username, password: "palavra-passe", recaptchaToken: "t", signupFrom });
  const session = response.cookies.find((c) => c.name === "politicando_session")!;
  return { id: response.json().user.id as number, cookie: `politicando_session=${session.value}` };
};
const login = (username: string) => call("POST", "/auth/login", undefined, { username, password: "palavra-passe", recaptchaToken: "t" });

const signIn = async (role: "admin" | "moderator") => {
  const email = `${role}@x.pt`;
  await db.insert(admins).values({ email, name: role === "admin" ? "Equipa" : "Mod", role, passwordHash: await hashPassword("palavra-passe-admin") });
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password: "palavra-passe-admin" } });
  const cookie = response.cookies[0]!;
  return `${cookie.name}=${cookie.value}`;
};

describe("admin readers", () => {
  it("lists, filters, sorts and counts readers, for admins only", async () => {
    const ana = await register("ana", "/orcamento/2027/proposta/25391");
    await register("rui", "https://elsewhere.example/x");
    await register("zeca", "//elsewhere.example");
    await db.update(users).set({ email: "ana@exemplo.pt", emailConfirmedAt: new Date() }).where(eq(users.id, ana.id));
    const article = await insertArticle(db);
    await db.insert(comments).values({ articleId: article.id, userId: ana.id, username: "ana", body: "Concordo." });
    expect((await call("POST", `/articles/${article.id}/vote`, ana.cookie, { value: 1 })).statusCode).toBe(200);

    expect((await call("GET", "/admin/readers")).statusCode).toBe(401);
    expect((await call("GET", "/admin/readers", await signIn("moderator"))).statusCode).toBe(403);
    const admin = await signIn("admin");

    const all = (await call("GET", "/admin/readers", admin)).json();
    expect(all.total).toBe(3);
    expect(all.items.map((r: { username: string }) => r.username)).toEqual(["zeca", "rui", "ana"]);
    const first = all.items[2];
    expect(first).toEqual({
      id: ana.id, username: "ana", email: "ana@exemplo.pt", emailConfirmed: true, newsletter: false,
      createdAt: expect.any(String), lastSeenAt: expect.any(String), status: "active", suspendedUntil: null,
      signupFrom: "/orcamento/2027/proposta/25391",
      counts: { comments: 1, forumPosts: 0, importa: 0, follows: 0, saved: 0, predictions: 0, reportsMade: 0, reportsAgainst: 0 },
    });
    expect(JSON.stringify(all)).not.toMatch(/password|hash|token/i);
    // Only a path on the site is kept.
    expect(all.items[0].signupFrom).toBeNull();
    expect(all.items[1].signupFrom).toBeNull();

    const names = async (query: string) => (await call("GET", `/admin/readers?${query}`, admin)).json().items.map((r: { username: string }) => r.username);
    expect(await names("q=EXEMPLO")).toEqual(["ana"]);
    expect(await names("q=ru")).toEqual(["rui"]);
    expect(await names("email=confirmed")).toEqual(["ana"]);
    expect(await names("email=none&sort=oldest")).toEqual(["rui", "zeca"]);
    expect(await names("sort=most_active&limit=1")).toEqual(["ana"]);
    expect(await names("status=banned")).toEqual([]);
    expect(await names("active=7&sort=oldest")).toEqual(["ana", "rui", "zeca"]);

    const page = (await call("GET", "/admin/readers?limit=2", admin)).json();
    expect(page.nextCursor).toBe("2");
    expect((await call("GET", `/admin/readers?limit=2&cursor=${page.nextCursor}`, admin)).json()).toMatchObject({ items: [{ username: "ana" }], nextCursor: null, total: 3 });
    expect((await call("GET", "/admin/readers?cursor=nope", admin)).statusCode).toBe(400);

    const stats = (await call("GET", "/admin/readers/stats", admin)).json();
    expect(stats).toMatchObject({ total: 3, newToday: 3, newThisWeek: 3, active7d: 3, active30d: 3, withEmail: 1, emailConfirmed: 1, suspended: 0, banned: 0 });
    expect(stats.signupsByDay).toHaveLength(30);
    expect(stats.signupsByDay.at(-1)).toEqual({ date: new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" }), count: 3 });
    expect(stats.signupsByDay[0].count).toBe(0);
  });

  it("suspends, bans, removes content and deletes, each audited; a restricted reader gets 403 with why", async () => {
    const ana = await register("ana");
    const article = await insertArticle(db, { title: "Parlamento aprova" });
    const [comment] = await db.insert(comments).values({ articleId: article.id, userId: ana.id, username: "ana", body: "Concordo com a proposta." }).returning();
    await call("POST", `/articles/${article.id}/vote`, ana.cookie, { value: 1 });
    const admin = await signIn("admin");
    const act = (action: string, payload: object) => call("POST", `/admin/readers/${ana.id}/${action}`, admin, payload);
    const vote = () => call("POST", `/articles/${article.id}/vote`, ana.cookie, { value: -1 });

    // A reason is required; a suspension ends in the future.
    expect((await act("suspend", { until: new Date(Date.now() + 86_400_000).toISOString(), reason: "x" })).json().error.code).toBe("invalid_request");
    expect((await act("suspend", { until: new Date(Date.now() - 1000).toISOString(), reason: "insultos" })).statusCode).toBe(400);
    expect((await call("POST", "/admin/readers/999999/ban", admin, { reason: "insultos" })).statusCode).toBe(404);

    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const suspended = (await act("suspend", { until, reason: "insultos" })).json();
    expect(suspended).toMatchObject({ status: "suspended", suspendedUntil: until, moderation: [{ action: "suspended", by: { name: "Equipa" }, reason: "insultos", until }] });
    expect((await vote()).json().error.code).toBe("account_suspended");
    expect((await login("ana")).json().error).toMatchObject({ code: "account_suspended", message: expect.stringContaining(until) });
    // Still logged in to read (and export or delete their data).
    expect((await call("GET", "/me", ana.cookie)).statusCode).toBe(200);

    expect((await act("unsuspend", { reason: "engano" })).json().status).toBe("active");
    expect((await vote()).statusCode).toBe(200);

    expect((await act("ban", { reason: "spam" })).json().status).toBe("banned");
    expect((await vote()).json().error.code).toBe("account_banned");
    expect((await login("ana")).json().error.code).toBe("account_banned");
    expect((await act("unban", { reason: "recurso aceite" })).json().status).toBe("active");

    const removed = (await act("remove-content", { reason: "spam" })).json();
    expect(removed).toMatchObject({ removed: 1, moderation: [{ action: "content_removed" }, { action: "unbanned" }, { action: "banned" }, { action: "unsuspended" }, { action: "suspended" }] });
    expect((await db.select().from(comments).where(eq(comments.id, comment!.id)))[0]!.hiddenAt).not.toBeNull();
    expect((await act("remove-content", { reason: "spam" })).json().removed).toBe(0);

    const activity = (await call("GET", `/admin/readers/${ana.id}/activity`, admin)).json();
    expect(activity.nextCursor).toBeNull();
    expect(activity.items).toContainEqual({
      at: expect.any(String), kind: "comment", text: "Concordo com a proposta.", removed: true,
      target: { type: "article", id: article.id, title: "Parlamento aprova" },
    });
    expect((await call("GET", `/admin/readers/${ana.id}/activity?kind=vote`, admin)).json().items).toEqual([
      { at: expect.any(String), kind: "vote", text: "down", removed: false, target: { type: "article", id: article.id, title: "Parlamento aprova" } },
    ]);
    expect((await call("GET", `/admin/readers/${ana.id}/activity?kind=bogus`, admin)).statusCode).toBe(400);

    // Opening the page is audited too, and the audit filters by reader.
    expect((await call("GET", `/admin/readers/${ana.id}`, admin)).json().moderation).toHaveLength(6);
    const audit = (await call("GET", `/admin/audit?entity=reader&entityId=${ana.id}`, admin)).json().items;
    expect(audit.map((a: { action: string }) => a.action)).toEqual([
      "reader.view", "reader.remove_content", "reader.remove_content", "reader.unban", "reader.ban", "reader.unsuspend", "reader.suspend",
    ]);
    expect(audit[6].after).toEqual({ reason: "insultos", until });

    expect((await call("DELETE", `/admin/readers/${ana.id}`, admin, {})).statusCode).toBe(400);
    expect((await call("DELETE", `/admin/readers/${ana.id}`, admin, { reason: "pedido do próprio" })).statusCode).toBe(204);
    expect((await call("GET", `/admin/readers/${ana.id}`, admin)).statusCode).toBe(404);
    expect((await call("GET", `/admin/audit?entity=reader&entityId=${ana.id}`, admin)).json().items[0]).toMatchObject({
      action: "reader.delete", before: { username: "ana" }, after: { reason: "pedido do próprio" },
    });
  });
});
