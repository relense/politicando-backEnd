import { type SQL, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { adminGuard, audit } from "../../admin/sessions.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { deleteAccount } from "../accounts/routes.js";
import { errorSchema } from "../shared.js";

/*
 * Reader accounts for administrators (role admin): the list, totals, one reader with what was
 * done to them and everything they did, and suspend / ban / remove content / delete. Opening a
 * reader and every action go into the audit log (entity "reader"). Never sent: password hashes,
 * session tokens, IPs (we don't keep IPs; voters and reporters are keyed hashes).
 */

const MAX_INT = 2_147_483_647;
const idParams = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };
const reasonSchema = z.string().trim().min(3).max(500);
/** An offset into the list, handed out as nextCursor. */
const cursorSchema = z.string().regex(/^\d{1,7}$/, "The cursor is not valid").optional();

export const READER_STATUSES = ["active", "suspended", "banned", "deleted"] as const;
export const ACTIVITY_KINDS = [
  "comment", "forum_thread", "forum_post", "importa", "vote", "follow", "unfollow", "save", "prediction", "report", "feedback", "read",
] as const;
const MODERATION_ACTIONS = ["comment_removed", "post_removed", "suspended", "unsuspended", "banned", "unbanned", "content_removed"] as const;

const countsSchema = z.object({
  comments: z.number(),
  forumPosts: z.number().describe("Threads opened plus replies"),
  importa: z.number().describe("«Importa» on stories and blog posts"),
  follows: z.number(),
  saved: z.number(),
  predictions: z.number(),
  reportsMade: z.number(),
  reportsAgainst: z.number().describe("Reports ever made on their comments and forum posts, open or closed"),
});
const readerSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string().nullable(),
  emailConfirmed: z.boolean(),
  newsletter: z.boolean().describe("Subscribed with their confirmed email"),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable().describe("Their last request while logged in, to the hour"),
  status: z.enum(READER_STATUSES).describe("Deleted accounts are removed, so never `deleted` in practice"),
  suspendedUntil: z.string().nullable(),
  signupFrom: z.string().nullable(),
  counts: countsSchema,
});
const moderationSchema = z.object({
  at: z.string(),
  action: z.enum(MODERATION_ACTIONS),
  by: z.object({ id: z.number(), name: z.string() }).nullable(),
  reason: z.string().nullable(),
  until: z.string().nullable(),
});
const detailSchema = readerSchema.extend({ moderation: z.array(moderationSchema).describe("Newest first, at most 200") });
const targetSchema = z
  .object({
    type: z.enum(["article", "story", "thread", "initiative", "budget_proposal", "editorial"]),
    id: z.number(),
    title: z.string().nullable(),
    year: z.number().optional(),
    board: z.string().optional(),
    slug: z.string().optional(),
  })
  .nullable();
const activitySchema = z.object({
  at: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  text: z.string().nullable(),
  removed: z.boolean(),
  target: targetSchema,
});

