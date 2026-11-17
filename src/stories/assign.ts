import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  pickStory,
  rarity,
  termsOf,
  type Grouping,
  type StoryArticle,
} from "./similarity.js";
import { storyTagsOf } from "./tags.js";

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
export const assignStories = async (db: Db) =>
  db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('assign_stories'))`,
    );
    const touched = new Set<number>();
    const counts = await group(tx, touched);
    return { ...counts, tagged: await refreshTags(tx, touched) };
  });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Recomputes the tags of the stories that changed, and of any never tagged. */
const refreshTags = async (tx: Tx, touched: Set<number>) => {
  const missing = (
    await tx.execute<{ id: number }>(
      sql`select id from stories where tags is null`,
    )
  ).rows.map((r) => r.id);
  const ids = [...new Set([...touched, ...missing])];
  if (ids.length === 0) return 0;
  const rows = (
    await tx.execute<{ story_id: number; title: string; excerpt: string }>(sql`
      select story_id, title, excerpt from articles
      where hidden_at is null and story_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`)
  ).rows;
  const versions = new Map<number, { title: string; excerpt: string }[]>(
    ids.map((id) => [id, []]),
  );
  for (const r of rows) versions.get(r.story_id)!.push(r);
  for (const [id, list] of versions) {
    await tx.execute(
      sql`update stories set tags = ${JSON.stringify(storyTagsOf(list))}::jsonb where id = ${id}`,
    );
  }
  return ids.length;
};

const group = async (tx: Tx, touched: Set<number>) => {
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
