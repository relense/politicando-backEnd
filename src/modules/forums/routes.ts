import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, comments, forumPosts, forumThreads, forumVotes, initiatives, parties, reports } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { posterId, reporterKey, voterKey } from "../../forums/identity.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { errorSchema } from "../shared.js";

export const GENERAL_BOARD = "geral";
/** Readers' ideas for the site, which the team answers with a status (see /feedback/ideias). */
export const IDEAS_BOARD = "ideias";
const OWN_BOARDS = [
  { board: GENERAL_BOARD, name: "Geral", acronym: null },
  { board: IDEAS_BOARD, name: "Ideias", acronym: null },
];
export const IDEA_STATUSES = ["reviewing", "planned", "in_progress", "done", "declined"] as const;
const MAX_INT = 2_147_483_647;

const nickname = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value) => value || null);
const recaptchaToken = z.string().min(1).max(4_096);
const idParams = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) });

const linkSchema = z.object({
  article: z.object({ id: z.number(), title: z.string() }).nullable(),
  initiative: z.object({ id: z.number(), title: z.string() }).nullable(),
});

const threadSummarySchema = z.object({
  id: z.number(),
  board: z.string(),
  title: z.string(),
  excerpt: z.string().describe("The opening post's first 300 characters"),
  nickname: z.string().nullable(),
  posterId: z.string().describe("The poster's ID in this thread"),
  replyCount: z.number(),
  createdAt: z.string(),
  bumpedAt: z.string().describe("Last reply"),
  pinned: z.boolean(),
  locked: z.boolean(),
  link: linkSchema,
  score: z.number().describe("Readers' upvotes"),
  status: z.enum(IDEA_STATUSES).nullable().describe("The team's verdict (ideas board): null until they look at it"),
  answer: z.string().nullable().describe("The team's public answer, if any"),
  answeredAt: z.string().nullable(),
});

const postSchema = z.object({
  id: z.number(),
  body: z.string().nullable().describe("Plain text; null when a moderator removed it"),
  nickname: z.string().nullable(),
  posterId: z.string().nullable(),
  isOp: z.boolean().describe("Posted by whoever opened the thread"),
  replyTo: z.number().nullable(),
  createdAt: z.string(),
  hidden: z.boolean(),
});

export const REPORT_REASONS = ["spam", "insult", "hate", "personal_data", "illegal", "other"] as const;
/** What can be wrong with a news article: our tagging or the item itself, not what the outlet wrote. */
export const ARTICLE_REPORT_REASONS = ["wrong_tags", "broken_link", "duplicate", "not_politics", "other"] as const;

export interface ForumRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  forumSecret: string;
  createLimitPerMinute: number;
}

const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

