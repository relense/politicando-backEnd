import { sql } from "drizzle-orm";
import { loadIngestConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { restore, type ReportKind } from "../moderation/reports.js";

/*
 * Moderation from the terminal, until there's an admin screen:
 *   npm run moderation                      what was hidden automatically and what's reported (last 14 days)
 *   npm run moderation -- restore comment 42   show it again (its reports are dismissed)
 */

const KINDS = ["thread", "post", "comment", "article"] as const;
const { db, pool } = createDb(loadIngestConfig().DATABASE_URL);
const [command, kind, id] = process.argv.slice(2);

const textOf = sql`
  case r.kind
    when 'comment' then (select body from comments where id = r.target_id)
    when 'post' then (select body from forum_posts where id = r.target_id)
    when 'thread' then (select title || ' — ' || body from forum_threads where id = r.target_id)
    when 'article' then (select title || ' — ' || url from articles where id = r.target_id)
  end`;

try {
  if (command === "restore") {
    const targetId = Number(id);
    if (!KINDS.includes(kind as ReportKind) || !Number.isInteger(targetId)) {
      throw new Error(`Usage: npm run moderation -- restore <${KINDS.join("|")}> <id>`);
    }
    console.log((await restore(db, kind as ReportKind, targetId)) ? `Restored ${kind} ${targetId}` : `No ${kind} ${targetId}`);
  } else {
    const rows = await db.execute<{ kind: string; target_id: number; state: string; reports: number; reasons: string[]; last: string; text: string | null }>(sql`
      select r.kind, r.target_id,
        case when bool_or(r.resolved_at is null) then 'open' else max(r.resolution) end as state,
        count(*)::int as reports, array_agg(distinct r.reason) as reasons,
        to_char(max(r.created_at) at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') as last,
        ${textOf} as text
      from reports r where r.created_at >= now() - interval '14 days'
      group by r.kind, r.target_id order by max(r.created_at) desc`);
    if (rows.rows.length === 0) console.log("No reports in the last 14 days.");
    for (const r of rows.rows) {
      const text = (r.text ?? "(deleted)").replace(/\s+/g, " ").slice(0, 160);
      console.log(`[${r.state}] ${r.kind} ${r.target_id} · ${r.reports} report(s): ${r.reasons.join(", ")} · ${r.last}\n    ${text}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
