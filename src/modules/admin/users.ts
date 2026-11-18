import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { endReaderSessions } from "../../accounts/sessions.js";
import { adminGuard, audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

/* Reader accounts for moderators: find one, and ban (disable) or unban it. Audited. */

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

const userRowSchema = z.object({
  id: z.number(),
  username: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  comments: z.number(),
  forumPosts: z.number().describe("Threads opened plus replies"),
  reportsAgainst: z.number().describe("Open reports on their comments and forum posts"),
});

export const adminUserRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    app.get(
      "/admin/users",
      {
        schema: {
          tags: ["admin"],
          summary: "Reader accounts, most reported first, or matching a username (moderators)",
          querystring: z.object({ q: z.string().trim().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
          response: { 200: z.object({ items: z.array(userRowSchema) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { q, limit } = request.query;
        const rows = await db.execute<{
          id: number; username: string; created_at: Date; last_login_at: Date | null; disabled_at: Date | null;
          comments: number; forum_posts: number; reports_against: number;
        }>(sql`
          select u.id, u.username, u.created_at, u.last_login_at, u.disabled_at,
            (select count(*)::int from comments c where c.user_id = u.id) as comments,
            (select count(*)::int from forum_threads t where t.user_id = u.id) + (select count(*)::int from forum_posts p where p.user_id = u.id) as forum_posts,
            (select count(*)::int from reports r where r.resolved_at is null and (
              (r.kind = 'comment' and r.target_id in (select id from comments where user_id = u.id)) or
              (r.kind = 'thread' and r.target_id in (select id from forum_threads where user_id = u.id)) or
              (r.kind = 'post' and r.target_id in (select id from forum_posts where user_id = u.id)))) as reports_against
          from users u
          ${q ? sql`where lower(u.username) like ${`%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`}` : sql``}
          order by reports_against desc, u.created_at desc limit ${limit}`);
        const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
        return {
          items: rows.rows.map((r) => ({
            id: r.id, username: r.username, createdAt: iso(r.created_at)!, lastLoginAt: iso(r.last_login_at), disabledAt: iso(r.disabled_at),
            comments: r.comments, forumPosts: r.forum_posts, reportsAgainst: r.reports_against,
          })),
        };
      },
    );

    for (const action of ["disable", "enable"] as const) {
      app.post(
        `/admin/users/:id/${action}`,
        {
          schema: {
            tags: ["admin"],
            summary: action === "disable" ? "Ban a reader account: logged out, can't log in or take part (moderators)" : "Lift the ban (moderators)",
            params: idParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) => {
          const me = await requireAdmin(request, "moderator");
          const [user] = await db
            .update(users)
            .set({ disabledAt: action === "disable" ? new Date() : null })
            .where(eq(users.id, request.params.id))
            .returning({ id: users.id });
          if (!user) throw notFound("User");
          if (action === "disable") await endReaderSessions(db, user.id);
          await audit(db, me.id, `user.${action}`, "user", user.id);
          return reply.status(204).send(null);
        },
      );
    }
  };

