import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articles, auditLog, comments, forumThreads } from "../src/db/schema.js";
import { restore } from "../src/moderation/reports.js";
import { screenText } from "../src/moderation/screen.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
});

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = async (method: "GET" | "POST", url: string, payload?: object, ip = "10.0.0.1") => {
  const response = await app.inject({ method, url: `/api/v2${url}`, ...(payload && { payload }), remoteAddress: ip });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
let n = 0;
const report = (kind: string, id: number, reason: string, ip: string) => call("POST", "/reports", { kind, id, reason }, ip);
const commentHidden = async (id: number) => (await db.select().from(comments).where(eq(comments.id, id)))[0]!.hiddenAt !== null;

describe("screening what readers write", () => {
  it("lets rudeness and opinions through", () => {
    expect(screenText("Este governo é uma merda e o ministro é um incompetente")).toBeNull();
    expect(screenText("O OE2027 prevê 200 000 000 euros, ou 2000000000 no total, e 9 312 345 de pessoas")).toBeNull();
    expect(screenText("Os imigrantes contribuem para a Segurança Social", "Zé")).toBeNull();
    expect(screenText("Ver https://www.parlamento.pt e https://dre.pt")).toBeNull();
  });

  it("refuses contact details, slurs, threats and link spam", () => {
    expect(screenText("Liguem-lhe: 912 345 678")?.code).toBe("personal_data");
    expect(screenText("o número dele é +351 213 456 789")?.code).toBe("personal_data");
    expect(screenText("escrevam para fulano.silva@gmail.com")?.code).toBe("personal_data");
    expect(screenText("Esses CIGANOS de merda")?.code).toBe("hate");
    expect(screenText("bom texto", "paneleiro")?.code).toBe("hate");
    expect(screenText("Vou-te matar, ministro")?.code).toBe("threat");
    expect(screenText("sei onde moras")?.code).toBe("threat");
    expect(screenText("a.com b.pt c.net")?.code).toBe("too_many_links");
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

  it("hides an item reported by 3 different readers, or 2 for something harmful", async () => {
    const id = await comment();
    await report("comment", id, "insult", "1.1.1.1");
    await report("comment", id, "insult", "1.1.1.1");
    await report("comment", id, "spam", "2.2.2.2");
    expect(await commentHidden(id)).toBe(false);
    await report("comment", id, "other", "3.3.3.3");
    expect(await commentHidden(id)).toBe(true);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("report.auto_hide");

    const other = await comment();
    await report("comment", other, "hate", "1.1.1.1");
    await report("comment", other, "personal_data", "2.2.2.2");
    expect(await commentHidden(other)).toBe(true);

    const [thread] = await db.insert(forumThreads).values({ board: "geral", title: "Tópico", body: "x", posterId: "p" }).returning();
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) await report("thread", thread!.id, "spam", ip);
    expect((await db.select().from(forumThreads)).find((t) => t.id === thread!.id)!.hiddenAt).not.toBeNull();
  });

  it("needs twice as many reports once an item was restored", async () => {
    const id = await comment();
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) await report("comment", id, "insult", ip);
    expect(await restore(db, "comment", id)).toBe(true);
    expect(await commentHidden(id)).toBe(false);
    for (const ip of ["4.4.4.4", "5.5.5.5", "6.6.6.6", "7.7.7.7", "8.8.8.8"]) await report("comment", id, "insult", ip);
    expect(await commentHidden(id)).toBe(false);
    await report("comment", id, "insult", "9.9.9.9");
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
