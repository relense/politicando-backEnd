import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { ELECTIONS } from "../elections/catalog.js";
import { importCandidates } from "../elections/candidates.js";
import { HISTORIC_LEGISLATIVAS, importHistoricLegislativas } from "../elections/historic.js";
import { importElection } from "../elections/import.js";
import { importMayors } from "../elections/mayors.js";
import { createPoliteClient } from "../ingestion/politeClient.js";

/*
 * One-off import of election results, and the candidate lists where the site has them. Not
 * a scheduled job: run it once, and again after an election once the official count is final.
 *
 *   npm run elections:import                         every election in the catalog
 *   npm run elections:import -- legislativas-2025    just one (or several)
 *   npm run elections:import -- --parishes           every body down to parishes (slow)
 *   npm run elections:import -- --refresh            re-download what's already stored
 *   npm run elections:import -- --historic           only the legislativas 1975–2009 (curated, no download)
 *
 * The historic legislativas (src/elections/historic.ts) are loaded with every full run.
 */
const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith("--"));
const historicOnly = args.includes("--historic");
const chosen = historicOnly ? [] : ids.length > 0 ? ELECTIONS.filter((e) => ids.includes(e.id)) : ELECTIONS;
const historic = historicOnly || ids.length === 0 ? HISTORIC_LEGISLATIVAS : HISTORIC_LEGISLATIVAS.filter((e) => ids.includes(e.id));
const unknown = ids.filter((id) => !ELECTIONS.some((e) => e.id === id) && !HISTORIC_LEGISLATIVAS.some((e) => e.id === id));
if (unknown.length > 0) {
  console.error(`Unknown election(s): ${unknown.join(", ")}. Known: ${[...HISTORIC_LEGISLATIVAS, ...ELECTIONS].map((e) => e.id).join(", ")}`);
  process.exit(1);
}

const config = loadDatabaseConfig();
const { db, pool } = createDb(config.DATABASE_URL);
// The results site has no robots.txt and serves static files; one request per second is gentle.
const client = createPoliteClient({ defaultDelayMs: 1_000 });

try {
  if (historic.length > 0) console.log(JSON.stringify({ historic: await importHistoricLegislativas(db, historic) }));
  for (const election of chosen) {
    const stats = await importElection(db, client, election, {
      parishes: args.includes("--parishes"),
      refresh: args.includes("--refresh"),
      onProgress: (message) => console.log(message),
    });
    const candidates = await importCandidates(db, client, election);
    const mayors = await importMayors(db, client, election);
    console.log(JSON.stringify({ election: election.id, ...stats, candidates, ...(mayors.candidates > 0 && { mayors }) }));
  }
} catch (error) {
  console.error("Election import failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
