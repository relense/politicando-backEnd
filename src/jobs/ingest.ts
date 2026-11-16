import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { purgeFeedback } from "../feedback/purge.js";
import { ingest, refreshGenericHeadlines } from "../ingestion/ingest.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { NEWS_SOURCES } from "../ingestion/sources.js";

const config = loadIngestConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const client = createPoliteClient();

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
  // Not news, but this job runs every hour: old feedback screenshots go here too.
  await purgeFeedback(db);

  // A few sites failing is normal. Most failing means the scanner itself is broken.
  const unreadable = stats.filter((source) => source.listingError).length;
  if (unreadable > stats.length / 2) {
    console.error(`${unreadable} of ${stats.length} sources could not be read`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Ingest failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
