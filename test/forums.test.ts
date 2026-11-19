import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, comments } from "../src/db/schema.js";
import { posterId } from "../src/forums/identity.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
let human = true;
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => human, forumSecret: "test-secret", commentLimitPerMinute: 1000, loginLimitPerMinute: 1000,
});

beforeEach(async () => {
  human = true;
  await resetDb(db);
  await db.insert(admins).values({ email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash: await hashPassword("correct horse battery") });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: object, headers: Record<string, string> = {}) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers, ...(payload && { payload }), remoteAddress: headers["x-ip"] ?? "10.0.0.1" });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const as = (ip: string) => ({ "x-ip": ip });
const modCookie = async () => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email: "mod@example.pt", password: "correct horse battery" } });
  return { cookie: `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}` };
};
const openThread = (board = "ps", extra: object = {}, ip = "10.0.0.1") =>
  call("POST", `/forums/${board}/threads`, { title: "Orçamento", body: "O que acham?", recaptchaToken: "t", ...extra }, as(ip));

describe("poster IDs", () => {
  it("are stable within a thread and differ across threads and people", () => {
    expect(posterId("s", "1.1.1.1", 1)).toBe(posterId("s", "1.1.1.1", 1));
    expect(posterId("s", "1.1.1.1", 1)).not.toBe(posterId("s", "1.1.1.1", 2));
    expect(posterId("s", "1.1.1.1", 1)).not.toBe(posterId("s", "2.2.2.2", 1));
    expect(posterId("s", "1.1.1.1", 1)).toHaveLength(8);
  });
});

describe("boards and threads", () => {
  it("lists the general board, then parties by seats", async () => {
    await openThread("ps");
    const { body } = await call("GET", "/forums");
    expect(body.items[0]).toMatchObject({ board: "geral", name: "Geral", threads: 0 });
    expect(body.items[1]).toMatchObject({ board: "ideias", name: "Ideias", acronym: null });
    expect(body.items.find((b: { board: string }) => b.board === "ps")).toMatchObject({ acronym: "PS", threads: 1, posts: 1 });
  });

  it("opens threads anonymously, with replies that mark the opener", async () => {
    const article = await insertArticle(db);
    const opened = await openThread("ps", { nickname: "  ", articleId: article.id });
    expect(opened.status).toBe(201);
    const id = opened.body.id;
    expect(opened.body.posterId).toBe(posterId("test-secret", "10.0.0.1", id));

    const first = await call("POST", `/forums/threads/${id}/posts`, { body: "Concordo", recaptchaToken: "t" }, as("10.0.0.2"));
    await call("POST", `/forums/threads/${id}/posts`, { body: "Obrigado", replyTo: first.body.id, nickname: "Zé", recaptchaToken: "t" }, as("10.0.0.1"));

    const { body } = await call("GET", `/forums/threads/${id}`);
    expect(body.thread).toMatchObject({ title: "Orçamento", body: "O que acham?", nickname: null, replyCount: 2, link: { article: { id: article.id } } });
    expect(body.posts).toMatchObject([
      { body: "Concordo", isOp: false, replyTo: null },
      { body: "Obrigado", isOp: true, nickname: "Zé", replyTo: first.body.id },
    ]);
    expect(JSON.stringify(body)).not.toContain("10.0.0");
  });

  it("sorts by activity, novelty or replies, with pinned threads first", async () => {
    const a = (await openThread("ps", { title: "Primeiro" })).body.id;
    const b = (await openThread("ps", { title: "Segundo" })).body.id;
    await call("POST", `/forums/threads/${a}/posts`, { body: "up", recaptchaToken: "t" });
    const titles = async (q: string) => (await call("GET", `/forums/ps/threads?${q}`)).body.items.map((t: { title: string }) => t.title);
    expect(await titles("sort=active")).toEqual(["Primeiro", "Segundo"]);
    expect(await titles("sort=new")).toEqual(["Segundo", "Primeiro"]);
    expect(await titles("sort=top")).toEqual(["Primeiro", "Segundo"]);
    const { cookie } = await modCookie();
    await call("POST", `/admin/forum/threads/${b}/pin`, undefined, { cookie });
    expect(await titles("sort=active")).toEqual(["Segundo", "Primeiro"]);
  });

  it("refuses bots, unknown boards and bad links", async () => {
    human = false;
    expect((await openThread()).status).toBe(403);
    human = true;
    expect((await openThread("nope")).status).toBe(404);
    expect((await openThread("ps", { articleId: 999 })).status).toBe(404);
    const id = (await openThread()).body.id;
    expect((await call("POST", `/forums/threads/${id}/posts`, { body: "x", replyTo: 999, recaptchaToken: "t" })).status).toBe(400);
    expect((await openThread("geral")).status).toBe(201);
  });
});

