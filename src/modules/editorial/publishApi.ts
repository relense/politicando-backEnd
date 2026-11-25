import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { budgetProposals, budgetSummaries, editorialPosts } from "../../db/schema.js";
import { parseMarkdownPost, saveMarkdownPosts } from "../../editorial/markdownFiles.js";
import { ApiError, notFound } from "../../errors.js";
import multipart from "@fastify/multipart";
import { MAX_IMAGE_BYTES, imageType, storeImage } from "../../media/images.js";
import type { Revalidate } from "../../revalidate.js";
import { errorSchema } from "../shared.js";

/*
 * Publishing by API key, for the team until the admin screens exist: send an article.md (front
 * matter + Markdown, see src/editorial/markdownFiles.ts) with `Authorization: Bearer <key>` and
 * it's live. The keys are PUBLISH_API_KEYS on the API; without any, these routes answer 404.
 * From a terminal: `npm run editorial:publish -- article.md`.
 */

const digest = (value: string) => createHash("sha256").update(value).digest();

export const publishRoutes =
  (db: Db, keys: readonly string[], { apiUrl = "http://localhost:4000", revalidate = async () => {} }: { apiUrl?: string; revalidate?: Revalidate } = {}): FastifyPluginAsyncZod =>
  async (app) => {
    if (keys.length === 0) return;
    // A cover image as the request body (image/png or image/jpeg), or as a multipart file.
    app.addContentTypeParser(["image/png", "image/jpeg"], { parseAs: "buffer", bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));
    await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });
    const expected = keys.map(digest);

    const requireKey = (request: FastifyRequest) => {
      const sent = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
      // Compares every key, in constant time, so the answer's timing says nothing.
      const ok = sent !== undefined && expected.map((key) => timingSafeEqual(digest(sent), key)).some(Boolean);
      if (!ok) throw new ApiError(401, "invalid_key", "Missing or wrong API key");
    };
    // Every route here needs the key, checked first: without it, nothing is read, parsed or validated.
    app.addHook("onRequest", async (request) => requireKey(request));

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
        // The longest article.md (every character up to 4 bytes of UTF-8) plus the other fields.
        bodyLimit: 200_000 * 4 + 64 * 1024,
        schema: {
          tags: ["editorial"],
          summary: "Publish (or update) a blog post from its article.md, with the team's API key",
          description:
            "Matched by the front matter's `slug`: a new slug creates the post, an existing one replaces its text and keeps its first publication date. A new post is a front-page pick (featured) unless the front matter says `featured: false`; on an update, `featured: true|false` changes it and leaving it out keeps it.",
          headers: z.object({ authorization: z.string().optional() }),
          body: z.strictObject({
            markdown: z.string().min(1).max(200_000).describe("The whole file: the front matter between --- lines, then the body"),
            draft: z.boolean().default(false).describe("Store it without publishing"),
            author: z.string().trim().min(1).max(100).default("Redação Politicando"),
          }),
          response: { 200: result, 400: errorSchema, 401: errorSchema, 409: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        const { markdown, draft, author } = request.body;
        let post;
        try {
          post = parseMarkdownPost(markdown);
        } catch (error) {
          throw new ApiError(400, "invalid_article", error instanceof Error ? error.message : String(error));
        }
        if (!post) throw new ApiError(400, "invalid_article", "The front matter needs a slug");
        if (draft) {
          const [live] = await db.select({ status: editorialPosts.status }).from(editorialPosts).where(eq(editorialPosts.slug, post.slug));
          if (live?.status === "published") throw new ApiError(409, "already_published", "This post is live: a draft would replace it at once. Unpublish it first, or publish the change");
        }
        const [saved] = await saveMarkdownPosts(db, [post], { authorName: author, publish: !draft });
        if (saved!.changed) await audit(db, null, draft ? "editorial.api_draft" : "editorial.api_publish", "editorial", post.slug);
        // Not awaited: the site refreshing never slows or fails the publish.
        if (saved!.changed && !draft) void revalidate(["blog"]);
        return { slug: post.slug, status: draft ? ("draft" as const) : ("published" as const), created: saved!.created, changed: saved!.changed, url: siteUrl(post.slug) };
      },
    );

    app.post(
      "/publish/image",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        bodyLimit: MAX_IMAGE_BYTES + 64 * 1024,
        schema: {
          tags: ["publish"],
          summary: "Upload a cover image (PNG or JPG, up to 2 MB): returns a permanent public URL for the cover: field",
          description:
            "Send the file as the body (Content-Type image/png or image/jpeg) or as one multipart file. The same file always gets the same URL, so sending it again doesn't duplicate.",
          response: { 200: z.object({ url: z.string(), created: z.boolean().describe("False when this exact image was already stored") }), 400: errorSchema, 401: errorSchema, 413: errorSchema, 429: errorSchema },
        },
      },
      async (request) => {
        let bytes: Buffer | undefined;
        if (request.isMultipart()) {
          const file = await request.file();
          if (file) {
            bytes = await file.toBuffer().catch((error: unknown) => {
              if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new ApiError(413, "too_large", "Images can be up to 2 MB");
              throw error;
            });
          }
        } else if (Buffer.isBuffer(request.body)) bytes = request.body;
        if (!bytes || bytes.length === 0) throw new ApiError(400, "invalid_image", "Send a PNG or JPG, as the body or a multipart file");
        if (bytes.length > MAX_IMAGE_BYTES) throw new ApiError(413, "too_large", "Images can be up to 2 MB");
        const type = imageType(bytes);
        if (!type) throw new ApiError(400, "invalid_image", "Only PNG and JPG images");
        const { file, created } = await storeImage(db, bytes, type);
        if (created) await audit(db, null, "media.api_upload", "media", file);
        return { url: `${apiUrl.replace(/\/$/, "")}/media/${file}`, created };
      },
    );

    // "O que muda" for State Budget proposals, written from each official PDF by the studio.
    const proposalId = z.object({ id: z.coerce.number().int().min(1).max(2_147_483_647) });
    const proposalExists = async (id: number) =>
      (await db.select({ id: budgetProposals.id }).from(budgetProposals).where(eq(budgetProposals.id, id))).length > 0;

    app.get(
      "/publish/budget/missing",
      {
        schema: {
          tags: ["publish"],
          summary: "Budget proposals without a plain summary yet, latest votes first: the studio's to-do list",
          headers: z.object({ authorization: z.string().optional() }),
          querystring: z.object({
            year: z.coerce.number().int().min(2000).max(2100).optional(),
            voted: z.enum(["true", "false"]).optional().describe("true: only proposals already voted; false: only those still waiting"),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.number(), year: z.number(), number: z.string(), title: z.string(), article: z.string().nullable(),
                  topics: z.array(z.string()), result: z.string(), lastVotedOn: z.string().nullable(), documentUrl: z.string().nullable(),
                }),
              ),
              total: z.number(),
            }),
            401: errorSchema,
          },
        },
      },
      async (request) => {
        const { year, voted, limit } = request.query;
        const where = and(
          isNull(budgetSummaries.proposalId),
          year ? eq(budgetProposals.year, year) : undefined,
          voted === "true" ? sql`${budgetProposals.lastVotedOn} is not null` : voted === "false" ? isNull(budgetProposals.lastVotedOn) : undefined,
        );
        const from = () => db.select().from(budgetProposals).leftJoin(budgetSummaries, eq(budgetSummaries.proposalId, budgetProposals.id));
        const [rows, [{ total } = { total: 0 }]] = await Promise.all([
          from().where(where).orderBy(sql`${budgetProposals.year} desc, ${budgetProposals.lastVotedOn} desc nulls last, ${budgetProposals.id}`).limit(limit),
          db.select({ total: sql<number>`count(*)::int` }).from(budgetProposals).leftJoin(budgetSummaries, eq(budgetSummaries.proposalId, budgetProposals.id)).where(where),
        ]);
        return {
          items: rows.map(({ budget_proposals: p }) => ({
            id: p.id, year: p.year, number: p.number, title: p.title, article: p.article, topics: p.topics,
            result: p.result, lastVotedOn: p.lastVotedOn, documentUrl: p.documentUrl,
          })),
          total,
        };
      },
    );

    app.put(
      "/publish/budget/:id/summary",
      {
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        schema: {
          tags: ["publish"],
          summary: "Set a Budget proposal's plain summary (\"O que muda\"), written from its official PDF",
          headers: z.object({ authorization: z.string().optional() }),
          params: proposalId,
          body: z.strictObject({
            summary: z.string().trim().min(10).max(600).describe("One or two neutral sentences: what the proposal changes"),
            automatic: z.boolean().default(true).describe("True when a model wrote it; the site labels it as an automatic summary"),
          }),
          response: { 200: z.object({ id: z.number(), summary: z.string(), automatic: z.boolean(), changed: z.boolean() }), 400: errorSchema, 401: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const { summary, automatic } = request.body;
        if (!(await proposalExists(id))) throw notFound("Proposal");
        const changed = await db
          .insert(budgetSummaries)
          .values({ proposalId: id, summary, automatic, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: budgetSummaries.proposalId,
            set: { summary, automatic, updatedAt: new Date() },
            setWhere: sql`(${budgetSummaries.summary}, ${budgetSummaries.automatic}) is distinct from (${summary}, ${automatic})`,
          })
          .returning({ id: budgetSummaries.proposalId });
        if (changed.length > 0) void revalidate(["budget"]);
        return { id, summary, automatic, changed: changed.length > 0 };
      },
    );

    app.delete(
      "/publish/budget/:id/summary",
      {
        schema: {
          tags: ["publish"],
          summary: "Remove a Budget proposal's plain summary",
          headers: z.object({ authorization: z.string().optional() }),
          params: proposalId,
          response: { 204: z.null(), 401: errorSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const removed = await db.delete(budgetSummaries).where(eq(budgetSummaries.proposalId, request.params.id)).returning({ id: budgetSummaries.proposalId });
        if (removed.length === 0) throw notFound("Summary");
        void revalidate(["budget"]);
        return reply.status(204).send(null);
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
        const [row] = await db
          .update(editorialPosts)
          .set({ status: "draft", featured: false, updatedAt: new Date() })
          .where(and(eq(editorialPosts.slug, request.params.slug)))
          .returning({ slug: editorialPosts.slug });
        if (!row) throw notFound("Post");
        await audit(db, null, "editorial.api_unpublish", "editorial", row.slug);
        void revalidate(["blog"]);
        return reply.status(204).send(null);
      },
    );
  };
