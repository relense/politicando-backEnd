import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { briefOf, recentStories, type MergeArticle, type MergeJudge, type MergeStory } from "./merge.js";
import { rarity, sameStory, termsOf, type Rarity } from "./similarity.js";
import { refreshStoryTags } from "./tags.js";

/*
 * Takes out of a story the articles that don't belong in it. Articles join a story when they
 * match half of it, so a story can drift: a roundup of two votes ("IVA zero sim, rendas
 * moderadas não") matches both, and the next articles follow, until the first article, about
 * the other vote, no longer fits anything in the story.
 *
 * 1. Cheap rules pick the odd ones out: articles that few others in their story match.
 * 2. The same small model as merging (merge.ts) says whether each one tells the same happening
 *    as the rest of the story. Its answer is kept until the story doubles.
 * 3. A "no" moves the article into a story of its own, kept apart from the old one for good
 *    (story_apart), so merging never joins them back. Merging may still join it to the story it
 *    does belong to.
 *
 * Articles that came in through a merge are left alone: the model already said they belong,
 * and they're expected to share few words with the rest. The same goes for stories with joins
 * from before merges kept their articles.
 *
 * splitStory is also what `npm run story:split` runs, for the cases this misses.
 */

/** Stories with fewer visible articles aren't looked at: with 3, "odd one out" means little. */
export const MIN_STORY_SIZE = 4;
/** An article is odd when it matches fewer than this share of the others in its story. */
export const MIN_MATCH_SHARE = 1 / 3;
/** The model is asked at most this often per run. */
export const MAX_STRAY_CHECKS = 100;
/** Questions to the model at once. */
const CONCURRENCY = 4;
const RARITY_DAYS = 7;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const intArray = (ids: number[]) => sql`${`{${ids.join(",")}}`}::integer[]`;

/**
 * Moves these articles out of their story into a new one, kept apart from the old one. Earlier
 * joins whose articles all moved go with them, so their old ids answer as the new story.
 * Throws when an article isn't in the story or nothing would be left.
 */
