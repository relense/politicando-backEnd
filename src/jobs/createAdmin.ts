import { randomBytes } from "node:crypto";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { admins } from "../db/schema.js";
import { hashPassword } from "../admin/password.js";

/*
 * Creates the first admin (later ones are invited from the admin itself):
 *
 *   npm run admin:create -- ana@example.pt "Ana Silva" admin
 *
 * Prints a random password once; sign in and change it at POST /admin/password.
 */
const [email, name, role = "admin"] = process.argv.slice(2);
if (!email || !name || !["author", "moderator", "admin"].includes(role)) {
  console.error('Usage: npm run admin:create -- <email> "<name>" [author|moderator|admin]');
  process.exit(1);
}

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  const password = randomBytes(12).toString("base64url");
  const [created] = await db
    .insert(admins)
    .values({ email: email.toLowerCase(), name, role: role as "author" | "moderator" | "admin", passwordHash: await hashPassword(password) })
    .onConflictDoNothing({ target: admins.email })
    .returning({ id: admins.id });
  if (!created) {
    console.error(`${email} already exists`);
    process.exitCode = 1;
  } else {
    console.log(`Created ${role} ${email}. Password (shown once, change it after signing in): ${password}`);
  }
} finally {
  await pool.end();
}
