import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  "postgres://politicando:politicando@localhost:5433/postgres";
const TEST_DB = "politicando_test";

export const testDatabaseUrl = () => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
};

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await pool.end();
}
