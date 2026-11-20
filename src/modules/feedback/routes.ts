import multipart from "@fastify/multipart";
import { createHash, randomBytes } from "node:crypto";
import { imageType } from "../../media/images.js";
import { and, count, desc, eq, getTableColumns, gte, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { adminGuard, audit } from "../../admin/sessions.js";
import { lisbonDay } from "../../agenda/time.js";
import type { Db } from "../../db/client.js";
import { corrections, feedbackMessages } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { purgeFeedback } from "../../feedback/purge.js";
import { notify } from "../../notifications/index.js";
import type { Mailer } from "../../newsletter/mailer.js";
import type { RecaptchaVerifier } from "../comments/recaptcha.js";
import { errorSchema } from "../shared.js";

/*
 * The feedback form, the public corrections log, and the admin to read, answer and close
 * messages. Privacy (as the privacy page says): the email only serves to answer and is deleted
 * when the message is closed; screenshots are deleted after 90 days; the log never says who
 * asked.
 */

export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const FEEDBACK_KINDS = ["error", "idea", "broken", "other"] as const;
const CORRECTION_STATUSES = ["fixed", "checking", "rejected"] as const;
const MAX_INT = 2_147_483_647;


/** The follow-up link's token is shown once; only its hash is kept. */
export const followUpHash = (token: string) => createHash("sha256").update(token).digest("hex");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

const formSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(1).max(1000),
  page: optionalText(100),
  url: optionalText(1000),
  correction: optionalText(1000),
  source: optionalText(1000),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((value) => value || null)
    .pipe(z.email().nullable()),
  recaptchaToken: z.string().min(1).max(4096),
});

