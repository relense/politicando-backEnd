import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, articleVotes, articles, comments, editorialPosts, forumPosts, forumThreads, stories, storyMerges, userSessions, users } from "../src/db/schema.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const ALL = ["comments", "forum", "votes", "reports"] as const;
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
  loginLimitPerMinute: 1000, registerLimitPerHour: 1000, loginRequired: ALL,
});

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, options: { cookie?: string; payload?: object; ip?: string } = {}) =>
  app.inject({
    method, url: `/api/v2${url}`, payload: options.payload, remoteAddress: options.ip,
    headers: options.cookie ? { cookie: `politicando_session=${options.cookie}` } : {},
  });

const register = async (username = "leitor_1", password = "palavra-passe") => {
  const response = await call("POST", "/auth/register", { payload: { username, password, recaptchaToken: "t" } });
  const session = response.cookies.find((c) => c.name === "politicando_session");
  return { response, cookie: session?.value ?? "", session };
};

describe("accounts", () => {
  it("saves blog posts, comments, forum threads and replies, and lists them with their details", async () => {
    const { cookie } = await register();
    const [post] = await db
      .insert(editorialPosts)
      .values({ slug: "guardado", title: "Um post", kind: "article", body: "texto", authorName: "Ana", status: "published", publishedAt: new Date() })
      .returning();
    const [comment] = await db.insert(comments).values({ editorialPostId: post!.id, username: "ana", body: "Bom texto" }).returning();
    const [thread] = await db.insert(forumThreads).values({ board: "geral", title: "Um fio", body: "Abertura", posterId: "p1" }).returning();
    const [reply] = await db.insert(forumPosts).values({ threadId: thread!.id, body: "Uma resposta", posterId: "p2" }).returning();
    for (const [kind, id] of [["editorial", post!.id], ["comment", comment!.id], ["thread", thread!.id], ["reply", reply!.id]] as const) {
      expect((await call("PUT", `/me/saved/${kind}/${id}`, { cookie })).statusCode).toBe(204);
    }
    expect((await call("PUT", "/me/saved/forum/1", { cookie })).statusCode).toBe(400);
    expect((await call("GET", "/me/state", { cookie })).json().saved).toMatchObject({ editorial: [post!.id], comments: [comment!.id], threads: [thread!.id], replies: [reply!.id] });

    const saved = (await call("GET", "/me/saved", { cookie })).json();
    expect(saved.editorial).toEqual([expect.objectContaining({ id: post!.id, slug: "guardado", title: "Um post" })]);
    expect(saved.comments).toEqual([expect.objectContaining({ id: comment!.id, body: "Bom texto", postSlug: "guardado", articleId: null })]);
    expect(saved.threads).toEqual([expect.objectContaining({ id: thread!.id, title: "Um fio", board: "geral" })]);
    expect(saved.replies).toEqual([expect.objectContaining({ id: reply!.id, threadId: thread!.id, threadTitle: "Um fio", body: "Uma resposta" })]);

    // Hidden by a moderator: no longer listed, and can't be saved again.
    await db.update(comments).set({ hiddenAt: new Date() }).where(eq(comments.id, comment!.id));
    expect((await call("GET", "/me/saved", { cookie })).json().comments).toEqual([]);
    expect((await call("PUT", `/me/saved/comment/${comment!.id}`, { cookie })).statusCode).toBe(404);
    expect((await call("GET", "/me/saved")).statusCode).toBe(401);
  });

  it("renews a session on any page, and then that page is private, never cached publicly", async () => {
    const { cookie } = await register();
    const page = await call("GET", "/budget", { cookie });
    expect(page.headers["cache-control"]).toBe("public, max-age=300");
    expect(page.headers["set-cookie"]).toBeUndefined();
    // Under 15 days left: the session is extended, and the new cookie rides on this response.
    await db.update(userSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) });
    const renewed = await call("GET", "/budget", { cookie });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.headers["set-cookie"]).toBeDefined();
    expect(renewed.headers["cache-control"]).toBe("private, no-store");
  });

  it("saves, unsaves and merges a merged story under the story it went into", async () => {
    const { cookie } = await register();
    const [into] = await db.insert(stories).values({}).returning();
    await db.insert(storyMerges).values({ fromId: 999_001, intoId: into!.id, reason: "model" });
    expect((await call("PUT", "/me/saved/story/999001", { cookie })).statusCode).toBe(204);
    expect((await call("GET", "/me/state", { cookie })).json().saved.stories).toEqual([into!.id]);
    expect((await call("DELETE", "/me/saved/story/999001", { cookie })).statusCode).toBe(204);
    expect((await call("GET", "/me/state", { cookie })).json().saved.stories).toEqual([]);

    const merged = await call("POST", "/me/merge", { cookie, payload: { saved: { stories: [999_001, into!.id] }, read: [999_001] } });
    expect(merged.json()).toMatchObject({ saved: { stories: [into!.id] }, read: [into!.id] });
  });

  it("registers and logs in with a username and password, by an httpOnly cookie on /api/v2", async () => {
    const { response, cookie, session } = await register("Ana_Silva");
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ username: "Ana_Silva" });
    expect(session).toMatchObject({ path: "/api/v2", httpOnly: true, sameSite: "Lax", secure: true });
    expect((await call("GET", "/me", { cookie })).json()).toMatchObject({ username: "Ana_Silva" });
    expect((await call("GET", "/me")).statusCode).toBe(401);

    // Unique ignoring case; reserved and malformed names refused.
    expect((await register("ana_silva")).response.json().error.code).toBe("username_taken");
    expect((await register("Admin")).response.statusCode).toBe(409);
    // Names that read like the team, as anonymous nicknames can't either.
    for (const name of ["Admin_PT", "EquipaPoliticando", "moderador2", "Staff_Oficial", "mod1"]) {
      expect((await register(name)).response.json().error.code).toBe("username_taken");
    }
    expect((await register("Modesto")).response.statusCode).toBe(201);
    expect((await register("a")).response.statusCode).toBe(400);
    expect((await register("nome com espaços")).response.statusCode).toBe(400);
    expect((await register("curta", "1234567")).response.statusCode).toBe(400);

    const login = await call("POST", "/auth/login", { payload: { username: "ANA_SILVA", password: "palavra-passe", recaptchaToken: "t" } });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((c) => c.name === "politicando_session")?.value).toBeTruthy();
  });

  it("answers the same for an unknown name and a wrong password, and locks a name after 10 failures", async () => {
    await register("joana");
    const login = (username: string, password: string) => call("POST", "/auth/login", { payload: { username, password, recaptchaToken: "t" } });
    const unknown = await login("ninguem", "palavra-passe");
    const wrong = await login("joana", "errada-errada");
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    for (let i = 0; i < 9; i++) await login("joana", "errada-errada");
    expect((await login("joana", "palavra-passe")).json().error.code).toBe("too_many_attempts");
  });

  it("limits sign-ups per IP", async () => {
    const strict = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", loginRequired: ALL });
    const statuses = [];
    for (const name of ["um_leitor", "dois_leitor", "tres_leitor", "quatro_leitor"]) {
      statuses.push((await strict.inject({ method: "POST", url: "/api/v2/auth/register", payload: { username: name, password: "palavra-passe", recaptchaToken: "t" } })).statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
    await strict.close();
  });

  it("logs out, and a password change logs out every other session", async () => {
    const { cookie } = await register("rui");
    const other = (await call("POST", "/auth/login", { payload: { username: "rui", password: "palavra-passe", recaptchaToken: "t" } })).cookies[0]!.value;
    expect((await call("PUT", "/me/password", { cookie, payload: { current: "errada", new: "nova-palavra" } })).statusCode).toBe(401);
    expect((await call("PUT", "/me/password", { cookie, payload: { current: "palavra-passe", new: "nova-palavra" } })).statusCode).toBe(204);
    expect((await call("GET", "/me", { cookie: other })).statusCode).toBe(401);
    expect((await call("GET", "/me", { cookie })).statusCode).toBe(200);
    expect((await call("POST", "/auth/logout", { cookie })).statusCode).toBe(204);
    expect((await call("GET", "/me", { cookie })).statusCode).toBe(401);
  });

  it("syncs saved, hidden, muted and read, and merges what the browser had", async () => {
    const { cookie } = await register();
    const a = (await insertArticle(db, { sourceUri: "guardar" }, [])).id;
    const [story] = await db.insert(stories).values({} as typeof stories.$inferInsert).returning();
    expect((await call("PUT", `/me/saved/article/${a}`, { cookie })).statusCode).toBe(204);
    await call("PUT", `/me/saved/article/${a}`, { cookie });
    await call("PUT", `/me/saved/story/${story!.id}`, { cookie });
    expect((await call("PUT", "/me/saved/article/999999", { cookie })).statusCode).toBe(404);
    await call("PUT", "/me/hidden/9", { cookie });
    await call("PUT", "/me/muted/source/publico.pt", { cookie });
    await call("PUT", "/me/muted/party/chega", { cookie });
    await call("PUT", "/me/read/3", { cookie });
    expect((await call("PUT", "/me/muted/party/Not A Slug", { cookie })).statusCode).toBe(400);
    expect((await call("PUT", `/me/saved/article/${a}`)).statusCode).toBe(401);

    const merged = await call("POST", "/me/merge", {
      cookie,
      payload: { saved: { articles: [8, a] }, hidden: [9, 10], muted: { sources: ["expresso.pt"] }, read: [4] },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({
      saved: { articles: expect.arrayContaining([a, 8]), stories: [story!.id], editorial: [], comments: [], threads: [], replies: [] },
      hidden: expect.arrayContaining([9, 10]),
      muted: { sources: expect.arrayContaining(["publico.pt", "expresso.pt"]), parties: ["chega"] },
      read: expect.arrayContaining([3, 4]),
    });
    expect(merged.json().saved.articles).toHaveLength(2);

    await call("DELETE", `/me/saved/article/${a}`, { cookie });
    await call("DELETE", "/me/muted/party/chega", { cookie });
    const state = (await call("GET", "/me/state", { cookie })).json();
    expect(state.saved.articles).toEqual([8]);
    expect(state.muted.parties).toEqual([]);

    // Lists keep the newest 200 reads (the site's own cap).
    await call("POST", "/me/merge", { cookie, payload: { read: Array.from({ length: 200 }, (_, i) => 1000 + i) } });
    await call("PUT", "/me/read/5000", { cookie });
    const read = (await call("GET", "/me/state", { cookie })).json().read;
    expect(read).toHaveLength(200);
    expect(read[0]).toBe(5000);
  });

  it("needs an account to take part, and posts under the account's username", async () => {
    const article = await insertArticle(db);
    expect((await call("POST", `/articles/${article.id}/comments`, { payload: { body: "Olá", recaptchaToken: "t" } })).json().error.code).toBe("login_required");
    expect((await call("POST", `/articles/${article.id}/vote`, { payload: { value: 1 } })).statusCode).toBe(401);
    expect((await call("POST", "/reports", { payload: { kind: "article", id: article.id, reason: "duplicate" } })).statusCode).toBe(401);
    expect((await call("POST", "/forums/geral/threads", { payload: { title: "Tema", body: "Texto", recaptchaToken: "t" } })).statusCode).toBe(401);

    const { cookie } = await register("maria");
    // No reCAPTCHA for accounts, and the name sent is ignored.
    const comment = await call("POST", `/articles/${article.id}/comments`, { cookie, payload: { body: "Olá", username: "Outra Pessoa" } });
    expect(comment.statusCode).toBe(201);
    expect(comment.json()).toMatchObject({ username: "maria", account: true });
    const listed = (await call("GET", `/articles/${article.id}/comments`)).json();
    expect(listed[0]).toMatchObject({ username: "maria", account: true });

    const thread = await call("POST", "/forums/geral/threads", { cookie, payload: { title: "Tema", body: "Texto", nickname: "x" } });
    expect(thread.statusCode).toBe(201);
    const detail = (await call("GET", `/forums/threads/${thread.json().id}`)).json();
    expect(detail.thread).toMatchObject({ nickname: "maria", account: true });

    expect((await call("POST", "/reports", { cookie, payload: { kind: "comment", id: comment.json().id, reason: "spam" } })).statusCode).toBe(202);
    expect((await call("GET", "/me/activity", { cookie })).json()).toMatchObject({ comments: [{ body: "Olá" }], threads: [{ title: "Tema" }] });
  });

  it("counts one vote per account whatever the IP, and lists the reader's own votes", async () => {
    const article = await insertArticle(db);
    const { cookie } = await register();
    await call("POST", `/articles/${article.id}/vote`, { cookie, payload: { value: 1 }, ip: "1.1.1.1" });
    const again = await call("POST", `/articles/${article.id}/vote`, { cookie, payload: { value: 1 }, ip: "2.2.2.2" });
    expect(again.json()).toMatchObject({ up: 1, down: 0, mine: 1 });
    const comment = (await call("POST", `/articles/${article.id}/comments`, { cookie, payload: { body: "Gosto" } })).json();
    await call("POST", `/comments/${comment.id}/like`, { cookie, payload: { value: 1 } });
    const votes = (await call("GET", "/me/state", { cookie })).json().votes;
    expect(votes).toMatchObject({ articles: { [String(article.id)]: 1 }, comments: [comment.id] });
  });

  it("deletes the account: votes come off the totals, comments are removed", async () => {
    const article = await insertArticle(db);
    const [story] = await db.insert(stories).values({ title: "Uma história" } as typeof stories.$inferInsert).returning();
    await db.update(articles).set({ storyId: story!.id }).where(eq(articles.id, article.id));
    const { cookie } = await register();
    const other = await register("outro_leitor");
    await call("POST", `/articles/${article.id}/vote`, { cookie, payload: { value: 1 } });
    await call("POST", `/articles/${article.id}/vote`, { cookie: other.cookie, payload: { value: -1 } });
    await call("POST", `/stories/${story!.id}/vote`, { cookie, payload: { value: 1 } });
    const mine = (await call("POST", `/articles/${article.id}/comments`, { cookie, payload: { body: "Meu" } })).json();
    const theirs = (await call("POST", `/articles/${article.id}/comments`, { cookie: other.cookie, payload: { body: "Resposta", parentId: mine.id } })).json();
    await call("POST", `/comments/${theirs.id}/like`, { cookie, payload: { value: 1 } });

    expect((await call("DELETE", "/me", { cookie, payload: { password: "errada" } })).statusCode).toBe(401);
    const gone = await call("DELETE", "/me", { cookie, payload: { password: "palavra-passe" } });
    expect(gone.statusCode).toBe(204);
    expect(gone.cookies.find((c) => c.name === "politicando_session")?.value).toBe("");

    const [a] = await db.select({ up: articles.upvotes, down: articles.downvotes }).from(articles).where(eq(articles.id, article.id));
    expect(a).toEqual({ up: 0, down: 1 });
    const [s] = await db.select({ importa: stories.importa }).from(stories).where(eq(stories.id, story!.id));
    expect(s!.importa).toBe(0);
    const left = await db.select({ id: comments.id, body: comments.body, likes: comments.likes, hidden: comments.hiddenAt }).from(comments);
    expect(left.find((c) => c.id === mine.id)).toMatchObject({ body: "[apagado]", hidden: expect.any(Date) });
    expect(left.find((c) => c.id === theirs.id)).toMatchObject({ body: "Resposta", likes: 0, hidden: null });
    expect(await db.select().from(users).where(eq(users.username, "leitor_1"))).toEqual([]);
    expect((await db.select().from(articleVotes)).length).toBe(1);
    expect((await call("GET", "/me", { cookie })).statusCode).toBe(401);
  });

  it("lets a moderator ban an account", async () => {
    const { cookie, response } = await register("trol");
    const [admin] = await db.insert(admins).values({ email: "m@x.pt", name: "m", role: "moderator", passwordHash: await hashPassword("palavra-passe-admin") }).returning();
    const login = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email: admin!.email, password: "palavra-passe-admin" } });
    const adminCookie = login.cookies[0]!;
    const asAdmin = (url: string, method: "GET" | "POST" = "POST") =>
      app.inject({ method, url: `/api/v2${url}`, headers: { cookie: `${adminCookie.name}=${adminCookie.value}` } });
    expect((await asAdmin("/admin/users?q=tro", "GET")).json().items[0]).toMatchObject({ username: "trol", disabledAt: null });
    expect((await asAdmin(`/admin/users/${response.json().user.id}/disable`)).statusCode).toBe(204);
    expect((await call("GET", "/me", { cookie })).statusCode).toBe(401);
    expect((await call("POST", "/auth/login", { payload: { username: "trol", password: "palavra-passe", recaptchaToken: "t" } })).statusCode).toBe(401);
    await asAdmin(`/admin/users/${response.json().user.id}/enable`);
    expect((await call("POST", "/auth/login", { payload: { username: "trol", password: "palavra-passe", recaptchaToken: "t" } })).statusCode).toBe(200);
  });

  it("stays anonymous when login isn't required", async () => {
    const open = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", loginRequired: [] });
    const article = await insertArticle(db);
    const comment = await open.inject({ method: "POST", url: `/api/v2/articles/${article.id}/comments`, payload: { body: "Anónimo", username: "Zé", recaptchaToken: "t" } });
    expect(comment.json()).toMatchObject({ username: "Zé", account: false });
    expect((await open.inject({ method: "POST", url: `/api/v2/articles/${article.id}/vote`, payload: { value: 1 } })).statusCode).toBe(200);
    await open.close();
  });
});
