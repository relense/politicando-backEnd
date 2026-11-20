import { and, eq, isNull, sql } from "drizzle-orm";
import { lisbonDay } from "../agenda/time.js";
import type { Db } from "../db/client.js";
import { type VoteRecord, predictions } from "../db/schema.js";
import { notifySafely } from "../notifications/index.js";
import { DECIDING_VOTES } from "../parliament/parse.js";
import { STAGE_GROUP_SQL } from "../parliament/plain.js";

/*
 * "Passa ou chumba?": readers guess whether an initiative passes its next deciding vote. A vote
 * opens only when it's on a plenary agenda within the week (src/predictions/rounds.ts) and
 * closes when that session starts, so nobody "predicts" a result already known. Private: no
 * leaderboard, no profile.
 */

/** Initiatives still waiting for a deciding vote (the SQL works on the `initiatives` table, unaliased). */
export const OPEN_FOR_PREDICTION = sql.raw(`${STAGE_GROUP_SQL} in ('submitted', 'debate')`);
/** Open right now: waiting for a vote, and on the agenda with the session not started yet. */
export const PREDICTABLE_NOW = sql`initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}
  and exists (select 1 from vote_rounds r where r.initiative_id = initiatives.id and r.opens_at <= now() and r.closes_at > now())`;

export type Outcome = "hit" | "miss" | "void";

/**
 * How one prediction ends, or null while it's still pending: the first deciding vote on or
 * after the day of the reader's last change settles it (picks lock when the session starts).
 */
export const settle = (
  prediction: { pick: "pass" | "fail"; updatedAt: Date },
  initiative: { votes: VoteRecord[]; open: boolean },
): { outcome: Outcome; voteDate: string | null; voteResult: string | null; vote: VoteRecord | null } | null => {
  const from = lisbonDay(prediction.updatedAt);
  const vote = initiative.votes
    .filter((v) => DECIDING_VOTES.has(v.phase) && v.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (vote) {
    if (vote.result === "Aprovado" || vote.result === "Rejeitado") {
      const passed = vote.result === "Aprovado";
      return { outcome: passed === (prediction.pick === "pass") ? "hit" : "miss", voteDate: vote.date, voteResult: vote.result, vote };
    }
    // "Prejudicado": the vote fell through, nothing to score.
    return { outcome: "void", voteDate: vote.date, voteResult: vote.result, vote };
  }
  // Decided some other way (withdrawn, not admitted, or by a vote before the prediction).
  return initiative.open ? null : { outcome: "void", voteDate: null, voteResult: null, vote: null };
};

/**
 * Which vote comes next, by rule: the final one once approved na generalidade; na generalidade
 * for bills; a single vote for everything else (resolutions, deliberations…). A best reading:
 * parliament doesn't say in advance which vote a session holds.
 */
export const nextVoteLabel = (type: string, votes: VoteRecord[]) => {
  if (votes.some((v) => v.phase === "Votação na generalidade" && v.result === "Aprovado")) return "votação final global";
  if (/^(Projeto|Proposta) de Lei/i.test(type)) return "votação na generalidade";
  return "votação";
};

/** Settles what the latest parliament sync decided and tells each reader. Run after the sync. */
export const resolvePredictions = async (db: Db, log: { error: (obj: unknown, msg: string) => void } = { error: (obj, msg) => console.error(msg, obj) }) => {
  const pending = (
    await db.execute<{ user_id: number; initiative_id: number; pick: "pass" | "fail"; updated_at: Date | string; votes: VoteRecord[]; open: boolean }>(sql`
      select p.user_id, p.initiative_id, p.pick, p.updated_at, initiatives.votes, ${OPEN_FOR_PREDICTION} as open
      from predictions p join initiatives on initiatives.id = p.initiative_id
      where p.outcome is null`)
  ).rows;
  const counts = { hit: 0, miss: 0, void: 0 };
  for (const row of pending) {
    const result = settle({ pick: row.pick, updatedAt: new Date(row.updated_at) }, { votes: row.votes, open: row.open });
    if (!result) continue;
    const [updated] = await db
      .update(predictions)
      .set({ outcome: result.outcome, voteDate: result.voteDate, voteResult: result.voteResult, resolvedAt: new Date() })
      .where(and(eq(predictions.userId, row.user_id), eq(predictions.initiativeId, row.initiative_id), isNull(predictions.outcome)))
      .returning({ userId: predictions.userId });
    if (!updated) continue;
    counts[result.outcome]++;
    // Best effort: the prediction is settled either way, and the rest of the run goes on.
    if (result.outcome !== "void") await notifySafely(db, log, { userIds: [row.user_id], kind: "prediction_result", targetId: row.initiative_id });
  }
  return counts;
};

/** The reader's private record: hits, misses, still pending, and the current run of hits. */
export const record = (rows: { outcome: Outcome | null; resolvedAt: Date | null }[]) => {
  const settled = rows.filter((r) => r.outcome === "hit" || r.outcome === "miss").sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime());
  let streak = 0;
  for (const r of settled) {
    if (r.outcome !== "hit") break;
    streak++;
  }
  return {
    hits: settled.filter((r) => r.outcome === "hit").length,
    misses: settled.filter((r) => r.outcome === "miss").length,
    pending: rows.filter((r) => r.outcome === null).length,
    streak,
  };
};
