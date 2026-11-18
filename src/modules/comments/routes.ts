import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, commentLikes, comments, editorialPosts } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { commentLikerKey } from "../../forums/identity.js";
import { assertPublishable } from "../../moderation/screen.js";
import { follow, notify } from "../../notifications/index.js";
import { articleParamsSchema, errorSchema } from "../shared.js";
import type { RecaptchaVerifier } from "./recaptcha.js";

/*
 * Anonymous comments, on stories (/stories/:id/comments), news articles
 * (/articles/:id/comments) and our editorial posts (/editorial/:slug/comments). Same rules
 * everywhere: reCAPTCHA, a per-IP limit, one level of "in reply to", likes, and moderation and
 * reports by comment id.
 */

const stanceSchema = z.enum(["agree", "disagree"]);

const baseCommentSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  username: z.string().nullable().describe("The account's username when `account` is true; otherwise a free-text name from before accounts"),
  account: z.boolean().describe("Written by a logged-in reader"),
  parentUsername: z.string().nullable(),
  body: z.string().describe("Plain text. Clients must escape it when rendering."),
  stance: stanceSchema.nullable().describe('The commenter\'s side, if they picked one: "Concordo" (agree) or "Discordo" (disagree)'),
  likes: z.number(),
  createdAt: z.string(),
});
export type PublicComment = z.infer<typeof baseCommentSchema>;
const storyCommentSchema = baseCommentSchema.extend({ storyId: z.number() });
const articleCommentSchema = baseCommentSchema.extend({ articleId: z.number() });
const postCommentSchema = baseCommentSchema.extend({ postId: z.number().describe("The editorial post's id") });

const createCommentSchema = z.strictObject({
  username: z
    .string()
    .trim()
    .max(50)
    .nullish()
    .transform((value) => value || null),
  body: z.string().trim().min(1).max(500),
  parentId: z.number().int().positive().max(2_147_483_647).nullish(),
  stance: stanceSchema.nullish().describe("Optional: the commenter's side"),
  recaptchaToken: z.string().min(1).max(4_096).optional().describe("Anonymous comments only (when login isn't required)"),
});

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) });
const postErrors = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema };

export interface CommentRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  createLimitPerMinute: number;
  /** Keys the hash that tells readers apart for likes. */
  voteSecret: string;
}

/** Where comments are: which ones a page shows (`scope`), and where a new one is stored. */
type Target = { id: number; scope: SQL; insert: { articleId?: number; storyId?: number; editorialPostId?: number } };

/**
 * A story's comments: those made on the story, plus older ones made on any of its visible
 * articles before stories existed.
 */
export const storyCommentScope = (storyId: number) =>
  or(
    eq(comments.storyId, storyId),
    sql`${comments.articleId} in (select a.id from articles a where a.story_id = ${storyId} and a.hidden_at is null)`,
  )!;

/** The fields every comment response has. */
export const publicCommentColumns = {
  id: comments.id,
  parentId: comments.parentId,
  username: comments.username,
  account: sql<boolean>`${comments.userId} is not null`,
  body: comments.body,
  stance: comments.stance,
  likes: comments.likes,
  createdAt: comments.createdAt,
};

