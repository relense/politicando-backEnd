import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { ingest } from "../ingestion/ingest.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { NEWS_SOURCES } from "../ingestion/sources.js";

const config = loadIngestConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const stats = await ingest({
    db,
    client: createPoliteClient(),
    sources: NEWS_SOURCES,
    maxPagesPerSource: config.INGEST_MAX_PAGES_PER_SOURCE,
    onArticleError: (url, error) => console.error(`Failed to store ${url}:`, error),
  });
  for (const source of stats) console.log(JSON.stringify(source));

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
