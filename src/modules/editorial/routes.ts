import { createHash } from "node:crypto";
import { and, arrayContains, count, countDistinct, desc, eq, like, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { lisbonDay } from "../../agenda/time.js";
import { z } from "zod";
import { type Admin, adminGuard, audit, hasRole } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { editorialPosts, editorialViews, editorialVotes } from "../../db/schema.js";
import { parseMedia, slugify } from "../../editorial/media.js";
import { ApiError, notFound } from "../../errors.js";
import { postVoterKey } from "../../forums/identity.js";
import { errorSchema } from "../shared.js";

const kindSchema = z.enum(["article", "opinion", "podcast", "interview", "video"]);
const mediaSchema = z
  .object({
    provider: z.enum(["youtube", "vimeo", "spotify", "soundcloud", "apple_podcasts"]),
    url: z.string(),
    embedUrl: z.string().describe("Use as the iframe src"),
  })
  .nullable();

const summarySchema = z.object({
  id: z.number(),
  slug: z.string(),
  kind: kindSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  authorName: z.string(),
  coverImageUrl: z.string().nullable(),
  media: mediaSchema,
  tags: z.array(z.string()),
  featured: z.boolean(),
  readingMinutes: z.number().describe("Words ÷ 200, rounded up; at least 1"),
  upvotes: z.number(),
  downvotes: z.number(),
  publishedAt: z.string().nullable(),
});
const bodySchema = z.string().describe("Markdown. Render it without raw HTML");
/** What readers get: the post plus how many visible comments and reads it has. */
const publicSummarySchema = summarySchema.extend({
  commentCount: z.number(),
  views: z.number().describe("Reads since publication: one per reader per day"),
  recentViews: z.number().optional().describe("Reads in the last `days` (sort=popular only); the list is sorted by it"),
});
const postSchema = publicSummarySchema.extend({ body: bodySchema });
const adminPostSchema = summarySchema.extend({ body: bodySchema,
  status: z.enum(["draft", "published"]),
  authorId: z.number().nullable(),
  mediaUrl: z.string().nullable(),
  updatedAt: z.string(),
});

const httpsUrl = z.url({ protocol: /^https$/ }).max(1000);
export const editorialInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  subtitle: z.string().trim().max(300).nullable(),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .nullable()
    .describe("Defaults to one made from the title"),
  kind: kindSchema,
  body: z.string().max(100_000),
  authorName: z.string().trim().min(1).max(100).nullable().describe("Byline; defaults to your name"),
  coverImageUrl: httpsUrl.nullable(),
  mediaUrl: httpsUrl.nullable().describe("YouTube, Vimeo, Spotify, SoundCloud or Apple Podcasts"),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10),
});

type Row = typeof editorialPosts.$inferSelect;
/** Words in the Markdown, links' addresses and markup left out, at 200 words a minute. */
export const readingMinutes = (markdown: string) => {
  const text = markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~|-]+/g, " ");
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.max(1, Math.ceil(words / 200));
};
const present = (r: Row) => ({
  id: r.id, slug: r.slug, kind: r.kind, title: r.title, subtitle: r.subtitle, authorName: r.authorName,
  coverImageUrl: r.coverImageUrl, media: r.mediaUrl ? parseMedia(r.mediaUrl) : null, tags: r.tags, featured: r.featured,
  readingMinutes: readingMinutes(r.body), upvotes: r.upvotes, downvotes: r.downvotes, publishedAt: r.publishedAt?.toISOString() ?? null,
});
const presentAdmin = (r: Row) => ({
  ...present(r), body: r.body, status: r.status, authorId: r.authorId, mediaUrl: r.mediaUrl, updatedAt: r.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) });

// The table named in full: inside the subquery, a bare "id" would be the comment's.
const commentCount = sql<number>`(select count(*)::int from comments c where c.editorial_post_id = "editorial_posts"."id" and c.hidden_at is null)`;

const totalViews = sql<number>`(select coalesce(sum(v.views), 0)::int from editorial_views v where v.post_id = "editorial_posts"."id")`;

/** Today in Lisbon, in SQL, so reads are counted by the same day everywhere. */
export const lisbonToday = sql`(now() at time zone 'Europe/Lisbon')::date`;

/**
 * Who already counted as a read of a post today, so reloads and repeated beacons count once.
 * Kept in memory only, as hashes, and forgotten at the end of the day (or past its size).
 */
