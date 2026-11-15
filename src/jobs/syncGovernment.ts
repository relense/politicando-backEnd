import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { syncGovernment } from "../government/sync.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { linkStoredArticles } from "../parliament/linkNews.js";

/** How far back to look for news that new members of the Government now match. */
const RELINK_DAYS = 30;

const config = loadDatabaseConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const stats = await syncGovernment(db, createPoliteClient());
  for (const warning of stats.warnings) console.warn(`Warning: ${warning}`);
  console.log(JSON.stringify({ ...stats, warnings: stats.warnings.length }));
  const since = new Date(Date.now() - RELINK_DAYS * 24 * 60 * 60 * 1000);
  console.log(JSON.stringify({ relinked: await linkStoredArticles(db, { since }) }));
} catch (error) {
  console.error("Government sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
