import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createEventRegistrySource } from "../ingestion/eventRegistry.js";
import { ingest, type IngestStats } from "../ingestion/ingest.js";

const config = loadIngestConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const stats: IngestStats = { fetched: 0, skipped: 0, matched: 0, rejected: 0, failed: 0 };

try {
  await ingest(
    {
      db,
      source: createEventRegistrySource({ apiKey: config.EVENT_REGISTRY_API_KEY }),
      maxPages: config.INGEST_MAX_PAGES,
      onArticleError: (sourceUri, error) => {
        console.error(`Failed to store article ${sourceUri}:`, error);
      },
    },
    stats,
  );
} catch (error) {
  console.error("Ingest failed:", error);
  process.exitCode = 1;
} finally {
  console.log("Ingest finished", JSON.stringify(stats));
  await pool.end();
}
