import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createRecaptchaVerifier } from "./modules/comments/recaptcha.js";

const config = loadApiConfig();
const { db, pool } = createDb(config.DATABASE_URL);

const app = await buildApp({
  db,
  corsOrigins: config.CORS_ORIGINS,
  trustProxy: config.TRUST_PROXY,
  verifyRecaptcha: createRecaptchaVerifier(config.RECAPTCHA_SECRET),
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ port: config.PORT, host: "0.0.0.0" });