export const createReadDedupe = (max = 200_000) => {
  let day = "";
  let seen = new Set<string>();
  return (ip: string, postId: number, today: string) => {
    if (today !== day || seen.size >= max) {
      day = today;
      seen = new Set();
    }
    const key = createHash("sha256").update(`${ip}|${postId}|${today}`).digest("base64url").slice(0, 16);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
};
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

export const editorialRoutes =
  (db: Db, { voteSecret }: { voteSecret: string }): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    // Public.

    app.get(
      "/editorial",
      {
        schema: {
          tags: ["editorial"],
          summary: "Our published articles, opinion, podcasts and interviews: newest first, or most read",
          querystring: z.object({
            sort: z.enum(["new", "popular"]).default("new").describe("popular: most read in the last `days`; posts with no reads are left out"),
            days: z.coerce.number().int().min(1).max(90).default(7).describe("For sort=popular"),
            featured: z.enum(["true", "false"]).optional().describe("true: the front-page picks"),
            kind: kindSchema.optional(),
            tag: z.string().max(40).optional(),
            page: z.coerce.number().int().min(1).max(1000).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: { 200: z.object({ items: z.array(publicSummarySchema), total: z.number() }), 400: errorSchema },
        },
      },
      async (request) => {
        const { sort, days, featured, kind, tag, page, limit } = request.query;
        const where = and(
          eq(editorialPosts.status, "published"),
          featured ? eq(editorialPosts.featured, featured === "true") : undefined,
          kind ? eq(editorialPosts.kind, kind) : undefined,
          tag ? arrayContains(editorialPosts.tags, [tag.toLowerCase()]) : undefined,
        );
        if (sort === "popular") {
          const recent = and(eq(editorialViews.postId, editorialPosts.id), sql`${editorialViews.day} > ${lisbonToday} - ${days}::int`);
          const recentViews = sql<number>`sum(${editorialViews.views})::int`;
          const [rows, [total]] = await Promise.all([
            db
              .select({ post: editorialPosts, recentViews, views: totalViews, commentCount })
              .from(editorialPosts)
              .innerJoin(editorialViews, recent)
              .where(where)
              .groupBy(editorialPosts.id)
              .orderBy(desc(recentViews), desc(editorialPosts.publishedAt), desc(editorialPosts.id))
              .limit(limit)
              .offset((page - 1) * limit),
            db.select({ n: countDistinct(editorialPosts.id) }).from(editorialPosts).innerJoin(editorialViews, recent).where(where),
          ]);
          return {
            items: rows.map((r) => ({ ...present(r.post), views: r.views, recentViews: r.recentViews, commentCount: r.commentCount })),
            total: total?.n ?? 0,
          };
        }
        const [rows, [total]] = await Promise.all([
          db
            .select({ post: editorialPosts, views: totalViews, commentCount })
            .from(editorialPosts)
            .where(where)
            .orderBy(desc(editorialPosts.publishedAt), desc(editorialPosts.id))
            .limit(limit)
            .offset((page - 1) * limit),
          db.select({ n: count() }).from(editorialPosts).where(where),
        ]);
        return { items: rows.map((r) => ({ ...present(r.post), views: r.views, commentCount: r.commentCount })), total: total?.n ?? 0 };
      },
    );

    app.get(
      "/editorial/:slug",
      {
        schema: {
          tags: ["editorial"],
          summary: "One published post",
          params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }),
          response: { 200: postSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const [row] = await db
          .select({ post: editorialPosts, views: totalViews, commentCount })
          .from(editorialPosts)
          .where(and(eq(editorialPosts.slug, request.params.slug), eq(editorialPosts.status, "published")));
        if (!row) throw notFound("Post");
        return { ...present(row.post), views: row.views, commentCount: row.commentCount, body: row.post.body };
      },
    );

    // Reads, for "Mais lidos". The browser sends a beacon (navigator.sendBeacon), which may come
    // as text/plain or with no body at all: this route takes any body and ignores it.
    app.post(
      "/editorial/:slug/vote",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["editorial"],
          summary: "Vote a post up (1) or down (-1), or remove the vote (0). One vote per reader; voting again replaces it",
          params: slugParams,
          body: z.strictObject({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
          response: {
            200: z.object({ up: z.number(), down: z.number(), mine: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
            400: errorSchema,
            404: errorSchema,
            429: errorSchema,
          },
        },
      },
      async (request) => {
        const { value } = request.body;
        const who = app.participant(request, "votes");
        return db.transaction(async (tx) => {
          // Locks the post, so votes on it count one at a time and the totals stay exact.
          const [post] = await tx
            .select({ id: editorialPosts.id })
            .from(editorialPosts)
            .where(and(eq(editorialPosts.slug, request.params.slug), eq(editorialPosts.status, "published")))
            .for("update");
          if (!post) throw notFound("Post");
          const voter = postVoterKey(voteSecret, who.key, post.id);
          const mine = and(eq(editorialVotes.postId, post.id), eq(editorialVotes.voter, voter));
          if (value === 0) await tx.delete(editorialVotes).where(mine);
          else {
            await tx
              .insert(editorialVotes)
              .values({ postId: post.id, voter, value, userId: who.userId })
              .onConflictDoUpdate({ target: [editorialVotes.postId, editorialVotes.voter], set: { value, userId: who.userId, updatedAt: sql`now()` } });
          }
          const [counts] = await tx
            .update(editorialPosts)
            .set({
              upvotes: sql`(select count(*)::int from editorial_votes v where v.post_id = ${post.id} and v.value = 1)`,
              downvotes: sql`(select count(*)::int from editorial_votes v where v.post_id = ${post.id} and v.value = -1)`,
            })
            .where(eq(editorialPosts.id, post.id))
            .returning({ up: editorialPosts.upvotes, down: editorialPosts.downvotes });
          return { up: counts!.up, down: counts!.down, mine: value };
        });
      },
    );

    const firstRead = createReadDedupe();
    await app.register(async (scope) => {
      const beacon = scope.withTypeProvider<ZodTypeProvider>();
      beacon.removeAllContentTypeParsers();
      beacon.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 4096 }, (_request, _body, done) => done(null, null));
      beacon.post(
        "/editorial/:slug/view",
        {
          config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
          schema: {
            tags: ["editorial"],
            summary: "Count a read of a post (once per reader per post per day; no reader data is kept)",
            params: slugParams,
            response: { 204: z.null(), 400: errorSchema, 404: errorSchema, 429: errorSchema },
          },
        },
        async (request, reply) => {
          const [post] = await db
            .select({ id: editorialPosts.id })
            .from(editorialPosts)
            .where(and(eq(editorialPosts.slug, request.params.slug), eq(editorialPosts.status, "published")));
          if (!post) throw notFound("Post");
          if (firstRead(request.ip, post.id, lisbonDay(new Date()))) {
            await db
              .insert(editorialViews)
              .values({ postId: post.id, day: sql`${lisbonToday}`, views: 1 })
              .onConflictDoUpdate({ target: [editorialViews.postId, editorialViews.day], set: { views: sql`${editorialViews.views} + 1` } });
          }
          return reply.status(204).send(null);
        },
      );
    });

    // Admin: authors write and publish their own posts; moderators and admins can edit any and choose the featured ones.

    const load = async (id: number, me: Admin) => {
      const [row] = await db.select().from(editorialPosts).where(eq(editorialPosts.id, id));
      if (!row) throw notFound("Post");
      if (row.authorId !== me.id && !hasRole(me.role, "moderator")) throw new ApiError(403, "forbidden", "Only its author or a moderator can change it");
      return row;
    };

    const fields = async (input: z.infer<typeof editorialInputSchema>, me: Admin, id: number | null) => {
      if (input.mediaUrl && !parseMedia(input.mediaUrl)) {
        throw new ApiError(400, "unsupported_media", "Use a YouTube, Vimeo, Spotify, SoundCloud or Apple Podcasts link");
      }
      let slug = input.slug ?? slugify(input.title);
      if (input.slug) {
        const [taken] = await db.select({ id: editorialPosts.id }).from(editorialPosts).where(eq(editorialPosts.slug, slug));
        if (taken && taken.id !== id) throw new ApiError(409, "slug_taken", "Another post uses that slug");
      } else {
        // Keep the slug a post already has; otherwise add a number until it's free.
        const existing = await db
          .select({ id: editorialPosts.id, slug: editorialPosts.slug })
          .from(editorialPosts)
          .where(or(eq(editorialPosts.slug, slug), like(editorialPosts.slug, `${slug}-%`)));
        const mine = existing.find((e) => e.id === id && (e.slug === slug || /^\d+$/.test(e.slug.slice(slug.length + 1))));
        if (mine) slug = mine.slug;
        else if (existing.some((e) => e.slug === slug)) {
          let n = 2;
          while (existing.some((e) => e.slug === `${slug}-${n}`)) n++;
          slug = `${slug}-${n}`;
        }
      }
      const { slug: _slug, authorName, tags, ...rest } = input;
      return { ...rest, slug, tags: [...new Set(tags)], authorName: authorName ?? me.name };
    };

    app.get(
      "/admin/editorial",
      {
        schema: {
          tags: ["admin"],
          summary: "Posts you can edit (authors: their own), last edited first",
          response: { 200: z.object({ items: z.array(adminPostSchema.omit({ body: true })) }), ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request);
        const rows = await db
          .select()
          .from(editorialPosts)
          .where(hasRole(me.role, "moderator") ? undefined : eq(editorialPosts.authorId, me.id))
          .orderBy(desc(editorialPosts.updatedAt));
        return { items: rows.map((r) => { const { body: _body, ...rest } = presentAdmin(r); return rest; }) };
      },
    );

    app.get(
      "/admin/editorial/:id",
      { schema: { tags: ["admin"], summary: "One post, to edit", params: idParams, response: { 200: adminPostSchema, ...errors } } },
      async (request) => presentAdmin(await load(request.params.id, await requireAdmin(request))),
    );

    app.post(
      "/admin/editorial",
      {
        schema: { tags: ["admin"], summary: "Write a new post (a draft)", body: editorialInputSchema, response: { 201: adminPostSchema, 409: errorSchema, ...errors } },
      },
      async (request, reply) => {
        const me = await requireAdmin(request);
        const [created] = await db.insert(editorialPosts).values({ ...(await fields(request.body, me, null)), authorId: me.id }).returning();
        await audit(db, me.id, "editorial.create", "editorial", created!.id, null, presentAdmin(created!));
        return reply.status(201).send(presentAdmin(created!));
      },
    );

    app.put(
      "/admin/editorial/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Replace a post's content (it keeps its status)",
          params: idParams,
          body: editorialInputSchema,
          response: { 200: adminPostSchema, 409: errorSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request);
        const before = await load(request.params.id, me);
        const [after] = await db
          .update(editorialPosts)
          .set({ ...(await fields(request.body, me, before.id)), authorName: request.body.authorName ?? before.authorName, updatedAt: new Date() })
          .where(eq(editorialPosts.id, before.id))
          .returning();
        await audit(db, me.id, "editorial.update", "editorial", before.id, presentAdmin(before), presentAdmin(after!));
        return presentAdmin(after!);
      },
    );

    const transitions = [
      { name: "publish", role: "author", set: (r: Row) => ({ status: "published" as const, publishedAt: r.publishedAt ?? new Date() }) },
      { name: "unpublish", role: "author", set: () => ({ status: "draft" as const, featured: false }) },
      { name: "feature", role: "moderator", set: () => ({ featured: true }) },
      { name: "unfeature", role: "moderator", set: () => ({ featured: false }) },
    ] as const;

    for (const t of transitions) {
      app.post(
        `/admin/editorial/:id/${t.name}`,
        {
          schema: {
            tags: ["admin"],
            summary: { publish: "Publish a post", unpublish: "Back to draft", feature: "Show it on the front page (moderators)", unfeature: "Take it off the front page" }[t.name],
            params: idParams,
            response: { 200: adminPostSchema, ...errors },
          },
        },
        async (request) => {
          const me = await requireAdmin(request, t.role);
          const before = await load(request.params.id, me);
          if (t.name === "feature" && before.status !== "published") throw new ApiError(400, "not_published", "Publish it first");
          if (t.name === "publish" && before.body.trim().length === 0) throw new ApiError(400, "empty_body", "Write something first");
          const [after] = await db
            .update(editorialPosts)
            .set({ ...t.set(before), updatedAt: new Date() })
            .where(eq(editorialPosts.id, before.id))
            .returning();
          await audit(db, me.id, `editorial.${t.name}`, "editorial", before.id);
          return presentAdmin(after!);
        },
      );
    }

    app.delete(
      "/admin/editorial/:id",
      {
        schema: { tags: ["admin"], summary: "Delete a draft (unpublish it first)", params: idParams, response: { 204: z.null(), ...errors } },
      },
      async (request, reply) => {
        const me = await requireAdmin(request);
        const before = await load(request.params.id, me);
        if (before.status === "published") throw new ApiError(400, "published", "Unpublish it first");
        await db.delete(editorialPosts).where(eq(editorialPosts.id, before.id));
        await audit(db, me.id, "editorial.delete", "editorial", before.id, presentAdmin(before), null);
        return reply.status(204).send(null);
      },
    );
  };
