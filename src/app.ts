import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
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
import { adminForumRoutes } from "./modules/admin/forums.js";
import { adminRecordRoutes } from "./modules/admin/records.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { caseRoutes } from "./modules/cases/routes.js";
import { forumRoutes } from "./modules/forums/routes.js";
import { agendaRoutes } from "./modules/agenda/routes.js";
import { editorialRoutes } from "./modules/editorial/routes.js";
import { feedbackRoutes } from "./modules/feedback/routes.js";
import { seoRoutes } from "./modules/seo/routes.js";
import { placeRoutes } from "./modules/places/routes.js";
import { articleRoutes } from "./modules/articles/routes.js";
import type { RecaptchaVerifier } from "./modules/comments/recaptcha.js";
import { commentRoutes } from "./modules/comments/routes.js";
import { type NewsletterSettings, newsletterRoutes } from "./modules/newsletter/routes.js";
import type { Mailer } from "./newsletter/mailer.js";
import { contractRoutes } from "./modules/contracts/routes.js";
import { historyRoutes } from "./modules/history/routes.js";
import { legislatureRoutes } from "./modules/legislatures/routes.js";
import { explainerRoutes } from "./modules/explainers/routes.js";
import { peopleRoutes } from "./modules/people/routes.js";
import { electionRoutes } from "./modules/elections/routes.js";
import { governmentRoutes } from "./modules/government/routes.js";
import { parliamentRoutes } from "./modules/parliament/routes.js";
import { presidencyRoutes } from "./modules/presidency/routes.js";
import { partyRoutes } from "./modules/parties/routes.js";

export interface AppOptions {
  db: Db;
  corsOrigins: string[];
  verifyRecaptcha: RecaptchaVerifier;
  trustProxy?: boolean;
  /**
   * A header our proxy sets to the client's IP and clients can't forge (Render, behind
   * Cloudflare: "true-client-ip"). When set, it's the only source of request.ip: rate limits,
   * reCAPTCHA and forum poster IDs never see a client-sent X-Forwarded-For.
   */
  clientIpHeader?: string;
  logger?: boolean;
  commentLimitPerMinute?: number;
  /** Admin session cookie over HTTPS only (default true; turn off for local HTTP). */
  secureCookies?: boolean;
  loginLimitPerMinute?: number;
  /** Keys anonymous poster IDs. Keep it stable: changing it changes everyone's IDs. */
  forumSecret?: string;
  /** Mail and links for the newsletter; without it, sign-ups answer 503. */
  newsletter?: NewsletterSettings | null;
  /** Precompute the contracts page's totals at start and after imports (the server, not tests). */
  warmCaches?: boolean;
  /**
   * Shared with the frontend's server. Its page renders all come from one address, so with the
   * key it says whose page it is rendering (X-Reader-IP) and limits apply to each reader, not
   * to the frontend as a whole. Without the key, those headers are ignored.
   */
  frontendKey?: string;
  /** Sends the team's answers to feedback; without it, answers are only noted. */
  mailer?: Mailer | null;
  feedbackLimitPerHour?: number;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export const buildApp = async ({
  db,
  corsOrigins,
  verifyRecaptcha,
  trustProxy = false,
  clientIpHeader,
  logger = false,
  commentLimitPerMinute = 5,
  secureCookies = true,
  loginLimitPerMinute = 5,
  forumSecret = randomBytes(32).toString("hex"),
  newsletter = null,
  warmCaches = false,
  frontendKey,
  mailer = null,
  feedbackLimitPerHour = 10,
}: AppOptions) => {
  const proxied = trustProxy || clientIpHeader !== undefined;
  const app = Fastify({ logger, trustProxy: proxied || frontendKey !== undefined, bodyLimit: 64 * 1024 });
  if (clientIpHeader !== undefined) {
    const header = clientIpHeader.toLowerCase();
    // Registered first, so the rate limiter already sees the real address.
    app.addHook("onRequest", async (request) => {
      const value = request.headers[header];
      const ip = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
      // Without the header, fall back to the connection's address rather than anything sent.
      if (ip) request.raw.headers["x-forwarded-for"] = ip;
      else delete request.raw.headers["x-forwarded-for"];
    });
  }
  // Frontend renders without a reader (background revalidation) skip the general limit.
  const fromFrontend = new WeakSet<object>();
  if (frontendKey !== undefined) {
    const expected = createHash("sha256").update(frontendKey).digest();
    app.addHook("onRequest", async (request) => {
      const sentKey = request.headers["x-frontend-key"];
      const reader = request.headers["x-reader-ip"];
      delete request.raw.headers["x-frontend-key"];
      delete request.raw.headers["x-reader-ip"];
      // trustProxy is on only for the key's sake: never take a client's own X-Forwarded-For.
      if (!proxied) delete request.raw.headers["x-forwarded-for"];
      if (typeof sentKey !== "string" || !timingSafeEqual(createHash("sha256").update(sentKey).digest(), expected)) return;
      const ip = typeof reader === "string" ? reader.trim() : "";
      if (isIP(ip)) request.raw.headers["x-forwarded-for"] = ip;
      else if (request.method === "GET" || request.method === "HEAD") fromFrontend.add(request.raw);
    });
  }
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

  // The API serves JSON only; the Swagger UI sets its own policy for /docs.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cookie);
  // credentials: the admin frontend sends its session cookie; only the listed origins may.
  await app.register(cors, { origin: corsOrigins, methods: ["GET", "POST", "PATCH", "DELETE"], credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", allowList: (request) => fromFrontend.has(request.raw) });
  await app.register(swagger, {
    openapi: { info: { title: "Politicando API", version: "2.0.0", contact: { name: "Politicando", email: "info@politicando.pt", url: "https://www.politicando.pt" } } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs", staticCSP: true });

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
      await api.register(parliamentRoutes(db));
      await api.register(governmentRoutes(db));
      await api.register(presidencyRoutes(db));
      await api.register(electionRoutes(db));
      await api.register(peopleRoutes(db));
      await api.register(explainerRoutes(db));
      await api.register(historyRoutes(db));
      await api.register(legislatureRoutes(db));
      await api.register(contractRoutes(db, { warm: warmCaches, recheckMs: warmCaches ? 60_000 : 0 }));
      await api.register(adminRoutes({ db, secureCookies, loginLimitPerMinute }));
      await api.register(adminRecordRoutes(db));
      await api.register(adminForumRoutes(db));
      await api.register(editorialRoutes(db));
      await api.register(agendaRoutes(db));
      await api.register(feedbackRoutes({ db, verifyRecaptcha, mailer, limitPerHour: feedbackLimitPerHour }));
      await api.register(seoRoutes(db));
      await api.register(placeRoutes(db));
      await api.register(forumRoutes({ db, verifyRecaptcha, forumSecret, createLimitPerMinute: commentLimitPerMinute }));
      await api.register(caseRoutes(db));
      await api.register(
        newsletterRoutes({ db, verifyRecaptcha, createLimitPerMinute: commentLimitPerMinute, settings: newsletter }),
      );
      await api.register(
        commentRoutes({ db, verifyRecaptcha, createLimitPerMinute: commentLimitPerMinute }),
      );
    },
    { prefix: "/api/v2" },
  );

  return app;
};
