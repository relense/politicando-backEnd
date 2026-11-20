import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { purgeFeedback } from "../feedback/purge.js";
import { pruneNotifications } from "../notifications/index.js";
import { ingest, refreshGenericHeadlines } from "../ingestion/ingest.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { NEWS_SOURCES } from "../ingestion/sources.js";
import { syncPodcast } from "../podcast/spotify.js";
import { changedPages, pingIndexNow } from "../seo/indexNow.js";
import { createRevalidator } from "../revalidate.js";
import { assignStories } from "../stories/assign.js";
import { judgeFromEnv } from "../stories/merge.js";

const config = loadIngestConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const client = createPoliteClient();
const revalidate = createRevalidator();
// The previous run started an hour ago: from then on, everything new is worth announcing.
const changedSince = new Date(Date.now() - 61 * 60 * 1000);

try {
  const stats = await ingest({
    db,
    client,
    sources: NEWS_SOURCES,
    maxPagesPerSource: config.INGEST_MAX_PAGES_PER_SOURCE,
    onArticleError: (url, error) => console.error(`Failed to store ${url}:`, error),
  });
  for (const source of stats) console.log(JSON.stringify(source));
  console.log(JSON.stringify({ refreshedHeadlines: await refreshGenericHeadlines({ db, client }) }));
  // After the headlines are final: every new article joins a story, or starts one.
  console.log(JSON.stringify({ stories: await assignStories(db, { judge: judgeFromEnv() }) }));
  // Not news, but this job runs every hour: old feedback screenshots go here too.
  await purgeFeedback(db);
  console.log(JSON.stringify({ prunedNotifications: await pruneNotifications(db) }));
  // And the podcast's newest episode, for the home page. Spotify being down only means it shows a bit later.
  let podcastChanged = false;
  try {
    const podcast = await syncPodcast(db);
    podcastChanged = podcast.changed;
    console.log(JSON.stringify({ podcast }));
  } catch (error) {
    console.error("Podcast:", error instanceof Error ? error.message : error);
  }
  // The site shows the new news (and episode) now, not when its cached copy expires.
  await revalidate(podcastChanged ? ["news", "podcast"] : ["news"]);
  if (config.INDEXNOW_KEY) {
    const paths = await changedPages(db, changedSince);
    console.log(JSON.stringify({ indexNow: await pingIndexNow({ key: config.INDEXNOW_KEY, siteUrl: config.SITE_URL, paths }) }));
  }

  // A few sites failing is normal. Most failing means the scanner itself is broken.
  const unreadable = stats.filter((source) => source.listingError).length;
  if (unreadable > stats.length / 2) {
    console.error(`${unreadable} of ${stats.length} sources could not be read`);
    process.exitCode = 1;
  }
  // Articles found but mostly not stored: the database side is broken (full disk, a bad migration).
  const failed = stats.reduce((n, source) => n + source.failed, 0);
  const handled = stats.reduce((n, source) => n + source.matched + source.rejected, 0);
  if (failed >= 5 && failed > handled) {
    console.error(`${failed} articles could not be stored (${handled} were)`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Ingest failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
