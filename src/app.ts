import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyError } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Db } from "./db/client.js";
import { ApiError } from "./errors.js";
import { articleRoutes } from "./modules/articles/routes.js";
import type { RecaptchaVerifier } from "./modules/comments/recaptcha.js";
import { commentRoutes } from "./modules/comments/routes.js";
import { partyRoutes } from "./modules/parties/routes.js";

export interface AppOptions {
  db: Db;
  corsOrigins: string[];
  verifyRecaptcha: RecaptchaVerifier;
  trustProxy?: boolean;
  logger?: boolean;
  commentLimitPerMinute?: number;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export const buildApp = async ({
  db,
  corsOrigins,
  verifyRecaptcha,
  trustProxy = false,
  logger = false,
  commentLimitPerMinute = 5,
}: AppOptions) => {
  const app = Fastify({ logger, trustProxy, bodyLimit: 64 * 1024 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(errorBody(error.code, error.message));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send(errorBody("invalid_request", error.message));
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send(errorBody("rate_limited", "Too many requests"));
    }
    if (status >= 500) {
      request.log.error(error);
      return reply.status(status).send(errorBody("internal_error", "Something went wrong"));
    }
    return reply.status(status).send(errorBody("bad_request", error.message));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(errorBody("not_found", "Route not found")),
  );

  await app.register(cors, { origin: corsOrigins, methods: ["GET", "POST"] });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: { info: { title: "Politicando API", version: "2.0.0" } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get("/health", { schema: { hide: true } }, async (request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok" };
    } catch (error) {
      request.log.error(error);
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  await typed.register(
    async (api) => {
      await api.register(partyRoutes(db));
      await api.register(articleRoutes(db));
      await api.register(
        commentRoutes({ db, verifyRecaptcha, createLimitPerMinute: commentLimitPerMinute }),
      );
    },
    { prefix: "/api/v2" },
  );

  return app;
};
