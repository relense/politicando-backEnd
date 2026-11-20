import { z } from "zod";
import { PARTICIPATION } from "./accounts/participant.js";

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
  /**
   * What needs a reader account, comma-separated: comments, forum, votes, reports. Empty by
   * default (anonymous, keyed by IP), so a deploy never locks readers out before the website has
   * its login screens; set "comments,forum,votes,reports" once it does.
   */
  LOGIN_REQUIRED: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(PARTICIPATION))),
  /** Keys for POST /publish (blog posts by API), comma-separated, 32+ characters each. Empty: off. */
  PUBLISH_API_KEYS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((k) => k.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(32))),
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
/**
 * Settings that work locally but are wrong in production. Only warned about, never fatal: a
 * missing variable mustn't take the live site down at the next deploy.
 */
export const apiConfigWarnings = (env: NodeJS.ProcessEnv): string[] => {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!env.SITE_URL) warnings.push("SITE_URL is not set: email links point at http://localhost:3000");
  if (!env.PUBLIC_API_URL) warnings.push("PUBLIC_API_URL is not set: uploaded image and newsletter URLs point at http://localhost:4000");
  if (!env.RECAPTCHA_HOSTNAMES?.trim()) warnings.push("RECAPTCHA_HOSTNAMES is empty: reCAPTCHA tokens solved on any site are accepted");
  return warnings;
};

export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = (message) => console.warn(`[config] ${message}`)) => {
  const config = apiSchema.parse(env);
  for (const message of apiConfigWarnings(env)) warn(message);
  return config;
};
export const loadIngestConfig = (env: NodeJS.ProcessEnv = process.env) =>
  ingestSchema.parse(env);
export const loadParliamentConfig = (env: NodeJS.ProcessEnv = process.env) =>
  parliamentSchema.parse(env);
