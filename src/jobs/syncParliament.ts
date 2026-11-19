import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { linkStoredArticles } from "../parliament/linkNews.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { syncParliament } from "../parliament/sync.js";
import { resolvePredictions } from "../predictions/index.js";
import { openVoteRounds } from "../predictions/rounds.js";
import { createRevalidator } from "../revalidate.js";

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
  // "Passa ou chumba?": settle what the new votes decided, and tell the readers.
  console.log(JSON.stringify({ predictions: await resolvePredictions(db) }));
  console.log(JSON.stringify({ voteRounds: await openVoteRounds(db) }));
  await createRevalidator()(["parliament", "predictions", "news"]);
} catch (error) {
  console.error("Parliament sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
