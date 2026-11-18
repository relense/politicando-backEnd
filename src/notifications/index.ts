import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type NotificationKind, notifications, userFollows } from "../db/schema.js";

/*
 * A reader's private inbox and what they follow. Everything else only calls notify() and
 * follow(): this module owns its tables, so it can become its own service later (notify()
 * turning into a queue message) without touching the callers. Nothing here is public.
 */

/** Anything that can run queries: the db or a transaction. */
type Runner = Pick<Db, "insert" | "select" | "delete" | "update" | "execute">;

export type FollowKind = "story" | "thread";
/** Follows kept per kind; past it, the oldest go. */
export const FOLLOW_CAP = 200;
/** Read or not, notifications older than this are deleted. */
export const KEEP_DAYS = 90;

/**
 * Tells these readers about something. An unread notification for the same thing is bumped
 * (count + 1, newest actor, back on top) instead of repeated, so a busy thread is one line.
 */
export const notify = async (db: Runner, input: { userIds: Iterable<number>; kind: NotificationKind; targetId: number; actorName?: string | null }) => {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  await db
    .insert(notifications)
    .values(userIds.map((userId) => ({ userId, kind: input.kind, targetId: input.targetId, actorName: input.actorName ?? null })))
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.kind, notifications.targetId],
      targetWhere: sql`read_at is null`,
      set: { count: sql`${notifications.count} + 1`, actorName: sql`excluded.actor_name`, createdAt: sql`now()` },
    });
};

/** Runs notify() without ever failing the caller: a lost notification beats a lost reply. */
export const notifySafely = async (db: Runner, log: { error: (obj: unknown, msg: string) => void }, input: Parameters<typeof notify>[1]) => {
  try {
    await notify(db, input);
  } catch (error) {
    log.error(error, "notification failed");
  }
};

export const follow = async (db: Runner, userId: number, kind: FollowKind, targetId: number) => {
  await db.insert(userFollows).values({ userId, kind, targetId }).onConflictDoNothing();
  await db.execute(sql`
    delete from user_follows where user_id = ${userId} and kind = ${kind} and (target_id, created_at) in (
      select target_id, created_at from user_follows where user_id = ${userId} and kind = ${kind}
      order by created_at desc offset ${FOLLOW_CAP})`);
};

export const unfollow = (db: Runner, userId: number, kind: FollowKind, targetId: number) =>
  db.delete(userFollows).where(and(eq(userFollows.userId, userId), eq(userFollows.kind, kind), eq(userFollows.targetId, targetId)));

export const followers = async (db: Runner, kind: FollowKind, targetId: number) =>
  (await db.select({ userId: userFollows.userId }).from(userFollows).where(and(eq(userFollows.kind, kind), eq(userFollows.targetId, targetId)))).map(
    (r) => r.userId,
  );

export const followsOf = async (db: Runner, userId: number) => {
  const rows = await db
    .select({ kind: userFollows.kind, id: userFollows.targetId })
    .from(userFollows)
    .where(eq(userFollows.userId, userId))
    .orderBy(sql`${userFollows.createdAt} desc`);
  return { stories: rows.filter((r) => r.kind === "story").map((r) => r.id), threads: rows.filter((r) => r.kind === "thread").map((r) => r.id) };
};

/**
 * Still worth showing: what it points to hasn't been hidden or deleted since. Checked when
 * reading (things get hidden in many places: moderators, reports, deleted accounts).
 */
const stillThereIn = (table: string) => {
  const kind = sql.raw(`${table}.kind`);
  const target = sql.raw(`${table}.target_id`);
  return sql`(case ${kind}
  when 'comment_reply' then exists (select 1 from comments c0 where c0.id = ${target} and c0.hidden_at is null)
  when 'forum_reply' then exists (select 1 from forum_posts p0 join forum_threads t0 on t0.id = p0.thread_id
    where p0.id = ${target} and p0.hidden_at is null and t0.hidden_at is null)
  when 'thread_update' then exists (select 1 from forum_threads t0 where t0.id = ${target} and t0.hidden_at is null)
  when 'story_update' then exists (select 1 from articles a0 where a0.story_id = ${target} and a0.hidden_at is null)
  else true end)`;
};

export const unreadCount = async (db: Runner, userId: number) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), stillThereIn("notifications")));
  return row?.count ?? 0;
};

