import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { DUMMY_HASH, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "../../admin/password.js";
import {
  SESSION_COOKIE,
  adminGuard,
  audit,
  createSession,
  endAllSessions,
  endSession,
} from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { admins, auditLog, comments } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

const roleSchema = z.enum(["author", "moderator", "admin"]);
const adminSchema = z.object({ id: z.number(), email: z.string(), name: z.string(), role: roleSchema });
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);
const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

export interface AdminRouteOptions {
  db: Db;
  /** Send the session cookie only over HTTPS. Off for local development over plain HTTP. */
  secureCookies: boolean;
  loginLimitPerMinute?: number;
}

export const adminRoutes =
  ({ db, secureCookies, loginLimitPerMinute = 5 }: AdminRouteOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const cookieOptions = {
      path: "/api/v2/admin",
      httpOnly: true,
      sameSite: "strict" as const,
      secure: secureCookies,
    };

    const requireAdmin = adminGuard(db);

    const startSession = async (reply: FastifyReply, adminId: number) => {
      const { token, expiresAt } = await createSession(db, adminId);
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
    };

    app.post(
      "/admin/login",
      {
        config: { rateLimit: { max: loginLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["admin"],
          summary: "Sign in; sets an httpOnly session cookie scoped to /api/v2/admin",
          body: z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }),
          response: { 200: z.object({ admin: adminSchema }), 400: errorSchema, 401: errorSchema, 429: errorSchema },
        },
      },
      async (request, reply) => {
        const { email, password } = request.body;
        const [found] = await db.select().from(admins).where(eq(admins.email, email));
        const valid = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH);
        if (!found || !valid || found.disabledAt) throw new ApiError(401, "invalid_credentials", "Wrong email or password");
        await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, found.id));
        await startSession(reply, found.id);
        return { admin: { id: found.id, email: found.email, name: found.name, role: found.role } };
      },
    );

    app.post(
      "/admin/logout",
      { schema: { tags: ["admin"], summary: "Sign out", response: { 204: z.null() } } },
      async (request, reply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (token) await endSession(db, token);
        reply.clearCookie(SESSION_COOKIE, cookieOptions);
        return reply.status(204).send(null);
      },
    );

    app.get(
      "/admin/me",
      { schema: { tags: ["admin"], summary: "Who is signed in", response: { 200: z.object({ admin: adminSchema }), ...errors } } },
      async (request) => ({ admin: await requireAdmin(request) }),
    );

    app.post(
      "/admin/password",
      {
        config: { rateLimit: { max: loginLimitPerMinute, timeWindow: "1 minute" } },
        schema: {
          tags: ["admin"],
          summary: "Change your password; signs out every other session",
          body: z.object({ current: z.string().max(200), next: passwordSchema }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const admin = await requireAdmin(request);
        const [row] = await db.select({ hash: admins.passwordHash }).from(admins).where(eq(admins.id, admin.id));
        if (!row || !(await verifyPassword(request.body.current, row.hash))) {
          throw new ApiError(401, "invalid_credentials", "Wrong current password");
        }
        await db.update(admins).set({ passwordHash: await hashPassword(request.body.next) }).where(eq(admins.id, admin.id));
        await endAllSessions(db, admin.id);
        await startSession(reply, admin.id);
        await audit(db, admin.id, "admin.password", "admin", admin.id);
        return reply.status(204).send(null);
      },
    );

    // Managing admins (role admin).

    const listedAdmin = adminSchema.extend({
      disabled: z.boolean(),
      createdAt: z.string(),
      lastLoginAt: z.string().nullable(),
    });
    const listed = (a: typeof admins.$inferSelect) => ({
      id: a.id, email: a.email, name: a.name, role: a.role, disabled: a.disabledAt !== null,
      createdAt: a.createdAt.toISOString(), lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    });

    app.get(
      "/admin/admins",
      { schema: { tags: ["admin"], summary: "Everyone who can sign in", response: { 200: z.object({ items: z.array(listedAdmin) }), ...errors } } },
      async (request) => {
        await requireAdmin(request, "admin");
        return { items: (await db.select().from(admins).orderBy(admins.name)).map(listed) };
      },
    );

    app.post(
      "/admin/admins",
      {
        schema: {
          tags: ["admin"],
          summary: "Invite someone: give them the password over a safe channel and ask them to change it",
          body: z.object({
            email: z.email().trim().toLowerCase().max(200),
            name: z.string().trim().min(1).max(100),
            role: roleSchema,
            password: passwordSchema,
          }),
          response: { 201: listedAdmin, 409: errorSchema, ...errors },
        },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "admin");
        const { password, ...fields } = request.body;
        const [created] = await db
          .insert(admins)
          .values({ ...fields, passwordHash: await hashPassword(password) })
          .onConflictDoNothing({ target: admins.email })
          .returning();
        if (!created) throw new ApiError(409, "email_taken", "Someone already uses that email");
        await audit(db, me.id, "admin.create", "admin", created.id, null, fields);
        return reply.status(201).send(listed(created));
      },
    );

    app.patch(
      "/admin/admins/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Change someone's name or role, or disable them (signs them out)",
          params: idParams,
          body: z.object({ name: z.string().trim().min(1).max(100).optional(), role: roleSchema.optional(), disabled: z.boolean().optional() }),
          response: { 200: listedAdmin, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "admin");
        const { id } = request.params;
        const { name, role, disabled } = request.body;
        if (id === me.id && (disabled || (role && role !== "admin"))) {
          throw new ApiError(400, "self_lockout", "You can't disable yourself or drop your own admin role");
        }
        const [before] = await db.select().from(admins).where(eq(admins.id, id));
        if (!before) throw notFound("Admin");
        const [after] = await db
          .update(admins)
          .set({
            ...(name !== undefined && { name }),
            ...(role !== undefined && { role }),
            ...(disabled !== undefined && { disabledAt: disabled ? (before.disabledAt ?? new Date()) : null }),
          })
          .where(eq(admins.id, id))
          .returning();
        if (disabled) await endAllSessions(db, id);
        const pick = (a: typeof admins.$inferSelect) => ({ name: a.name, role: a.role, disabled: a.disabledAt !== null });
        await audit(db, me.id, "admin.update", "admin", id, pick(before), pick(after!));
        return listed(after!);
      },
    );

    // Comment moderation (role moderator).

    const moderatedComment = z.object({
      id: z.number(),
      articleId: z.number().nullable().describe("On a news article…"),
      articleTitle: z.string().nullable(),
      postId: z.number().nullable().describe("…or on one of our editorial posts"),
      postSlug: z.string().nullable(),
      postTitle: z.string().nullable(),
      parentId: z.number().nullable(),
      username: z.string().nullable(),
      body: z.string(),
      createdAt: z.string(),
      hiddenAt: z.string().nullable(),
    });

    app.get(
      "/admin/comments",
      {
        schema: {
          tags: ["admin"],
          summary: "Comments, newest first, to moderate",
          querystring: z.object({
            status: z.enum(["visible", "hidden", "all"]).default("visible"),
            articleId: z.coerce.number().int().positive().optional(),
            postId: z.coerce.number().int().positive().optional().describe("An editorial post's id"),
            before: z.coerce.number().int().positive().optional().describe("Comments with a smaller id (the last id of the previous page)"),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: z.object({ items: z.array(moderatedComment) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { status, articleId, postId, before, limit } = request.query;
        const rows = await db.execute<{
          id: number; article_id: number | null; article_title: string | null; post_id: number | null; post_slug: string | null;
          post_title: string | null; parent_id: number | null; username: string | null; body: string; created_at: string; hidden_at: string | null;
        }>(sql`
          select c.id, c.article_id, a.title as article_title, c.editorial_post_id as post_id, e.slug as post_slug,
            e.title as post_title, c.parent_id, c.username, c.body,
            to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
            to_char(c.hidden_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as hidden_at
          from comments c left join articles a on a.id = c.article_id left join editorial_posts e on e.id = c.editorial_post_id
          where ${status === "visible" ? sql`c.hidden_at is null` : status === "hidden" ? sql`c.hidden_at is not null` : sql`true`}
            and ${articleId ? sql`c.article_id = ${articleId}` : sql`true`}
            and ${postId ? sql`c.editorial_post_id = ${postId}` : sql`true`}
            and ${before ? sql`c.id < ${before}` : sql`true`}
          order by c.id desc limit ${limit}`);
        return {
          items: rows.rows.map((r) => ({
            id: r.id, articleId: r.article_id, articleTitle: r.article_title, postId: r.post_id, postSlug: r.post_slug, postTitle: r.post_title,
            parentId: r.parent_id, username: r.username,
            body: r.body, createdAt: r.created_at, hiddenAt: r.hidden_at,
          })),
        };
      },
    );

    for (const hide of [true, false]) {
      app.post(
        `/admin/comments/:id/${hide ? "hide" : "unhide"}`,
        {
          schema: {
            tags: ["admin"],
            summary: hide ? "Hide a comment from the public API" : "Show a hidden comment again",
            params: idParams,
            body: z.object({ reason: z.string().trim().max(500).optional() }).nullish(),
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) => {
          const me = await requireAdmin(request, "moderator");
          const { id } = request.params;
          const [updated] = await db
            .update(comments)
            .set({ hiddenAt: hide ? new Date() : null })
            .where(and(eq(comments.id, id), hide ? isNull(comments.hiddenAt) : isNotNull(comments.hiddenAt)))
            .returning({ id: comments.id });
          if (!updated) {
            const [exists] = await db.select({ id: comments.id }).from(comments).where(eq(comments.id, id));
            if (!exists) throw notFound("Comment");
            return reply.status(204).send(null); // Already in that state.
          }
          await audit(db, me.id, hide ? "comment.hide" : "comment.unhide", "comment", id, null, { reason: request.body?.reason ?? null });
          return reply.status(204).send(null);
        },
      );
    }

    // Audit log (role moderator).

    app.get(
      "/admin/audit",
      {
        schema: {
          tags: ["admin"],
          summary: "Every change made through the admin, newest first",
          querystring: z.object({
            entity: z.string().max(50).optional(),
            entityId: z.string().max(50).optional(),
            before: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  id: z.number(),
                  admin: z.object({ id: z.number(), name: z.string() }).nullable(),
                  action: z.string(),
                  entity: z.string(),
                  entityId: z.string(),
                  before: z.unknown(),
                  after: z.unknown(),
                  at: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { entity, entityId, before, limit } = request.query;
        const rows = await db
          .select({
            id: auditLog.id, adminId: auditLog.adminId, adminName: admins.name, action: auditLog.action, entity: auditLog.entity,
            entityId: auditLog.entityId, before: auditLog.before, after: auditLog.after, at: auditLog.at,
          })
          .from(auditLog)
          .leftJoin(admins, eq(admins.id, auditLog.adminId))
          .where(
            and(
              entity ? eq(auditLog.entity, entity) : undefined,
              entityId ? eq(auditLog.entityId, entityId) : undefined,
              before ? lt(auditLog.id, before) : undefined,
            ),
          )
          .orderBy(desc(auditLog.id))
          .limit(limit);
        return {
          items: rows.map((r) => ({
            id: r.id,
            admin: r.adminId !== null && r.adminName !== null ? { id: r.adminId, name: r.adminName } : null,
            action: r.action, entity: r.entity, entityId: r.entityId, before: r.before, after: r.after, at: r.at.toISOString(),
          })),
        };
      },
    );
  };
