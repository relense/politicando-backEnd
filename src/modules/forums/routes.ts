import { looksLikeTeam } from "../../accounts/reserved.js";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, comments, forumPostVotes, forumPosts, forumThreads, forumVotes, initiatives, parties, reports } from "../../db/schema.js";
import { escapeLike, searchWords } from "../articles/routes.js";
import { ApiError, notFound } from "../../errors.js";
import { posterId, reporterKey, voterKey } from "../../forums/identity.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { autoModerate } from "../../moderation/reports.js";
import { assertPublishable } from "../../moderation/screen.js";
import { follow, followers, notify } from "../../notifications/index.js";
import { VOTES_BOARD } from "../../predictions/rounds.js";
import { errorSchema } from "../shared.js";
import type { Participant } from "../../accounts/participant.js";

export const GENERAL_BOARD = "geral";
/** Readers' ideas for the site, which the team answers with a status (see /feedback/ideias). */
export const IDEAS_BOARD = "ideias";
const OWN_BOARDS = [
  { board: GENERAL_BOARD, name: "Geral", acronym: null },
  { board: IDEAS_BOARD, name: "Ideias", acronym: null },
  { board: VOTES_BOARD, name: "Votações", acronym: null },
];
export const IDEA_STATUSES = ["reviewing", "planned", "in_progress", "done", "declined", "duplicate"] as const;
/** How the team signs its replies (POST /admin/forum/threads/:id/posts). */
export const TEAM_NAME = "Politicando";
export const TEAM_POSTER_ID = "equipa";

/** Words too common to tell ideas apart. */
const STOPWORDS = new Set(
  "que para com uma uns umas dos das nos nas pelo pela pelos pelas por mais como nao sim ser ter seria era sao esta este isto esse essa isso aquilo quando onde qual quais muito pouco tambem sobre entre depois antes ate sem mas ou ja so the and"
    .split(" "),
);
/** The words of a search or a title worth matching: 3+ letters (or any number), common words left out unless that's all there is. */
export const ideaWords = (text: string, min = 3) => {
  const all = searchWords(text).filter((w) => w.length >= min || /\d/.test(w));
  const kept = all.filter((w) => !STOPWORDS.has(w));
  return kept.length ? kept : all;
};
const fold = (column: string) => sql.raw(`translate(lower(${column}), 'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny')`);
/** 2 points per word in the title, 1 in the body. */
const relevance = (words: string[]) =>
  sql.join(
    words.map((w) => {
      const like = `%${escapeLike(w)}%`;
      return sql`(case when ${fold("t.title")} like ${like} then 2 else 0 end + case when ${fold("t.body")} like ${like} then 1 else 0 end)`;
    }),
    sql` + `,
  );
const MAX_INT = 2_147_483_647;

const nickname = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value) => value || null)
  .refine((value) => value === null || !looksLikeTeam(value), "That name is the team's");
const recaptchaToken = z.string().min(1).max(4_096).optional().describe("Anonymous posts only (when login isn't required)");
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
  nickname: z.string().nullable().describe("The account's username when `account` is true"),
  account: z.boolean().describe("Opened by a logged-in reader"),
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
  expectedOn: z.string().nullable().describe("When the team expects it done (YYYY-MM-DD), if they said"),
  duplicateOf: z.object({ id: z.number(), title: z.string() }).nullable().describe('With status "duplicate": the idea it repeats'),
  area: z.string().nullable().describe("The part of the site an idea is about"),
  followers: z.number().describe("Logged-in readers following it"),
});

