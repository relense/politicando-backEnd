import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, comments, editorialPosts } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { articleParamsSchema, errorSchema } from "../shared.js";
import type { RecaptchaVerifier } from "./recaptcha.js";

/*
 * Anonymous comments, on news articles (/articles/:id/comments) and on our editorial posts
 * (/editorial/:slug/comments). Same rules for both: reCAPTCHA, a per-IP limit, one level of
 * "in reply to", and moderation and reports by comment id.
 */

const baseCommentSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  username: z.string().nullable(),
  parentUsername: z.string().nullable(),
  body: z.string().describe("Plain text. Clients must escape it when rendering."),
  createdAt: z.string(),
});
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
  recaptchaToken: z.string().min(1).max(4_096),
});

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) });
const postErrors = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema };

export interface CommentRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  createLimitPerMinute: number;
}

type Target = { column: typeof comments.articleId | typeof comments.editorialPostId; id: number };

export const commentRoutes =
  ({ db, verifyRecaptcha, createLimitPerMinute }: CommentRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const articleTarget = async (id: number): Promise<Target> => {
      const [article] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, id));
      if (!article) throw notFound("Article");
      return { column: comments.articleId, id };
    };
    const postTarget = async (slug: string): Promise<Target> => {
      const [post] = await db
        .select({ id: editorialPosts.id })
        .from(editorialPosts)
        .where(and(eq(editorialPosts.slug, slug), eq(editorialPosts.status, "published")));
      if (!post) throw notFound("Post");
      return { column: comments.editorialPostId, id: post.id };
    };

    /** Visible comments on one article or post, oldest first. */
    const list = async (target: Target) => {
      const parent = alias(comments, "parent");
      const rows = await db
        .select({
          id: comments.id,
          parentId: comments.parentId,
          username: comments.username,
          parentUsername: parent.username,
          body: comments.body,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .leftJoin(parent, eq(comments.parentId, parent.id))
        .where(and(eq(target.column, target.id), isNull(comments.hiddenAt)))
        .orderBy(asc(comments.createdAt), asc(comments.id));
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    };

    const create = async (
      input: z.infer<typeof createCommentSchema>,
      ip: string,
      log: { error: (error: unknown, message: string) => void },
      findTarget: () => Promise<Target>,
    ) => {
      const { username, body, parentId, recaptchaToken } = input;
      let human: boolean;
      try {
        human = await verifyRecaptcha(recaptchaToken, ip);
      } catch (error) {
        log.error(error, "reCAPTCHA verification unavailable");
        throw new ApiError(503, "recaptcha_unavailable", "Comments are temporarily unavailable");
      }
      if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");

      const target = await findTarget();
      let parentUsername: string | null = null;
      if (parentId != null) {
        const [parent] = await db
          .select({ username: comments.username })
          .from(comments)
          .where(and(eq(comments.id, parentId), eq(target.column, target.id), isNull(comments.hiddenAt)));
        if (!parent) throw new ApiError(400, "invalid_parent", "The parent comment is not on this page");
        parentUsername = parent.username;
      }

      const onArticle = target.column === comments.articleId;
      const [created] = await db
        .insert(comments)
        .values({
          articleId: onArticle ? target.id : null,
          editorialPostId: onArticle ? null : target.id,
          parentId: parentId ?? null,
          username,
          body,
        })
        .returning();
      if (!created) throw new Error("Insert returned no row");
      return {
        targetId: target.id,
        comment: {
          id: created.id,
          parentId: created.parentId,
          username: created.username,
          parentUsername,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
        },
      };
    };

    const posting = { config: { rateLimit: { max: createLimitPerMinute, timeWindow: "1 minute" } } };

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
        const { targetId, comment } = await create(request.body, request.ip, request.log, () => articleTarget(request.params.id));
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
        const { targetId, comment } = await create(request.body, request.ip, request.log, () => postTarget(request.params.slug));
        return reply.status(201).send({ ...comment, postId: targetId });
      },
    );
  };
