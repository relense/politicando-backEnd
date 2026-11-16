import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { linkStoredArticles } from "../parliament/linkNews.js";

/**
 * Links stored articles to deputies and initiatives. Only adds links, unless run with
 * --replace, which recomputes automatic links (after changing matching rules).
 */
const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  console.log(JSON.stringify(await linkStoredArticles(db, { replace: process.argv.includes("--replace") })));
} catch (error) {
  console.error("Linking failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
