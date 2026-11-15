import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { syncParliament } from "../parliament/sync.js";

const config = loadParliamentConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const stats = await syncParliament(db, createOpenDataClient({ legislature: config.PARLIAMENT_LEGISLATURE }));
  for (const warning of stats.warnings) console.warn(`Warning: ${warning}`);
  console.log(JSON.stringify({ ...stats, warnings: stats.warnings.length }));
} catch (error) {
  console.error("Parliament sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
