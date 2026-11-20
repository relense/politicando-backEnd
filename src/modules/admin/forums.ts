import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { adminGuard, audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { articles, comments, forumPosts, forumStatusChanges, forumThreads, forumVotes, reports } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { voterKey } from "../../forums/identity.js";
import { followers, notify } from "../../notifications/index.js";
import { assertPublishable } from "../../moderation/screen.js";
import { IDEA_STATUSES, IDEAS_BOARD, TEAM_NAME, TEAM_POSTER_ID } from "../forums/routes.js";
import { dismissReports, tableOf } from "../../moderation/reports.js";
import { errorSchema } from "../shared.js";

/* Forum moderation and the reports queue (role moderator). Every action is audited. */

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };
const kindSchema = z.enum(["thread", "post", "comment", "article"]);
type Kind = z.infer<typeof kindSchema>;


export const adminForumRoutes =
  (db: Db, forumSecret: string): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    /** What a report points at, for the moderator to judge without leaving the queue. */
    const targets = async (kind: Kind, ids: number[]) => {
      const map = new Map<
        number,
        { text: string; hidden: boolean; threadId: number | null; articleId: number | null; postId: number | null; storyId?: number | null }
      >();
      if (ids.length === 0) return map;
      if (kind === "thread") {
        const rows = await db
          .select({ id: forumThreads.id, title: forumThreads.title, body: forumThreads.body, hiddenAt: forumThreads.hiddenAt })
          .from(forumThreads)
          .where(inArray(forumThreads.id, ids));
        for (const r of rows) map.set(r.id, { text: `${r.title}\n\n${r.body}`, hidden: r.hiddenAt !== null, threadId: r.id, articleId: null, postId: null });
      } else if (kind === "post") {
        const rows = await db
          .select({ id: forumPosts.id, body: forumPosts.body, hiddenAt: forumPosts.hiddenAt, threadId: forumPosts.threadId })
          .from(forumPosts)
          .where(inArray(forumPosts.id, ids));
        for (const r of rows) map.set(r.id, { text: r.body, hidden: r.hiddenAt !== null, threadId: r.threadId, articleId: null, postId: null });
      } else if (kind === "article") {
        const rows = await db
          .select({ id: articles.id, title: articles.title, excerpt: articles.excerpt, url: articles.url, hiddenAt: articles.hiddenAt })
          .from(articles)
          .where(inArray(articles.id, ids));
        for (const r of rows) {
          map.set(r.id, { text: `${r.title}\n\n${r.excerpt}\n\n${r.url}`, hidden: r.hiddenAt !== null, threadId: null, articleId: r.id, postId: null });
        }
      } else {
        const rows = await db
          .select({
            id: comments.id, body: comments.body, hiddenAt: comments.hiddenAt, articleId: comments.articleId, postId: comments.editorialPostId,
            storyId: comments.storyId,
          })
          .from(comments)
          .where(inArray(comments.id, ids));
        for (const r of rows) {
          map.set(r.id, { text: r.body, hidden: r.hiddenAt !== null, threadId: null, articleId: r.articleId, postId: r.postId, storyId: r.storyId });
        }
      }
      return map;
    };

    app.get(
      "/admin/reports",
      {
        schema: {
          tags: ["admin"],
          summary: "Reported content, one item per thread, post, comment or news article, most reported first",
          querystring: z.object({
            status: z.enum(["open", "resolved"]).default("open"),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  kind: kindSchema,
                  targetId: z.number(),
                  reports: z.number(),
                  reasons: z.array(z.string()),
                  details: z.array(z.string()).describe("What reporters wrote, if anything"),
                  firstReportedAt: z.string(),
                  resolution: z.enum(["hidden", "dismissed"]).nullable(),
                  target: z
                    .object({
                      text: z.string(),
                      hidden: z.boolean(),
                      threadId: z.number().nullable(),
                      articleId: z.number().nullable(),
                      postId: z.number().nullable().describe("An editorial post's id, for comments on our posts"),
                      storyId: z.number().nullable().optional().describe("A story's id, for comments on stories"),
                    })
                    .nullable()
                    .describe("null if it no longer exists"),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { status, limit } = request.query;
        const rows = await db.execute<{
          kind: Kind; target_id: number; n: number; reasons: string[]; details: string[]; first: string; resolution: "hidden" | "dismissed" | null;
        }>(sql`
          select kind, target_id, count(*)::int as n, array_agg(distinct reason) as reasons,
            coalesce(array_agg(details) filter (where details is not null), '{}') as details,
            to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first,
            max(resolution) as resolution
          from reports where ${status === "open" ? sql`resolved_at is null` : sql`resolved_at is not null`}
          group by kind, target_id order by n desc, first limit ${limit}`);
        const byKind = new Map<Kind, Awaited<ReturnType<typeof targets>>>();
        for (const kind of kindSchema.options) {
          byKind.set(kind, await targets(kind, rows.rows.filter((r) => r.kind === kind).map((r) => r.target_id)));
        }
        return {
          items: rows.rows.map((r) => ({
            kind: r.kind, targetId: r.target_id, reports: r.n, reasons: r.reasons, details: r.details, firstReportedAt: r.first,
            resolution: status === "open" ? null : r.resolution, target: byKind.get(r.kind)!.get(r.target_id) ?? null,
          })),
        };
      },
    );

    app.post(
      "/admin/reports/resolve",
      {
        schema: {
          tags: ["admin"],
          summary: "Close every open report on one item: hide it, or dismiss the reports",
          body: z.object({ kind: kindSchema, targetId: z.number().int().positive().max(2_147_483_647), action: z.enum(["hide", "dismiss"]) }),
          response: { 200: z.object({ resolved: z.number() }), ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const { kind, targetId, action } = request.body;
        if (action === "hide") {
          const table = tableOf(kind);
          await db.update(table).set({ hiddenAt: new Date() }).where(and(eq(table.id, targetId), isNull(table.hiddenAt)));
        }
        const resolved = await db
          .update(reports)
          .set({ resolvedAt: new Date(), resolvedBy: me.id, resolution: action === "hide" ? "hidden" : "dismissed" })
          .where(and(eq(reports.kind, kind), eq(reports.targetId, targetId), isNull(reports.resolvedAt)))
          .returning({ id: reports.id });
        if (resolved.length === 0) throw notFound("Open report");
        await audit(db, me.id, `report.${action}`, kind, targetId, null, { reports: resolved.length });
        return { resolved: resolved.length };
      },
    );

    const actions = [
      { kind: "thread", name: "hide", set: () => ({ hiddenAt: new Date() }) },
      { kind: "thread", name: "unhide", set: () => ({ hiddenAt: null }) },
      { kind: "thread", name: "lock", set: () => ({ lockedAt: new Date() }) },
      { kind: "thread", name: "unlock", set: () => ({ lockedAt: null }) },
      { kind: "thread", name: "pin", set: () => ({ pinned: true }) },
      { kind: "thread", name: "unpin", set: () => ({ pinned: false }) },
      { kind: "post", name: "hide", set: () => ({ hiddenAt: new Date() }) },
      { kind: "post", name: "unhide", set: () => ({ hiddenAt: null }) },
    ] as const;

    for (const name of ["hide", "unhide"] as const) {
      app.post(
        `/admin/articles/:id/${name}`,
        {
          schema: {
            tags: ["admin"],
            summary:
              name === "hide"
                ? "Hide a news article everywhere readers look (duplicate, not about politics…)"
                : "Show a hidden news article again",
            params: idParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) => {
          const me = await requireAdmin(request, "moderator");
          const updated = await db
            .update(articles)
            .set({ hiddenAt: name === "hide" ? new Date() : null })
            .where(eq(articles.id, request.params.id))
            .returning({ id: articles.id });
          if (updated.length === 0) throw notFound("Article");
          if (name === "unhide") await dismissReports(db, "article", request.params.id, me.id);
          await audit(db, me.id, `article.${name}`, "article", request.params.id);
          return reply.status(204).send(null);
        },
      );
    }

    app.put(
      "/admin/forum/threads/:id/status",
      {
        schema: {
          tags: ["admin"],
          summary: "Give an idea (ideias board) the team's status and, optionally, a public answer and an expected date",
          description:
            "Followers are told when the status changes, and it goes on the idea's public timeline. `duplicate` needs `duplicateOf`: the duplicate's votes then count on the original too (until it's unmarked).",
          params: idParams,
          body: z.object({
            status: z.enum(IDEA_STATUSES).nullable(),
            answer: z
              .string()
              .trim()
              .max(1000)
              .nullable()
              .transform((value) => value || null)
              .describe('e.g. "Feito em novembro: já podes filtrar por distrito"'),
            expectedOn: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullish()
              .describe("When we expect it done (YYYY-MM-DD); null clears it, left out keeps it"),
            duplicateOf: z.number().int().positive().max(2_147_483_647).nullish().describe('The original idea, with status "duplicate"'),
          }),
          response: {
            200: z.object({
              status: z.enum(IDEA_STATUSES).nullable(),
              answer: z.string().nullable(),
              answeredAt: z.string().nullable(),
              expectedOn: z.string().nullable(),
              duplicateOf: z.number().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const [before] = await db.select().from(forumThreads).where(eq(forumThreads.id, request.params.id));
        if (!before) throw notFound("Thread");
        if (before.board !== IDEAS_BOARD) throw new ApiError(400, "not_an_idea", "Only threads on the ideas board get a status");
        const { status, answer } = request.body;
        const expectedOn = request.body.expectedOn === undefined ? before.expectedOn : request.body.expectedOn;
        const duplicateOf = status === "duplicate" ? (request.body.duplicateOf ?? null) : null;
        if (status === "duplicate") {
          if (duplicateOf === null) throw new ApiError(400, "duplicate_of_required", "Say which idea it repeats (duplicateOf)");
          const [original] = await db
            .select({ id: forumThreads.id, board: forumThreads.board, status: forumThreads.status, hiddenAt: forumThreads.hiddenAt })
            .from(forumThreads)
            .where(eq(forumThreads.id, duplicateOf));
          if (!original || original.board !== IDEAS_BOARD || original.hiddenAt !== null || original.id === before.id || original.status === "duplicate") {
            throw new ApiError(400, "invalid_duplicate", "duplicateOf must be another visible idea that isn't itself a duplicate");
          }
        }
        // The answer's date moves only when its text changes.
        const answeredAt = answer === null ? null : answer === before.answer ? before.answeredAt : new Date();
        const changed = status !== before.status;
        const after = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(forumThreads)
            .set({ status, answer, answeredAt, expectedOn, duplicateOf })
            .where(eq(forumThreads.id, before.id))
            .returning();
          if (changed) await tx.insert(forumStatusChanges).values({ threadId: before.id, status });
          if (before.duplicateOf !== duplicateOf) {
            // Votes carried to the old original go back; the new original gets this idea's voters (each counted once).
            if (before.duplicateOf !== null) {
              await tx.delete(forumVotes).where(and(eq(forumVotes.threadId, before.duplicateOf), eq(forumVotes.fromThreadId, before.id)));
            }
            if (duplicateOf !== null) {
              const voters = await tx.select().from(forumVotes).where(eq(forumVotes.threadId, before.id));
              if (voters.length) {
                await tx
                  .insert(forumVotes)
                  .values(
                    voters.map((v) => ({
                      threadId: duplicateOf,
                      // An account counts once across both; anonymous votes can't be matched, so each is kept.
                      voter: v.userId !== null ? voterKey(forumSecret, `u:${v.userId}`, duplicateOf) : `dup:${before.id}:${v.voter}`,
                      userId: v.userId,
                      createdAt: v.createdAt,
                      fromThreadId: before.id,
                    })),
                  )
                  .onConflictDoNothing();
              }
            }
            const touched = [before.duplicateOf, duplicateOf].filter((id): id is number => id !== null);
            await tx
              .update(forumThreads)
              .set({ score: sql`(select count(*)::int from forum_votes v where v.thread_id = ${forumThreads.id})` })
              .where(inArray(forumThreads.id, touched));
          }
          return row!;
        });
        await audit(
          db, me.id, "thread.status", "thread", before.id,
          { status: before.status, answer: before.answer, expectedOn: before.expectedOn, duplicateOf: before.duplicateOf },
          { status, answer, expectedOn, duplicateOf },
        );
        if (changed && status !== null) {
          try {
            await notify(db, { userIds: await followers(db, "thread", before.id), kind: "idea_status", targetId: before.id, actorName: TEAM_NAME });
          } catch (error) {
            request.log.error(error, "idea status notification failed");
          }
        }
        return {
          status: after.status, answer: after.answer, answeredAt: after.answeredAt?.toISOString() ?? null,
          expectedOn: after.expectedOn, duplicateOf: after.duplicateOf,
        };
      },
    );

    app.post(
      "/admin/forum/threads/:id/posts",
      {
        schema: {
          tags: ["admin"],
          summary: "Reply to a thread as the team: signed as the team (team: true), also in locked threads",
          params: idParams,
          body: z.strictObject({
            body: z.string().trim().min(1).max(5_000),
            replyTo: z.number().int().positive().max(2_147_483_647).nullish().describe("A post in this thread being answered"),
          }),
          response: { 201: z.object({ id: z.number() }), ...errors },
        },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const threadId = request.params.id;
        const { body, replyTo } = request.body;
        assertPublishable(body);
        const [thread] = await db
          .select({ id: forumThreads.id })
          .from(forumThreads)
          .where(and(eq(forumThreads.id, threadId), isNull(forumThreads.hiddenAt)));
        if (!thread) throw notFound("Thread");
        let quotedUserId: number | null = null;
        if (replyTo) {
          const [quoted] = await db
            .select({ userId: forumPosts.userId, hiddenAt: forumPosts.hiddenAt })
            .from(forumPosts)
            .where(and(eq(forumPosts.id, replyTo), eq(forumPosts.threadId, threadId)));
          if (!quoted) throw new ApiError(400, "invalid_reply", "That post is not in this thread");
          quotedUserId = quoted.hiddenAt ? null : quoted.userId;
        }
        const id = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(forumPosts)
            .values({ threadId, body, nickname: TEAM_NAME, posterId: TEAM_POSTER_ID, team: true, replyTo: replyTo ?? null })
            .returning({ id: forumPosts.id });
          await tx.update(forumThreads).set({ replyCount: sql`${forumThreads.replyCount} + 1`, bumpedAt: sql`now()` }).where(eq(forumThreads.id, threadId));
          return created!.id;
        });
        await audit(db, me.id, "post.team_reply", "post", id, null, { threadId, body });
        try {
          if (quotedUserId !== null) await notify(db, { userIds: [quotedUserId], kind: "forum_reply", targetId: id, actorName: TEAM_NAME });
          const others = (await followers(db, "thread", threadId)).filter((userId) => userId !== quotedUserId);
          await notify(db, { userIds: others, kind: "thread_update", targetId: threadId, actorName: TEAM_NAME });
        } catch (error) {
          request.log.error(error, "forum notification failed");
        }
        return reply.status(201).send({ id });
      },
    );

    for (const action of actions) {
      app.post(
        `/admin/forum/${action.kind}s/:id/${action.name}`,
        {
          schema: {
            tags: ["admin"],
            summary: `${action.name[0]!.toUpperCase()}${action.name.slice(1)} a forum ${action.kind}`,
            params: idParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) => {
          const me = await requireAdmin(request, "moderator");
          const table = action.kind === "thread" ? forumThreads : forumPosts;
          const updated = await db
            .update(table)
            .set(action.set() as never)
            .where(eq(table.id, request.params.id))
            .returning({ id: table.id });
          if (updated.length === 0) throw notFound(action.kind === "thread" ? "Thread" : "Post");
          if (action.name === "unhide") await dismissReports(db, action.kind, request.params.id, me.id);
          await audit(db, me.id, `${action.kind}.${action.name}`, action.kind, request.params.id);
          return reply.status(204).send(null);
        },
      );
    }
  };
