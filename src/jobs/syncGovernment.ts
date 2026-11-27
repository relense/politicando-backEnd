import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { syncGovernment } from "../government/sync.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { linkStoredArticles } from "../parliament/linkNews.js";
import { syncWikidataLinks } from "../people/wikidata.js";
import { syncPresidency } from "../presidency/sync.js";
import { createRevalidator } from "../revalidate.js";

/** How far back to look for news that new members of the Government now match. */
const RELINK_DAYS = 30;

const config = loadDatabaseConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const client = createPoliteClient();

// Each step uses a different site: one failing doesn't stop the others.
const steps: [string, () => Promise<{ warnings: string[] }>][] = [
  ["Government", () => syncGovernment(db, client)],
  ["President", () => syncPresidency(db, client)],
  // Official sites and social accounts of deputies and the Government (after the Government, whose members it links).
  ["Wikidata", async () => ({ ...(await syncWikidataLinks(db)), warnings: [] })],
];
try {
  for (const [name, run] of steps) {
    try {
      const stats = await run();
      for (const warning of stats.warnings) console.warn(`${name} warning: ${warning}`);
      console.log(JSON.stringify({ [name]: { ...stats, warnings: stats.warnings.length } }));
    } catch (error) {
      console.error(`${name} sync failed:`, error);
      process.exitCode = 1;
    }
  }
  // On its own too: a database error here mustn't skip telling the site.
  try {
    const since = new Date(Date.now() - RELINK_DAYS * 24 * 60 * 60 * 1000);
    console.log(JSON.stringify({ relinked: await linkStoredArticles(db, { since }) }));
  } catch (error) {
    console.error("Relinking news failed:", error);
    process.exitCode = 1;
  }
  await createRevalidator()(["government", "news"]);
} finally {
  await pool.end();
}