export const forumRoutes =
  ({ db, verifyRecaptcha, forumSecret, createLimitPerMinute }: ForumRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const checkHuman = async (token: string, ip: string, log: FastifyBaseLogger) => {
      let human: boolean;
      try {
        human = await verifyRecaptcha(token, ip);
      } catch (error) {
        log.error(error, "reCAPTCHA verification unavailable");
        throw new ApiError(503, "recaptcha_unavailable", "Posting is temporarily unavailable");
      }
      if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");
    };

    const assertBoard = async (board: string) => {
      if (OWN_BOARDS.some((b) => b.board === board)) return;
      const [party] = await db.select({ id: parties.id }).from(parties).where(eq(parties.slug, board));
      if (!party) throw notFound("Board");
    };

    type ThreadRow = {
      id: number; board: string; title: string; body: string; nickname: string | null; poster_id: string; reply_count: number;
      created_at: string; bumped_at: string; pinned: boolean; locked: boolean;
      score: number; status: (typeof IDEA_STATUSES)[number] | null; answer: string | null; answered_at: string | null;
      article_id: number | null; article_title: string | null; initiative_id: number | null; initiative_title: string | null;
    };
    const threadColumns = sql`t.id, t.board, t.title, t.body, t.nickname, t.poster_id, t.reply_count,
      ${iso("t.created_at")} as created_at, ${iso("t.bumped_at")} as bumped_at, t.pinned, t.locked_at is not null as locked,
      t.score, t.status, t.answer, ${iso("t.answered_at")} as answered_at,
      a.id as article_id, a.title as article_title, i.id as initiative_id, i.title as initiative_title`;
    const threadFrom = sql`forum_threads t
      left join articles a on a.id = t.article_id and a.hidden_at is null
      left join initiatives i on i.id = t.initiative_id`;
    const summary = (r: ThreadRow) => ({
      id: r.id, board: r.board, title: r.title, excerpt: r.body.length > 300 ? `${r.body.slice(0, 299)}…` : r.body,
      nickname: r.nickname, posterId: r.poster_id, replyCount: r.reply_count, createdAt: r.created_at, bumpedAt: r.bumped_at,
      pinned: r.pinned, locked: r.locked, score: r.score, status: r.status, answer: r.answer, answeredAt: r.answered_at,
      link: {
        article: r.article_id !== null ? { id: r.article_id, title: r.article_title! } : null,
        initiative: r.initiative_id !== null ? { id: r.initiative_id, title: r.initiative_title! } : null,
      },
    });

    app.get(
      "/forums",
      {
        schema: {
          tags: ["forums"],
          summary: "The boards: a general one, the ideas board, then one per party (by seats), with activity",
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  board: z.string(),
                  name: z.string(),
                  acronym: z.string().nullable(),
                  threads: z.number(),
                  posts: z.number().describe("Threads plus replies"),
                  lastActivity: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      async () => {
        const rows = await db.execute<{ board: string; threads: number; posts: number; last: string | null }>(sql`
          select t.board, count(*)::int as threads, (count(*) + coalesce(sum(t.reply_count), 0))::int as posts,
            ${iso("max(t.bumped_at)")} as last
          from forum_threads t where t.hidden_at is null group by t.board`);
        const stats = new Map(rows.rows.map((r) => [r.board, r]));
        const partyRows = await db
          .select({ slug: parties.slug, acronym: parties.acronym, name: parties.name, seats: parties.assemblySeats })
          .from(parties)
          .orderBy(sql`${parties.assemblySeats} desc`, parties.name);
        const boards = [
          ...OWN_BOARDS,
          ...partyRows.map((p) => ({ board: p.slug, name: p.name, acronym: p.acronym })),
        ];
        return {
          items: boards.map((b) => {
            const s = stats.get(b.board);
            return { ...b, threads: s?.threads ?? 0, posts: s?.posts ?? 0, lastActivity: s?.last ?? null };
          }),
        };
      },
    );

    app.get(
      "/forums/:board/threads",
      {
        schema: {
          tags: ["forums"],
          summary: "Threads on a board. Pinned threads come first",
          params: z.object({ board: z.string().regex(/^[a-z0-9-]{1,50}$/) }),
          querystring: z.object({
            sort: z.enum(["active", "new", "top"]).default("active").describe("active: last reply; new: newest; top: most upvoted (then most replies)"),
            status: z.enum(IDEA_STATUSES).optional().describe("Only threads the team gave this status (ideas board)"),
            page: z.coerce.number().int().min(1).max(1000).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(25),
          }),
          response: { 200: z.object({ items: z.array(threadSummarySchema), total: z.number() }), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const { board } = request.params;
        await assertBoard(board);
        const { sort, status, page, limit } = request.query;
        const order =
          sort === "new" ? sql`t.created_at desc` : sort === "top" ? sql`t.score desc, t.reply_count desc, t.bumped_at desc` : sql`t.bumped_at desc`;
        const where = sql`t.board = ${board} and t.hidden_at is null ${status ? sql`and t.status = ${status}` : sql``}`;
        const [rows, total] = await Promise.all([
          db.execute<ThreadRow>(sql`select ${threadColumns} from ${threadFrom} where ${where}
            order by t.pinned desc, ${order}, t.id desc limit ${limit} offset ${(page - 1) * limit}`),
          db.execute<{ n: number }>(sql`select count(*)::int as n from forum_threads t where ${where}`),
        ]);
        return { items: rows.rows.map(summary), total: total.rows[0]?.n ?? 0 };
      },
    );

    app.get(
      "/forums/threads/:id",
      {
        schema: {
          tags: ["forums"],
          summary: "A thread and its replies, oldest first",
          params: idParams,
          querystring: z.object({
            after: z.coerce.number().int().min(0).max(MAX_INT).default(0).describe("Replies with a larger id (for loading new ones)"),
            limit: z.coerce.number().int().min(1).max(500).default(200),
          }),
          response: {
            200: z.object({
              thread: threadSummarySchema.omit({ excerpt: true }).extend({ body: z.string() }),
              posts: z.array(postSchema),
              hasMore: z.boolean(),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const rows = await db.execute<ThreadRow>(sql`select ${threadColumns} from ${threadFrom} where t.id = ${request.params.id} and t.hidden_at is null`);
        const thread = rows.rows[0];
        if (!thread) throw notFound("Thread");
        const { after, limit } = request.query;
        const posts = await db.execute<{ id: number; body: string; nickname: string | null; poster_id: string; reply_to: number | null; created_at: string; hidden: boolean }>(sql`
          select p.id, p.body, p.nickname, p.poster_id, p.reply_to, ${iso("p.created_at")} as created_at, p.hidden_at is not null as hidden
          from forum_posts p where p.thread_id = ${thread.id} and p.id > ${after} order by p.id limit ${limit + 1}`);
        const { excerpt: _excerpt, ...rest } = summary(thread);
        return {
          thread: { ...rest, body: thread.body },
          posts: posts.rows.slice(0, limit).map((p) => ({
            id: p.id, body: p.hidden ? null : p.body, nickname: p.hidden ? null : p.nickname, posterId: p.hidden ? null : p.poster_id,
            isOp: !p.hidden && p.poster_id === thread.poster_id, replyTo: p.reply_to, createdAt: p.created_at, hidden: p.hidden,
          })),
          hasMore: posts.rows.length > limit,
        };
      },
    );

    const posting = { config: { rateLimit: { max: createLimitPerMinute, timeWindow: "1 minute" } } };

    app.post(
      "/forums/:board/threads",
      {
        ...posting,
        schema: {
          tags: ["forums"],
          summary: "Open a thread, anonymously",
          params: z.object({ board: z.string().regex(/^[a-z0-9-]{1,50}$/) }),
          body: z.strictObject({
            title: z.string().trim().min(3).max(150),
            body: z.string().trim().min(1).max(5_000),
            nickname,
            articleId: z.number().int().positive().max(MAX_INT).nullish(),
            initiativeId: z.number().int().positive().max(MAX_INT).nullish(),
            recaptchaToken,
          }),
          response: { 201: z.object({ id: z.number(), posterId: z.string() }), 400: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema },
        },
      },
      async (request, reply) => {
        const { board } = request.params;
        const { title, body, nickname: name, articleId, initiativeId } = request.body;
        await checkHuman(request.body.recaptchaToken, request.ip, request.log);
        await assertBoard(board);
        if (articleId) {
          const [found] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.id, articleId), isNull(articles.hiddenAt)));
          if (!found) throw notFound("Article");
        }
        if (initiativeId) {
          const [found] = await db.select({ id: initiatives.id }).from(initiatives).where(eq(initiatives.id, initiativeId));
          if (!found) throw notFound("Initiative");
        }
        const id = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(forumThreads)
            .values({ board, title, body, nickname: name, posterId: "", articleId: articleId ?? null, initiativeId: initiativeId ?? null })
            .returning({ id: forumThreads.id });
          await tx.update(forumThreads).set({ posterId: posterId(forumSecret, request.ip, created!.id) }).where(eq(forumThreads.id, created!.id));
          return created!.id;
        });
        return reply.status(201).send({ id, posterId: posterId(forumSecret, request.ip, id) });
      },
    );

    app.post(
      "/forums/threads/:id/posts",
      {
        ...posting,
        schema: {
          tags: ["forums"],
          summary: "Reply to a thread, anonymously",
          params: idParams,
          body: z.strictObject({
            body: z.string().trim().min(1).max(5_000),
            nickname,
            replyTo: z.number().int().positive().max(MAX_INT).nullish().describe("A post in this thread being answered"),
            recaptchaToken,
          }),
          response: {
            201: z.object({ id: z.number(), posterId: z.string() }),
            400: errorSchema,
            403: errorSchema,
            404: errorSchema,
            409: errorSchema,
            429: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const threadId = request.params.id;
        const { body, nickname: name, replyTo } = request.body;
        await checkHuman(request.body.recaptchaToken, request.ip, request.log);
        const [thread] = await db
          .select({ id: forumThreads.id, lockedAt: forumThreads.lockedAt })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, threadId), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        if (thread.lockedAt) throw new ApiError(409, "thread_locked", "This thread is closed to replies");
        if (replyTo) {
          const [quoted] = await db
            .select({ id: forumPosts.id })
            .from(forumPosts)
            .where(and(eq(forumPosts.id, replyTo), eq(forumPosts.threadId, threadId)));
          if (!quoted) throw new ApiError(400, "invalid_reply", "That post is not in this thread");
        }
        const poster = posterId(forumSecret, request.ip, threadId);
        const id = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(forumPosts)
            .values({ threadId, body, nickname: name, posterId: poster, replyTo: replyTo ?? null })
            .returning({ id: forumPosts.id });
          await tx
            .update(forumThreads)
            .set({ replyCount: sql`${forumThreads.replyCount} + 1`, bumpedAt: sql`now()` })
            .where(eq(forumThreads.id, threadId));
          return created!.id;
        });
        return reply.status(201).send({ id, posterId: poster });
      },
    );

    app.post(
      "/forums/threads/:id/vote",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["forums"],
          summary: "Upvote a thread. Once per reader: voting again returns the same score",
          params: idParams,
          response: { 200: z.object({ score: z.number() }), 400: errorSchema, 404: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        const threadId = request.params.id;
        const [thread] = await db
          .select({ id: forumThreads.id })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, threadId), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        return db.transaction(async (tx) => {
          const added = await tx
            .insert(forumVotes)
            .values({ threadId, voter: voterKey(forumSecret, request.ip, threadId) })
            .onConflictDoNothing()
            .returning({ threadId: forumVotes.threadId });
          const [row] = added.length
            ? await tx.update(forumThreads).set({ score: sql`${forumThreads.score} + 1` }).where(eq(forumThreads.id, threadId)).returning({ score: forumThreads.score })
            : await tx.select({ score: forumThreads.score }).from(forumThreads).where(eq(forumThreads.id, threadId));
          return { score: row!.score };
        });
      },
    );

    app.post(
      "/reports",
      {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
          tags: ["forums"],
          summary: "Report a thread, reply, comment or news article to the moderators",
          body: z.discriminatedUnion("kind", [
            z.strictObject({
              kind: z.enum(["thread", "post", "comment"]),
              id: z.number().int().positive().max(MAX_INT),
              reason: z.enum(REPORT_REASONS),
              details: z.string().trim().max(500).nullish(),
            }),
            z.strictObject({
              kind: z.literal("article"),
              id: z.number().int().positive().max(MAX_INT),
              reason: z.enum(ARTICLE_REPORT_REASONS),
              details: z.string().trim().max(500).nullish(),
            }),
          ]),
          response: { 202: z.null(), 400: errorSchema, 404: errorSchema, 429: errorSchema },
        },
      },
      async (request, reply) => {
        const { kind, id, reason, details } = request.body;
        const table = kind === "thread" ? forumThreads : kind === "post" ? forumPosts : kind === "article" ? articles : comments;
        const [found] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), isNull(table.hiddenAt)));
        if (!found) throw notFound(kind === "thread" ? "Thread" : kind === "post" ? "Post" : kind === "article" ? "Article" : "Comment");
        await db
          .insert(reports)
          .values({ kind, targetId: id, reason, details: details || null, reporter: reporterKey(forumSecret, request.ip) })
          .onConflictDoNothing();
        return reply.status(202).send(null);
      },
    );
  };
