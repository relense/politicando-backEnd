import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { editorialPosts } from "../../db/schema.js";
import { parseMarkdownPost, saveMarkdownPosts } from "../../editorial/markdownFiles.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

/*
 * Publishing by API key, for the team until the admin screens exist: send an article.md (front
 * matter + Markdown, see src/editorial/markdownFiles.ts) with `Authorization: Bearer <key>` and
 * it's live. The keys are PUBLISH_API_KEYS on the API; without any, these routes answer 404.
 * From a terminal: `npm run editorial:publish -- article.md`.
 */

const digest = (value: string) => createHash("sha256").update(value).digest();

export const publishRoutes =
  (db: Db, keys: readonly string[]): FastifyPluginAsyncZod =>
  async (app) => {
    if (keys.length === 0) return;
    const expected = keys.map(digest);

    const requireKey = (request: FastifyRequest) => {
      const sent = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
      // Compares every key, in constant time, so the answer's timing says nothing.
      const ok = sent !== undefined && expected.map((key) => timingSafeEqual(digest(sent), key)).some(Boolean);
      if (!ok) throw new ApiError(401, "invalid_key", "Missing or wrong API key");
    };

    const result = z.object({
      slug: z.string(),
      status: z.enum(["published", "draft"]),
      created: z.boolean().describe("A new post (false: an existing one, matched by slug)"),
      changed: z.boolean().describe("False when the post was already exactly this"),
      url: z.string().describe("Where it is on the site"),
    });
    const siteUrl = (slug: string) => `https://www.politicando.pt/editorial/${slug}`;

    app.post(
      "/publish",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["editorial"],
          summary: "Publish (or update) a blog post from its article.md, with the team's API key",
          description:
            "Matched by the front matter's `slug`: a new slug creates the post, an existing one replaces its text and keeps its first publication date. `featured: true|false` in the front matter sets the front-page pick.",
          headers: z.object({ authorization: z.string().optional() }),
          body: z.strictObject({
            markdown: z.string().min(1).max(200_000).describe("The whole file: the front matter between --- lines, then the body"),
            draft: z.boolean().default(false).describe("Store it without publishing"),
            author: z.string().trim().min(1).max(100).default("Redação Politicando"),
          }),
          response: { 200: result, 400: errorSchema, 401: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        requireKey(request);
        const { markdown, draft, author } = request.body;
        let post;
        try {
          post = parseMarkdownPost(markdown);
        } catch (error) {
          throw new ApiError(400, "invalid_article", error instanceof Error ? error.message : String(error));
        }
        if (!post) throw new ApiError(400, "invalid_article", "The front matter needs a slug");
        const [saved] = await saveMarkdownPosts(db, [post], { authorName: author, publish: !draft });
        if (saved!.changed) await audit(db, null, draft ? "editorial.api_draft" : "editorial.api_publish", "editorial", post.slug);
        return { slug: post.slug, status: draft ? ("draft" as const) : ("published" as const), created: saved!.created, changed: saved!.changed, url: siteUrl(post.slug) };
      },
    );

    app.post(
      "/publish/:slug/unpublish",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["editorial"],
          summary: "Take a post off the site (back to draft), with the team's API key",
          headers: z.object({ authorization: z.string().optional() }),
          params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }),
          response: { 204: z.null(), 400: errorSchema, 401: errorSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        requireKey(request);
        const [row] = await db
          .update(editorialPosts)
          .set({ status: "draft", featured: false, updatedAt: new Date() })
          .where(and(eq(editorialPosts.slug, request.params.slug)))
          .returning({ slug: editorialPosts.slug });
        if (!row) throw notFound("Post");
        await audit(db, null, "editorial.api_unpublish", "editorial", row.slug);
        return reply.status(204).send(null);
      },
    );
  };
