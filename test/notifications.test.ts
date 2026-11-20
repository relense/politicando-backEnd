import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { comments, forumPosts, notifications, stories, storyMerges } from "../src/db/schema.js";
import { pruneNotifications } from "../src/notifications/index.js";
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

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url: `/api/v2${url}`, payload, headers: cookie ? { cookie: `politicando_session=${cookie}` } : {} });

const register = async (username: string) => {
  const response = await call("POST", "/auth/register", undefined, { username, password: "palavra-passe", recaptchaToken: "t" });
  return response.cookies.find((c) => c.name === "politicando_session")!.value;
};
const unread = async (cookie: string) => (await call("GET", "/me/notifications/unread", cookie)).json().count as number;
const inbox = async (cookie: string) => (await call("GET", "/me/notifications", cookie)).json().items;

describe("reply notifications", () => {
  it("tells a commenter about replies, but not about their own, nor anonymous commenters", async () => {
    const [ana, rui] = [await register("ana"), await register("rui")];
    const article = await insertArticle(db, { sourceUri: "n1" }, []);
    const first = (await call("POST", `/articles/${article.id}/comments`, ana, { body: "Primeiro comentário" })).json();
    await call("POST", `/articles/${article.id}/comments`, ana, { body: "Eu outra vez", parentId: first.id });
    expect(await unread(ana)).toBe(0);

    const reply = (await call("POST", `/articles/${article.id}/comments`, rui, { body: "Discordo de ti", parentId: first.id })).json();
    expect(await unread(ana)).toBe(1);
    expect(await inbox(ana)).toEqual([
      expect.objectContaining({
        kind: "comment_reply", actorName: "rui", snippet: "Discordo de ti", read: false, count: 1,
        link: expect.objectContaining({ commentId: reply.id, articleId: article.id }),
      }),
    ]);
    expect(await unread(rui)).toBe(0);

    // A comment from before accounts has nobody to tell.
    const [old] = await db.insert(comments).values({ articleId: article.id, username: "anónimo", body: "Antigo" }).returning();
    await call("POST", `/articles/${article.id}/comments`, rui, { body: "Resposta", parentId: old!.id });
    expect(await db.select().from(notifications)).toHaveLength(1);

    // Hidden by a moderator: gone from the inbox and the count.
    await db.update(comments).set({ hiddenAt: new Date() }).where(eq(comments.id, reply.id));
    expect(await unread(ana)).toBe(0);
    expect(await inbox(ana)).toEqual([]);
  });

  it("tells the one answered in the forum, and followers of the thread once, coalesced", async () => {
    const [ana, rui, eva] = [await register("ana"), await register("rui"), await register("eva")];
    const thread = (await call("POST", "/forums/geral/threads", ana, { title: "Orçamento", body: "Que acham?" })).json();
    const evaPost = (await call("POST", `/forums/threads/${thread.id}/posts`, eva, { body: "Acho bem" })).json();
    expect(await unread(ana)).toBe(1); // Ana follows her own thread.

    await call("POST", `/forums/threads/${thread.id}/posts`, rui, { body: "Não concordo, Eva", replyTo: evaPost.id });
    // Eva hears it as a reply to her (not also as thread news); Ana as more thread news.
    expect(await inbox(eva)).toEqual([expect.objectContaining({ kind: "forum_reply", actorName: "rui", link: expect.objectContaining({ threadId: thread.id }) })]);
    expect(await inbox(ana)).toEqual([expect.objectContaining({ kind: "thread_update", count: 2, actorName: "rui", threadTitle: "Orçamento", board: "geral" })]);

    // Read, then a new reply starts a new line; Rui now follows too (he replied).
    await call("POST", "/me/notifications/read", ana, {});
    expect(await unread(ana)).toBe(0);
    await call("POST", `/forums/threads/${thread.id}/posts`, eva, { body: "Mais uma" });
    expect(await unread(ana)).toBe(1);
    expect(await unread(rui)).toBe(1);
    expect(await inbox(ana)).toHaveLength(2);

    // Eva wrote the last reply herself, so she has only Rui's answer; hiding it drops it.
    const [post] = await db.select().from(forumPosts).where(eq(forumPosts.body, "Não concordo, Eva"));
    await db.update(forumPosts).set({ hiddenAt: new Date() }).where(eq(forumPosts.id, post!.id));
    expect(await inbox(eva)).toEqual([]);
  });
});

describe("following", () => {
  it("follows and unfollows threads and stories, listed in /me/state", async () => {
    const ana = await register("ana");
    const rui = await register("rui");
    const thread = (await call("POST", "/forums/geral/threads", rui, { title: "Saúde", body: "Pacto?" })).json();
    expect((await call("PUT", `/me/follows/thread/${thread.id}`, ana)).statusCode).toBe(204);
    expect((await call("PUT", "/me/follows/story/999", ana)).statusCode).toBe(404);
    expect((await call("PUT", `/me/follows/thread/${thread.id}`)).statusCode).toBe(401);
    expect((await call("GET", "/me/state", ana)).json().follows).toEqual({ stories: [], threads: [thread.id] });

    await call("POST", `/forums/threads/${thread.id}/posts`, rui, { body: "Alguém?" });
    expect(await unread(ana)).toBe(1);
    await call("DELETE", `/me/follows/thread/${thread.id}`, ana);
    await call("POST", "/me/notifications/read", ana, {});
    await call("POST", `/forums/threads/${thread.id}/posts`, rui, { body: "Olá?" });
    expect(await unread(ana)).toBe(0);
  });

  it("follows and unfollows a merged story by its old id, under the story it went into", async () => {
    const ana = await register("ana");
    const [into] = await db.insert(stories).values({ title: "Uma história" } as typeof stories.$inferInsert).returning();
    await insertArticle(db, { storyId: into!.id });
    await db.insert(storyMerges).values({ fromId: 999_001, intoId: into!.id, reason: "model" });
    expect((await call("PUT", "/me/follows/story/999001", ana)).statusCode).toBe(204);
    expect((await call("GET", "/me/state", ana)).json().follows.stories).toEqual([into!.id]);
    expect((await call("DELETE", "/me/follows/story/999001", ana)).statusCode).toBe(204);
    expect((await call("GET", "/me/state", ana)).json().follows.stories).toEqual([]);
  });

  it("keeps the inbox private, pages it, and prunes old notifications", async () => {
    expect((await call("GET", "/me/notifications")).statusCode).toBe(401);
    const ana = await register("ana");
    const rui = await register("rui");
    const article = await insertArticle(db, { sourceUri: "n2" }, []);
    const mine = (await call("POST", `/articles/${article.id}/comments`, ana, { body: "Olá" })).json();
    for (let i = 0; i < 32; i++) await call("POST", `/articles/${article.id}/comments`, rui, { body: `Resposta ${i}`, parentId: mine.id });
    const first = (await call("GET", "/me/notifications", ana)).json();
    expect(first.items).toHaveLength(30);
    const second = (await call("GET", `/me/notifications?cursor=${encodeURIComponent(first.nextCursor)}`, ana)).json();
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    for (const bad of ["1_1", "nope", "2026-02-30T10:00:00.000000Z_5", "2026-11-20T10:00:00.000000Z_99999999999", `${first.nextCursor}x`]) {
      const response = await call("GET", `/me/notifications?cursor=${encodeURIComponent(bad)}`, ana);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_cursor");
    }

    await db.update(notifications).set({ createdAt: sql`now() - interval '91 days'` }).where(sql`true`);
    expect(await pruneNotifications(db)).toBe(32);
  });
});
