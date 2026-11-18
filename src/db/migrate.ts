import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "./client.js";
import { seed } from "./seed.js";

/*
 * Runs on every deploy (Render's pre-deploy command). The seed runs here too, so parties and
 * local officials follow each deploy even when the dashboard's command is only this script.
 */
const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations applied");
  await seed(db);
} finally {
  await pool.end();
}
