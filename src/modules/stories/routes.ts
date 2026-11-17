import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articles, comments, deputies, initiatives, parties, stories, storyVotes } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { storyVoterKey } from "../../forums/identity.js";
import { stemsOf } from "../../stories/similarity.js";
import {
  articleColumns,
  articleDeputySchema,
  articleGovernmentSchema,
  articleInitiativeSchema,
  articlePartySchema,
  articleSchema,
  commaList,
  decodeOffset,
  encodeOffset,
  escapeLike,
  FOLDED_TEXT,
  idList,
  lisbonMidnight,
  searchWords,
  visibleArticle,
} from "../articles/routes.js";
import { publicCommentColumns, storyCommentScope } from "../comments/routes.js";
import { errorSchema } from "../shared.js";

/*
 * Stories: the same news told by several outlets, as one card. Grouped in src/stories after
 * each ingest. A story's card comes from its visible articles; readers mark it "Importa" and
 * comment on the story, not on each outlet's version.
 */

const MAX_INT = 2_147_483_647;
const idParams = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) });

const storySourceSchema = z.object({
  name: z.string().describe("The outlet's domain, as article.source"),
  articleId: z.number(),
  title: z.string().describe("How this outlet headlined it"),
  url: z.string(),
  publishedAt: z.string(),
});

export const storySchema = z.object({
  id: z.number(),
  title: z.string().describe("The headline most like the others (what most outlets said)"),
  imageUrl: z.string().nullable(),
  firstPublishedAt: z.string(),
  lastPublishedAt: z.string().describe("The latest version: newest sorts by it"),
  articleCount: z.number(),
  sourceCount: z.number().describe('Outlets that told it: "7 jornais contaram isto"'),
  sources: z.array(storySourceSchema).describe("One per outlet, first to publish first"),
  parties: z.array(articlePartySchema).describe("Named across its articles, most often first"),
  deputies: z.array(articleDeputySchema),
  government: z.array(articleGovernmentSchema),
  president: z.object({ id: z.string(), name: z.string() }).nullable(),
  initiatives: z.array(articleInitiativeSchema),
  importa: z.number().describe('Readers who marked it "Importa"'),
  importance: z
    .number()
    .describe("0 to 1: how its Importa marks compare with the stories of the last 24 hours (the share it ties or beats). 0 with no marks"),
  commentCount: z.number(),
});

const debateCommentSchema = z.object({
  id: z.number(),
  username: z.string().nullable(),
  body: z.string(),
  likes: z.number(),
  createdAt: z.string(),
});

const storyDetailSchema = storySchema.extend({
  articles: z.array(articleSchema).describe("Every outlet's version, first published first"),
  debate: z
    .object({ agree: debateCommentSchema.nullable(), disagree: debateCommentSchema.nullable() })
    .describe('The most liked comment that agrees, and that disagrees (at least 1 like each). Show the pair only when both exist'),
});

type Story = z.infer<typeof storySchema>;
type ArticleRow = Awaited<ReturnType<ReturnType<typeof selectArticles>["execute"]>>[number];

const selectArticles = (db: Db, storyIds: number[]) =>
  db
    .select(articleColumns)
    .from(articles)
    .where(and(inArray(articles.storyId, storyIds), visibleArticle))
    .orderBy(asc(articles.publishedAt), asc(articles.id));

/** Each story's numbers, over its visible articles. */
const storyStats = sql`(
  select a.story_id as id, count(*)::int as article_count, count(distinct a.source)::int as source_count,
    min(a.published_at) as first_at, max(a.published_at) as last_at
  from articles a where a.hidden_at is null and a.story_id is not null
  group by a.story_id
)`;

interface StatsRow extends Record<string, unknown> {
  id: number;
  article_count: number;
  source_count: number;
  first_at: Date | string;
  last_at: Date | string;
  importa: number;
}