describe("moderation", () => {
  it("locks and hides threads, and blanks hidden replies without breaking quotes", async () => {
    const { cookie } = await modCookie();
    const id = (await openThread()).body.id;
    const post = (await call("POST", `/forums/threads/${id}/posts`, { body: "insulto", recaptchaToken: "t" })).body.id;

    await call("POST", `/admin/forum/posts/${post}/hide`, undefined, { cookie });
    expect((await call("GET", `/forums/threads/${id}`)).body.posts).toEqual([
      expect.objectContaining({ id: post, body: null, posterId: null, hidden: true }),
    ]);

    await call("POST", `/admin/forum/threads/${id}/lock`, undefined, { cookie });
    expect((await call("POST", `/forums/threads/${id}/posts`, { body: "x", recaptchaToken: "t" })).body.error.code).toBe("thread_locked");

    await call("POST", `/admin/forum/threads/${id}/hide`, undefined, { cookie });
    expect((await call("GET", `/forums/threads/${id}`)).status).toBe(404);
    expect((await call("GET", "/forums/ps/threads")).body.total).toBe(0);
    expect((await call("POST", "/admin/forum/threads/999/hide", undefined, { cookie })).status).toBe(404);
  });

  it("counts a reader once whether logged in or not, and keeps team names for the team", async () => {
    const { body: thread } = await openThread();
    const register = await app.inject({
      method: "POST", url: "/api/v2/auth/register", payload: { username: "zeca", password: "palavra-passe", recaptchaToken: "t" }, remoteAddress: "3.3.3.3",
    });
    const cookie = `politicando_session=${register.cookies.find((c) => c.name === "politicando_session")!.value}`;
    // Logged in, then logged out, from the same connection: one report, so nothing is hidden.
    await call("POST", "/reports", { kind: "thread", id: thread.id, reason: "hate" }, { ...as("3.3.3.3"), cookie });
    await call("POST", "/reports", { kind: "thread", id: thread.id, reason: "hate" }, as("3.3.3.3"));
    expect((await call("GET", `/forums/threads/${thread.id}`)).status).toBe(200);

    for (const nickname of ["Politicando", "Redação", "moderador", "Moderação", "A Equipa", "Admin1", "mod"]) {
      expect((await openThread("ps", { nickname })).status).toBe(400);
    }
    for (const nickname of ["Zé Povinho", "Modesto"]) expect((await openThread("ps", { nickname })).status).toBe(201);
  });

  it("queues reports per item, counts each reporter once, and resolves them", async () => {
    const { cookie } = await modCookie();
    const id = (await openThread()).body.id;
    const article = await insertArticle(db);
    const [comment] = await db.insert(comments).values({ articleId: article.id, body: "spam" }).returning();

    expect((await call("POST", "/reports", { kind: "thread", id, reason: "insult" }, as("1.1.1.1"))).status).toBe(202);
    await call("POST", "/reports", { kind: "thread", id, reason: "insult" }, as("1.1.1.1"));
    await call("POST", "/reports", { kind: "thread", id, reason: "hate", details: "Ataque a um grupo" }, as("2.2.2.2"));
    await call("POST", "/reports", { kind: "comment", id: comment!.id, reason: "spam" }, as("1.1.1.1"));
    expect((await call("POST", "/reports", { kind: "post", id: 999, reason: "spam" })).status).toBe(404);

    const queue = await call("GET", "/admin/reports", undefined, { cookie });
    expect(queue.body.items).toMatchObject([
      { kind: "thread", targetId: id, reports: 2, reasons: ["hate", "insult"], details: ["Ataque a um grupo"], target: { hidden: false, threadId: id } },
      { kind: "comment", targetId: comment!.id, reports: 1, target: { text: "spam", articleId: article.id } },
    ]);

    expect((await call("POST", "/admin/reports/resolve", { kind: "thread", targetId: id, action: "hide" }, { cookie })).body).toEqual({ resolved: 2 });
    expect((await call("GET", `/forums/threads/${id}`)).status).toBe(404);
    await call("POST", "/admin/reports/resolve", { kind: "comment", targetId: comment!.id, action: "dismiss" }, { cookie });
    expect((await call("GET", `/articles/${article.id}/comments`)).body).toHaveLength(1);
    expect((await call("GET", "/admin/reports", undefined, { cookie })).body.items).toEqual([]);
    expect((await call("GET", "/admin/reports?status=resolved", undefined, { cookie })).body.items.map((i: { resolution: string }) => i.resolution).sort()).toEqual([
      "dismissed",
      "hidden",
    ]);

    const log = await call("GET", "/admin/audit", undefined, { cookie });
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["report.dismiss", "report.hide"]);
  });
});

