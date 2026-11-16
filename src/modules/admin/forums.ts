import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { adminGuard, audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { comments, forumPosts, forumThreads, reports } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { IDEA_STATUSES, IDEAS_BOARD } from "../forums/routes.js";
import { errorSchema } from "../shared.js";

/* Forum moderation and the reports queue (role moderator). Every action is audited. */

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };
const kindSchema = z.enum(["thread", "post", "comment"]);
type Kind = z.infer<typeof kindSchema>;

const tableOf = (kind: Kind) => (kind === "thread" ? forumThreads : kind === "post" ? forumPosts : comments);

export const adminForumRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    /** What a report points at, for the moderator to judge without leaving the queue. */
    const targets = async (kind: Kind, ids: number[]) => {
      const map = new Map<number, { text: string; hidden: boolean; threadId: number | null; articleId: number | null }>();
      if (ids.length === 0) return map;
      if (kind === "thread") {
        const rows = await db
          .select({ id: forumThreads.id, title: forumThreads.title, body: forumThreads.body, hiddenAt: forumThreads.hiddenAt })
          .from(forumThreads)
          .where(inArray(forumThreads.id, ids));
        for (const r of rows) map.set(r.id, { text: `${r.title}\n\n${r.body}`, hidden: r.hiddenAt !== null, threadId: r.id, articleId: null });
      } else if (kind === "post") {
        const rows = await db
          .select({ id: forumPosts.id, body: forumPosts.body, hiddenAt: forumPosts.hiddenAt, threadId: forumPosts.threadId })
          .from(forumPosts)
          .where(inArray(forumPosts.id, ids));
        for (const r of rows) map.set(r.id, { text: r.body, hidden: r.hiddenAt !== null, threadId: r.threadId, articleId: null });
      } else {
        const rows = await db
          .select({ id: comments.id, body: comments.body, hiddenAt: comments.hiddenAt, articleId: comments.articleId })
          .from(comments)
          .where(inArray(comments.id, ids));
        for (const r of rows) map.set(r.id, { text: r.body, hidden: r.hiddenAt !== null, threadId: null, articleId: r.articleId });
      }
      return map;
    };

    app.get(
      "/admin/reports",
      {
        schema: {
          tags: ["admin"],
          summary: "Reported content, one item per thread, post or comment, most reported first",
          querystring: z.object({
            status: z.enum(["open", "resolved"]).default("open"),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  kind: kindSchema,
                  targetId: z.number(),
                  reports: z.number(),
                  reasons: z.array(z.string()),
                  details: z.array(z.string()).describe("What reporters wrote, if anything"),
                  firstReportedAt: z.string(),
                  resolution: z.enum(["hidden", "dismissed"]).nullable(),
                  target: z
                    .object({ text: z.string(), hidden: z.boolean(), threadId: z.number().nullable(), articleId: z.number().nullable() })
                    .nullable()
                    .describe("null if it no longer exists"),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { status, limit } = request.query;
        const rows = await db.execute<{
          kind: Kind; target_id: number; n: number; reasons: string[]; details: string[]; first: string; resolution: "hidden" | "dismissed" | null;
        }>(sql`
          select kind, target_id, count(*)::int as n, array_agg(distinct reason) as reasons,
            coalesce(array_agg(details) filter (where details is not null), '{}') as details,
            to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first,
            max(resolution) as resolution
          from reports where ${status === "open" ? sql`resolved_at is null` : sql`resolved_at is not null`}
          group by kind, target_id order by n desc, first limit ${limit}`);
        const byKind = new Map<Kind, Awaited<ReturnType<typeof targets>>>();
        for (const kind of ["thread", "post", "comment"] as const) {
          byKind.set(kind, await targets(kind, rows.rows.filter((r) => r.kind === kind).map((r) => r.target_id)));
        }
        return {
          items: rows.rows.map((r) => ({
            kind: r.kind, targetId: r.target_id, reports: r.n, reasons: r.reasons, details: r.details, firstReportedAt: r.first,
            resolution: status === "open" ? null : r.resolution, target: byKind.get(r.kind)!.get(r.target_id) ?? null,
          })),
        };
      },
    );

    app.post(
      "/admin/reports/resolve",
      {
        schema: {
          tags: ["admin"],
          summary: "Close every open report on one item: hide it, or dismiss the reports",
          body: z.object({ kind: kindSchema, targetId: z.number().int().positive(), action: z.enum(["hide", "dismiss"]) }),
          response: { 200: z.object({ resolved: z.number() }), ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const { kind, targetId, action } = request.body;
        if (action === "hide") {
          const table = tableOf(kind);
          await db.update(table).set({ hiddenAt: new Date() }).where(and(eq(table.id, targetId), isNull(table.hiddenAt)));
        }
        const resolved = await db
          .update(reports)
          .set({ resolvedAt: new Date(), resolvedBy: me.id, resolution: action === "hide" ? "hidden" : "dismissed" })
          .where(and(eq(reports.kind, kind), eq(reports.targetId, targetId), isNull(reports.resolvedAt)))
          .returning({ id: reports.id });
        if (resolved.length === 0) throw notFound("Open report");
        await audit(db, me.id, `report.${action}`, kind, targetId, null, { reports: resolved.length });
        return { resolved: resolved.length };
      },
    );

    const actions = [
      { kind: "thread", name: "hide", set: () => ({ hiddenAt: new Date() }) },
      { kind: "thread", name: "unhide", set: () => ({ hiddenAt: null }) },
      { kind: "thread", name: "lock", set: () => ({ lockedAt: new Date() }) },
      { kind: "thread", name: "unlock", set: () => ({ lockedAt: null }) },
      { kind: "thread", name: "pin", set: () => ({ pinned: true }) },
      { kind: "thread", name: "unpin", set: () => ({ pinned: false }) },
      { kind: "post", name: "hide", set: () => ({ hiddenAt: new Date() }) },
      { kind: "post", name: "unhide", set: () => ({ hiddenAt: null }) },
    ] as const;

    app.put(
      "/admin/forum/threads/:id/status",
      {
        schema: {
          tags: ["admin"],
          summary: "Give an idea (ideias board) the team's status and, optionally, a public answer",
          params: idParams,
          body: z.object({
            status: z.enum(IDEA_STATUSES).nullable(),
            answer: z
              .string()
              .trim()
              .max(1000)
              .nullable()
              .transform((value) => value || null)
              .describe('e.g. "Feito em novembro: já podes filtrar por distrito"'),
          }),
          response: { 200: z.object({ status: z.enum(IDEA_STATUSES).nullable(), answer: z.string().nullable(), answeredAt: z.string().nullable() }), ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const [before] = await db.select().from(forumThreads).where(eq(forumThreads.id, request.params.id));
        if (!before) throw notFound("Thread");
        if (before.board !== IDEAS_BOARD) throw new ApiError(400, "not_an_idea", "Only threads on the ideas board get a status");
        const { status, answer } = request.body;
        // The answer's date moves only when its text changes.
        const answeredAt = answer === null ? null : answer === before.answer ? before.answeredAt : new Date();
        const [after] = await db
          .update(forumThreads)
          .set({ status, answer, answeredAt })
          .where(eq(forumThreads.id, before.id))
          .returning({ status: forumThreads.status, answer: forumThreads.answer, answeredAt: forumThreads.answeredAt });
        await audit(db, me.id, "thread.status", "thread", before.id, { status: before.status, answer: before.answer }, { status, answer });
        return { status: after!.status, answer: after!.answer, answeredAt: after!.answeredAt?.toISOString() ?? null };
      },
    );

    for (const action of actions) {
      app.post(
        `/admin/forum/${action.kind}s/:id/${action.name}`,
        {
          schema: {
            tags: ["admin"],
            summary: `${action.name[0]!.toUpperCase()}${action.name.slice(1)} a forum ${action.kind}`,
            params: idParams,
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) => {
          const me = await requireAdmin(request, "moderator");
          const table = action.kind === "thread" ? forumThreads : forumPosts;
          const updated = await db
            .update(table)
            .set(action.set() as never)
            .where(eq(table.id, request.params.id))
            .returning({ id: table.id });
          if (updated.length === 0) throw notFound(action.kind === "thread" ? "Thread" : "Post");
          await audit(db, me.id, `${action.kind}.${action.name}`, action.kind, request.params.id);
          return reply.status(204).send(null);
        },
      );
    }
  };
