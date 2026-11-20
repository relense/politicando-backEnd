import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { READER_COOKIE, createReaderSession } from "../src/accounts/sessions.js";
import { articles, auditLog, comments, forumThreads, reports, users } from "../src/db/schema.js";
import { restore } from "../src/moderation/reports.js";
import { screenText } from "../src/moderation/screen.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
});

beforeEach(async () => {
  await resetDb(db);
  accountCookies.clear();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = async (method: "GET" | "POST", url: string, payload?: object, ip = "10.0.0.1", cookie?: string) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, ...(payload && { payload }), remoteAddress: ip, ...(cookie && { headers: { cookie } }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
let n = 0;
/** A signed-in reader per address (made on first use): only accounts' reports hide anything. */
const accountCookies = new Map<string, string>();
const accountAt = async (ip: string) => {
  let cookie = accountCookies.get(ip);
  if (!cookie) {
    const [user] = await db.insert(users).values({ username: `r${++n}`, passwordHash: "x" }).returning();
    cookie = `${READER_COOKIE}=${(await createReaderSession(db, user!.id)).token}`;
    accountCookies.set(ip, cookie);
  }
  return cookie;
};
const report = async (kind: string, id: number, reason: string, ip: string) => call("POST", "/reports", { kind, id, reason }, ip, await accountAt(ip));
const anonymousReport = (kind: string, id: number, reason: string, ip: string) => call("POST", "/reports", { kind, id, reason }, ip);
const commentHidden = async (id: number) => (await db.select().from(comments).where(eq(comments.id, id)))[0]!.hiddenAt !== null;

describe("screening what readers write", () => {
  it("lets rudeness, insults and opinions through", () => {
    expect(screenText("Este governo é uma merda e o ministro é um incompetente do caralho")).toBeNull();
    expect(screenText("És mesmo burro, paneleiro")).toBeNull();
    expect(screenText("O OE2027 prevê 200 000 000 euros, ou 2000000000 no total, e 9 312 345 de pessoas")).toBeNull();
    expect(screenText("Os imigrantes contribuem para a Segurança Social", "Zé")).toBeNull();
    expect(screenText("Menos imigração, já! Fronteiras controladas")).toBeNull();
    expect(screenText("a.com b.pt c.net d.org https://x.pt")).toBeNull();
  });

  it("refuses what's illegal: contact details, attacks on a group, threats", () => {
    expect(screenText("Liguem-lhe: 912 345 678")?.code).toBe("personal_data");
    expect(screenText("o número dele é +351 213 456 789")?.code).toBe("personal_data");
    expect(screenText("escrevam para fulano.silva@gmail.com")?.code).toBe("personal_data");
    expect(screenText("Esses CIGANOS de merda")?.code).toBe("hate");
    expect(screenText("morte aos imigrantes")?.code).toBe("hate");
    expect(screenText("os pretos são macacos")?.code).toBe("hate");
    expect(screenText("bom texto", "judeus de merda")?.code).toBe("hate");
    expect(screenText("Vou-te matar, ministro")?.code).toBe("threat");
    expect(screenText("sei onde moras")?.code).toBe("threat");
  });

  it("refuses them when posting, with a message to show", async () => {
    const article = await insertArticle(db, { title: "Notícia", source: "x.pt", sourceUri: `s${++n}`, url: `https://x.pt/${n}`, publishedAt: new Date() });
    const refused = await call("POST", `/articles/${article.id}/comments`, { body: "Liga-lhe para o 912345678", recaptchaToken: "t" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "personal_data", message: expect.stringContaining("contactos") });
    expect((await call("POST", "/forums/geral/threads", { title: "Ameaça", body: "vou te matar", recaptchaToken: "t" })).body.error.code).toBe("threat");
    expect((await call("POST", `/articles/${article.id}/comments`, { body: "Discordo totalmente", recaptchaToken: "t" })).status).toBe(201);
  });
});

describe("hiding what readers report", () => {
  const comment = async () => {
    const article = await insertArticle(db, { title: "Notícia", source: "x.pt", sourceUri: `s${++n}`, url: `https://x.pt/${n}`, publishedAt: new Date() });
    return (await call("POST", `/articles/${article.id}/comments`, { body: "Comentário", recaptchaToken: "t" })).body.id as number;
  };

  it("hides what 2 readers call illegal and what 3 call spam, never what's only rude", async () => {
    const rude = await comment();
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]) await report("comment", rude, "insult", ip);
    await report("comment", rude, "other", "6.6.6.6");
    expect(await commentHidden(rude)).toBe(false);

    const illegal = await comment();
    await report("comment", illegal, "hate", "1.1.1.1");
    await report("comment", illegal, "hate", "1.1.1.1");
    expect(await commentHidden(illegal)).toBe(false);
    await report("comment", illegal, "personal_data", "2.2.2.2");
    expect(await commentHidden(illegal)).toBe(true);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("report.auto_hide");

    const [thread] = await db.insert(forumThreads).values({ board: "geral", title: "Tópico", body: "x", posterId: "p" }).returning();
    await report("thread", thread!.id, "spam", "1.1.1.1");
    await report("thread", thread!.id, "spam", "2.2.2.2");
    expect((await db.select().from(forumThreads))[0]!.hiddenAt).toBeNull();
    await report("thread", thread!.id, "spam", "3.3.3.3");
    expect((await db.select().from(forumThreads))[0]!.hiddenAt).not.toBeNull();
  });

  it("never hides on anonymous reports alone, but queues them, and counts each account once", async () => {
    const id = await comment();
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) expect((await anonymousReport("comment", id, "hate", ip)).status).toBe(202);
    for (const ip of ["5.5.5.5", "6.6.6.6", "7.7.7.7"]) await anonymousReport("comment", id, "spam", ip);
    expect(await commentHidden(id)).toBe(false);
    expect(await db.select().from(reports)).toHaveLength(7);

    // One account reporting from two connections is still one account.
    const cookie = await accountAt("8.8.8.8");
    await call("POST", "/reports", { kind: "comment", id, reason: "hate" }, "8.8.8.8", cookie);
    await call("POST", "/reports", { kind: "comment", id, reason: "illegal" }, "9.9.9.9", cookie);
    expect(await commentHidden(id)).toBe(false);

    // Reported logged out, then again logged in from the same connection: the account counts.
    await anonymousReport("comment", id, "hate", "10.1.1.1");
    expect(await commentHidden(id)).toBe(false);
    await report("comment", id, "hate", "10.1.1.1");
    expect(await commentHidden(id)).toBe(true);
  });

  it("keeps an account's report apart from an anonymous one sent from the same connection", async () => {
    const id = await comment();
    // Someone else on a shared connection (a phone network, a household) reported it as only rude.
    await call("POST", "/reports", { kind: "comment", id, reason: "insult", details: "de outra pessoa" }, "10.2.2.2");
    const cookie = await accountAt("10.2.2.2");
    await call("POST", "/reports", { kind: "comment", id, reason: "hate" }, "10.2.2.2", cookie);
    const rows = await db.select({ reason: reports.reason, details: reports.details, userId: reports.userId }).from(reports).orderBy(reports.id);
    expect(rows).toEqual([
      { reason: "insult", details: "de outra pessoa", userId: null },
      { reason: "hate", details: null, userId: expect.any(Number) },
    ]);
  });

  it("needs twice as many reports once an item was restored", async () => {
    const id = await comment();
    for (const ip of ["1.1.1.1", "2.2.2.2"]) await report("comment", id, "illegal", ip);
    expect(await commentHidden(id)).toBe(true);
    expect(await restore(db, "comment", id)).toBe(true);
    expect(await commentHidden(id)).toBe(false);
    for (const ip of ["3.3.3.3", "4.4.4.4", "5.5.5.5"]) await report("comment", id, "illegal", ip);
    expect(await commentHidden(id)).toBe(false);
    await report("comment", id, "hate", "6.6.6.6");
    expect(await commentHidden(id)).toBe(true);
  });

  it("hides news only when it's a duplicate, broken or not politics, never for wrong tags", async () => {
    const a = await insertArticle(db, { title: "Notícia", source: "x.pt", sourceUri: `s${++n}`, url: `https://x.pt/${n}`, publishedAt: new Date() });
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) await report("article", a.id, "wrong_tags", ip);
    const hidden = async () => (await db.select().from(articles).where(eq(articles.id, a.id)))[0]!.hiddenAt !== null;
    expect(await hidden()).toBe(false);
    await report("article", a.id, "duplicate", "5.5.5.5");
    await report("article", a.id, "not_politics", "6.6.6.6");
    expect(await hidden()).toBe(false);
    await report("article", a.id, "duplicate", "7.7.7.7");
    expect(await hidden()).toBe(true);
  });
});
