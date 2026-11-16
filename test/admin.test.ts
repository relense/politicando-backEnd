import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, comments } from "../src/db/schema.js";
import { createRecaptchaVerifier } from "../src/modules/comments/recaptcha.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: ["http://localhost:3000"], verifyRecaptcha: async () => true, loginLimitPerMinute: 1000 });

const PASSWORD = "correct horse battery";

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const addAdmin = async (email: string, role: "author" | "moderator" | "admin") => {
  const [row] = await db.insert(admins).values({ email, name: email.split("@")[0]!, role, passwordHash: await hashPassword(PASSWORD) }).returning();
  return row!;
};

const login = async (email: string, password = PASSWORD) => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password } });
  const cookie = response.cookies.find((c) => c.name === "politicando_admin");
  return { response, cookie: cookie ? `politicando_admin=${cookie.value}` : undefined, raw: cookie };
};

const call = async (method: "GET" | "POST" | "PATCH", url: string, cookie?: string, payload?: object) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers: cookie ? { cookie } : {}, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(await hashPassword(PASSWORD));
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });
});

describe("signing in", () => {
  it("sets an httpOnly, strict, admin-scoped cookie and knows who you are", async () => {
    await addAdmin("ana@example.pt", "admin");
    const { response, cookie, raw } = await login("ANA@example.pt");
    expect(response.statusCode).toBe(200);
    expect(response.json().admin).toMatchObject({ email: "ana@example.pt", role: "admin" });
    expect(raw).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/v2/admin", secure: true });
    expect((await call("GET", "/admin/me", cookie)).body.admin.email).toBe("ana@example.pt");
  });

  it("rejects wrong passwords, unknown emails and disabled admins alike", async () => {
    const ana = await addAdmin("ana@example.pt", "admin");
    expect((await login("ana@example.pt", "nope")).response.json().error.code).toBe("invalid_credentials");
    expect((await login("bob@example.pt")).response.statusCode).toBe(401);
    await db.update(admins).set({ disabledAt: new Date() });
    expect((await login("ana@example.pt")).response.statusCode).toBe(401);
    expect(ana.id).toBeGreaterThan(0);
  });

  it("signs out", async () => {
    await addAdmin("ana@example.pt", "admin");
    const { cookie } = await login("ana@example.pt");
    expect((await call("POST", "/admin/logout", cookie)).status).toBe(204);
    expect((await call("GET", "/admin/me", cookie)).status).toBe(401);
  });

  it("changes the password and ends other sessions", async () => {
    await addAdmin("ana@example.pt", "author");
    const first = await login("ana@example.pt");
    const second = await login("ana@example.pt");
    expect((await call("POST", "/admin/password", second.cookie, { current: "wrong", next: "a much better one" })).status).toBe(401);
    expect((await call("POST", "/admin/password", second.cookie, { current: PASSWORD, next: "short" })).status).toBe(400);
    expect((await call("POST", "/admin/password", second.cookie, { current: PASSWORD, next: "a much better one" })).status).toBe(204);
    expect((await call("GET", "/admin/me", first.cookie)).status).toBe(401);
    expect((await login("ana@example.pt", "a much better one")).response.statusCode).toBe(200);
  });
});

describe("roles", () => {
  it("keeps admin management to admins, and moderation to moderators and up", async () => {
    await addAdmin("author@example.pt", "author");
    await addAdmin("mod@example.pt", "moderator");
    const author = (await login("author@example.pt")).cookie;
    const mod = (await login("mod@example.pt")).cookie;
    expect((await call("GET", "/admin/admins")).status).toBe(401);
    expect((await call("GET", "/admin/admins", mod)).status).toBe(403);
    expect((await call("GET", "/admin/comments", author)).status).toBe(403);
    expect((await call("GET", "/admin/comments", mod)).status).toBe(200);
  });

  it("invites, updates and disables admins, with an audit trail", async () => {
    const me = await addAdmin("ana@example.pt", "admin");
    const cookie = (await login("ana@example.pt")).cookie;
    const invited = await call("POST", "/admin/admins", cookie, { email: "Bob@Example.pt", name: "Bob", role: "author", password: PASSWORD });
    expect(invited).toMatchObject({ status: 201, body: { email: "bob@example.pt", role: "author", disabled: false } });
    expect((await call("POST", "/admin/admins", cookie, { email: "bob@example.pt", name: "B", role: "author", password: PASSWORD })).status).toBe(409);

    const bob = (await login("bob@example.pt")).cookie;
    const updated = await call("PATCH", `/admin/admins/${invited.body.id}`, cookie, { role: "moderator", disabled: true });
    expect(updated.body).toMatchObject({ role: "moderator", disabled: true });
    expect((await call("GET", "/admin/me", bob)).status).toBe(401);

    expect((await call("PATCH", `/admin/admins/${me.id}`, cookie, { disabled: true })).body.error.code).toBe("self_lockout");

    const log = await call("GET", "/admin/audit?entity=admin", cookie);
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["admin.update", "admin.create"]);
    expect(log.body.items[0]).toMatchObject({
      admin: { id: me.id, name: "ana" },
      before: { role: "author", disabled: false },
      after: { role: "moderator", disabled: true },
    });
    expect(JSON.stringify(log.body)).not.toContain("password");
  });
});

describe("comment moderation", () => {
  it("hides and unhides comments, logging why", async () => {
    await addAdmin("mod@example.pt", "moderator");
    const cookie = (await login("mod@example.pt")).cookie;
    const article = await insertArticle(db);
    const [comment] = await db.insert(comments).values({ articleId: article.id, body: "spam" }).returning();

    const listed = await call("GET", "/admin/comments", cookie);
    expect(listed.body.items).toMatchObject([{ id: comment!.id, articleTitle: "O PS e o PSD", hiddenAt: null }]);

    expect((await call("POST", `/admin/comments/${comment!.id}/hide`, cookie, { reason: "Spam" })).status).toBe(204);
    expect((await call("GET", `/articles/${article.id}/comments`)).body).toEqual([]);
    expect((await call("GET", "/admin/comments?status=hidden", cookie)).body.items).toHaveLength(1);
    expect((await call("POST", `/admin/comments/${comment!.id}/unhide`, cookie)).status).toBe(204);
    expect((await call("GET", `/articles/${article.id}/comments`)).body).toHaveLength(1);
    expect((await call("POST", "/admin/comments/999/hide", cookie)).status).toBe(404);

    const log = await call("GET", `/admin/audit?entity=comment&entityId=${comment!.id}`, cookie);
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["comment.unhide", "comment.hide"]);
    expect(log.body.items[1].after).toEqual({ reason: "Spam" });
  });
});

describe("hardening", () => {
  it("sends security headers and allows credentials only for listed origins", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v2/parties", headers: { origin: "http://localhost:3000" } });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const other = await app.inject({ method: "GET", url: "/api/v2/parties", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still serves the API docs page", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("rejects reCAPTCHA tokens solved on other sites", async () => {
    const google = (hostname: string) => (async () => new Response(JSON.stringify({ success: true, hostname }))) as unknown as typeof fetch;
    expect(await createRecaptchaVerifier("s", google("politicando.pt"), ["politicando.pt"])("t", "1.1.1.1")).toBe(true);
    expect(await createRecaptchaVerifier("s", google("evil.example"), ["politicando.pt"])("t", "1.1.1.1")).toBe(false);
    expect(await createRecaptchaVerifier("s", google("anything"))("t", "1.1.1.1")).toBe(true);
  });
});
