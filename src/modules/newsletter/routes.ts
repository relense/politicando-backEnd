import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { newsletterSubscribers } from "../../db/schema.js";
import { ApiError } from "../../errors.js";
import type { Mailer } from "../../newsletter/mailer.js";
import { CONFIRM_TTL_DAYS, createToken, readToken } from "../../newsletter/tokens.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { errorSchema } from "../shared.js";

export interface NewsletterSettings {
  mailer: Mailer;
  /** Signs the confirmation and unsubscribe links. Changing it breaks every link already sent. */
  secret: string;
  /** The website, where people land after confirming or unsubscribing. */
  siteUrl: string;
  /** This API's public address, for the links in the emails. */
  apiUrl: string;
}

export interface NewsletterRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  createLimitPerMinute: number;
  /** Absent: sign-ups answer 503 (no mail configured). */
  settings: NewsletterSettings | null;
}

/** Ask again for a pending address at most this often, so the form can't be used to flood an inbox. */
const RESEND_AFTER_MINUTES = 10;

const emailSchema = z.email();
const tokenQuery = z.object({ token: z.string().max(1_000) });

export const newsletterRoutes =
  ({ db, verifyRecaptcha, createLimitPerMinute, settings }: NewsletterRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    // Mail clients' one-click unsubscribe (RFC 8058) posts a form body we don't need.
    app.addContentTypeParser("application/x-www-form-urlencoded", (_request, _payload, done) => done(null, undefined));

    const landing = (state: "confirmado" | "cancelado" | "invalido") =>
      `${settings?.siteUrl.replace(/\/$/, "") ?? ""}/newsletter?estado=${state}`;
    const link = (path: string, token: string) =>
      `${settings!.apiUrl.replace(/\/$/, "")}/api/v2/newsletter/${path}?token=${encodeURIComponent(token)}`;

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
        const email = request.body.email.trim().toLowerCase();
        if (email.length > 254 || !emailSchema.safeParse(email).success) {
          throw new ApiError(400, "invalid_email", "That is not a valid email address");
        }
        if (!settings) throw new ApiError(503, "newsletter_unavailable", "The newsletter is not available yet");

        let human: boolean;
        try {
          human = await verifyRecaptcha(request.body.recaptchaToken, request.ip);
        } catch (error) {
          request.log.error(error, "reCAPTCHA verification unavailable");
          throw new ApiError(503, "recaptcha_unavailable", "Sign-ups are temporarily unavailable");
        }
        if (!human) throw new ApiError(403, "recaptcha_failed", "reCAPTCHA verification failed");

        // Forget addresses that never confirmed.
        await db
          .delete(newsletterSubscribers)
          .where(and(isNull(newsletterSubscribers.confirmedAt), lt(newsletterSubscribers.createdAt, sql`now() - make_interval(days => ${CONFIRM_TTL_DAYS})`)));

        // New, or pending and not asked recently: (re)send. Confirmed or just asked: say the same, send nothing,
        // so the answer never reveals whether an address is subscribed.
        const [toAsk] = await db
          .insert(newsletterSubscribers)
          .values({ email })
          .onConflictDoUpdate({
            target: newsletterSubscribers.email,
            set: { createdAt: sql`now()` },
            setWhere: sql`${newsletterSubscribers.confirmedAt} is null and ${newsletterSubscribers.createdAt} < now() - make_interval(mins => ${RESEND_AFTER_MINUTES})`,
          })
          .returning({ email: newsletterSubscribers.email });

        if (toAsk) {
          const confirm = link("confirm", createToken(settings.secret, "confirm", email));
          const unsubscribe = link("unsubscribe", createToken(settings.secret, "unsubscribe", email));
          try {
            await settings.mailer({
              to: email,
              subject: "Confirma a tua inscrição na newsletter do Politicando",
              text: [
                "Olá,",
                "",
                "Recebemos um pedido para inscrever este endereço na newsletter do Politicando.",
                "Para confirmar, abre esta ligação:",
                "",
                confirm,
                "",
                `A ligação é válida durante ${CONFIRM_TTL_DAYS} dias. Se não foste tu, ignora este email: sem confirmação, o endereço é apagado.`,
                "",
                `Para não receberes mais nada: ${unsubscribe}`,
              ].join("\n"),
              headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
            });
          } catch (error) {
            request.log.error(error, "Newsletter confirmation email failed");
            await db.delete(newsletterSubscribers).where(and(eq(newsletterSubscribers.email, email), isNull(newsletterSubscribers.confirmedAt)));
            throw new ApiError(503, "mail_unavailable", "We couldn't send the email; try again later");
          }
        }
        return reply.status(202).send({ status: "pending" as const });
      },
    );

    // The links carry the address (signed), so these routes keep it out of the request log.

    app.get(
      "/newsletter/confirm",
      {
        logLevel: "warn",
        schema: { tags: ["newsletter"], summary: "The link in the confirmation email. Redirects to the website", querystring: tokenQuery },
      },
      async (request, reply) => {
        const email = settings && readToken(settings.secret, "confirm", request.query.token);
        if (!email) return reply.redirect(landing("invalido"));
        const [row] = await db
          .update(newsletterSubscribers)
          .set({ confirmedAt: sql`coalesce(${newsletterSubscribers.confirmedAt}, now())` })
          .where(eq(newsletterSubscribers.email, email))
          .returning({ email: newsletterSubscribers.email });
        // No row: it expired and was deleted, or they unsubscribed since.
        return reply.redirect(landing(row ? "confirmado" : "invalido"));
      },
    );

    const unsubscribe = async (token: string) => {
      const email = settings && readToken(settings.secret, "unsubscribe", token);
      if (!email) return false;
      await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.email, email));
      return true;
    };

    app.get(
      "/newsletter/unsubscribe",
      {
        logLevel: "warn",
        schema: { tags: ["newsletter"], summary: "The link in every email. Deletes the address, then redirects to the website", querystring: tokenQuery },
      },
      async (request, reply) => reply.redirect(landing((await unsubscribe(request.query.token)) ? "cancelado" : "invalido")),
    );

    app.post(
      "/newsletter/unsubscribe",
      {
        logLevel: "warn",
        schema: {
          tags: ["newsletter"],
          summary: "One-click unsubscribe from mail clients (RFC 8058)",
          querystring: tokenQuery,
          response: { 204: z.null(), 400: errorSchema },
        },
      },
      async (request, reply) => {
        if (!(await unsubscribe(request.query.token))) throw new ApiError(400, "invalid_token", "The link is not valid");
        return reply.status(204).send(null);
      },
    );
  };
