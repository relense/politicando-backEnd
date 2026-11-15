import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { linkStoredArticles } from "../parliament/linkNews.js";

/** Re-links stored articles to deputies. Run once after the first parliament sync. */
const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  console.log(JSON.stringify(await linkStoredArticles(db)));
} catch (error) {
  console.error("Linking failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
