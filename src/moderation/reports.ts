import { and, eq, isNull, or, sql } from "drizzle-orm";
import { audit } from "../admin/sessions.js";
import type { Db } from "../db/client.js";
import { articles, comments, forumPosts, forumThreads, reports } from "../db/schema.js";

/*
 * Moderation without anyone watching the queue: when enough different readers report the
 * same item, it's hidden on its own. A moderator (or `npm run moderation -- restore`) can
 * bring it back, and an item that was brought back needs twice as many reports next time,
 * so a group can't keep hiding something that was found fine.
 */

export type ReportKind = "thread" | "post" | "comment" | "article";

/** Different readers whose reports hide an item. */
export const HIDE_AFTER = 3;
/** Fewer when they report something illegal or harmful whoever reads it. */
export const HIDE_AFTER_SEVERE = 2;
const SEVERE = ["hate", "personal_data", "illegal"];
/** News articles are hidden only for these; "wrong_tags" is our mistake to fix, not a reason to hide. */
const ARTICLE_HIDE_REASONS = ["duplicate", "not_politics", "broken_link"];

export const tableOf = (kind: ReportKind) =>
  kind === "thread" ? forumThreads : kind === "post" ? forumPosts : kind === "article" ? articles : comments;

/** Hides the item if its open reports reach the limit. Returns whether it was hidden now. */
export const autoModerate = async (db: Db, kind: ReportKind, targetId: number): Promise<boolean> => {
  const [counts] = (
    await db.execute<{ open: number; severe: number; eligible: number; restored: boolean }>(sql`
      select
        count(*) filter (where resolved_at is null)::int as open,
        count(*) filter (where resolved_at is null and reason in (${sql.join(SEVERE.map((r) => sql`${r}`), sql`, `)}))::int as severe,
        count(*) filter (where resolved_at is null and reason in (${sql.join(ARTICLE_HIDE_REASONS.map((r) => sql`${r}`), sql`, `)}))::int as eligible,
        bool_or(resolution = 'dismissed') as restored
      from reports where kind = ${kind} and target_id = ${targetId}`)
  ).rows;
  if (!counts) return false;
  const factor = counts.restored ? 2 : 1;
  const reached =
    kind === "article"
      ? counts.eligible >= HIDE_AFTER * factor
      : counts.open >= HIDE_AFTER * factor || counts.severe >= HIDE_AFTER_SEVERE * factor;
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