export const splitStory = async (tx: Tx, storyId: number, articleIds: number[], reason: "model" | "manual") => {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) throw new Error("No articles to split off");
  const inStory = await tx.execute<{ n: number; first: Date | null }>(
    sql`select count(*)::int as n, min(published_at) as first from articles where story_id = ${storyId} and id = any(${intArray(ids)})`,
  );
  if (inStory.rows[0]!.n !== ids.length) throw new Error(`Not every article is in story ${storyId}`);
  const left = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from articles where story_id = ${storyId} and hidden_at is null and not (id = any(${intArray(ids)}))`,
  );
  if (left.rows[0]!.n === 0) throw new Error(`Story ${storyId} would have no visible articles left`);

  const [created] = (
    await tx.execute<{ id: number }>(sql`insert into stories (created_at) values (${new Date(inStory.rows[0]!.first!).toISOString()}::timestamptz) returning id`)
  ).rows;
  const newId = created!.id;
  await tx.execute(sql`update articles set story_id = ${newId} where id = any(${intArray(ids)})`);
  const redirected = await tx.execute<{ from_id: number }>(sql`
    update story_merges set into_id = ${newId}
    where into_id = ${storyId} and cardinality(article_ids) > 0 and article_ids <@ ${intArray(ids)}
    returning from_id`);
  await tx.execute(sql`insert into story_apart (low_id, high_id, reason) values (${storyId}, ${newId}, ${reason}) on conflict do nothing`);
  await refreshStoryTags(tx, new Set([storyId, newId]));
  return { id: newId, moved: ids.length, left: left.rows[0]!.n, redirected: redirected.rows.map((r) => r.from_id).sort((a, b) => a - b) };
};

export interface Stray {
  story: MergeStory;
  article: MergeArticle;
}

/**
 * The odd ones out: in stories of at least MIN_STORY_SIZE, articles that match fewer than
 * MIN_MATCH_SHARE of the others. `exempt` holds the articles that came in through a merge.
 */
export const findStrays = (stories: MergeStory[], rare: Rarity, exempt: Set<number> = new Set()): Stray[] => {
  const found: Stray[] = [];
  for (const story of stories) {
    if (story.articles.length < MIN_STORY_SIZE) continue;
    const terms = story.articles.map((a) => ({ article: a, terms: termsOf(a), source: a.source }));
    const need = Math.ceil((terms.length - 1) * MIN_MATCH_SHARE);
    for (const x of terms) {
      if (exempt.has(x.article.id)) continue;
      const hits = terms.filter((y) => y !== x && sameStory(x, y, rare).ok).length;
      if (hits < need) found.push({ story, article: x.article });
    }
  }
  return found;
};

/**
 * Finds the articles that don't belong in their story and moves each into a story of its own
 * (see the top of this file). Needs the model: without it nothing moves.
 */
export const detachStrays = async (
  db: Db,
  { judge = null, maxChecks = MAX_STRAY_CHECKS, now = new Date(), log = console }: { judge?: MergeJudge | null; maxChecks?: number; now?: Date; log?: Pick<Console, "error"> } = {},
) => {
  const none = { suspects: 0, checked: 0, detached: 0 };
  if (!judge) return none;
  const stories = await recentStories(db, now);
  if (stories.length === 0) return none;

  // Articles that came in through a merge are exempt; stories with joins of unknown articles are skipped.
  const merges = await db.execute<{ into_id: number; article_ids: number[] | null }>(
    sql`select into_id, article_ids from story_merges where into_id = any(${intArray(stories.map((s) => s.id))})`,
  );
  const exempt = new Set<number>();
  const unknown = new Set<number>();
  for (const m of merges.rows) {
    if (m.article_ids === null) unknown.add(m.into_id);
    else for (const id of m.article_ids) exempt.add(id);
  }
  const context = await db.execute<{ title: string; excerpt: string }>(sql`
    select title, excerpt from articles where hidden_at is null
      and published_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${RARITY_DAYS})`);
  const rare = rarity(context.rows.map((a) => termsOf({ ...a, people: [] })));
  const strays = findStrays(stories.filter((s) => !unknown.has(s.id)), rare, exempt);
  if (strays.length === 0) return none;

  const cached = await db.execute<{ story_id: number; article_id: number; story_size: number; belongs: boolean }>(sql`
    select story_id, article_id, story_size, belongs from story_article_checks
    where article_id = any(${intArray(strays.map((s) => s.article.id))})`);
  const answers = new Map(cached.rows.map((r) => [`${r.story_id}:${r.article_id}`, r]));

  const out: Stray[] = [];
  const toAsk: Stray[] = [];
  for (const stray of strays) {
    const answer = answers.get(`${stray.story.id}:${stray.article.id}`);
    // Kept until the story doubles: by then it may have drifted further, or back.
    if (answer && stray.story.articles.length < answer.story_size * 2) {
      if (!answer.belongs) out.push(stray);
    } else if (toAsk.length < maxChecks) {
      toAsk.push(stray);
    }
  }

  let checked = 0;
  let failures = 0;
  for (let i = 0; i < toAsk.length && failures < 3; i += CONCURRENCY) {
    await Promise.all(
      toAsk.slice(i, i + CONCURRENCY).map(async (stray) => {
        const { story, article } = stray;
        let same: boolean | null;
        try {
          checked++;
          same = await judge(briefOf({ ...story, articles: story.articles.filter((a) => a.id !== article.id) }), briefOf({ ...story, articles: [article] }));
        } catch (error) {
          failures++;
          log.error("Story article check failed:", error instanceof Error ? error.message : error);
          return;
        }
        if (same === null) return;
        await db.execute(sql`
          insert into story_article_checks (story_id, article_id, story_size, belongs)
          values (${story.id}, ${article.id}, ${story.articles.length}, ${same})
          on conflict (story_id, article_id) do update set story_size = excluded.story_size, belongs = excluded.belongs, checked_at = now()`);
        if (!same) out.push(stray);
      }),
    );
  }

  // A story the model says is mostly strays is left as it is: that's a doubt, not a fix.
  const byStory = new Map<number, Stray[]>();
  for (const stray of out) byStory.set(stray.story.id, [...(byStory.get(stray.story.id) ?? []), stray]);
  let detached = 0;
  const moves = [...byStory.values()].filter((list) => list.length * 2 < list[0]!.story.articles.length);
  if (moves.length) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assign_stories'))`);
      for (const list of moves) {
        for (const { story, article } of list) {
          // Moved since it was read (a merge, a hand split): skip it, the next run sees it as it is.
          const still = await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from articles where id = ${article.id} and story_id = ${story.id} and hidden_at is null`);
          if (still.rows[0]!.n !== 1) continue;
          await splitStory(tx, story.id, [article.id], "model");
          detached++;
        }
      }
    });
  }
  return { suspects: strays.length, checked, detached };
};
