import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../../admin/password.js";
import {
  READER_COOKIE,
  type Reader,
  createReaderSession,
  endReaderSession,
  endReaderSessions,
  readerCookieOptions,
} from "../../accounts/sessions.js";
import type { Db } from "../../db/client.js";
import {
  SAVE_KINDS,
  type SaveKind,
  articleVotes,
  commentLikes,
  comments,
  editorialPosts,
  editorialVotes,
  forumPosts,
  forumThreads,
  forumVotes,
  reports,
  storyVotes,
  userHidden,
  userMutes,
  userReads,
  userSaves,
  users,
} from "../../db/schema.js";
import { ApiError } from "../../errors.js";
import { assertPublishable } from "../../moderation/screen.js";
import { followsOf } from "../../notifications/index.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { errorSchema } from "../shared.js";

/*
 * Reader accounts: a username and a password (no email, so no reset by email either). The
 * session is an httpOnly cookie scoped to /api/v2. /me/* syncs what the site used to keep only
 * in the browser: saved, hidden and muted items, stories read, and the reader's own votes.
 */

const MAX_INT = 2_147_483_647;
/** The same caps the site keeps in the browser. */
export const CAPS = { saved: 500, hidden: 500, muted: 50, read: 200 } as const;
const RESERVED = new Set([
  "admin", "administrador", "administrator", "moderador", "moderator", "mod", "politicando", "redacao", "equipa", "staff",
  "suporte", "support", "root", "sistema", "system", "anonimo", "anonymous", "apagado", "deleted", "null", "undefined",
]);
/** Failed logins for one username before it's locked for a while. */
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,20}$/, "3 to 20 letters, digits or _");
const passwordSchema = z.string().min(8).max(200);
const userSchema = z.object({ id: z.number(), username: z.string(), createdAt: z.string() });
const idSchema = z.coerce.number().int().positive().max(MAX_INT);
const muteValue = { source: /^[a-z0-9.-]{1,100}$/, party: /^[a-z0-9-]{1,40}$/ } as const;

/** Where each kind of save goes in /me/state and /me/merge. */
const SAVED_LISTS = { article: "articles", story: "stories", editorial: "editorial", comment: "comments", thread: "threads", reply: "replies" } as const;

const stateSchema = z.object({
  saved: z
    .object({
      articles: z.array(z.number()),
      stories: z.array(z.number()),
      editorial: z.array(z.number()).describe("Blog post ids"),
      comments: z.array(z.number()),
      threads: z.array(z.number()).describe("Forum threads"),
      replies: z.array(z.number()).describe("Forum replies (posts in a thread)"),
    })
    .describe("Ids, newest first. GET /me/saved has the details"),
  hidden: z.array(z.number()).describe("Article ids, newest first"),
  muted: z.object({ sources: z.array(z.string()), parties: z.array(z.string()) }),
  read: z.array(z.number()).describe("Story ids, newest first"),
  follows: z.object({ stories: z.array(z.number()), threads: z.array(z.number()) }).describe('What the reader follows ("Seguir"), newest first'),
  votes: z.object({
    articles: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).describe("Article id → 1 or -1"),
    editorial: z.record(z.string(), z.literal(1)).describe('Blog posts marked "Importa": slug → 1'),
    stories: z.array(z.number()).describe('Stories marked "Importa"'),
    comments: z.array(z.number()).describe("Comments liked"),
    forum: z.array(z.number()).describe("Forum threads upvoted"),
  }),
});

const mergeSchema = z.strictObject({
  saved: z
    .strictObject(Object.fromEntries(Object.values(SAVED_LISTS).map((list) => [list, z.array(idSchema).max(CAPS.saved).default([])])) as Record<(typeof SAVED_LISTS)[SaveKind], z.ZodDefault<z.ZodArray<typeof idSchema>>>)
    .default({ articles: [], stories: [], editorial: [], comments: [], threads: [], replies: [] }),
  hidden: z.array(idSchema).max(CAPS.hidden).default([]),
  muted: z
    .strictObject({
      sources: z.array(z.string().regex(muteValue.source)).max(CAPS.muted).default([]),
      parties: z.array(z.string().regex(muteValue.party)).max(CAPS.muted).default([]),
    })
    .default({ sources: [], parties: [] }),
  read: z.array(idSchema).max(CAPS.read).default([]),
});

