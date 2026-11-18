import { buildApp } from "./app.js";
import { loadApiConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createRecaptchaVerifier } from "./modules/comments/recaptcha.js";
import { createMailer } from "./newsletter/mailer.js";

const config = loadApiConfig();
const { db, pool } = createDb(config.DATABASE_URL);

const mailer = createMailer(config.SMTP_URL, config.MAIL_FROM);
const newsletter =
  mailer && config.NEWSLETTER_SECRET
    ? { mailer, secret: config.NEWSLETTER_SECRET, siteUrl: config.SITE_URL, apiUrl: config.PUBLIC_API_URL }
    : null;
if (!newsletter) console.warn("Newsletter off: set SMTP_URL and NEWSLETTER_SECRET to turn it on");

const app = await buildApp({
  db,
  corsOrigins: config.CORS_ORIGINS,
  trustProxy: config.TRUST_PROXY,
  clientIpHeader: config.CLIENT_IP_HEADER,
  frontendKey: config.FRONTEND_API_KEY,
  verifyRecaptcha: createRecaptchaVerifier(config.RECAPTCHA_SECRET, fetch, config.RECAPTCHA_HOSTNAMES, (message) => console.warn(message)),
  secureCookies: config.COOKIE_SECURE,
  loginRequired: config.LOGIN_REQUIRED,
  forumSecret: config.FORUM_SECRET,
  newsletter,
  logger: true,
  warmCaches: true,
  mailer,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ port: config.PORT, host: "0.0.0.0" });
