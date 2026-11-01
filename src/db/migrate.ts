import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "./client.js";

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations applied");
} finally {
  await pool.end();
}