const postSchema = z.object({
  id: z.number(),
  body: z.string().nullable().describe("Plain text; null when a moderator removed it"),
  nickname: z.string().nullable().describe("The account's username when `account` is true"),
  account: z.boolean().describe("Written by a logged-in reader"),
  posterId: z.string().nullable(),
  isOp: z.boolean().describe("Posted by whoever opened the thread"),
  replyTo: z.number().nullable(),
  createdAt: z.string(),
  hidden: z.boolean(),
  pick: z.enum(["pass", "fail"]).nullable().describe('In a vote\'s megathread (board "votacoes"): the poster\'s "Passa ou chumba?" pick, shown as their side'),
  team: z.boolean().describe("Written by the team, signed as the team"),
  score: z.number().describe("Readers' votes (ideas board; 0 elsewhere)"),
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

/** Where a page of a thread's replies ended, in the order it was asked for ("top" also needs the score). */
const replyCursorSchema = z.strictObject({
  sort: z.enum(["old", "new", "top"]),
  id: z.number().int().min(0).max(MAX_INT),
  score: z.number().int().min(-MAX_INT).max(MAX_INT).optional(),
});
type ReplyCursor = z.infer<typeof replyCursorSchema>;
const encodeReplyCursor = (cursor: ReplyCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeReplyCursor = (value: string, sort: ReplyCursor["sort"]): ReplyCursor => {
  let cursor: ReplyCursor;
  try {
    cursor = replyCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
  if (cursor.sort !== sort || (sort === "top" && cursor.score === undefined)) throw new ApiError(400, "invalid_cursor", "The cursor is for another sort");
  return cursor;
};

const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

export const forumRoutes =
  ({ db, verifyRecaptcha, forumSecret, createLimitPerMinute }: ForumRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    /** Anonymous posters prove they're human; a logged-in reader's account does that. */
    const checkHuman = async (who: Participant, token: string | undefined, ip: string, log: FastifyBaseLogger) => {
      if (who.userId !== null) return;
      if (!token) throw new ApiError(400, "recaptcha_required", "reCAPTCHA token missing");
      let human: boolean;
      try {
        human = await verifyRecaptcha(token, ip);
      } catch (error) {
        log.error(error, "reCAPTCHA verification unavailable");
        throw new ApiError(503, "recaptcha_unavailable", "Posting is temporarily unavailable");
      }
      if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");
    };

    /** The ideas board needs an account to open or vote on an idea, whatever LOGIN_REQUIRED says. */
    const ideaAccount = (request: FastifyRequest) => {
      if (!request.reader) throw new ApiError(401, "login_required", "Log in to take part");
      return app.participant(request, "forum");
    };

    const assertBoard = async (board: string) => {
      if (OWN_BOARDS.some((b) => b.board === board)) return;
      const [party] = await db.select({ id: parties.id }).from(parties).where(eq(parties.slug, board));
      if (!party) throw notFound("Board");
    };

    type ThreadRow = {
      id: number; board: string; title: string; body: string; nickname: string | null; account: boolean; poster_id: string; reply_count: number;
      created_at: string; bumped_at: string; pinned: boolean; locked: boolean;
      score: number; status: (typeof IDEA_STATUSES)[number] | null; answer: string | null; answered_at: string | null;
      expected_on: string | null; duplicate_id: number | null; duplicate_title: string | null; area: string | null; followers: number;
      article_id: number | null; article_title: string | null; initiative_id: number | null; initiative_title: string | null;
    };
    const threadColumns = sql`t.id, t.board, t.title, t.body, t.nickname, t.user_id is not null as account, t.poster_id, t.reply_count,
      ${iso("t.created_at")} as created_at, ${iso("t.bumped_at")} as bumped_at, t.pinned, t.locked_at is not null as locked,
      t.score, t.status, t.answer, ${iso("t.answered_at")} as answered_at,
      to_char(t.expected_on, 'YYYY-MM-DD') as expected_on, d.id as duplicate_id, d.title as duplicate_title, t.area,
      (select count(*)::int from user_follows f where f.kind = 'thread' and f.target_id = t.id) as followers,
      a.id as article_id, a.title as article_title, i.id as initiative_id, i.title as initiative_title`;
    const threadFrom = sql`forum_threads t
      left join articles a on a.id = t.article_id and a.hidden_at is null
      left join initiatives i on i.id = t.initiative_id
      left join forum_threads d on d.id = t.duplicate_of and d.hidden_at is null`;
    const summary = (r: ThreadRow) => ({
      id: r.id, board: r.board, title: r.title, excerpt: r.body.length > 300 ? `${r.body.slice(0, 299)}…` : r.body,
      nickname: r.nickname, account: r.account, posterId: r.poster_id, replyCount: r.reply_count, createdAt: r.created_at, bumpedAt: r.bumped_at,
      pinned: r.pinned, locked: r.locked, score: r.score, status: r.status, answer: r.answer, answeredAt: r.answered_at,
      expectedOn: r.expected_on, duplicateOf: r.duplicate_id !== null ? { id: r.duplicate_id, title: r.duplicate_title! } : null,
      area: r.area, followers: r.followers,
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
          summary: "Threads on a board. Pinned threads come first, except in a search",
          params: z.object({ board: z.string().regex(/^[a-z0-9-]{1,50}$/) }),
          querystring: z.object({
            sort: z.enum(["active", "new", "top"]).default("active").describe("active: last reply; new: newest; top: most upvoted (then most replies)"),
            status: z.enum(IDEA_STATUSES).optional().describe("Only threads the team gave this status (ideas board)"),
            q: z.string().trim().min(3).max(200).optional().describe("Words in the title or body, ignoring accents and case; most relevant first, then most voted"),
            page: z.coerce.number().int().min(1).max(1000).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(25),
          }),
          response: { 200: z.object({ items: z.array(threadSummarySchema), total: z.number() }), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const { board } = request.params;
        await assertBoard(board);
        const { sort, status, q, page, limit } = request.query;
        const words = q ? ideaWords(q) : [];
        if (q && words.length === 0) return { items: [], total: 0 };
        const rank = words.length ? relevance(words) : null;
        const order = rank
          ? sql`${rank} desc, t.score desc`
          : sql`t.pinned desc, ${sort === "new" ? sql`t.created_at desc` : sort === "top" ? sql`t.score desc, t.reply_count desc, t.bumped_at desc` : sql`t.bumped_at desc`}`;
        const where = sql`t.board = ${board} and t.hidden_at is null ${status ? sql`and t.status = ${status}` : sql``} ${rank ? sql`and ${rank} > 0` : sql``}`;
        const [rows, total] = await Promise.all([
          db.execute<ThreadRow>(sql`select ${threadColumns} from ${threadFrom} where ${where}
            order by ${order}, t.id desc limit ${limit} offset ${(page - 1) * limit}`),
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
            cursor: z.string().max(200).optional().describe("The previous page's nextCursor, with the same sort: the next page of replies"),
            limit: z.coerce.number().int().min(1).max(500).default(200),
            sort: z
              .enum(["old", "top", "new"])
              .default("old")
              .describe("old: oldest first (default); new: newest first; top: most voted, then oldest (ideas board only; elsewhere it's old)"),
          }),
          response: {
            200: z.object({
              thread: threadSummarySchema.omit({ excerpt: true }).extend({
                body: z.string(),
                statusHistory: z
                  .array(z.object({ status: z.enum(IDEA_STATUSES).nullable(), at: z.string() }))
                  .describe("The idea's status over time, oldest first, starting with { status: null, at: createdAt }"),
              }),
              posts: z.array(postSchema),
              hasMore: z.boolean(),
              nextCursor: z.string().nullable().describe("Pass as ?cursor= (same sort) for the next page; null when there's no more"),
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
        const sort = request.query.sort === "top" && thread.board !== IDEAS_BOARD ? "old" : request.query.sort;
        const order = sort === "new" ? sql`p.id desc` : sort === "top" ? sql`p.score desc, p.id` : sql`p.id`;
        const cursor = request.query.cursor === undefined ? null : decodeReplyCursor(request.query.cursor, sort);
        // The next page starts after the last reply of this one, in this order.
        const from = !cursor
          ? sql``
          : sort === "new"
            ? sql`and p.id < ${cursor.id}`
            : sort === "top"
              ? sql`and (p.score < ${cursor.score ?? 0} or (p.score = ${cursor.score ?? 0} and p.id > ${cursor.id}))`
              : sql`and p.id > ${cursor.id}`;
        const [posts, changes] = await Promise.all([
          db.execute<{
            id: number; body: string; nickname: string | null; account: boolean; poster_id: string; reply_to: number | null; created_at: string; hidden: boolean;
            pick: "pass" | "fail" | null; team: boolean; score: number;
          }>(sql`
            select p.id, p.body, p.nickname, p.user_id is not null as account, p.poster_id, p.reply_to, ${iso("p.created_at")} as created_at, p.hidden_at is not null as hidden,
              pr.pick, p.team, p.score
            from forum_posts p
            left join predictions pr on pr.initiative_id = ${thread.board === VOTES_BOARD ? thread.initiative_id : null} and pr.user_id = p.user_id
            where p.thread_id = ${thread.id} and p.id > ${after} ${from} order by ${order} limit ${limit + 1}`),
          db.execute<{ status: (typeof IDEA_STATUSES)[number] | null; at: string }>(sql`
            select status, ${iso("at")} as at from forum_status_changes where thread_id = ${thread.id} order by at, id`),
        ]);
        const { excerpt: _excerpt, ...rest } = summary(thread);
        const hasMore = posts.rows.length > limit;
        const last = posts.rows[limit - 1];
        return {
          thread: { ...rest, body: thread.body, statusHistory: [{ status: null, at: thread.created_at }, ...changes.rows] },
          posts: posts.rows.slice(0, limit).map((p) => ({
            id: p.id, body: p.hidden ? null : p.body, nickname: p.hidden ? null : p.nickname, account: !p.hidden && p.account, posterId: p.hidden ? null : p.poster_id,
            isOp: !p.hidden && !p.team && p.poster_id === thread.poster_id, replyTo: p.reply_to, createdAt: p.created_at, hidden: p.hidden,
            pick: p.hidden ? null : p.pick, team: !p.hidden && p.team, score: p.score,
          })),
          hasMore,
          nextCursor: hasMore && last ? encodeReplyCursor({ sort, id: last.id, ...(sort === "top" && { score: last.score }) }) : null,
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
            area: z
              .string()
              .trim()
              .max(100)
              .nullish()
              .transform((value) => value || null)
              .describe('Ideas: the part of the site it\'s about, as the feedback form\'s "page"'),
            recaptchaToken,
          }),
          response: {
            201: z.object({ id: z.number(), posterId: z.string() }),
            400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { board } = request.params;
        const who = board === IDEAS_BOARD ? ideaAccount(request) : app.participant(request, "forum");
        const { title, body, articleId, initiativeId, area } = request.body;
        const name = who.username ?? request.body.nickname;
        assertPublishable(title, body, name);
        await checkHuman(who, request.body.recaptchaToken, request.ip, request.log);
        await assertBoard(board);
        if (board === VOTES_BOARD) throw new ApiError(403, "board_closed", "Vote threads open on their own when a vote is on the agenda");
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
            .values({ board, title, body, nickname: name, userId: who.userId, posterId: "", articleId: articleId ?? null, initiativeId: initiativeId ?? null, area, score: 1 })
            .returning({ id: forumThreads.id });
          await tx.update(forumThreads).set({ posterId: posterId(forumSecret, who.key, created!.id) }).where(eq(forumThreads.id, created!.id));
          // A thread starts with its author's own upvote, as if they'd voted for it themselves.
          await tx.insert(forumVotes).values({ threadId: created!.id, voter: voterKey(forumSecret, who.key, created!.id), userId: who.userId });
          return created!.id;
        });
        if (who.userId !== null) {
          try {
            await follow(db, who.userId, "thread", id);
          } catch (error) {
            request.log.error(error, "follow failed");
          }
        }
        return reply.status(201).send({ id, posterId: posterId(forumSecret, who.key, id) });
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
        const who = app.participant(request, "forum");
        const { body, replyTo } = request.body;
        const name = who.username ?? request.body.nickname;
        assertPublishable(body, name);
        await checkHuman(who, request.body.recaptchaToken, request.ip, request.log);
        const [thread] = await db
          .select({ id: forumThreads.id, lockedAt: forumThreads.lockedAt, board: forumThreads.board })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, threadId), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        if (thread.lockedAt) throw new ApiError(409, "thread_locked", "This thread is closed to replies");
        let quotedUserId: number | null = null;
        if (replyTo) {
          const [quoted] = await db
            .select({ id: forumPosts.id, userId: forumPosts.userId, hidden: sql<boolean>`${forumPosts.hiddenAt} is not null` })
            .from(forumPosts)
            .where(and(eq(forumPosts.id, replyTo), eq(forumPosts.threadId, threadId)));
          if (!quoted) throw new ApiError(400, "invalid_reply", "That post is not in this thread");
          // A moderated post can still be quoted, but its author isn't called back to it.
          quotedUserId = quoted.hidden ? null : quoted.userId;
        }
        const poster = posterId(forumSecret, who.key, threadId);
        // On the ideas board a reply starts with its author's own vote (replies' votes need an account).
        const ownVote = thread.board === IDEAS_BOARD ? who.userId : null;
        const id = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(forumPosts)
            .values({ threadId, body, nickname: name, userId: who.userId, posterId: poster, replyTo: replyTo ?? null, score: ownVote === null ? 0 : 1 })
            .returning({ id: forumPosts.id });
          if (ownVote !== null) await tx.insert(forumPostVotes).values({ postId: created!.id, userId: ownVote });
          await tx
            .update(forumThreads)
            .set({ replyCount: sql`${forumThreads.replyCount} + 1`, bumpedAt: sql`now()` })
            .where(eq(forumThreads.id, threadId));
          return created!.id;
        });
        // Best effort: the one answered hears it as a reply, the thread's followers as news.
        try {
          const answered = quotedUserId !== null && quotedUserId !== who.userId ? quotedUserId : null;
          if (answered !== null) await notify(db, { userIds: [answered], kind: "forum_reply", targetId: id, actorName: name });
          const others = (await followers(db, "thread", threadId)).filter((userId) => userId !== who.userId && userId !== answered);
          await notify(db, { userIds: others, kind: "thread_update", targetId: threadId, actorName: name });
          if (who.userId !== null) await follow(db, who.userId, "thread", threadId);
        } catch (error) {
          request.log.error(error, "forum notification failed");
        }
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
          description: "On the ideas board it needs an account, follows the idea, and a vote on a duplicate counts on the original too.",
          params: idParams,
          response: { 200: z.object({ score: z.number() }), 400: errorSchema, 401: errorSchema, 404: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        const threadId = request.params.id;
        const [thread] = await db
          .select({ id: forumThreads.id, board: forumThreads.board, duplicateOf: forumThreads.duplicateOf })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, threadId), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        const idea = thread.board === IDEAS_BOARD;
        const who = idea ? ideaAccount(request) : app.participant(request, "votes");
        const result = await db.transaction(async (tx) => {
          const voter = voterKey(forumSecret, who.key, threadId);
          const added = await tx
            .insert(forumVotes)
            .values({ threadId, voter, userId: who.userId })
            .onConflictDoNothing()
            .returning({ threadId: forumVotes.threadId });
          // Already counted, carried over from a duplicate this reader voted on: it's now their own
          // vote here too, so unmarking the duplicate later doesn't take it away.
          if (!added.length) {
            await tx
              .update(forumVotes)
              .set({ fromThreadId: null })
              .where(and(eq(forumVotes.threadId, threadId), eq(forumVotes.voter, voter), isNotNull(forumVotes.fromThreadId)));
          }
          const [row] = added.length
            ? await tx.update(forumThreads).set({ score: sql`${forumThreads.score} + 1` }).where(eq(forumThreads.id, threadId)).returning({ score: forumThreads.score })
            : await tx.select({ score: forumThreads.score }).from(forumThreads).where(eq(forumThreads.id, threadId));
          if (added.length && idea && thread.duplicateOf !== null) {
            const original = thread.duplicateOf;
            const copied = await tx
              .insert(forumVotes)
              .values({ threadId: original, voter: voterKey(forumSecret, who.key, original), userId: who.userId, fromThreadId: threadId })
              .onConflictDoNothing()
              .returning({ threadId: forumVotes.threadId });
            if (copied.length) await tx.update(forumThreads).set({ score: sql`${forumThreads.score} + 1` }).where(eq(forumThreads.id, original));
          }
          return { score: row!.score };
        });
        if (idea && who.userId !== null) {
          try {
            await follow(db, who.userId, "thread", threadId);
          } catch (error) {
            request.log.error(error, "follow failed");
          }
        }
        return result;
      },
    );

    app.get(
      "/forums/threads/:id/similar",
      {
        schema: {
          tags: ["forums"],
          summary: "Threads on the same board that look like this one (by the words of its title), most alike first, then most voted",
          params: idParams,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(10).default(3) }),
          response: { 200: z.object({ items: z.array(threadSummarySchema) }), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const [thread] = await db
          .select({ id: forumThreads.id, board: forumThreads.board, title: forumThreads.title })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, request.params.id), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        const words = ideaWords(thread.title, 4);
        if (words.length === 0) return { items: [] };
        const rank = relevance(words);
        // At least one word in the title, or two in the body: one shared word in passing isn't "alike".
        const rows = await db.execute<ThreadRow>(sql`select ${threadColumns} from ${threadFrom}
          where t.board = ${thread.board} and t.hidden_at is null and t.id <> ${thread.id} and ${rank} >= 2
          order by ${rank} desc, t.score desc, t.id desc limit ${request.query.limit}`);
        return { items: rows.rows.map(summary) };
      },
    );

    app.post(
      "/forums/posts/:id/vote",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["forums"],
          summary: "Vote for a reply on the ideas board. Needs an account; once per reader, no undo",
          params: idParams,
          response: { 200: z.object({ score: z.number() }), 400: errorSchema, 401: errorSchema, 404: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        const reader = request.reader;
        if (!reader) throw new ApiError(401, "login_required", "Log in to take part");
        const [post] = await db
          .select({ id: forumPosts.id, board: forumThreads.board })
          .from(forumPosts)
          .innerJoin(forumThreads, eq(forumThreads.id, forumPosts.threadId))
          .where(and(eq(forumPosts.id, request.params.id), isNull(forumPosts.hiddenAt), isNull(forumThreads.hiddenAt)));
        if (!post) throw notFound("Post");
        // Discussion elsewhere goes by activity, never popularity: only ideas' replies get votes.
        if (post.board !== IDEAS_BOARD) throw new ApiError(400, "not_an_idea", "Only replies on the ideas board take votes");
        return db.transaction(async (tx) => {
          const added = await tx.insert(forumPostVotes).values({ postId: post.id, userId: reader.id }).onConflictDoNothing().returning({ postId: forumPostVotes.postId });
          const [row] = added.length
            ? await tx.update(forumPosts).set({ score: sql`${forumPosts.score} + 1` }).where(eq(forumPosts.id, post.id)).returning({ score: forumPosts.score })
            : await tx.select({ score: forumPosts.score }).from(forumPosts).where(eq(forumPosts.id, post.id));
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
        const who = app.participant(request, "reports");
        const { kind, id, reason, details } = request.body;
        const table = kind === "thread" ? forumThreads : kind === "post" ? forumPosts : kind === "article" ? articles : comments;
        const [found] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), isNull(table.hiddenAt)));
        if (!found) throw notFound(kind === "thread" ? "Thread" : kind === "post" ? "Post" : kind === "article" ? "Article" : "Comment");
        // One report per account, or per connection when logged out, each kept as its sender wrote
        // it (a shared connection's anonymous report never becomes an account's). Only accounts
        // count toward hiding.
        await db
          .insert(reports)
          .values({ kind, targetId: id, reason, details: details || null, reporter: reporterKey(forumSecret, who.key), userId: who.userId })
          .onConflictDoNothing();
        await autoModerate(db, kind, id);
        return reply.status(202).send(null);
      },
    );
  };