const correctionSchema = z.object({
  id: z.number(),
  status: z.enum(CORRECTION_STATUSES),
  date: z.string(),
  area: z.string(),
  title: z.string(),
  url: z.string().nullable().describe("A path on this site, a full link, or null"),
});
const correctionInput = z.object({
  status: z.enum(CORRECTION_STATUSES),
  date: z.iso.date().optional().describe("Default today"),
  area: z.string().trim().min(1).max(100),
  title: z.string().trim().min(3).max(300),
  url: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .transform((value) => value || null)
    .refine((value) => value === null || /^\/(?![/\\])/.test(value) || /^https?:\/\//.test(value), "A path on the site (/…) or an http(s) link"),
});

const adminMessageSchema = z.object({
  id: z.number(),
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string(),
  page: z.string().nullable(),
  url: z.string().nullable(),
  correction: z.string().nullable(),
  source: z.string().nullable(),
  email: z.string().nullable().describe("Deleted when the message is closed"),
  screenshot: z.string().nullable().describe("Path of the image (admin session needed); null if none or past 90 days"),
  status: z.enum(["open", "answered", "closed"]),
  reply: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  account: z.boolean().describe("Sent by a logged-in reader: an in-site answer reaches their inbox"),
  followable: z.boolean().describe("The reader can read an in-site answer (an account, or their private link; the link goes when the message is closed)"),
  corrections: z.array(correctionSchema),
});

const idParams = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

export interface FeedbackRouteOptions {
  db: Db;
  verifyRecaptcha: RecaptchaVerifier;
  /** To answer readers by email from the admin; without it, answers are noted, not sent. */
  mailer: Mailer | null;
  limitPerHour: number;
}

type MessageRow = typeof feedbackMessages.$inferSelect;
type CorrectionRow = typeof corrections.$inferSelect;

const presentCorrection = (row: CorrectionRow) => ({ id: row.id, status: row.status, date: row.date, area: row.area, title: row.title, url: row.url });

export const feedbackRoutes =
  ({ db, verifyRecaptcha, mailer, limitPerHour }: FeedbackRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);
    await app.register(multipart, {
      limits: { fileSize: SCREENSHOT_MAX_BYTES, files: 1, fields: 12, fieldSize: 8 * 1024, parts: 14 },
    });

    /** The form's fields and its screenshot, if any. */
    const readForm = async (request: FastifyRequest) => {
      if (!request.isMultipart()) throw new ApiError(400, "validation_failed", "Send the form as multipart/form-data");
      const fields: Record<string, string> = {};
      let screenshot: { bytes: Buffer; type: string } | null = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "screenshot") {
              await part.toBuffer();
              continue;
            }
            const bytes = await part.toBuffer();
            if (bytes.length === 0) continue;
            const type = imageType(bytes);
            if (!type) throw new ApiError(415, "unsupported_file", "The screenshot must be a PNG or JPG image");
            screenshot = { bytes, type };
          } else if (typeof part.value === "string") {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE") throw new ApiError(413, "file_too_large", "The screenshot can be up to 5 MB");
        if (code?.startsWith("FST_")) throw new ApiError(400, "validation_failed", "The form could not be read");
        throw error;
      }
      const parsed = formSchema.safeParse(fields);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError(400, "validation_failed", `${issue?.path.join(".") || "form"}: ${issue?.message ?? "invalid"}`);
      }
      return { ...parsed.data, screenshot };
    };

    app.post(
      "/feedback",
      {
        config: { rateLimit: { max: limitPerHour, timeWindow: "1 hour" } },
        schema: {
          tags: ["feedback"],
          summary: "Send a message to the team (multipart/form-data, with an optional PNG or JPG screenshot up to 5 MB)",
          description:
            "Fields: kind (error | idea | broken | other), message (required, up to 1000), page, url, correction, source, email, screenshot (file), recaptchaToken.",
          consumes: ["multipart/form-data"],
          response: {
            201: z.object({
              id: z.number(),
              followUpToken: z
                .string()
                .describe("Private, shown once: GET /feedback/follow/:token shows the team's answer. Works until the message is closed"),
            }),
            400: errorSchema,
            403: errorSchema,
            413: errorSchema,
            415: errorSchema,
            429: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const form = await readForm(request);
        let human: boolean;
        try {
          human = await verifyRecaptcha(form.recaptchaToken, request.ip);
        } catch (error) {
          request.log.error(error, "reCAPTCHA verification unavailable");
          throw new ApiError(503, "captcha_unavailable", "Sending is temporarily unavailable");
        }
        if (!human) throw new ApiError(403, "captcha_failed", "reCAPTCHA verification failed");
        const { recaptchaToken: _token, screenshot, ...fields } = form;
        const followUpToken = randomBytes(24).toString("base64url");
        const [created] = await db
          .insert(feedbackMessages)
          .values({
            ...fields, screenshot: screenshot?.bytes ?? null, screenshotType: screenshot?.type ?? null,
            userId: request.reader?.id ?? null, followUpHash: followUpHash(followUpToken),
          })
          .returning({ id: feedbackMessages.id });
        await purgeFeedback(db);
        return reply.status(201).send({ id: created!.id, followUpToken });
      },
    );

    app.get(
      "/feedback/follow/:token",
      {
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["feedback"],
          summary: "A message's status and the team's answer, by its private follow-up token (until the message is closed)",
          description: "Never the email, the message or anything else the reader wrote. 404 for an unknown token or a closed message.",
          params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) }),
          response: {
            200: z.object({
              kind: z.enum(FEEDBACK_KINDS),
              page: z.string().nullable(),
              createdAt: z.string(),
              status: z.enum(["open", "answered"]),
              reply: z.string().nullable().describe("The team's answer, once given"),
              answeredAt: z.string().nullable(),
            }),
            400: errorSchema,
            404: errorSchema,
            429: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const [row] = await db
          .select({ kind: feedbackMessages.kind, page: feedbackMessages.page, createdAt: feedbackMessages.createdAt, status: feedbackMessages.status, reply: feedbackMessages.reply, answeredAt: feedbackMessages.answeredAt })
          .from(feedbackMessages)
          .where(eq(feedbackMessages.followUpHash, followUpHash(request.params.token)));
        if (!row || row.status === "closed") throw notFound("Message");
        reply.header("Cache-Control", "private, no-store");
        return {
          kind: row.kind, page: row.page, createdAt: row.createdAt.toISOString(), status: row.status,
          reply: row.reply, answeredAt: row.answeredAt?.toISOString() ?? null,
        };
      },
    );

    app.get(
      "/feedback/summary",
      {
        schema: {
          tags: ["feedback"],
          summary: "For the feedback page's side boxes: response time, corrections this month, the latest corrections",
          response: {
            200: z.object({
              stats: z.object({
                responseDays: z.number().nullable().describe("Median days to a first answer over the last 90 days; null with fewer than 5 answers"),
                correctionsThisMonth: z.number().describe("Corrections marked fixed this month (Lisbon)"),
              }),
              corrections: z.array(correctionSchema).describe("The latest 4"),
            }),
          },
        },
      },
      async () => {
        const today = lisbonDay(new Date());
        const [median, fixed, latest] = await Promise.all([
          db.execute<{ days: number | null; n: number }>(sql`
            select percentile_cont(0.5) within group (order by extract(epoch from answered_at - created_at) / 86400)::float8 as days,
              count(*)::int as n
            from feedback_messages where answered_at is not null and created_at > now() - interval '90 days'`),
          db
            .select({ n: count() })
            .from(corrections)
            .where(and(eq(corrections.status, "fixed"), gte(corrections.date, `${today.slice(0, 7)}-01`))),
          db.select().from(corrections).orderBy(desc(corrections.date), desc(corrections.id)).limit(4),
        ]);
        const m = median.rows[0];
        return {
          stats: {
            responseDays: m && m.n >= 5 && m.days !== null ? Math.max(1, Math.round(m.days)) : null,
            correctionsThisMonth: fixed[0]?.n ?? 0,
          },
          corrections: latest.map(presentCorrection),
        };
      },
    );

    const encodeCursor = (row: { date: string; id: number }) => Buffer.from(JSON.stringify([row.date, row.id])).toString("base64url");
    const decodeCursor = (cursor: string) => {
      try {
        const [date, id] = z.tuple([z.iso.date(), z.number().int()]).parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
        return { date, id };
      } catch {
        throw new ApiError(400, "invalid_cursor", "Invalid cursor");
      }
    };

    app.get(
      "/corrections",
      {
        schema: {
          tags: ["feedback"],
          summary: "The public corrections log, newest first",
          querystring: z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
          response: { 200: z.object({ items: z.array(correctionSchema), nextCursor: z.string().nullable() }), 400: errorSchema },
        },
      },
      async (request) => {
        const { cursor, limit } = request.query;
        const after = cursor ? decodeCursor(cursor) : null;
        const rows = await db
          .select()
          .from(corrections)
          .where(after ? sql`(${corrections.date}, ${corrections.id}) < (${after.date}::date, ${after.id})` : undefined)
          .orderBy(desc(corrections.date), desc(corrections.id))
          .limit(limit + 1);
        const items = rows.slice(0, limit);
        return { items: items.map(presentCorrection), nextCursor: rows.length > limit ? encodeCursor(items.at(-1)!) : null };
      },
    );

    // Admin (moderators): read, answer and close messages; keep the corrections log.

    const presentMessage = (row: MessageRow, linked: CorrectionRow[] = []) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      page: row.page,
      url: row.url,
      correction: row.correction,
      source: row.source,
      email: row.email,
      screenshot: row.screenshotType ? `/api/v2/admin/feedback/${row.id}/screenshot` : null,
      status: row.status,
      reply: row.reply,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      answeredAt: row.answeredAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      account: row.userId !== null,
      followable: row.userId !== null || row.followUpHash !== null,
      corrections: linked.map(presentCorrection),
    });
    // Everything but the image itself.
    const { screenshot: _bytes, ...messageColumns } = getTableColumns(feedbackMessages);
    const loadMessage = async (id: number) => {
      const [row] = await db.select(messageColumns).from(feedbackMessages).where(eq(feedbackMessages.id, id));
      if (!row) throw notFound("Message");
      return { ...row, screenshot: null } as MessageRow;
    };
    const withCorrections = async (row: MessageRow) =>
      presentMessage(row, await db.select().from(corrections).where(eq(corrections.feedbackId, row.id)).orderBy(desc(corrections.id)));

    app.get(
      "/admin/feedback",
      {
        schema: {
          tags: ["admin"],
          summary: "Messages from the feedback form, newest first",
          querystring: z.object({
            status: z.enum(["open", "answered", "closed"]).optional(),
            kind: z.enum(FEEDBACK_KINDS).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(100),
          }),
          response: { 200: z.object({ items: z.array(adminMessageSchema.omit({ corrections: true })) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        await purgeFeedback(db);
        const { status, kind, limit } = request.query;
        const rows = await db
          .select(messageColumns)
          .from(feedbackMessages)
          .where(and(status ? eq(feedbackMessages.status, status) : undefined, kind ? eq(feedbackMessages.kind, kind) : undefined))
          .orderBy(desc(feedbackMessages.createdAt), desc(feedbackMessages.id))
          .limit(limit);
        return { items: rows.map((row) => { const { corrections: _c, ...rest } = presentMessage({ ...row, screenshot: null } as MessageRow); return rest; }) };
      },
    );

    app.get(
      "/admin/feedback/:id",
      { schema: { tags: ["admin"], summary: "One message, with the corrections made from it", params: idParams, response: { 200: adminMessageSchema, ...errors } } },
      async (request) => {
        await requireAdmin(request, "moderator");
        await purgeFeedback(db);
        return withCorrections(await loadMessage(request.params.id));
      },
    );

    app.get(
      "/admin/feedback/:id/screenshot",
      { schema: { tags: ["admin"], summary: "A message's screenshot (PNG or JPG)", params: idParams } },
      async (request, reply) => {
        await requireAdmin(request, "moderator");
        await purgeFeedback(db);
        const [row] = await db
          .select({ bytes: feedbackMessages.screenshot, type: feedbackMessages.screenshotType })
          .from(feedbackMessages)
          .where(eq(feedbackMessages.id, request.params.id));
        if (!row?.bytes || !row.type) throw notFound("Screenshot");
        return reply.header("Content-Type", row.type).header("Cache-Control", "private, no-store").send(row.bytes);
      },
    );

    app.post(
      "/admin/feedback/:id/answer",
      {
        schema: {
          tags: ["admin"],
          summary: "Answer a message: by email, on the site, or note one given elsewhere",
          description:
            "channel email (or the older send: true) emails it; site shows it on the reader's private follow-up link, with no email needed; none (default) only notes it. Either way the answer shows on the follow-up link, and with email or site a logged-in reader also gets it in their inbox.",
          params: idParams,
          body: z.object({
            reply: z.string().trim().min(1).max(5000).nullable().describe("What we answered"),
            send: z.boolean().default(false).describe("Same as channel: email (kept for the admin that sends it)"),
            channel: z.enum(["email", "site", "none"]).optional().describe("Default: email when send is true, otherwise none"),
          }),
          response: { 200: adminMessageSchema, 503: errorSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const before = await loadMessage(request.params.id);
        const { reply } = request.body;
        const channel = request.body.channel ?? (request.body.send ? "email" : "none");
        const send = channel === "email";
        if (channel === "site") {
          if (!reply) throw new ApiError(400, "empty_reply", "Write the reply first");
          if (before.userId === null && before.followUpHash === null) {
            throw new ApiError(400, "not_followable", "The reader can no longer see an answer on the site: the message was closed");
          }
        }
        if (send) {
          if (!reply) throw new ApiError(400, "empty_reply", "Write the reply first");
          if (!before.email) throw new ApiError(400, "no_email", "The reader didn't leave an email");
          if (!mailer) throw new ApiError(503, "mail_unavailable", "Mail isn't set up: answer from your own email and note it here");
          await mailer({
            to: before.email,
            subject: "Resposta à tua mensagem para o Politicando",
            text: `${reply}\n\n— A equipa do Politicando\n\n---\nA tua mensagem:\n${before.message}`,
          });
        }
        const [after] = await db
          .update(feedbackMessages)
          .set({ reply: reply ?? before.reply, status: before.status === "closed" ? "closed" : "answered", answeredAt: before.answeredAt ?? new Date() })
          .where(eq(feedbackMessages.id, before.id))
          .returning();
        await audit(db, me.id, channel === "email" ? "feedback.reply" : channel === "site" ? "feedback.reply_site" : "feedback.answered", "feedback", before.id);
        if (channel !== "none" && reply && before.userId !== null) {
          try {
            await notify(db, { userIds: [before.userId], kind: "feedback_reply", targetId: before.id, actorName: "Politicando" });
          } catch (error) {
            request.log.error(error, "feedback notification failed");
          }
        }
        return withCorrections(after!);
      },
    );

    app.put(
      "/admin/feedback/:id/note",
      {
        schema: {
          tags: ["admin"],
          summary: "The team's internal note on a message",
          params: idParams,
          body: z.object({ note: z.string().trim().max(2000).nullable() }),
          response: { 200: adminMessageSchema, ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const before = await loadMessage(request.params.id);
        const [after] = await db.update(feedbackMessages).set({ note: request.body.note || null }).where(eq(feedbackMessages.id, before.id)).returning();
        return withCorrections(after!);
      },
    );

    app.post(
      "/admin/feedback/:id/close",
      {
        schema: { tags: ["admin"], summary: "Close a message; its email and follow-up link are deleted", params: idParams, response: { 200: adminMessageSchema, ...errors } },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const before = await loadMessage(request.params.id);
        const [after] = await db
          .update(feedbackMessages)
          .set({ status: "closed", closedAt: before.closedAt ?? new Date(), email: null, followUpHash: null })
          .where(eq(feedbackMessages.id, before.id))
          .returning();
        await audit(db, me.id, "feedback.close", "feedback", before.id);
        return withCorrections(after!);
      },
    );

    app.post(
      "/admin/feedback/:id/correction",
      {
        schema: {
          tags: ["admin"],
          summary: "Turn a message into an entry in the public corrections log (never says who asked)",
          params: idParams,
          body: correctionInput.extend({ area: correctionInput.shape.area.optional().describe("Default: the section the reader chose") }),
          response: { 201: correctionSchema, ...errors },
        },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const message = await loadMessage(request.params.id);
        const area = request.body.area ?? message.page;
        if (!area) throw new ApiError(400, "validation_failed", "area: say which section it's about");
        const [created] = await db
          .insert(corrections)
          .values({ ...request.body, area, date: request.body.date ?? lisbonDay(new Date()), feedbackId: message.id })
          .returning();
        await audit(db, me.id, "correction.create", "correction", created!.id, null, presentCorrection(created!));
        return reply.status(201).send(presentCorrection(created!));
      },
    );

    app.get(
      "/admin/corrections",
      {
        schema: {
          tags: ["admin"],
          summary: "The corrections log, newest first, with the message each came from",
          response: { 200: z.object({ items: z.array(correctionSchema.extend({ feedbackId: z.number().nullable() })) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const rows = await db.select().from(corrections).orderBy(desc(corrections.date), desc(corrections.id)).limit(500);
        return { items: rows.map((row) => ({ ...presentCorrection(row), feedbackId: row.feedbackId })) };
      },
    );

    app.post(
      "/admin/corrections",
      { schema: { tags: ["admin"], summary: "Add an entry to the corrections log", body: correctionInput, response: { 201: correctionSchema, ...errors } } },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const [created] = await db
          .insert(corrections)
          .values({ ...request.body, date: request.body.date ?? lisbonDay(new Date()) })
          .returning();
        await audit(db, me.id, "correction.create", "correction", created!.id, null, presentCorrection(created!));
        return reply.status(201).send(presentCorrection(created!));
      },
    );

    app.put(
      "/admin/corrections/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Change an entry (e.g. from checking to fixed)",
          params: idParams,
          body: correctionInput,
          response: { 200: correctionSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const [before] = await db.select().from(corrections).where(eq(corrections.id, request.params.id));
        if (!before) throw notFound("Correction");
        const [after] = await db
          .update(corrections)
          .set({ ...request.body, date: request.body.date ?? before.date, updatedAt: new Date() })
          .where(eq(corrections.id, before.id))
          .returning();
        await audit(db, me.id, "correction.update", "correction", before.id, presentCorrection(before), presentCorrection(after!));
        return presentCorrection(after!);
      },
    );

    app.delete(
      "/admin/corrections/:id",
      { schema: { tags: ["admin"], summary: "Remove an entry from the log", params: idParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const [removed] = await db.delete(corrections).where(eq(corrections.id, request.params.id)).returning();
        if (!removed) throw notFound("Correction");
        await audit(db, me.id, "correction.delete", "correction", removed.id, presentCorrection(removed), null);
        return reply.status(204).send(null);
      },
    );
  };