export const commentRoutes =
  ({ db, verifyRecaptcha, createLimitPerMinute, voteSecret }: CommentRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const articleTarget = async (id: number): Promise<Target> => {
      const [article] = await db.select({ id: articles.id }).from(articles).where(and(eq(articles.id, id), isNull(articles.hiddenAt)));
      if (!article) throw notFound("Article");
      return { id, scope: eq(comments.articleId, id), insert: { articleId: id } };
    };
    const storyTarget = async (id: number): Promise<Target> => {
      const [story] = await db
        .select({ id: articles.storyId })
        .from(articles)
        .where(and(eq(articles.storyId, id), isNull(articles.hiddenAt)))
        .limit(1);
      if (!story) throw notFound("Story");
      return { id, scope: storyCommentScope(id), insert: { storyId: id } };
    };
    const postTarget = async (slug: string): Promise<Target> => {
      const [post] = await db
        .select({ id: editorialPosts.id })
        .from(editorialPosts)
        .where(and(eq(editorialPosts.slug, slug), eq(editorialPosts.status, "published")));
      if (!post) throw notFound("Post");
      return { id: post.id, scope: eq(comments.editorialPostId, post.id), insert: { editorialPostId: post.id } };
    };

    /** Visible comments on one article or post, oldest first. */
    const list = async (target: Target) => {
      const parent = alias(comments, "parent");
      const rows = await db
        .select({ ...publicCommentColumns, parentUsername: parent.username })
        .from(comments)
        .leftJoin(parent, eq(comments.parentId, parent.id))
        .where(and(target.scope, isNull(comments.hiddenAt)))
        .orderBy(asc(comments.createdAt), asc(comments.id));
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    };

    const create = async (input: z.infer<typeof createCommentSchema>, request: FastifyRequest, findTarget: () => Promise<Target>) => {
      const who = app.participant(request, "comments");
      const { body, parentId, stance, recaptchaToken } = input;
      // A logged-in reader always writes under their username; the account replaces reCAPTCHA.
      const username = who.username ?? input.username;
      assertPublishable(body, username);
      if (who.userId === null) {
        if (!recaptchaToken) throw new ApiError(400, "recaptcha_required", "reCAPTCHA token missing");
        let human: boolean;
        try {
          human = await verifyRecaptcha(recaptchaToken, request.ip);
        } catch (error) {
          request.log.error(error, "reCAPTCHA verification unavailable");
          throw new ApiError(503, "recaptcha_unavailable", "Comments are temporarily unavailable");
        }
        if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");
      }

      const target = await findTarget();
      let parentUsername: string | null = null;
      let parentUserId: number | null = null;
      if (parentId != null) {
        const [parent] = await db
          .select({ username: comments.username, userId: comments.userId })
          .from(comments)
          .where(and(eq(comments.id, parentId), target.scope, isNull(comments.hiddenAt)));
        if (!parent) throw new ApiError(400, "invalid_parent", "The parent comment is not on this page");
        parentUsername = parent.username;
        parentUserId = parent.userId;
      }

      const [created] = await db
        .insert(comments)
        .values({ ...target.insert, parentId: parentId ?? null, username, userId: who.userId, body, stance: stance ?? null })
        .returning();
      if (!created) throw new Error("Insert returned no row");
      // Best effort: a reply is never lost because its notification failed.
      try {
        if (parentUserId !== null && parentUserId !== who.userId) {
          await notify(db, { userIds: [parentUserId], kind: "comment_reply", targetId: created.id, actorName: username });
        }
        if (who.userId !== null && target.insert.storyId) await follow(db, who.userId, "story", target.insert.storyId);
      } catch (error) {
        request.log.error(error, "comment notification failed");
      }
      return {
        targetId: target.id,
        comment: {
          id: created.id,
          parentId: created.parentId,
          username: created.username,
          account: created.userId !== null,
          parentUsername,
          body: created.body,
          stance: created.stance,
          likes: created.likes,
          createdAt: created.createdAt.toISOString(),
        },
      };
    };

    const posting = { config: { rateLimit: { max: createLimitPerMinute, timeWindow: "1 minute" } } };

    const storyParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });

    app.get(
      "/stories/:id/comments",
      {
        schema: {
          tags: ["comments"],
          summary: "Comments on a story, oldest first (including those made on its articles before stories existed)",
          params: storyParams,
          response: { 200: z.array(storyCommentSchema), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const target = await storyTarget(request.params.id);
        return (await list(target)).map((c) => ({ ...c, storyId: target.id }));
      },
    );

    app.post(
      "/stories/:id/comments",
      {
        ...posting,
        schema: {
          tags: ["comments"],
          summary: "Comment on a story (same rules as everywhere)",
          params: storyParams,
          body: createCommentSchema,
          response: { 201: storyCommentSchema, ...postErrors },
        },
      },
      async (request, reply) => {
        const { targetId, comment } = await create(request.body, request, () => storyTarget(request.params.id));
        return reply.status(201).send({ ...comment, storyId: targetId });
      },
    );

    app.post(
      "/comments/:id/like",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["comments"],
          summary: "Like a comment (1) or take the like back (0). One like per reader",
          params: storyParams,
          body: z.strictObject({ value: z.union([z.literal(1), z.literal(0)]) }),
          response: {
            200: z.object({ likes: z.number(), mine: z.union([z.literal(1), z.literal(0)]) }),
            400: errorSchema,
            404: errorSchema,
            429: errorSchema,
          },
        },
      },
      async (request) => {
        const commentId = request.params.id;
        const { value } = request.body;
        const who = app.participant(request, "votes");
        const voter = commentLikerKey(voteSecret, who.key, commentId);
        return db.transaction(async (tx) => {
          // Locks the comment, so likes on it count one at a time and the total stays exact.
          const [comment] = await tx
            .select({ id: comments.id })
            .from(comments)
            .where(and(eq(comments.id, commentId), isNull(comments.hiddenAt)))
            .for("update");
          if (!comment) throw notFound("Comment");
          if (value === 0) {
            await tx.delete(commentLikes).where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.voter, voter)));
          } else {
            await tx.insert(commentLikes).values({ commentId, voter, userId: who.userId }).onConflictDoNothing();
          }
          const [row] = await tx
            .update(comments)
            .set({ likes: sql`(select count(*)::int from comment_likes l where l.comment_id = ${commentId})` })
            .where(eq(comments.id, commentId))
            .returning({ likes: comments.likes });
          return { likes: row!.likes, mine: value };
        });
      },
    );

    app.get(
      "/articles/:id/comments",
      {
        schema: {
          tags: ["comments"],
          params: articleParamsSchema,
          response: { 200: z.array(articleCommentSchema), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const target = await articleTarget(request.params.id);
        return (await list(target)).map((c) => ({ ...c, articleId: target.id }));
      },
    );

    app.post(
      "/articles/:id/comments",
      {
        ...posting,
        schema: { tags: ["comments"], params: articleParamsSchema, body: createCommentSchema, response: { 201: articleCommentSchema, ...postErrors } },
      },
      async (request, reply) => {
        const { targetId, comment } = await create(request.body, request, () => articleTarget(request.params.id));
        return reply.status(201).send({ ...comment, articleId: targetId });
      },
    );

    app.get(
      "/editorial/:slug/comments",
      {
        schema: {
          tags: ["comments"],
          summary: "Comments on one of our editorial posts, oldest first",
          params: slugParams,
          response: { 200: z.array(postCommentSchema), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const target = await postTarget(request.params.slug);
        return (await list(target)).map((c) => ({ ...c, postId: target.id }));
      },
    );

    app.post(
      "/editorial/:slug/comments",
      {
        ...posting,
        schema: {
          tags: ["comments"],
          summary: "Comment on one of our editorial posts (same rules as on news)",
          params: slugParams,
          body: createCommentSchema,
          response: { 201: postCommentSchema, ...postErrors },
        },
      },
      async (request, reply) => {
        const { targetId, comment } = await create(request.body, request, () => postTarget(request.params.slug));
        return reply.status(201).send({ ...comment, postId: targetId });
      },
    );
  };