const errors = { 400: errorSchema, 401: errorSchema };
const pgCode = (error: unknown) => (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;

export interface AccountRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  secureCookies: boolean;
  loginLimitPerMinute?: number;
  registerLimitPerHour?: number;
}

export const accountRoutes =
  ({ db, verifyRecaptcha, secureCookies, loginLimitPerMinute = 5, registerLimitPerHour = 3 }: AccountRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const cookie = readerCookieOptions(secureCookies);
    const failures = new Map<string, { count: number; until: number }>();

    const requireReader = (request: FastifyRequest): Reader => {
      if (!request.reader) throw new ApiError(401, "unauthenticated", "Log in first");
      return request.reader;
    };

    const startSession = async (reply: FastifyReply, userId: number) => {
      const { token, expiresAt } = await createReaderSession(db, userId);
      reply.setCookie(READER_COOKIE, token, { ...cookie, expires: expiresAt });
    };

    const checkHuman = async (token: string, request: FastifyRequest) => {
      let human: boolean;
      try {
        human = await verifyRecaptcha(token, request.ip);
      } catch (error) {
        request.log.error(error, "reCAPTCHA verification unavailable");
        throw new ApiError(503, "recaptcha_unavailable", "Accounts are temporarily unavailable");
      }
      if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");
    };

    const publicUser = (u: { id: number; username: string; createdAt: Date }) => ({ id: u.id, username: u.username, createdAt: u.createdAt.toISOString() });

    /** Keeps the newest `cap` rows of one list. */
    const trim = async (table: "user_saves" | "user_hidden" | "user_mutes" | "user_reads", userId: number, cap: number, kind?: string) => {
      const byKind = kind ? sql`and kind = ${kind}` : sql``;
      await db.execute(sql`
        delete from ${sql.raw(table)} where user_id = ${userId} ${byKind} and ctid in (
          select ctid from ${sql.raw(table)} where user_id = ${userId} ${byKind} order by created_at desc offset ${cap})`);
    };

    const state = async (userId: number): Promise<z.infer<typeof stateSchema>> => {
      const [saves, hidden, mutes, reads, aVotes, eVotes, sVotes, likes, fVotes] = await Promise.all([
        db.select({ kind: userSaves.kind, id: userSaves.targetId }).from(userSaves).where(eq(userSaves.userId, userId)).orderBy(desc(userSaves.createdAt)),
        db.select({ id: userHidden.articleId }).from(userHidden).where(eq(userHidden.userId, userId)).orderBy(desc(userHidden.createdAt)),
        db.select({ kind: userMutes.kind, value: userMutes.value }).from(userMutes).where(eq(userMutes.userId, userId)).orderBy(desc(userMutes.createdAt)),
        db.select({ id: userReads.storyId }).from(userReads).where(eq(userReads.userId, userId)).orderBy(desc(userReads.createdAt)),
        db.select({ id: articleVotes.articleId, value: articleVotes.value }).from(articleVotes).where(eq(articleVotes.userId, userId)),
        db
          .select({ slug: editorialPosts.slug })
          .from(editorialVotes)
          .innerJoin(editorialPosts, eq(editorialPosts.id, editorialVotes.postId))
          .where(eq(editorialVotes.userId, userId)),
        db.select({ id: storyVotes.storyId }).from(storyVotes).where(eq(storyVotes.userId, userId)),
        db.select({ id: commentLikes.commentId }).from(commentLikes).where(eq(commentLikes.userId, userId)),
        db.select({ id: forumVotes.threadId }).from(forumVotes).where(eq(forumVotes.userId, userId)),
      ]);
      const vote = (v: number) => (v > 0 ? 1 : -1) as 1 | -1;
      return {
        saved: Object.fromEntries(SAVE_KINDS.map((kind) => [SAVED_LISTS[kind], saves.filter((s) => s.kind === kind).map((s) => s.id)])) as z.infer<typeof stateSchema>["saved"],
        hidden: hidden.map((h) => h.id),
        muted: { sources: mutes.filter((m) => m.kind === "source").map((m) => m.value), parties: mutes.filter((m) => m.kind === "party").map((m) => m.value) },
        read: reads.map((r) => r.id),
        follows: await followsOf(db, userId),
        votes: {
          articles: Object.fromEntries(aVotes.map((v) => [String(v.id), vote(v.value)])),
          editorial: Object.fromEntries(eVotes.map((v) => [v.slug, 1 as const])),
          stories: sVotes.map((v) => v.id),
          comments: likes.map((v) => v.id),
          forum: fVotes.map((v) => v.id),
        },
      };
    };

    // --- Logging in ---------------------------------------------------------------------

    app.post(
      "/auth/register",
      {
        config: { rateLimit: { max: registerLimitPerHour, timeWindow: "1 hour" } },
        schema: {
          tags: ["accounts"],
          summary: "Create an account and log in (sets an httpOnly session cookie scoped to /api/v2)",
          body: z.strictObject({ username: usernameSchema, password: passwordSchema, recaptchaToken: z.string().min(1).max(4_096) }),
          response: { 201: z.object({ user: userSchema }), 400: errorSchema, 403: errorSchema, 409: errorSchema, 429: errorSchema, 503: errorSchema },
        },
      },
      async (request, reply) => {
        const { username, password, recaptchaToken } = request.body;
        if (RESERVED.has(username.toLowerCase())) throw new ApiError(409, "username_taken", "That username is taken");
        assertPublishable(username);
        await checkHuman(recaptchaToken, request);
        let created;
        try {
          [created] = await db.insert(users).values({ username, passwordHash: await hashPassword(password), lastLoginAt: new Date() }).returning();
        } catch (error) {
          if (pgCode(error) === "23505") throw new ApiError(409, "username_taken", "That username is taken");
          throw error;
        }
        await startSession(reply, created!.id);
        return reply.status(201).send({ user: publicUser(created!) });
      },
    );

    app.post(
      "/auth/login",
      {
        config: { rateLimit: { max: loginLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["accounts"],
          summary: "Log in (sets an httpOnly session cookie scoped to /api/v2)",
          body: z.strictObject({ username: z.string().trim().max(40), password: z.string().max(200), recaptchaToken: z.string().min(1).max(4_096) }),
          response: { 200: z.object({ user: userSchema }), 400: errorSchema, 401: errorSchema, 403: errorSchema, 429: errorSchema, 503: errorSchema },
        },
      },
      async (request, reply) => {
        const { username, password, recaptchaToken } = request.body;
        const name = username.toLowerCase();
        const lock = failures.get(name);
        if (lock && lock.count >= LOCK_AFTER && lock.until > Date.now()) {
          throw new ApiError(429, "too_many_attempts", "Too many failed attempts: try again in a few minutes");
        }
        await checkHuman(recaptchaToken, request);
        const [user] = await db.select().from(users).where(sql`lower(${users.username}) = ${name}`);
        // Unknown names are checked against a dummy hash, so the time doesn't tell them apart.
        const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !ok || user.disabledAt) {
          const count = (lock && lock.until > Date.now() ? lock.count : 0) + 1;
          if (failures.size > 10_000) failures.clear();
          failures.set(name, { count, until: Date.now() + LOCK_MINUTES * 60_000 });
          throw new ApiError(401, "invalid_credentials", "Wrong username or password");
        }
        failures.delete(name);
        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
        await startSession(reply, user.id);
        return { user: publicUser(user) };
      },
    );

    app.post(
      "/auth/logout",
      { schema: { tags: ["accounts"], summary: "Log out (ends this session)", response: { 204: z.null() } } },
      async (request, reply) => {
        const token = request.cookies[READER_COOKIE];
        if (token) await endReaderSession(db, token);
        reply.clearCookie(READER_COOKIE, cookie);
        return reply.status(204).send(null);
      },
    );

    // --- The account -------------------------------------------------------------------

    app.get(
      "/me",
      { schema: { tags: ["accounts"], summary: "The logged-in reader, or 401", response: { 200: userSchema, 401: errorSchema } } },
      async (request) => {
        const reader = requireReader(request);
        const [user] = await db.select().from(users).where(eq(users.id, reader.id));
        return publicUser(user!);
      },
    );

    app.put(
      "/me/password",
      {
        config: { rateLimit: { max: loginLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["accounts"],
          summary: "Change the password; every other session is logged out",
          body: z.strictObject({ current: z.string().max(200), new: passwordSchema }),
          response: { 204: z.null(), ...errors, 429: errorSchema },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        const [user] = await db.select().from(users).where(eq(users.id, reader.id));
        if (!(await verifyPassword(request.body.current, user!.passwordHash))) throw new ApiError(401, "invalid_credentials", "Wrong password");
        await db.update(users).set({ passwordHash: await hashPassword(request.body.new) }).where(eq(users.id, reader.id));
        await endReaderSessions(db, reader.id, request.cookies[READER_COOKIE]);
        return reply.status(204).send(null);
      },
    );

    app.get(
      "/me/state",
      { schema: { tags: ["accounts"], summary: "Everything to sync: saved, hidden, muted, read, and the reader's own votes", response: { 200: stateSchema, 401: errorSchema } } },
      async (request) => state(requireReader(request).id),
    );

    app.post(
      "/me/merge",
      {
        schema: {
          tags: ["accounts"],
          summary: "Add what this browser kept before logging in (saved, hidden, muted, read). Returns the merged state",
          description: "Votes aren't merged: an anonymous vote already counts, so adding it to the account would count it twice.",
          body: mergeSchema,
          response: { 200: stateSchema, ...errors },
        },
      },
      async (request) => {
        const { id: userId } = requireReader(request);
        const { saved, hidden, muted, read } = request.body;
        // The browser's lists are newest first: keep that order in the stored dates.
        const at = (index: number) => new Date(Date.now() - index * 1000);
        const saves = SAVE_KINDS.flatMap((kind) => saved[SAVED_LISTS[kind]].map((targetId, i) => ({ userId, kind, targetId, createdAt: at(i) })));
        if (saves.length) await db.insert(userSaves).values(saves).onConflictDoNothing();
        if (hidden.length) await db.insert(userHidden).values(hidden.map((articleId, i) => ({ userId, articleId, createdAt: at(i) }))).onConflictDoNothing();
        const mutes = [
          ...muted.sources.map((value, i) => ({ userId, kind: "source" as const, value, createdAt: at(i) })),
          ...muted.parties.map((value, i) => ({ userId, kind: "party" as const, value, createdAt: at(i) })),
        ];
        if (mutes.length) await db.insert(userMutes).values(mutes).onConflictDoNothing();
        if (read.length) await db.insert(userReads).values(read.map((storyId, i) => ({ userId, storyId, createdAt: at(i) }))).onConflictDoNothing();
        for (const kind of SAVE_KINDS) await trim("user_saves", userId, CAPS.saved, kind);
        await trim("user_hidden", userId, CAPS.hidden);
        await trim("user_mutes", userId, CAPS.muted, "source");
        await trim("user_mutes", userId, CAPS.muted, "party");
        await trim("user_reads", userId, CAPS.read);
        return state(userId);
      },
    );

    // One endpoint per list; PUT adds (idempotent), DELETE removes.
    const savedParams = z.object({ kind: z.enum(SAVE_KINDS), id: idSchema });
    /** Only things readers can see can be saved. */
    const visible = (kind: SaveKind, id: number) =>
      ({
        article: sql`select 1 from articles where id = ${id} and hidden_at is null`,
        story: sql`select 1 from stories where id = ${id}`,
        editorial: sql`select 1 from editorial_posts where id = ${id} and status = 'published'`,
        comment: sql`select 1 from comments where id = ${id} and hidden_at is null`,
        thread: sql`select 1 from forum_threads where id = ${id} and hidden_at is null`,
        reply: sql`select 1 from forum_posts where id = ${id} and hidden_at is null`,
      })[kind];
    app.put(
      "/me/saved/:kind/:id",
      {
        schema: {
          tags: ["accounts"],
          summary: "Save a news article, a story, a blog post (by id), a comment, a forum thread or a forum reply",
          params: savedParams,
          response: { 204: z.null(), ...errors, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const { kind, id } = request.params;
        if ((await db.execute(visible(kind, id))).rows.length === 0) throw new ApiError(404, "not_found", "Nothing to save there");
        await db.insert(userSaves).values({ userId, kind, targetId: id }).onConflictDoNothing();
        await trim("user_saves", userId, CAPS.saved, kind);
        return reply.status(204).send(null);
      },
    );
    app.delete(
      "/me/saved/:kind/:id",
      { schema: { tags: ["accounts"], summary: "Unsave", params: savedParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const { kind, id } = request.params;
        await db.delete(userSaves).where(and(eq(userSaves.userId, userId), eq(userSaves.kind, kind), eq(userSaves.targetId, id)));
        return reply.status(204).send(null);
      },
    );

    const savedAt = z.string().describe("When the reader saved it");
    const savedSchema = z.object({
      editorial: z.array(z.object({ savedAt, id: z.number(), slug: z.string(), kind: z.string(), title: z.string(), subtitle: z.string().nullable(), coverImageUrl: z.string().nullable(), publishedAt: z.string().nullable() })),
      comments: z.array(
        z.object({
          savedAt,
          id: z.number(),
          body: z.string(),
          username: z.string().nullable(),
          likes: z.number(),
          createdAt: z.string(),
          articleId: z.number().nullable().describe("What it's on: one of articleId, storyId or postSlug"),
          storyId: z.number().nullable(),
          postSlug: z.string().nullable(),
        }),
      ),
      threads: z.array(z.object({ savedAt, id: z.number(), board: z.string(), title: z.string(), nickname: z.string().nullable(), score: z.number(), replyCount: z.number(), createdAt: z.string() })),
      replies: z.array(z.object({ savedAt, id: z.number(), threadId: z.number(), threadTitle: z.string(), board: z.string(), body: z.string(), nickname: z.string().nullable(), createdAt: z.string() })),
    });
    app.get(
      "/me/saved",
      {
        schema: {
          tags: ["accounts"],
          summary: "The saved blog posts, comments, forum threads and replies, with what's needed to show them, newest saved first",
          description: "News and stories are in /me/state as ids (the site already loads those). Things since hidden or deleted are left out.",
          response: { 200: savedSchema, 401: errorSchema },
        },
      },
      async (request) => {
        const { id: userId } = requireReader(request);
        const saved = (kind: SaveKind) => and(eq(userSaves.userId, userId), eq(userSaves.kind, kind));
        const [posts, ownComments, threads, replies] = await Promise.all([
          db
            .select({ savedAt: userSaves.createdAt, id: editorialPosts.id, slug: editorialPosts.slug, kind: editorialPosts.kind, title: editorialPosts.title, subtitle: editorialPosts.subtitle, coverImageUrl: editorialPosts.coverImageUrl, publishedAt: editorialPosts.publishedAt })
            .from(userSaves)
            .innerJoin(editorialPosts, and(eq(editorialPosts.id, userSaves.targetId), eq(editorialPosts.status, "published")))
            .where(saved("editorial"))
            .orderBy(desc(userSaves.createdAt)),
          db
            .select({ savedAt: userSaves.createdAt, id: comments.id, body: comments.body, username: comments.username, likes: comments.likes, createdAt: comments.createdAt, articleId: comments.articleId, storyId: comments.storyId, postSlug: editorialPosts.slug })
            .from(userSaves)
            .innerJoin(comments, and(eq(comments.id, userSaves.targetId), sql`${comments.hiddenAt} is null`))
            .leftJoin(editorialPosts, eq(editorialPosts.id, comments.editorialPostId))
            .where(saved("comment"))
            .orderBy(desc(userSaves.createdAt)),
          db
            .select({ savedAt: userSaves.createdAt, id: forumThreads.id, board: forumThreads.board, title: forumThreads.title, nickname: forumThreads.nickname, score: forumThreads.score, replyCount: forumThreads.replyCount, createdAt: forumThreads.createdAt })
            .from(userSaves)
            .innerJoin(forumThreads, and(eq(forumThreads.id, userSaves.targetId), sql`${forumThreads.hiddenAt} is null`))
            .where(saved("thread"))
            .orderBy(desc(userSaves.createdAt)),
          db
            .select({ savedAt: userSaves.createdAt, id: forumPosts.id, threadId: forumPosts.threadId, threadTitle: forumThreads.title, board: forumThreads.board, body: forumPosts.body, nickname: forumPosts.nickname, createdAt: forumPosts.createdAt })
            .from(userSaves)
            .innerJoin(forumPosts, and(eq(forumPosts.id, userSaves.targetId), sql`${forumPosts.hiddenAt} is null`))
            .innerJoin(forumThreads, and(eq(forumThreads.id, forumPosts.threadId), sql`${forumThreads.hiddenAt} is null`))
            .where(saved("reply"))
            .orderBy(desc(userSaves.createdAt)),
        ]);
        const iso = <T extends { savedAt: Date; createdAt?: Date; publishedAt?: Date | null }>(r: T) => ({
          ...r,
          savedAt: r.savedAt.toISOString(),
          ...(r.createdAt ? { createdAt: r.createdAt.toISOString() } : {}),
          ...("publishedAt" in r ? { publishedAt: r.publishedAt?.toISOString() ?? null } : {}),
        });
        return { editorial: posts.map(iso), comments: ownComments.map(iso), threads: threads.map(iso), replies: replies.map(iso) } as z.infer<typeof savedSchema>;
      },
    );

    const articleParams = z.object({ id: idSchema });
    app.put(
      "/me/hidden/:id",
      { schema: { tags: ["accounts"], summary: "Hide a news article from the reader's feed", params: articleParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        await db.insert(userHidden).values({ userId, articleId: request.params.id }).onConflictDoNothing();
        await trim("user_hidden", userId, CAPS.hidden);
        return reply.status(204).send(null);
      },
    );
    app.delete(
      "/me/hidden/:id",
      { schema: { tags: ["accounts"], summary: "Show it again", params: articleParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        await db.delete(userHidden).where(and(eq(userHidden.userId, userId), eq(userHidden.articleId, request.params.id)));
        return reply.status(204).send(null);
      },
    );

    const muteParams = z
      .object({ kind: z.enum(["source", "party"]), value: z.string().max(100) })
      .refine((p) => muteValue[p.kind].test(p.value), { message: "An outlet's domain or a party's slug", path: ["value"] });
    app.put(
      "/me/muted/:kind/:value",
      { schema: { tags: ["accounts"], summary: "Mute an outlet (by domain) or a party (by slug)", params: muteParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const { kind, value } = request.params;
        await db.insert(userMutes).values({ userId, kind, value }).onConflictDoNothing();
        await trim("user_mutes", userId, CAPS.muted, kind);
        return reply.status(204).send(null);
      },
    );
    app.delete(
      "/me/muted/:kind/:value",
      { schema: { tags: ["accounts"], summary: "Unmute", params: muteParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const { kind, value } = request.params;
        await db.delete(userMutes).where(and(eq(userMutes.userId, userId), eq(userMutes.kind, kind), eq(userMutes.value, value)));
        return reply.status(204).send(null);
      },
    );

    app.put(
      "/me/read/:id",
      { schema: { tags: ["accounts"], summary: "Mark a story read", params: articleParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        await db
          .insert(userReads)
          .values({ userId, storyId: request.params.id })
          .onConflictDoUpdate({ target: [userReads.userId, userReads.storyId], set: { createdAt: sql`now()` } });
        await trim("user_reads", userId, CAPS.read);
        return reply.status(204).send(null);
      },
    );

    // --- What they wrote ------------------------------------------------------------------

    const activity = async (userId: number, includeHidden: boolean) => {
      const visible = (hiddenAt: AnyPgColumn) => (includeHidden ? undefined : sql`${hiddenAt} is null`);
      const [ownComments, threads, posts] = await Promise.all([
        db
          .select({ id: comments.id, body: comments.body, articleId: comments.articleId, storyId: comments.storyId, postId: comments.editorialPostId, likes: comments.likes, createdAt: comments.createdAt, hiddenAt: comments.hiddenAt })
          .from(comments)
          .where(and(eq(comments.userId, userId), visible(comments.hiddenAt)))
          .orderBy(desc(comments.createdAt))
          .limit(includeHidden ? 10_000 : 100),
        db
          .select({ id: forumThreads.id, board: forumThreads.board, title: forumThreads.title, body: forumThreads.body, createdAt: forumThreads.createdAt, hiddenAt: forumThreads.hiddenAt })
          .from(forumThreads)
          .where(and(eq(forumThreads.userId, userId), visible(forumThreads.hiddenAt)))
          .orderBy(desc(forumThreads.createdAt))
          .limit(includeHidden ? 10_000 : 100),
        db
          .select({ id: forumPosts.id, threadId: forumPosts.threadId, body: forumPosts.body, createdAt: forumPosts.createdAt, hiddenAt: forumPosts.hiddenAt })
          .from(forumPosts)
          .where(and(eq(forumPosts.userId, userId), visible(forumPosts.hiddenAt)))
          .orderBy(desc(forumPosts.createdAt))
          .limit(includeHidden ? 10_000 : 100),
      ]);
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      return {
        comments: ownComments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString(), hiddenAt: iso(c.hiddenAt) })),
        threads: threads.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), hiddenAt: iso(t.hiddenAt) })),
        posts: posts.map((p) => ({ ...p, createdAt: p.createdAt.toISOString(), hiddenAt: iso(p.hiddenAt) })),
      };
    };
    const when = z.string();
    const activitySchema = z.object({
      comments: z.array(z.object({ id: z.number(), body: z.string(), articleId: z.number().nullable(), storyId: z.number().nullable(), postId: z.number().nullable(), likes: z.number(), createdAt: when, hiddenAt: when.nullable() })),
      threads: z.array(z.object({ id: z.number(), board: z.string(), title: z.string(), body: z.string(), createdAt: when, hiddenAt: when.nullable() })),
      posts: z.array(z.object({ id: z.number(), threadId: z.number(), body: z.string(), createdAt: when, hiddenAt: when.nullable() })),
    });

    app.get(
      "/me/activity",
      { schema: { tags: ["accounts"], summary: "The reader's own comments and forum posts, newest first (100 of each, visible ones)", response: { 200: activitySchema, 401: errorSchema } } },
      async (request) => activity(requireReader(request).id, false),
    );

    app.get(
      "/me/export",
      {
        schema: {
          tags: ["accounts"],
          summary: "Everything stored about the account, as JSON (GDPR access)",
          response: {
            200: z.object({
              user: userSchema.extend({ lastLoginAt: when.nullable() }),
              state: stateSchema,
              activity: activitySchema,
              reports: z.array(z.object({ kind: z.string(), targetId: z.number(), reason: z.string(), details: z.string().nullable(), createdAt: when })),
            }),
            401: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        const own = await db
          .select({ kind: reports.kind, targetId: reports.targetId, reason: reports.reason, details: reports.details, createdAt: reports.createdAt })
          .from(reports)
          .where(eq(reports.userId, userId));
        reply.header("Content-Disposition", 'attachment; filename="politicando-conta.json"').header("Cache-Control", "private, no-store");
        return {
          user: { ...publicUser(user!), lastLoginAt: user!.lastLoginAt?.toISOString() ?? null },
          state: await state(userId),
          activity: await activity(userId, true),
          reports: own.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        };
      },
    );

    app.delete(
      "/me",
      {
        config: { rateLimit: { max: loginLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["accounts"],
          summary: "Delete the account and its data (GDPR)",
          description:
            "Votes, likes and marks are taken off the counts; comments and forum replies are removed; threads they opened stay, blanked, so other people's replies keep their place.",
          body: z.strictObject({ password: z.string().max(200) }),
          response: { 204: z.null(), ...errors, 429: errorSchema },
        },
      },
      async (request, reply) => {
        const { id: userId } = requireReader(request);
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        if (!(await verifyPassword(request.body.password, user!.passwordHash))) throw new ApiError(401, "invalid_credentials", "Wrong password");
        await deleteAccount(db, userId);
        reply.clearCookie(READER_COOKIE, cookie);
        return reply.status(204).send(null);
      },
    );
  };

/** Removes an account: its votes come off the totals, its comments and replies go, its threads are blanked. */
export const deleteAccount = (db: Db, userId: number) =>
  db.transaction(async (tx) => {
    const ids = async <T extends { id: number }>(rows: Promise<T[]>) => [...new Set((await rows).map((r) => r.id))];
    const votedArticles = await ids(tx.delete(articleVotes).where(eq(articleVotes.userId, userId)).returning({ id: articleVotes.articleId }));
    const votedPosts = await ids(tx.delete(editorialVotes).where(eq(editorialVotes.userId, userId)).returning({ id: editorialVotes.postId }));
    const markedStories = await ids(tx.delete(storyVotes).where(eq(storyVotes.userId, userId)).returning({ id: storyVotes.storyId }));
    const likedComments = await ids(tx.delete(commentLikes).where(eq(commentLikes.userId, userId)).returning({ id: commentLikes.commentId }));
    const votedThreads = await ids(tx.delete(forumVotes).where(eq(forumVotes.userId, userId)).returning({ id: forumVotes.threadId }));
    if (votedArticles.length) {
      await tx.execute(sql`update articles a set
        upvotes = (select count(*)::int from article_votes v where v.article_id = a.id and v.value = 1),
        downvotes = (select count(*)::int from article_votes v where v.article_id = a.id and v.value = -1)
        where a.id in (${sql.join(votedArticles.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (votedPosts.length) {
      await tx.execute(sql`update editorial_posts p set importa = (select count(*)::int from editorial_votes v where v.post_id = p.id)
        where p.id in (${sql.join(votedPosts.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (markedStories.length) {
      await tx.execute(sql`update stories s set importa = (select count(*)::int from story_votes v where v.story_id = s.id)
        where s.id in (${sql.join(markedStories.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (likedComments.length) {
      await tx.execute(sql`update comments c set likes = (select count(*)::int from comment_likes l where l.comment_id = c.id)
        where c.id in (${sql.join(likedComments.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (votedThreads.length) {
      await tx.update(forumThreads).set({ score: sql`greatest(${forumThreads.score} - 1, 0)` }).where(inArray(forumThreads.id, votedThreads));
    }
    const now = new Date();
    await tx.update(comments).set({ body: "[apagado]", username: null, hiddenAt: now }).where(eq(comments.userId, userId));
    await tx.update(forumPosts).set({ body: "[apagado]", nickname: null, hiddenAt: now }).where(eq(forumPosts.userId, userId));
    await tx.update(forumThreads).set({ title: "[apagado]", body: "[apagado]", nickname: null }).where(eq(forumThreads.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
