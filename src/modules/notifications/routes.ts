import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Reader } from "../../accounts/sessions.js";
import type { Db } from "../../db/client.js";
import { NOTIFICATION_KINDS } from "../../db/schema.js";
import { ApiError } from "../../errors.js";
import { type FollowKind, follow, inbox, markRead, unfollow, unreadCount } from "../../notifications/index.js";
import { resolveStoryId, withStory } from "../../stories/merge.js";
import { IDEA_STATUSES } from "../forums/routes.js";
import { errorSchema } from "../shared.js";

/*
 * The reader's inbox ("Responderam-te", news on what they follow, prediction results) and
 * "Seguir". Private to the account: nothing here is ever shown to anyone else.
 */

const MAX_INT = 2_147_483_647;
const idSchema = z.coerce.number().int().positive().max(MAX_INT);
const errors = { 400: errorSchema, 401: errorSchema };

const itemSchema = z.object({
  id: z.number(),
  kind: z.enum(NOTIFICATION_KINDS),
  actorName: z.string().nullable().describe("Who replied, as shown on their post (replies only)"),
  count: z.number().describe("How many times since last read: replies in a followed thread, new articles in a story"),
  createdAt: z.string(),
  read: z.boolean(),
  snippet: z.string().nullable().describe("The reply's text, cut at 200 characters (replies only)"),
  link: z.object({
    commentId: z.number().nullable(),
    articleId: z.number().nullable().describe("A comment reply: the comment is on this article, story (storyId) or blog post (postSlug)"),
    storyId: z.number().nullable(),
    postSlug: z.string().nullable(),
    threadId: z.number().nullable(),
    postId: z.number().nullable().describe("A forum reply: the new post in threadId"),
    initiativeId: z.number().nullable(),
    feedbackId: z.number().nullable().describe("feedback_reply: the reader's message the team answered"),
  }),
  threadTitle: z.string().nullable(),
  board: z.string().nullable(),
  headline: z.string().nullable().describe("A story update: the newest headline in it"),
  status: z
    .enum(IDEA_STATUSES)
    .nullable()
    .describe("idea_status: the idea's status now (threadId, threadTitle say which idea)"),
  feedback: z
    .object({ id: z.number(), reply: z.string().describe("The team's answer, in full") })
    .nullable()
    .describe("feedback_reply: the team answered the reader's message"),
  prediction: z
    .object({
      initiativeTitle: z.string(),
      pick: z.enum(["pass", "fail"]),
      outcome: z.enum(["hit", "miss", "void"]).nullable(),
      result: z.string().nullable().describe('The vote\'s result as parliament wrote it: "Aprovado" or "Rejeitado"'),
    })
    .nullable(),
});

export const notificationRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireReader = (request: FastifyRequest): Reader => {
      if (!request.reader) throw new ApiError(401, "unauthenticated", "Log in first");
      return request.reader;
    };
    const privately = { "Cache-Control": "private, no-store" };

    app.get(
      "/me/notifications",
      {
        schema: {
          tags: ["accounts"],
          summary: "The reader's inbox, newest first, 30 a page: replies to them, news on what they follow, prediction results",
          description: "Things hidden or deleted since are left out. Opening the inbox doesn't mark anything read: POST /me/notifications/read does.",
          querystring: z.object({ cursor: z.string().max(100).optional() }),
          response: { 200: z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() }), ...errors },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        reply.headers(privately);
        return inbox(db, reader.id, request.query.cursor);
      },
    );

    app.get(
      "/me/notifications/unread",
      {
        schema: {
          tags: ["accounts"],
          summary: "How many unread, for the bell (cheap: poll it every minute or so while the tab is visible)",
          response: { 200: z.object({ count: z.number() }), 401: errorSchema },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        reply.headers(privately);
        return { count: await unreadCount(db, reader.id) };
      },
    );

    app.post(
      "/me/notifications/read",
      {
        schema: {
          tags: ["accounts"],
          summary: "Mark these notifications read, or all of them without ids",
          body: z.strictObject({ ids: z.array(idSchema).max(100).optional() }).default({}),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        await markRead(db, reader.id, request.body.ids);
        return reply.status(204).send(null);
      },
    );

    const followParams = z.object({ kind: z.enum(["story", "thread"]), id: idSchema });
    const exists = async (kind: FollowKind, id: number, runner: Pick<Db, "execute"> = db) => {
      const query =
        kind === "story"
          ? sql`select 1 from articles where story_id = ${id} and hidden_at is null limit 1`
          : sql`select 1 from forum_threads where id = ${id} and hidden_at is null`;
      return (await runner.execute(query)).rows.length > 0;
    };

    app.put(
      "/me/follows/:kind/:id",
      {
        schema: {
          tags: ["accounts"],
          summary: '"Seguir" a story (told when new outlets cover it) or a forum thread (told about new replies)',
          description: "Opening or replying in a thread, and commenting on a story, follow it already. The newest 200 of each kind are kept.",
          params: followParams,
          response: { 204: z.null(), ...errors, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        const { kind } = request.params;
        if (kind === "story") {
          // A merged story's old id stands for the story it went into; held so a merge can't
          // delete it between the check and the follow.
          const done = await withStory(db, request.params.id, async (tx, id) => {
            if (!(await exists(kind, id, tx))) return false;
            await follow(tx, reader.id, kind, id);
            return true;
          });
          if (!done?.result) throw new ApiError(404, "not_found", "Story not found");
          return reply.status(204).send(null);
        }
        const id = request.params.id;
        if (!(await exists(kind, id))) throw new ApiError(404, "not_found", "Thread not found");
        await follow(db, reader.id, kind, id);
        return reply.status(204).send(null);
      },
    );

    app.delete(
      "/me/follows/:kind/:id",
      { schema: { tags: ["accounts"], summary: "Stop following", params: followParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const reader = requireReader(request);
        const { kind } = request.params;
        const id = kind === "story" ? await resolveStoryId(db, request.params.id) : request.params.id;
        await unfollow(db, reader.id, kind, id);
        return reply.status(204).send(null);
      },
    );
  };