/** Items named across a story's articles, most often first (then first seen). */
const byFrequency = <T>(lists: T[][], key: (item: T) => string | number) => {
  const seen = new Map<string | number, { item: T; count: number; first: number }>();
  let order = 0;
  for (const list of lists) {
    for (const item of list) {
      const k = key(item);
      const entry = seen.get(k);
      if (entry) entry.count++;
      else seen.set(k, { item, count: 1, first: order++ });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((e) => e.item);
};

/**
 * The headline most like the others, so the card reads as what most outlets said (the first
 * one can be written before the news happened: "Ventura vai a votos" before "Ventura
 * reeleito"). Ties go to the later headline.
 */
const representativeTitle = (titles: string[]) => {
  const stems = titles.map((t) => stemsOf(t));
  let best = 0;
  let bestScore = -1;
  stems.forEach((mine, i) => {
    let score = 0;
    stems.forEach((other, j) => {
      if (i === j) return;
      const shared = [...mine].filter((w) => other.has(w)).length;
      score += shared / Math.max(new Set([...mine, ...other]).size, 1);
    });
    if (score >= bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return titles[best]!;
};

/** "Hoje em 5": outlets that told it, plus half a point per Importa mark (up to 5 points). */
const TODAY_SCORE = sql`(st.source_count + least(s.importa, 10) / 2.0)`;

export const storyRoutes =
  (db: Db, { voteSecret }: { voteSecret: string }): FastifyPluginAsyncZod =>
  async (app) => {
    /** Importa marks of the stories with news in the last 24 hours, to place each story among them. */
    const importanceScale = async () => {
      const rows = await db.execute<{ importa: number }>(sql`
        select s.importa from stories s
        where exists (select 1 from articles a where a.story_id = s.id and a.hidden_at is null and a.published_at >= now() - interval '24 hours')`);
      const marks = rows.rows.map((r) => r.importa);
      return (importa: number) => (importa === 0 || marks.length === 0 ? 0 : Math.min(1, marks.filter((m) => m <= importa).length / marks.length));
    };

    /** Visible comments per story, counting those made on its articles too. */
    const commentCounts = async (ids: number[]) => {
      if (ids.length === 0) return new Map<number, number>();
      const rows = await db.execute<{ id: number; n: number }>(sql`
        select coalesce(c.story_id, a.story_id) as id, count(*)::int as n
        from comments c left join articles a on a.id = c.article_id
        where c.hidden_at is null
          and (c.story_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            or (a.hidden_at is null and a.story_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})))
        group by 1`);
      return new Map(rows.rows.map((r) => [r.id, r.n]));
    };

    /** Cards for these stories, in the order given, with their articles. */
    const hydrate = async (rows: StatsRow[]) => {
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [];
      const [all, counts, importance] = await Promise.all([selectArticles(db, ids), commentCounts(ids), importanceScale()]);
      const byStory = new Map<number, ArticleRow[]>();
      for (const article of all) byStory.set(article.storyId!, [...(byStory.get(article.storyId!) ?? []), article]);
      return rows
        .filter((r) => byStory.has(r.id))
        .map((r) => {
          const list = byStory.get(r.id)!;
          const outlets = new Map<string, ArticleRow>();
          for (const a of list) if (!outlets.has(a.source)) outlets.set(a.source, a);
          const presidents = byFrequency(list.map((a) => (a.president ? [a.president] : [])), (p) => p.id);
          const card: Story = {
            id: r.id,
            title: representativeTitle(list.map((a) => a.title)),
            imageUrl: list.find((a) => a.imageUrl)?.imageUrl ?? null,
            firstPublishedAt: new Date(r.first_at).toISOString(),
            lastPublishedAt: new Date(r.last_at).toISOString(),
            articleCount: r.article_count,
            sourceCount: r.source_count,
            sources: [...outlets.values()].map((a) => ({
              name: a.source,
              articleId: a.id,
              title: a.title,
              url: a.url,
              publishedAt: a.publishedAt.toISOString(),
            })),
            parties: byFrequency(list.map((a) => a.parties), (p) => p.slug),
            deputies: byFrequency(list.map((a) => a.deputies), (d) => d.id),
            government: byFrequency(list.map((a) => a.government), (g) => g.id),
            president: presidents[0] ?? null,
            initiatives: byFrequency(list.map((a) => a.initiatives), (i) => i.id),
            importa: r.importa,
            importance: importance(r.importa),
            commentCount: counts.get(r.id) ?? 0,
          };
          return { card, articles: list };
        });
    };

    app.get(
      "/stories",
      {
        schema: {
          tags: ["stories"],
          summary: "The news as stories: one card per story, with every outlet that told it",
          querystring: z.object({
            q: z.string().trim().max(200).optional().describe("Words in any version's title or excerpt"),
            party: commaList(30).optional().describe("Party slug(s): stories about any of them"),
            deputy: z.coerce.number().int().positive().max(MAX_INT).optional(),
            initiative: z.coerce.number().int().positive().max(MAX_INT).optional(),
            governmentMember: z.string().regex(/^[0-9a-f]{32}$/).optional(),
            president: z.string().regex(/^[a-z-]+$/).optional(),
            source: commaList(30).optional().describe("Stories told by any of these outlets"),
            ids: idList(100).optional().describe("Only these stories (saved ones)"),
            exclude: idList(500).optional().describe("Leave these stories out (hidden ones)"),
            excludeSource: commaList(30).optional().describe("Leave out stories told only by these outlets"),
            excludeParty: commaList(30).optional().describe("Leave out stories about any of these parties. Unknown slugs are ignored"),
            sort: z
              .enum(["newest", "top", "coverage"])
              .default("newest")
              .describe("newest: latest version first. top: most Importa marks. coverage: most outlets. Ties: newest"),
            period: z
              .enum(["today", "yesterday", "week", "month"])
              .optional()
              .describe("Stories with a version published then, in Lisbon days (as on /articles)"),
            since: z
              .string()
              .regex(/^\d{1,4}h?$/)
              .transform((value) => Number.parseInt(value, 10))
              .pipe(z.number().int().min(1).max(8760))
              .optional()
              .describe('Stories with a version in the last N hours, e.g. "24h"'),
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: {
            200: z.object({ items: z.array(storySchema), nextCursor: z.string().nullable(), total: z.number() }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const query = request.query;
        const offset = query.cursor === undefined ? 0 : decodeOffset(query.cursor);

        // What one of the story's versions must match. Written against "articles" so the shared search SQL fits.
        const versions: SQL[] = [sql`articles.hidden_at is null`];
        for (const word of searchWords(query.q ?? "")) versions.push(sql`${FOLDED_TEXT} like ${`%${escapeLike(word)}%`}`);
        if (query.source) versions.push(sql`articles.source in (${sql.join(query.source.map((s) => sql`${s}`), sql`, `)})`);
        if (query.excludeSource) versions.push(sql`articles.source not in (${sql.join(query.excludeSource.map((s) => sql`${s}`), sql`, `)})`);
        if (query.party) {
          const found = await db.select({ id: parties.id, slug: parties.slug }).from(parties).where(inArray(parties.slug, query.party));
          const unknown = query.party.filter((slug) => !found.some((p) => p.slug === slug));
          if (unknown.length > 0) throw new ApiError(404, "not_found", `Party not found: ${unknown.join(", ")}`);
          versions.push(sql`exists (select 1 from article_parties ap where ap.article_id = articles.id
            and ap.party_id in (${sql.join(found.map((p) => sql`${p.id}`), sql`, `)}))`);
        }
        if (query.deputy !== undefined) {
          const [found] = await db.select({ id: deputies.id }).from(deputies).where(eq(deputies.id, query.deputy));
          if (!found) throw notFound("Deputy");
          versions.push(sql`exists (select 1 from article_deputies ad where ad.article_id = articles.id and ad.deputy_id = ${found.id})`);
        }
        if (query.initiative !== undefined) {
          const [found] = await db.select({ id: initiatives.id }).from(initiatives).where(eq(initiatives.id, query.initiative));
          if (!found) throw notFound("Initiative");
          versions.push(sql`exists (select 1 from article_initiatives ai where ai.article_id = articles.id and ai.initiative_id = ${found.id})`);
        }
        if (query.governmentMember) {
          versions.push(sql`exists (select 1 from article_government_members agm
            where agm.article_id = articles.id and agm.member_id = ${query.governmentMember})`);
        }
        if (query.president) {
          versions.push(sql`exists (select 1 from article_presidents ap where ap.article_id = articles.id and ap.president_id = ${query.president})`);
        }

        const conditions: SQL[] = [sql`exists (select 1 from articles where articles.story_id = st.id and ${sql.join(versions, sql` and `)})`];
        if (query.ids) conditions.push(sql`st.id in (${sql.join(query.ids.map((id) => sql`${id}`), sql`, `)})`);
        if (query.exclude) conditions.push(sql`st.id not in (${sql.join(query.exclude.map((id) => sql`${id}`), sql`, `)})`);
        if (query.excludeParty) {
          conditions.push(sql`not exists (
            select 1 from articles x join article_parties ap on ap.article_id = x.id join parties p on p.id = ap.party_id
            where x.story_id = st.id and x.hidden_at is null and p.slug in (${sql.join(query.excludeParty.map((s) => sql`${s}`), sql`, `)}))`);
        }
        if (query.since !== undefined) conditions.push(sql`st.last_at >= now() - make_interval(hours => ${query.since})`);
        if (query.period === "today") conditions.push(sql`st.last_at >= ${lisbonMidnight(0)}`);
        if (query.period === "week") conditions.push(sql`st.last_at >= ${lisbonMidnight(6)}`);
        if (query.period === "month") conditions.push(sql`st.last_at >= ${lisbonMidnight(29)}`);
        if (query.period === "yesterday") {
          // A version published yesterday, whenever the others came out.
          conditions.push(sql`exists (select 1 from articles y where y.story_id = st.id and y.hidden_at is null
            and y.published_at >= ${lisbonMidnight(1)} and y.published_at < ${lisbonMidnight(0)})`);
        }

        const where = sql.join(conditions, sql` and `);
        const order = {
          newest: sql`st.last_at desc, st.id desc`,
          top: sql`s.importa desc, st.last_at desc, st.id desc`,
          coverage: sql`st.source_count desc, st.article_count desc, st.last_at desc, st.id desc`,
        }[query.sort];
        const [page, total] = await Promise.all([
          db.execute<StatsRow>(sql`
            select st.*, s.importa from ${storyStats} st join stories s on s.id = st.id
            where ${where} order by ${order} limit ${query.limit + 1} offset ${offset}`),
          db.execute<{ n: number }>(sql`select count(*)::int as n from ${storyStats} st where ${where}`),
        ]);
        const rows = page.rows.slice(0, query.limit);
        return {
          items: (await hydrate(rows)).map((s) => s.card),
          nextCursor: page.rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
          total: total.rows[0]?.n ?? 0,
        };
      },
    );

    app.get(
      "/stories/:id",
      {
        schema: {
          tags: ["stories"],
          summary: "One story, with every outlet's version and the debate in its comments",
          params: idParams,
          response: { 200: storyDetailSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const id = request.params.id;
        const stats = await db.execute<StatsRow>(sql`
          select st.*, s.importa from ${storyStats} st join stories s on s.id = st.id where st.id = ${id}`);
        const [story] = await hydrate(stats.rows);
        if (!story) throw notFound("Story");
        const best = async (stance: "agree" | "disagree") => {
          const [row] = await db
            .select(publicCommentColumns)
            .from(comments)
            .where(and(storyCommentScope(id), isNull(comments.hiddenAt), eq(comments.stance, stance), sql`${comments.likes} > 0`))
            .orderBy(desc(comments.likes), asc(comments.createdAt))
            .limit(1);
          return row ? { id: row.id, username: row.username, body: row.body, likes: row.likes, createdAt: row.createdAt.toISOString() } : null;
        };
        const [agree, disagree] = await Promise.all([best("agree"), best("disagree")]);
        return {
          ...story.card,
          articles: story.articles.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
          debate: { agree, disagree },
        };
      },
    );

    app.post(
      "/stories/:id/vote",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["stories"],
          summary: 'Mark a story "Importa" (1) or take the mark back (0). One per reader',
          params: idParams,
          body: z.strictObject({ value: z.union([z.literal(1), z.literal(0)]) }),
          response: {
            200: z.object({ importa: z.number(), importance: z.number(), mine: z.union([z.literal(1), z.literal(0)]) }),
            400: errorSchema,
            404: errorSchema,
            429: errorSchema,
          },
        },
      },
      async (request) => {
        const storyId = request.params.id;
        const { value } = request.body;
        const voter = storyVoterKey(voteSecret, request.ip, storyId);
        const importa = await db.transaction(async (tx) => {
          // Locks the story, so marks on it count one at a time and the total stays exact.
          const [story] = await tx
            .select({ id: stories.id })
            .from(stories)
            .where(and(eq(stories.id, storyId), sql`exists (select 1 from articles a where a.story_id = ${storyId} and a.hidden_at is null)`))
            .for("update");
          if (!story) throw notFound("Story");
          if (value === 0) await tx.delete(storyVotes).where(and(eq(storyVotes.storyId, storyId), eq(storyVotes.voter, voter)));
          else await tx.insert(storyVotes).values({ storyId, voter }).onConflictDoNothing();
          const [row] = await tx
            .update(stories)
            .set({ importa: sql`(select count(*)::int from story_votes v where v.story_id = ${storyId})` })
            .where(eq(stories.id, storyId))
            .returning({ importa: stories.importa });
          return row!.importa;
        });
        return { importa, importance: (await importanceScale())(importa), mine: value };
      },
    );

    app.get(
      "/today",
      {
        schema: {
          tags: ["stories"],
          summary: '"Hoje em 5": the 5 stories that matter most in the last 24 hours',
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(10).default(5) }),
          response: { 200: z.object({ items: z.array(storySchema), since: z.string() }) },
        },
      },
      async (request) => {
        const since = new Date(Date.now() - 24 * 3_600_000);
        const rows = await db.execute<StatsRow>(sql`
          select st.*, s.importa from ${storyStats} st join stories s on s.id = st.id
          where st.last_at >= ${since.toISOString()}::timestamptz
          order by ${TODAY_SCORE} desc, st.last_at desc, st.id desc
          limit ${request.query.limit}`);
        return { items: (await hydrate(rows.rows)).map((s) => s.card), since: since.toISOString() };
      },
    );
  };
