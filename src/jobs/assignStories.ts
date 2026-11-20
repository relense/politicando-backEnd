import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { assignStories } from "../stories/assign.js";
import { judgeFromEnv } from "../stories/merge.js";

// The hourly ingest does this too; this is for running it by hand (e.g. after a deploy).
const { db, pool } = createDb(loadIngestConfig().DATABASE_URL);
try {
  console.log(JSON.stringify(await assignStories(db, { judge: judgeFromEnv() })));
} catch (error) {
  console.error("Assigning stories failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
