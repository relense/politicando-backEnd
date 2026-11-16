import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { importPastLegislature, PAST_LEGISLATURES } from "../parliament/pastLegislatures.js";

/*
 * One-off import of earlier legislatures' initiatives from the parliament's open data, for
 * each legislature's record. The current legislature is synced daily by parliament:sync.
 *
 *   npm run parliament:history                 every past legislature (I to the last one)
 *   npm run parliament:history -- XV XVI       just these
 */
const ids = process.argv.slice(2);
const unknown = ids.filter((id) => !PAST_LEGISLATURES.includes(id));
if (unknown.length > 0) {
  console.error(`Not a past legislature: ${unknown.join(", ")}. Known: ${PAST_LEGISLATURES.join(", ")}`);
  process.exit(1);
}

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  // One legislature failing doesn't stop the others.
  for (const legislature of ids.length > 0 ? ids : PAST_LEGISLATURES) {
    try {
      console.log(JSON.stringify(await importPastLegislature(db, createOpenDataClient({ legislature }), legislature)));
    } catch (error) {
      console.error(`${legislature} failed:`, error);
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