describe("ideas board and votes", () => {
  const ids = (body: { items: { id: number }[] }) => body.items.map((t) => t.id);

  it("counts one upvote per reader and sorts top threads by score, then replies", async () => {
    const a = (await openThread("ideias", { title: "Alertas por partido" })).body.id;
    const b = (await openThread("ideias", { title: "Modo escuro" })).body.id;
    const c = (await openThread("ideias", { title: "Mapa de contratos" })).body.id;
    await call("POST", `/forums/threads/${c}/posts`, { body: "Sim!", recaptchaToken: "t" });

    expect((await call("POST", `/forums/threads/${b}/vote`, undefined, as("1.1.1.1"))).body).toEqual({ score: 1 });
    expect((await call("POST", `/forums/threads/${b}/vote`, undefined, as("1.1.1.1"))).body).toEqual({ score: 1 });
    expect((await call("POST", `/forums/threads/${b}/vote`, undefined, as("2.2.2.2"))).body).toEqual({ score: 2 });
    expect((await call("POST", `/forums/threads/${a}/vote`, undefined, as("1.1.1.1"))).body).toEqual({ score: 1 });
    expect((await call("POST", "/forums/threads/999999/vote")).status).toBe(404);

    const top = await call("GET", "/forums/ideias/threads?sort=top");
    // b has 2 votes; a and c have 1 and 0, but c's reply doesn't beat a's vote.
    expect(ids(top.body)).toEqual([b, a, c]);
    expect(top.body.items[0]).toMatchObject({ score: 2, status: null, answer: null, answeredAt: null });
    expect((await call("GET", `/forums/threads/${b}`)).body.thread).toMatchObject({ score: 2 });
    // On equal scores, most replies first.
    await call("POST", `/forums/threads/${c}/vote`, undefined, as("3.3.3.3"));
    expect(ids((await call("GET", "/forums/ideias/threads?sort=top")).body)).toEqual([b, c, a]);
  });

  it("lets moderators give ideas a status and an answer, and filters by status", async () => {
    const { cookie } = await modCookie();
    const idea = (await openThread("ideias")).body.id;
    const other = (await openThread("ideias")).body.id;
    const partyThread = (await openThread("ps")).body.id;

    const set = (id: number, body: object, headers: Record<string, string> = { cookie }) => call("PUT", `/admin/forum/threads/${id}/status`, body, headers);
    expect((await set(idea, { status: "done", answer: "Feito" }, {})).status).toBe(401);
    expect((await set(partyThread, { status: "done", answer: null })).body.error.code).toBe("not_an_idea");
    const first = await set(idea, { status: "done", answer: "Feito em novembro: já podes filtrar por distrito" });
    expect(first.body).toMatchObject({ status: "done", answer: "Feito em novembro: já podes filtrar por distrito", answeredAt: expect.any(String) });
    expect((await set(idea, { status: "done", answer: "Feito em novembro: já podes filtrar por distrito" })).body.answeredAt).toBe(first.body.answeredAt);
    await set(other, { status: "planned", answer: "" });

    expect(ids((await call("GET", "/forums/ideias/threads?status=planned")).body)).toEqual([other]);
    expect((await call("GET", "/forums/ideias/threads?status=done")).body.items[0]).toMatchObject({ id: idea, status: "done", answer: expect.stringContaining("distrito") });
    expect((await call("GET", `/forums/threads/${other}`)).body.thread).toMatchObject({ status: "planned", answer: null, answeredAt: null });
    expect((await call("GET", "/forums/ideias/threads?status=nope")).status).toBe(400);
  });
});
