import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, comments } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { articleParamsSchema, errorSchema } from "../shared.js";
import type { RecaptchaVerifier } from "./recaptcha.js";

const commentSchema = z.object({
  id: z.number(),
  articleId: z.number(),
  parentId: z.number().nullable(),
  username: z.string().nullable(),
  parentUsername: z.string().nullable(),
  body: z.string().describe("Plain text. Clients must escape it when rendering."),
  createdAt: z.string(),
});

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

export interface CommentRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  createLimitPerMinute: number;
}

export const commentRoutes =
  ({ db, verifyRecaptcha, createLimitPerMinute }: CommentRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const assertArticleExists = async (id: number) => {
      const [article] = await db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.id, id));
      if (!article) throw notFound("Article");
    };

    app.get(
      "/articles/:id/comments",
      {
        schema: {
          tags: ["comments"],
          params: articleParamsSchema,
          response: { 200: z.array(commentSchema), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        await assertArticleExists(request.params.id);
        const parent = alias(comments, "parent");
        const rows = await db
          .select({
            id: comments.id,
            articleId: comments.articleId,
            parentId: comments.parentId,
            username: comments.username,
            parentUsername: parent.username,
            body: comments.body,
            createdAt: comments.createdAt,
          })
          .from(comments)
          .leftJoin(parent, eq(comments.parentId, parent.id))
          .where(and(eq(comments.articleId, request.params.id), isNull(comments.hiddenAt)))
          .orderBy(asc(comments.createdAt), asc(comments.id));
        return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
      },
    );

    app.post(
      "/articles/:id/comments",
      {
        config: { rateLimit: { max: createLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["comments"],
          params: articleParamsSchema,
          body: createCommentSchema,
          response: {
            201: commentSchema,
            400: errorSchema,
            403: errorSchema,
            404: errorSchema,
            429: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { username, body, parentId, recaptchaToken } = request.body;
        const articleId = request.params.id;

        let human: boolean;
        try {
          human = await verifyRecaptcha(recaptchaToken, request.ip);
        } catch (error) {
          request.log.error(error, "reCAPTCHA verification unavailable");
          throw new ApiError(503, "recaptcha_unavailable", "Comments are temporarily unavailable");
        }
        if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");

        await assertArticleExists(articleId);

        let parentUsername: string | null = null;
        if (parentId != null) {
          const [parent] = await db
            .select({ username: comments.username })
            .from(comments)
            .where(
              and(
                eq(comments.id, parentId),
                eq(comments.articleId, articleId),
                isNull(comments.hiddenAt),
              ),
            );
          if (!parent) {
            throw new ApiError(400, "invalid_parent", "The parent comment is not on this article");
          }
          parentUsername = parent.username;
        }

        const [created] = await db
          .insert(comments)
          .values({ articleId, parentId: parentId ?? null, username, body })
          .returning();
        if (!created) throw new Error("Insert returned no row");

        return reply.status(201).send({
          id: created.id,
          articleId: created.articleId,
          parentId: created.parentId,
          username: created.username,
          parentUsername,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
        });
      },
    );
  };
