import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { linkStoredArticles } from "../parliament/linkNews.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { syncParliament } from "../parliament/sync.js";

/** How far back to look for news that new initiatives or deputies now match. */
const RELINK_DAYS = 30;

const config = loadParliamentConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const stats = await syncParliament(db, createOpenDataClient({ legislature: config.PARLIAMENT_LEGISLATURE }));
  for (const warning of stats.warnings) console.warn(`Warning: ${warning}`);
  console.log(JSON.stringify({ ...stats, warnings: stats.warnings.length }));
  // New initiatives and deputies can match news the scanner already stored.
  const since = new Date(Date.now() - RELINK_DAYS * 24 * 60 * 60 * 1000);
  console.log(JSON.stringify({ relinked: await linkStoredArticles(db, { since }) }));
} catch (error) {
  console.error("Parliament sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