interface ReaderRow extends Record<string, unknown> {
  id: number;
  username: string;
  email: string | null;
  email_confirmed: boolean;
  newsletter: boolean;
  created_at: Date | string;
  last_seen_at: Date | string | null;
  status: (typeof READER_STATUSES)[number];
  suspended_until: Date | string | null;
  signup_from: string | null;
  comments: number;
  forum_posts: number;
  importa: number;
  follows: number;
  saved: number;
  predictions: number;
  reports_made: number;
  reports_against: number;
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** Every list field of each reader matching `where`, ordered and paged by the caller. */
const readerRows = (where: SQL, tail: SQL = sql``) => sql`
  select * from (
    select u.id, u.username, u.email, u.email_confirmed_at is not null as email_confirmed, u.created_at, u.last_seen_at,
      u.suspended_until, u.signup_from,
      case when u.disabled_at is not null then 'banned' when u.suspended_until > now() then 'suspended' else 'active' end as status,
      u.email_confirmed_at is not null and exists (
        select 1 from newsletter_subscribers ns where ns.email = u.email and ns.confirmed_at is not null) as newsletter,
      (select count(*)::int from comments c where c.user_id = u.id) as comments,
      (select count(*)::int from forum_threads t where t.user_id = u.id) + (select count(*)::int from forum_posts p where p.user_id = u.id) as forum_posts,
      (select count(*)::int from story_votes v where v.user_id = u.id) + (select count(*)::int from editorial_votes v where v.user_id = u.id) as importa,
      (select count(*)::int from user_follows f where f.user_id = u.id) as follows,
      (select count(*)::int from user_saves s where s.user_id = u.id) as saved,
      (select count(*)::int from predictions pr where pr.user_id = u.id) as predictions,
      (select count(*)::int from reports r where r.user_id = u.id) as reports_made,
      (select count(*)::int from reports r where
        (r.kind = 'comment' and r.target_id in (select id from comments where user_id = u.id)) or
        (r.kind = 'thread' and r.target_id in (select id from forum_threads where user_id = u.id)) or
        (r.kind = 'post' and r.target_id in (select id from forum_posts where user_id = u.id))) as reports_against
    from users u
  ) r where ${where} ${tail}`;

const toReader = (r: ReaderRow): z.infer<typeof readerSchema> => ({
  id: r.id,
  username: r.username,
  email: r.email,
  emailConfirmed: r.email_confirmed,
  newsletter: r.newsletter,
  createdAt: iso(r.created_at)!,
  lastSeenAt: iso(r.last_seen_at),
  status: r.status,
  suspendedUntil: r.status === "suspended" ? iso(r.suspended_until) : null,
  signupFrom: r.signup_from,
  counts: {
    comments: r.comments, forumPosts: r.forum_posts, importa: r.importa, follows: r.follows, saved: r.saved,
    predictions: r.predictions, reportsMade: r.reports_made, reportsAgainst: r.reports_against,
  },
});

const ACTIVE_TOTAL = sql`(r.comments + r.forum_posts + r.importa + r.follows + r.saved + r.predictions + r.reports_made)`;
const ORDER = {
  newest: sql`r.created_at desc, r.id desc`,
  oldest: sql`r.created_at, r.id`,
  last_seen: sql`r.last_seen_at desc nulls last, r.id desc`,
  most_active: sql`${ACTIVE_TOTAL} desc, r.id desc`,
} as const;

/** What was done to the reader: by the admin here, and moderators hiding what they wrote. */
const moderationOf = async (db: Db, id: number) => {
  const key = String(id);
  const rows = await db.execute<{ at: Date | string; action: string; entity: string; after: { reason?: string; until?: string } | null; admin_id: number | null; admin_name: string | null }>(sql`
    select a.at, a.action, a.entity, a.after, ad.id as admin_id, ad.name as admin_name
    from audit_log a left join admins ad on ad.id = a.admin_id
    where (a.entity = 'reader' and a.entity_id = ${key} and a.action <> 'reader.view')
      or (a.entity = 'user' and a.entity_id = ${key} and a.action in ('user.disable', 'user.enable'))
      or (a.entity = 'comment' and a.action in ('comment.hide', 'report.hide')
        and a.entity_id in (select id::text from comments where user_id = ${id}))
      or (a.entity = 'thread' and a.action in ('thread.hide', 'report.hide')
        and a.entity_id in (select id::text from forum_threads where user_id = ${id}))
      or (a.entity = 'post' and a.action in ('post.hide', 'report.hide')
        and a.entity_id in (select id::text from forum_posts where user_id = ${id}))
    order by a.at desc, a.id desc
    limit 200`);
  const named: Record<string, (typeof MODERATION_ACTIONS)[number]> = {
    "reader.suspend": "suspended", "reader.unsuspend": "unsuspended", "reader.ban": "banned", "user.disable": "banned",
    "reader.unban": "unbanned", "user.enable": "unbanned", "reader.remove_content": "content_removed",
  };
  return rows.rows.map((r) => ({
    at: iso(r.at)!,
    action: named[r.action] ?? (r.entity === "comment" ? "comment_removed" : "post_removed"),
    by: r.admin_id !== null && r.admin_name !== null ? { id: r.admin_id, name: r.admin_name } : null,
    reason: typeof r.after?.reason === "string" ? r.after.reason : null,
    until: typeof r.after?.until === "string" ? r.after.until : null,
  }));
};

/** A story's title: its first visible headline. */
const storyTitle = (storyId: SQL) =>
  sql`(select sa.title from articles sa where sa.story_id = ${storyId} and sa.hidden_at is null order by sa.published_at limit 1)`;

/** Where a comment sits: the article, story or blog post it's on. */
const commentTarget = (c: string) => {
  const col = (name: string) => sql.raw(`${c}.${name}`);
  return sql`
    case when ${col("article_id")} is not null then 'article' when ${col("story_id")} is not null then 'story' else 'editorial' end as t_type,
    coalesce(${col("article_id")}, ${col("story_id")}, ${col("editorial_post_id")}) as t_id,
    case when ${col("article_id")} is not null then (select title from articles where id = ${col("article_id")})
      when ${col("story_id")} is not null then ${storyTitle(col("story_id"))}
      else (select title from editorial_posts where id = ${col("editorial_post_id")}) end as t_title,
    null::int as t_year, null::text as t_board,
    case when ${col("article_id")} is null and ${col("story_id")} is null then (select slug from editorial_posts where id = ${col("editorial_post_id")}) end as t_slug`;
};
const threadTarget = (threadId: SQL) => sql`
  'thread' as t_type, ${threadId} as t_id, (select title from forum_threads where id = ${threadId}) as t_title,
  null::int as t_year, (select board from forum_threads where id = ${threadId}) as t_board, null::text as t_slug`;
const simpleTarget = (type: string, id: SQL, title: SQL) => sql`
  ${type}::text as t_type, ${id} as t_id, ${title} as t_title, null::int as t_year, null::text as t_board, null::text as t_slug`;
const editorialTarget = (id: SQL) => sql`
  'editorial' as t_type, ${id} as t_id, (select title from editorial_posts where id = ${id}) as t_title,
  null::int as t_year, null::text as t_board, (select slug from editorial_posts where id = ${id}) as t_slug`;
const noTarget = sql`null::text as t_type, null::int as t_id, null::text as t_title, null::int as t_year, null::text as t_board, null::text as t_slug`;
const short = (text: SQL) => sql`left(${text}, 300)`;

/** Everything the reader did, one row each, as (at, kind, text, removed, t_*). */
const timeline = (id: number) => sql`
  select c.created_at as at, 'comment' as kind, ${short(sql`c.body`)} as text, c.hidden_at is not null as removed, ${commentTarget("c")}
    from comments c where c.user_id = ${id}
  union all
  select t.created_at, 'forum_thread', ${short(sql`t.title || ' — ' || t.body`)}, t.hidden_at is not null, ${threadTarget(sql`t.id`)}
    from forum_threads t where t.user_id = ${id}
  union all
  select p.created_at, 'forum_post', ${short(sql`p.body`)}, p.hidden_at is not null, ${threadTarget(sql`p.thread_id`)}
    from forum_posts p where p.user_id = ${id}
  union all
  select v.created_at, 'importa', null, false, ${simpleTarget("story", sql`v.story_id`, storyTitle(sql`v.story_id`))}
    from story_votes v where v.user_id = ${id}
  union all
  select v.created_at, 'importa', null, false, ${editorialTarget(sql`v.post_id`)}
    from editorial_votes v where v.user_id = ${id}
  union all
  select v.updated_at, 'vote', case when v.value > 0 then 'up' else 'down' end, false,
      ${simpleTarget("article", sql`v.article_id`, sql`(select title from articles where id = v.article_id)`)}
    from article_votes v where v.user_id = ${id}
  union all
  select f.created_at, 'follow', null, false,
      case f.kind when 'story' then 'story' when 'thread' then 'thread' else 'budget_proposal' end,
      f.target_id,
      case f.kind when 'story' then ${storyTitle(sql`f.target_id`)}
        when 'thread' then (select title from forum_threads where id = f.target_id)
        else (select title from budget_proposals where id = f.target_id) end,
      case when f.kind = 'budget_proposal' then (select year from budget_proposals where id = f.target_id) end,
      case when f.kind = 'thread' then (select board from forum_threads where id = f.target_id) end,
      null
    from user_follows f where f.user_id = ${id}
  union all
  select s.created_at, 'save', null, false,
      case s.kind when 'article' then 'article' when 'story' then 'story' when 'editorial' then 'editorial'
        when 'thread' then 'thread' when 'reply' then 'thread'
        else (select case when c.article_id is not null then 'article' when c.story_id is not null then 'story' else 'editorial' end from comments c where c.id = s.target_id) end,
      case s.kind when 'reply' then (select thread_id from forum_posts where id = s.target_id)
        when 'comment' then (select coalesce(c.article_id, c.story_id, c.editorial_post_id) from comments c where c.id = s.target_id)
        else s.target_id end,
      case s.kind when 'article' then (select title from articles where id = s.target_id)
        when 'story' then ${storyTitle(sql`s.target_id`)}
        when 'editorial' then (select title from editorial_posts where id = s.target_id)
        when 'thread' then (select title from forum_threads where id = s.target_id)
        when 'reply' then (select t.title from forum_posts p join forum_threads t on t.id = p.thread_id where p.id = s.target_id)
        else null end,
      null,
      case s.kind when 'thread' then (select board from forum_threads where id = s.target_id)
        when 'reply' then (select t.board from forum_posts p join forum_threads t on t.id = p.thread_id where p.id = s.target_id) end,
      case when s.kind = 'editorial' then (select slug from editorial_posts where id = s.target_id) end
    from user_saves s where s.user_id = ${id}
  union all
  select pr.updated_at, 'prediction', pr.pick, false,
      ${simpleTarget("initiative", sql`pr.initiative_id`, sql`(select title from initiatives where id = pr.initiative_id)`)}
    from predictions pr where pr.user_id = ${id}
  union all
  select r.created_at, 'report', r.reason, false,
      case r.kind when 'article' then 'article' when 'thread' then 'thread' when 'post' then 'thread'
        else (select case when c.article_id is not null then 'article' when c.story_id is not null then 'story' else 'editorial' end from comments c where c.id = r.target_id) end,
      case r.kind when 'post' then (select thread_id from forum_posts where id = r.target_id)
        when 'comment' then (select coalesce(c.article_id, c.story_id, c.editorial_post_id) from comments c where c.id = r.target_id)
        else r.target_id end,
      case r.kind when 'article' then (select title from articles where id = r.target_id)
        when 'thread' then (select title from forum_threads where id = r.target_id)
        when 'post' then (select t.title from forum_posts p join forum_threads t on t.id = p.thread_id where p.id = r.target_id)
        else null end,
      null,
      case r.kind when 'thread' then (select board from forum_threads where id = r.target_id)
        when 'post' then (select t.board from forum_posts p join forum_threads t on t.id = p.thread_id where p.id = r.target_id) end,
      null
    from reports r where r.user_id = ${id}
  union all
  select fb.created_at, 'feedback', ${short(sql`fb.message`)}, false, ${noTarget}
    from feedback_messages fb where fb.user_id = ${id}
  union all
  select ur.created_at, 'read', null, false, ${simpleTarget("story", sql`ur.story_id`, storyTitle(sql`ur.story_id`))}
    from user_reads ur where ur.user_id = ${id}`;

interface ActivityRow extends Record<string, unknown> {
  at: Date | string;
  kind: (typeof ACTIVITY_KINDS)[number];
  text: string | null;
  removed: boolean;
  t_type: NonNullable<z.infer<typeof targetSchema>>["type"] | null;
  t_id: number | null;
  t_title: string | null;
  t_year: number | null;
  t_board: string | null;
  t_slug: string | null;
}

const ACTIVITY_PAGE = 50;

export const adminReaderRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    const readerById = async (id: number) => {
      const [row] = (await db.execute<ReaderRow>(readerRows(sql`r.id = ${id}`))).rows;
      if (!row) throw notFound("Reader");
      return toReader(row);
    };
    const detail = async (id: number) => ({ ...(await readerById(id)), moderation: await moderationOf(db, id) });