export const markRead = (db: Runner, userId: number, ids?: number[]) =>
  db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));

export const PAGE_SIZE = 30;

interface InboxRow extends Record<string, unknown> {
  id: number;
  kind: NotificationKind;
  target_id: number;
  actor_name: string | null;
  count: number;
  created_at: Date | string;
  read_at: Date | string | null;
  // What it points to, by kind (see the joins below).
  snippet: string | null;
  article_id: number | null;
  story_id: number | null;
  post_slug: string | null;
  comment_id: number | null;
  thread_id: number | null;
  thread_title: string | null;
  board: string | null;
  headline: string | null;
  initiative_title: string | null;
  pick: string | null;
  outcome: string | null;
  vote_result: string | null;
}

/** One page of the inbox, newest first, with what the site needs to show and link each line. */
export const inbox = async (db: Runner, userId: number, cursor?: string) => {
  const [at, id] = cursor?.split("_") ?? [];
  const after = at && id && !Number.isNaN(Date.parse(at)) && /^\d+$/.test(id) ? sql`and (n.created_at, n.id) < (${at}::timestamptz, ${Number(id)})` : sql``;
  const rows = (
    await db.execute<InboxRow>(sql`
      select n.id, n.kind, n.target_id, n.actor_name, n.count, n.created_at, n.read_at,
        coalesce(c.body, fp.body) as snippet,
        c.article_id, coalesce(c.story_id, case when n.kind = 'story_update' then n.target_id end) as story_id,
        ep.slug as post_slug, c.id as comment_id,
        coalesce(fp.thread_id, ft.id) as thread_id, coalesce(fpt.title, ft.title) as thread_title, coalesce(fpt.board, ft.board) as board,
        (select a.title from articles a where n.kind = 'story_update' and a.story_id = n.target_id and a.hidden_at is null
          order by a.published_at desc limit 1) as headline,
        i.title as initiative_title, pr.pick, pr.outcome, pr.vote_result
      from notifications n
      left join comments c on n.kind = 'comment_reply' and c.id = n.target_id
      left join editorial_posts ep on ep.id = c.editorial_post_id
      left join forum_posts fp on n.kind = 'forum_reply' and fp.id = n.target_id
      left join forum_threads fpt on fpt.id = fp.thread_id
      left join forum_threads ft on n.kind = 'thread_update' and ft.id = n.target_id
      left join initiatives i on n.kind = 'prediction_result' and i.id = n.target_id
      left join predictions pr on n.kind = 'prediction_result' and pr.initiative_id = n.target_id and pr.user_id = n.user_id
      where n.user_id = ${userId} and ${stillThereIn("n")} ${after}
      order by n.created_at desc, n.id desc
      limit ${PAGE_SIZE + 1}`)
  ).rows;
  const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
  const page = rows.slice(0, PAGE_SIZE);
  return {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      actorName: r.actor_name,
      count: r.count,
      createdAt: iso(r.created_at)!,
      read: r.read_at !== null,
      snippet: r.snippet ? (r.snippet.length > 200 ? `${r.snippet.slice(0, 199)}…` : r.snippet) : null,
      link: {
        commentId: r.comment_id,
        articleId: r.article_id,
        storyId: r.story_id,
        postSlug: r.post_slug,
        threadId: r.thread_id,
        postId: r.kind === "forum_reply" ? r.target_id : null,
        initiativeId: r.kind === "prediction_result" ? r.target_id : null,
      },
      threadTitle: r.thread_title,
      board: r.board,
      headline: r.headline,
      prediction:
        r.kind === "prediction_result" && r.pick
          ? { initiativeTitle: r.initiative_title ?? "", pick: r.pick as "pass" | "fail", outcome: r.outcome as "hit" | "miss" | "void" | null, result: r.vote_result }
          : null,
    })),
    nextCursor: rows.length > PAGE_SIZE ? `${iso(page.at(-1)!.created_at)}_${page.at(-1)!.id}` : null,
  };
};

/** Deletes old notifications (run by the hourly ingest). */
export const pruneNotifications = async (db: Runner) => {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3_600_000);
  const gone = await db.delete(notifications).where(lt(notifications.createdAt, cutoff)).returning({ id: notifications.id });
  return gone.length;
};
