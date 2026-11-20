import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { followers, notify } from "../notifications/index.js";
import {
  pickStory,
  rarity,
  termsOf,
  type Grouping,
  type StoryArticle,
} from "./similarity.js";
import { mergeStories, type MergeJudge } from "./merge.js";
import { detachStrays } from "./split.js";
import { refreshStoryTags as refreshTags } from "./tags.js";

/** Articles this far back are compared with, and measure how rare words are. */
const CONTEXT_DAYS = 7;

interface Row extends Record<string, unknown> {
  id: number;
  title: string;
  excerpt: string;
  source: string;
  published_at: Date;
  story_id: number | null;
  people: string[];
}

/**
 * Gives every visible article without a story one: an existing story it matches, or a new
 * one. Oldest first, so stories grow in the order the news came out. Hidden articles are
 * skipped (if one is shown again, the next run groups it). Runs after each ingest; safe to run
 * twice at once (the second waits).
 */
export const assignStories = async (db: Db, { judge = null }: { judge?: MergeJudge | null } = {}) => {
  const created = new Set<number>();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('assign_stories'))`,
    );
    const touched = new Set<number>();
    const counts = await group(tx, touched, created);
    return { ...counts, tagged: await refreshTags(tx, touched), touched };
  });
  // Stories that already existed and got new coverage: tell whoever follows them.
  let notified = 0;
  for (const storyId of result.touched) {
    if (created.has(storyId)) continue;
    try {
      const userIds = await followers(db, "story", storyId);
      await notify(db, { userIds, kind: "story_update", targetId: storyId });
      notified += userIds.length;
    } catch (error) {
      console.error("Story notification failed:", error);
    }
  }
  // Articles that drifted into a story they don't belong in get one of their own (src/stories/split.ts).
  let strays = { suspects: 0, checked: 0, detached: 0 };
  try {
    strays = await detachStrays(db, { judge });
  } catch (error) {
    console.error("Checking stories for strays failed:", error);
  }
  // Then stories that turned out to be the same news are joined (src/stories/merge.ts).
  let merges: { candidates: number; checked: number; merged: number } = { candidates: 0, checked: 0, merged: 0 };
  try {
    const { into, ...counts } = await mergeStories(db, { judge });
    merges = counts;
    if (into.size) await db.transaction((tx) => refreshTags(tx, into));
  } catch (error) {
    console.error("Merging stories failed:", error);
  }
  const { touched: _touched, ...counts } = result;
  return { ...counts, notified, strays, merges };
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const group = async (tx: Tx, touched: Set<number>, createdIds: Set<number>) => {
  const [first] = (
    await tx.execute<{ at: Date | null }>(
      sql`select min(published_at) as at from articles where story_id is null and hidden_at is null`,
    )
  ).rows;
  if (!first?.at) return { assigned: 0, created: 0 };

  const rows = (
    await tx.execute<Row>(sql`
        select a.id, a.title, a.excerpt, a.source, a.published_at, a.story_id,
          array(select 'd:' || ad.deputy_id from article_deputies ad where ad.article_id = a.id)
            || array(select 'g:' || agm.member_id from article_government_members agm where agm.article_id = a.id)
            || array(select 'p:' || ap.president_id from article_presidents ap where ap.article_id = a.id) as people
        from articles a
        where a.hidden_at is null and a.published_at >= ${first.at}::timestamptz - make_interval(days => ${CONTEXT_DAYS})
        order by a.published_at, a.id`)
  ).rows;

  type Item = {
    article: StoryArticle & { storyId: number | null };
    terms: ReturnType<typeof termsOf>;
    source: string;
  };
  const items: Item[] = rows.map((r) => {
    const article = {
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      source: r.source,
      publishedAt: new Date(r.published_at),
      people: r.people,
      storyId: r.story_id,
    };
    return { article, terms: termsOf(article), source: r.source };
  });
  const rare = rarity(items.map((i) => i.terms));

  const stories = new Map<number, Grouping<Item["article"]> & { id: number }>();
  for (const item of items) {
    const id = item.article.storyId;
    if (id === null) continue;
    const story = stories.get(id) ?? { id, articles: [] };
    story.articles.push(item);
    stories.set(id, story);
  }

  let assigned = 0;
  let created = 0;
  for (const item of items) {
    if (item.article.storyId !== null) continue;
    let story = pickStory(item, [...stories.values()], rare);
    if (!story) {
      const [row] = (
        await tx.execute<{ id: number }>(
          sql`insert into stories default values returning id`,
        )
      ).rows;
      story = { id: row!.id, articles: [] };
      stories.set(story.id, story);
      createdIds.add(story.id);
      created++;
    }
    await tx.execute(
      sql`update articles set story_id = ${story.id} where id = ${item.article.id}`,
    );
    touched.add(story.id);
    item.article.storyId = story.id;
    story.articles.push(item);
    assigned++;
  }
  return { assigned, created };
};
