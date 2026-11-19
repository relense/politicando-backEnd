import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { newsletterSubscribers } from "../../db/schema.js";
import { ApiError } from "../../errors.js";
import { MailUnavailable, type NewsletterSettings, confirmPage, normalEmail, requestSubscription, unsubscribePage } from "../../newsletter/subscribe.js";
import { readToken } from "../../newsletter/tokens.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { errorSchema } from "../shared.js";

export type { NewsletterSettings };

export interface NewsletterRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  createLimitPerMinute: number;
  /** Absent: sign-ups answer 503 (no mail configured). */
  settings: NewsletterSettings | null;
}

const token = z.string().max(1_000);
const tokenQuery = z.object({ token });

export const newsletterRoutes =
  ({ db, verifyRecaptcha, createLimitPerMinute, settings }: NewsletterRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    // Mail clients' one-click unsubscribe (RFC 8058) posts a form body we don't need.
    app.addContentTypeParser("application/x-www-form-urlencoded", (_request, _payload, done) => done(null, undefined));

    const landing = (state: "confirmado" | "cancelado" | "invalido") =>
      `${settings?.siteUrl.replace(/\/$/, "") ?? ""}/newsletter?estado=${state}`;

    app.post(
      "/newsletter/subscribe",
      {
        config: { rateLimit: { max: createLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["newsletter"],
          summary: "Sign up. Sends an email with a link to confirm; nothing is sent until then",
          body: z.strictObject({ email: z.string().max(320), recaptchaToken: z.string().min(1).max(4_096) }),
          response: {
            202: z.object({ status: z.literal("pending") }),
            400: errorSchema,
            403: errorSchema,
            429: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const email = normalEmail(request.body.email);
        if (!email) throw new ApiError(400, "invalid_email", "That is not a valid email address");
        if (!settings) throw new ApiError(503, "newsletter_unavailable", "The newsletter is not available yet");

        let human: boolean;
        try {
          human = await verifyRecaptcha(request.body.recaptchaToken, request.ip);
        } catch (error) {
          request.log.error(error, "reCAPTCHA verification unavailable");
          throw new ApiError(503, "recaptcha_unavailable", "Sign-ups are temporarily unavailable");
        }
        if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");

        try {
          await requestSubscription(db, settings, email);
        } catch (error) {
          if (!(error instanceof MailUnavailable)) throw error;
          request.log.error(error, "Newsletter confirmation email failed");
          throw new ApiError(503, "mail_unavailable", "We couldn't send the email; try again later");
        }
        return reply.status(202).send({ status: "pending" as const });
      },
    );

    // The links carry the address (signed), so these routes keep it out of the request log.

    // Links sent before the confirmation pages existed: they open those pages now, and act only on the button.
    app.get(
      "/newsletter/confirm",
      {
        logLevel: "warn",
        schema: { tags: ["newsletter"], summary: "Old confirmation links: redirect to the website's page, which asks for a button press", querystring: tokenQuery },
      },
      async (request, reply) => (settings ? reply.redirect(confirmPage(settings, request.query.token)) : reply.redirect(landing("invalido"))),
    );

    app.get(
      "/newsletter/unsubscribe",
      {
        logLevel: "warn",
        schema: { tags: ["newsletter"], summary: "Old unsubscribe links: redirect to the website's page, which asks for a button press", querystring: tokenQuery },
      },
      async (request, reply) => (settings ? reply.redirect(unsubscribePage(settings, request.query.token)) : reply.redirect(landing("invalido"))),
    );

    app.post(
      "/newsletter/confirm",
      {
        logLevel: "warn",
        schema: {
          tags: ["newsletter"],
          summary: "The «Confirmar» button on /newsletter/confirmar: confirms the address in the token",
          description: "Call it only on the button press, never on page load (mail scanners open every link).",
          body: z.strictObject({ token }),
          response: { 200: z.object({ status: z.literal("confirmed") }), 400: errorSchema },
        },
      },
      async (request) => {
        const email = settings && readToken(settings.secret, "confirm", request.body.token);
        if (!email) throw new ApiError(400, "invalid_token", "The link is not valid");
        const [row] = await db
          .update(newsletterSubscribers)
          .set({ confirmedAt: sql`coalesce(${newsletterSubscribers.confirmedAt}, now())` })
          .where(eq(newsletterSubscribers.email, email))
          .returning({ email: newsletterSubscribers.email });
        // No row: it expired and was deleted, or they unsubscribed since.
        if (!row) throw new ApiError(400, "invalid_token", "The link is no longer valid");
        return { status: "confirmed" as const };
      },
    );

    app.post(
      "/newsletter/unsubscribe",
      {
        logLevel: "warn",
        schema: {
          tags: ["newsletter"],
          summary: "The «Cancelar inscrição» button ({ token } in the body), or mail clients' one-click unsubscribe (?token=, RFC 8058)",
          querystring: z.object({ token: token.optional() }),
          // Mail clients post a form we don't read (parsed as nothing): the token is then in the query.
          body: z.object({ token: token.optional() }).nullish(),
          response: { 200: z.object({ status: z.literal("unsubscribed") }), 400: errorSchema },
        },
      },
      async (request) => {
        const value = request.body?.token ?? request.query.token;
        const email = settings && value ? readToken(settings.secret, "unsubscribe", value) : null;
        if (!email) throw new ApiError(400, "invalid_token", "The link is not valid");
        await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.email, email));
        return { status: "unsubscribed" as const };
      },
    );
  };
