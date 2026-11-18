import { z } from "zod";

const envBoolean = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const baseSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

const apiSchema = baseSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: envBoolean,
  /** On Render: "true-client-ip". The one header to take the client's IP from (see AppOptions). */
  CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
  /** Shared with the frontend's server so limits apply per reader (see AppOptions.frontendKey). */
  FRONTEND_API_KEY: z.string().min(32).optional(),
  RECAPTCHA_SECRET: z.string().min(1),
  /** Hostnames of our site; reCAPTCHA tokens solved elsewhere are rejected. Empty: no check (local only). */
  RECAPTCHA_HOSTNAMES: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
  /** Keys anonymous forum poster IDs and reporter hashes. Long and random; never change it in production. */
  FORUM_SECRET: z.string().min(32),
  /** Send the admin session cookie over HTTPS only. Set to false for local HTTP. */
  COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  /** "" turns the newsletter off, "log" prints emails to the console (local only), or an smtp(s):// URL. */
  SMTP_URL: z.string().default(""),
  MAIL_FROM: z.string().default("Politicando <info@politicando.pt>"),
  /** Signs newsletter links. Long and random; changing it breaks every link already sent. */
  NEWSLETTER_SECRET: z.string().min(32).optional(),
  /** The website (where newsletter links land) and this API's public address (used in those links). */
  SITE_URL: z.url().default("http://localhost:3000"),
  PUBLIC_API_URL: z.url().default("http://localhost:4000"),
});

const ingestSchema = baseSchema.extend({
  INGEST_MAX_PAGES_PER_SOURCE: z.coerce.number().int().positive().default(40),
  /** IndexNow key (8-128 letters, digits or dashes), also served by the frontend at /<key>.txt. Unset: no pings. */
  INDEXNOW_KEY: z.string().regex(/^[A-Za-z0-9-]{8,128}$/).optional(),
  /** The website whose pages are announced to IndexNow. */
  SITE_URL: z.url().default("https://www.politicando.pt"),
});

const parliamentSchema = baseSchema.extend({
  /** Roman numeral, as the parliament writes it. Change it when a new legislature starts. */
  PARLIAMENT_LEGISLATURE: z.string().regex(/^[IVXLC]+$/).default("XVII"),
});

export const loadDatabaseConfig = (env: NodeJS.ProcessEnv = process.env) =>
  baseSchema.parse(env);
export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env) =>
  apiSchema.parse(env);
export const loadIngestConfig = (env: NodeJS.ProcessEnv = process.env) =>
  ingestSchema.parse(env);
export const loadParliamentConfig = (env: NodeJS.ProcessEnv = process.env) =>
  parliamentSchema.parse(env);
