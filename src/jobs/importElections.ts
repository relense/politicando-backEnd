import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { ELECTIONS } from "../elections/catalog.js";
import { importElection } from "../elections/import.js";
import { createPoliteClient } from "../ingestion/politeClient.js";

/*
 * One-off import of election results. Not a scheduled job: run it once, and again after
 * an election once the official count is final.
 *
 *   npm run elections:import                         every election in the catalog
 *   npm run elections:import -- legislativas-2025    just one (or several)
 *   npm run elections:import -- --parishes           every body down to parishes (slow)
 *   npm run elections:import -- --refresh            re-download what's already stored
 */
const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith("--"));
const chosen = ids.length > 0 ? ELECTIONS.filter((e) => ids.includes(e.id)) : ELECTIONS;
const unknown = ids.filter((id) => !ELECTIONS.some((e) => e.id === id));
if (unknown.length > 0) {
  console.error(`Unknown election(s): ${unknown.join(", ")}. Known: ${ELECTIONS.map((e) => e.id).join(", ")}`);
  process.exit(1);
}

const config = loadDatabaseConfig();
const { db, pool } = createDb(config.DATABASE_URL);
// The results site has no robots.txt and serves static files; one request per second is gentle.
const client = createPoliteClient({ defaultDelayMs: 1_000 });

try {
  for (const election of chosen) {
    const stats = await importElection(db, client, election, {
      parishes: args.includes("--parishes"),
      refresh: args.includes("--refresh"),
      onProgress: (message) => console.log(message),
    });
    console.log(JSON.stringify({ election: election.id, ...stats }));
  }
} catch (error) {
  console.error("Election import failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