    app.get(
      "/admin/readers",
      {
        schema: {
          tags: ["admin"],
          summary: "Reader accounts, with what they did (admins)",
          querystring: z.object({
            q: z.string().trim().max(100).optional().describe("Part of the username or email, any case"),
            email: z.enum(["confirmed", "unconfirmed", "none"]).optional(),
            status: z.enum(READER_STATUSES).optional(),
            active: z.enum(["7", "30"]).optional().describe("Seen in the last 7 or 30 days"),
            sort: z.enum(["newest", "oldest", "last_seen", "most_active"]).default("newest"),
            cursor: cursorSchema,
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: z.object({ items: z.array(readerSchema), nextCursor: z.string().nullable(), total: z.number() }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "admin");
        const { q, email, status, active, sort, limit } = request.query;
        const offset = Number(request.query.cursor ?? 0);
        const like = q ? `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
        const filters = [
          like ? sql`(lower(r.username) like ${like} or r.email like ${like})` : null,
          email === "confirmed" ? sql`r.email_confirmed` : email === "unconfirmed" ? sql`r.email is not null and not r.email_confirmed` : email === "none" ? sql`r.email is null` : null,
          status ? sql`r.status = ${status}` : null,
          active ? sql`r.last_seen_at >= now() - make_interval(days => ${Number(active)})` : null,
        ].filter((f): f is SQL => f !== null);
        const where = filters.length ? sql.join(filters, sql` and `) : sql`true`;
        const [rows, [count]] = await Promise.all([
          db.execute<ReaderRow>(readerRows(where, sql`order by ${ORDER[sort]} limit ${limit + 1} offset ${offset}`)),
          db.execute<{ total: number }>(sql`select count(*)::int as total from (${readerRows(where)}) x`).then((r) => r.rows),
        ]);
        return {
          items: rows.rows.slice(0, limit).map(toReader),
          nextCursor: rows.rows.length > limit ? String(offset + limit) : null,
          total: count?.total ?? 0,
        };
      },
    );

    app.get(
      "/admin/readers/stats",
      {
        schema: {
          tags: ["admin"],
          summary: "Reader totals and sign-ups per day for the last 30 days (admins)",
          description: "Days are Lisbon days. `newThisWeek` is the last 7 days, today included.",
          response: {
            200: z.object({
              total: z.number(), newToday: z.number(), newThisWeek: z.number(), active7d: z.number(), active30d: z.number(),
              withEmail: z.number(), emailConfirmed: z.number(), suspended: z.number(), banned: z.number(),
              signupsByDay: z.array(z.object({ date: z.string(), count: z.number() })).describe("Oldest first, zero days included"),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await requireAdmin(request, "admin");
        const today = sql`(now() at time zone 'Europe/Lisbon')::date`;
        const day = sql`(created_at at time zone 'Europe/Lisbon')::date`;
        const [totals] = (
          await db.execute<Record<string, number>>(sql`
            select count(*)::int as total,
              count(*) filter (where ${day} = ${today})::int as "newToday",
              count(*) filter (where ${day} > ${today} - 7)::int as "newThisWeek",
              count(*) filter (where last_seen_at >= now() - interval '7 days')::int as "active7d",
              count(*) filter (where last_seen_at >= now() - interval '30 days')::int as "active30d",
              count(*) filter (where email is not null)::int as "withEmail",
              count(*) filter (where email_confirmed_at is not null)::int as "emailConfirmed",
              count(*) filter (where disabled_at is null and suspended_until > now())::int as suspended,
              count(*) filter (where disabled_at is not null)::int as banned
            from users`)
        ).rows;
        const days = await db.execute<{ date: string; count: number }>(sql`
          select d::date::text as date, (select count(*)::int from users where ${day} = d::date) as count
          from generate_series(${today} - 29, ${today}, interval '1 day') d
          order by d`);
        return {
          total: totals!.total!, newToday: totals!.newToday!, newThisWeek: totals!.newThisWeek!, active7d: totals!.active7d!,
          active30d: totals!.active30d!, withEmail: totals!.withEmail!, emailConfirmed: totals!.emailConfirmed!,
          suspended: totals!.suspended!, banned: totals!.banned!, signupsByDay: days.rows,
        };
      },
    );

    app.get(
      "/admin/readers/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "One reader, and what was done to them (admins; audited as reader.view)",
          params: idParams,
          response: { 200: detailSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "admin");
        const reader = await detail(request.params.id);
        await audit(db, me.id, "reader.view", "reader", reader.id);
        return reader;
      },
    );

    app.get(
      "/admin/readers/:id/activity",
      {
        schema: {
          tags: ["admin"],
          summary: "Everything the reader did, newest first, 50 a page (admins)",
          description:
            "Unfollows aren't kept, so `unfollow` never appears. `read` is a story ticked as read («Hoje em 5»). Removed items show with `removed: true`.",
          params: idParams,
          querystring: z.object({
            kind: z
              .string()
              .max(200)
              .optional()
              .transform((v, ctx) => {
                if (v === undefined) return undefined;
                const kinds = v.split(",").map((k) => k.trim()).filter(Boolean);
                const bad = kinds.find((k) => !(ACTIVITY_KINDS as readonly string[]).includes(k));
                if (bad) {
                  ctx.addIssue({ code: "custom", message: `Unknown kind: ${bad}` });
                  return z.NEVER;
                }
                return kinds;
              })
              .describe("Comma list of kinds"),
            cursor: cursorSchema,
          }),
          response: { 200: z.object({ items: z.array(activitySchema), nextCursor: z.string().nullable() }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "admin");
        const { id } = request.params;
        const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
        if (!exists) throw notFound("Reader");
        const offset = Number(request.query.cursor ?? 0);
        const kinds = request.query.kind;
        const rows = (
          await db.execute<ActivityRow>(sql`
            select * from (${timeline(id)}) a
            where ${kinds?.length ? sql`a.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql`true`}
            order by a.at desc, a.kind, a.t_id
            limit ${ACTIVITY_PAGE + 1} offset ${offset}`)
        ).rows;
        return {
          items: rows.slice(0, ACTIVITY_PAGE).map((r) => ({
            at: iso(r.at)!,
            kind: r.kind,
            text: r.text,
            removed: r.removed,
            target:
              r.t_type && r.t_id !== null
                ? {
                    type: r.t_type, id: r.t_id, title: r.t_title,
                    ...(r.t_year !== null && { year: r.t_year }),
                    ...(r.t_board !== null && { board: r.t_board }),
                    ...(r.t_slug !== null && { slug: r.t_slug }),
                  }
                : null,
          })),
          nextCursor: rows.length > ACTIVITY_PAGE ? String(offset + ACTIVITY_PAGE) : null,
        };
      },
    );

    // Actions: each needs a reason, is audited, and returns the reader as GET /admin/readers/:id does.

    const act = async (adminId: number, id: number, action: string, set: Partial<typeof users.$inferInsert> | null, after: Record<string, unknown>) => {
      if (set) {
        const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning({ id: users.id });
        if (!row) throw notFound("Reader");
      } else {
        await readerById(id);
      }
      await audit(db, adminId, `reader.${action}`, "reader", id, null, after);
      return detail(id);
    };

    app.post(
      "/admin/readers/:id/suspend",
      {
        schema: {
          tags: ["admin"],
          summary: "Suspend a reader until a date: they can't log in or take part meanwhile (admins)",
          params: idParams,
          body: z.strictObject({ until: z.iso.datetime({ offset: true }), reason: reasonSchema }),
          response: { 200: detailSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "admin");
        const until = new Date(request.body.until);
        if (until.getTime() <= Date.now()) throw new ApiError(400, "invalid_request", "`until` must be in the future");
        return act(me.id, request.params.id, "suspend", { suspendedUntil: until }, { reason: request.body.reason, until: until.toISOString() });
      },
    );

    const simple = [
      { path: "unsuspend", summary: "Lift a suspension (admins)", set: { suspendedUntil: null } },
      { path: "ban", summary: "Ban a reader: they can't log in or take part (admins)", set: null },
      { path: "unban", summary: "Lift a ban (admins)", set: { disabledAt: null } },
    ] as const;
    for (const { path, summary, set } of simple) {
      app.post(
        `/admin/readers/:id/${path}`,
        {
          schema: { tags: ["admin"], summary, params: idParams, body: z.strictObject({ reason: reasonSchema }), response: { 200: detailSchema, ...errors } },
        },
        async (request) => {
          const me = await requireAdmin(request, "admin");
          // A ban keeps the first ban's date when banned again.
          const change = path === "ban" ? { disabledAt: sql`coalesce(${users.disabledAt}, now())` } : set;
          return act(me.id, request.params.id, path, change as Partial<typeof users.$inferInsert>, { reason: request.body.reason });
        },
      );
    }

    app.post(
      "/admin/readers/:id/remove-content",
      {
        schema: {
          tags: ["admin"],
          summary: "Hide every comment, thread and forum reply the reader wrote, as a moderator removal does (admins)",
          description: "Open reports on them are closed as hidden. `removed` is how many were hidden now.",
          params: idParams,
          body: z.strictObject({ reason: reasonSchema }),
          response: { 200: detailSchema.extend({ removed: z.number() }), ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "admin");
        const { id } = request.params;
        await readerById(id);
        const removed = await db.transaction(async (tx) => {
          const hidden = (
            await tx.execute<{ kind: string; id: number }>(sql`
              with c as (update comments set hidden_at = now() where user_id = ${id} and hidden_at is null returning 'comment' as kind, id),
                t as (update forum_threads set hidden_at = now() where user_id = ${id} and hidden_at is null returning 'thread' as kind, id),
                p as (update forum_posts set hidden_at = now() where user_id = ${id} and hidden_at is null returning 'post' as kind, id)
              select * from c union all select * from t union all select * from p`)
          ).rows;
          for (const kind of ["comment", "thread", "post"]) {
            const ids = hidden.filter((h) => h.kind === kind).map((h) => h.id);
            if (!ids.length) continue;
            await tx.execute(sql`
              update reports set resolved_at = now(), resolved_by = ${me.id}, resolution = 'hidden'
              where kind = ${kind} and resolved_at is null and target_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
          }
          return hidden.length;
        });
        const reader = await act(me.id, id, "remove_content", null, { reason: request.body.reason, removed });
        return { ...reader, removed };
      },
    );

    app.delete(
      "/admin/readers/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Delete the account as DELETE /me does: votes come off, comments and replies go, threads are blanked (admins)",
          params: idParams,
          body: z.strictObject({ reason: reasonSchema }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "admin");
        const { id } = request.params;
        const reader = await readerById(id);
        await deleteAccount(db, id);
        // Only the username is kept, so the audit can say who it was; nothing else about them.
        await audit(db, me.id, "reader.delete", "reader", id, { username: reader.username }, { reason: request.body.reason });
        return reply.status(204).send(null);
      },
    );
  };
