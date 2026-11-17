import { and, eq, isNull, or, sql } from "drizzle-orm";
import { audit } from "../admin/sessions.js";
import type { Db } from "../db/client.js";
import { articles, comments, forumPosts, forumThreads, reports } from "../db/schema.js";

/*
 * Moderation without anyone watching the queue, 4chan style: rudeness stays up, so reports of
 * "insult" or "other" only go to the queue. What's hidden on its own is what's illegal
 * (hate, personal data, anything else illegal) and spam, once enough different readers say
 * so. A moderator (or `npm run moderation -- restore`) can bring it back, and an item that
 * was brought back needs twice as many reports next time, so a group can't keep hiding
 * something that was found fine.
 */

export type ReportKind = "thread" | "post" | "comment" | "article";

/** Illegal content: 2 different readers saying so (in any mix of these reasons) hide it. */
const ILLEGAL = ["hate", "personal_data", "illegal"];
export const HIDE_AFTER_ILLEGAL = 2;
/** Spam: 3 readers. "insult" and "other" never hide anything. */
export const HIDE_AFTER_SPAM = 3;
/** News articles that aren't news we should list; "wrong_tags" is our mistake to fix, not a reason to hide. */
const ARTICLE_REASONS = ["duplicate", "not_politics", "broken_link"];
export const HIDE_AFTER_ARTICLE = 3;

export const tableOf = (kind: ReportKind) =>
  kind === "thread" ? forumThreads : kind === "post" ? forumPosts : kind === "article" ? articles : comments;

/** Hides the item if its open reports reach the limit. Returns whether it was hidden now. */
export const autoModerate = async (db: Db, kind: ReportKind, targetId: number): Promise<boolean> => {
  const rows = (
    await db.execute<{ reason: string; resolution: string | null; open: number }>(sql`
      select reason, resolution, count(*) filter (where resolved_at is null)::int as open
      from reports where kind = ${kind} and target_id = ${targetId} group by reason, resolution`)
  ).rows;
  if (rows.length === 0) return false;
  const factor = rows.some((r) => r.resolution === "dismissed") ? 2 : 1;
  const open = (reasons: string[]) => rows.filter((r) => reasons.includes(r.reason)).reduce((n, r) => n + r.open, 0);
  const reached =
    kind === "article"
      ? open(ARTICLE_REASONS) >= HIDE_AFTER_ARTICLE * factor
      : open(ILLEGAL) >= HIDE_AFTER_ILLEGAL * factor || open(["spam"]) >= HIDE_AFTER_SPAM * factor;
  if (!reached) return false;

  const table = tableOf(kind);
  const hidden = await db
    .update(table)
    .set({ hiddenAt: new Date() })
    .where(and(eq(table.id, targetId), isNull(table.hiddenAt)))
    .returning({ id: table.id });
  if (hidden.length === 0) return false;
  const resolved = await db
    .update(reports)
    .set({ resolvedAt: new Date(), resolution: "hidden" })
    .where(and(eq(reports.kind, kind), eq(reports.targetId, targetId), isNull(reports.resolvedAt)))
    .returning({ reason: reports.reason });
  await audit(db, null, "report.auto_hide", kind, targetId, null, { reports: resolved.length, reasons: [...new Set(resolved.map((r) => r.reason))] });
  return true;
};

/** Closes an item's reports as dismissed: it was judged fine, so the higher limit applies from now on. */
export const dismissReports = (db: Db, kind: ReportKind, targetId: number, adminId: number | null = null) =>
  db
    .update(reports)
    .set({ resolution: "dismissed", resolvedAt: new Date(), resolvedBy: adminId })
    .where(and(eq(reports.kind, kind), eq(reports.targetId, targetId), or(isNull(reports.resolvedAt), eq(reports.resolution, "hidden"))));

/** Shows a hidden item again and dismisses its reports. */
export const restore = async (db: Db, kind: ReportKind, targetId: number, adminId: number | null = null) => {
  const table = tableOf(kind);
  const updated = await db.update(table).set({ hiddenAt: null }).where(eq(table.id, targetId)).returning({ id: table.id });
  if (updated.length === 0) return false;
  await dismissReports(db, kind, targetId, adminId);
  await audit(db, adminId, "report.restore", kind, targetId);
  return true;
};
