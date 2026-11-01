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
  RECAPTCHA_SECRET: z.string().min(1),
});

const ingestSchema = baseSchema.extend({
  EVENT_REGISTRY_API_KEY: z.string().min(1),
  INGEST_MAX_PAGES: z.coerce.number().int().positive().default(1),
});

export const loadDatabaseConfig = (env: NodeJS.ProcessEnv = process.env) =>
  baseSchema.parse(env);
export const loadApiConfig = (env: NodeJS.ProcessEnv = process.env) =>
  apiSchema.parse(env);
export const loadIngestConfig = (env: NodeJS.ProcessEnv = process.env) =>
  ingestSchema.parse(env);
