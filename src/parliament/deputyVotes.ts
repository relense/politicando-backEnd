import type { VoteRecord } from "../db/schema.js";

/*
 * The Assembleia votes by group: the record says how each group voted, plus the deputies
 * who broke ranks. It doesn't list every deputy's vote. This works out an individual's vote
 * only where the record makes it certain, and says why.
 */

export type Position = "favor" | "against" | "abstention";

export type DeputyVote =
  /** Named in the record. */
  | { position: Position; basis: "named" }
  /** Their whole group voted this way and they weren't named as an exception. */
  | { position: Position; basis: "group" }
  /** Unanimous vote, recorded without a breakdown. */
  | { position: "favor"; basis: "unanimous" }
  /** Their group was recorded as absent. */
  | { position: null; basis: "absent" }
  /** Their group split without naming who voted which way, or isn't in the record. */
  | { position: null; basis: "unknown" };

const POSITIONS: Position[] = ["favor", "against", "abstention"];

export const deputyVote = (
  vote: Pick<VoteRecord, Position | "named" | "absent" | "unanimous" | "result">,
  deputy: { name: string; group: string; party: string },
): DeputyVote => {
  const named = vote.named.find((n) => n.name === deputy.name && n.group === deputy.group);
  if (named) return { position: named.position, basis: "named" };

  if (vote.absent.includes(deputy.party)) return { position: null, basis: "absent" };

  const entries = POSITIONS.flatMap((position) =>
    vote[position].filter((v) => v.party === deputy.party).map((v) => ({ position, count: v.count })),
  );
  if (entries.length === 0) {
    const noBreakdown = POSITIONS.every((position) => vote[position].length === 0);
    return vote.unanimous && noBreakdown && vote.result === "Aprovado"
      ? { position: "favor", basis: "unanimous" }
      : { position: null, basis: "unknown" };
  }

  const whole = entries.filter((e) => e.count === null);
  const partial = entries.filter((e) => e.count !== null);
  if (whole.length !== 1) return { position: null, basis: "unknown" };
  // "3-PS" for and "PS" against: the rest of PS voted against only if all 3 are named.
  const namedInGroup = vote.named.filter((n) => n.group === deputy.group).length;
  const partialTotal = partial.reduce((sum, e) => sum + (e.count ?? 0), 0);
  if (partialTotal > namedInGroup) return { position: null, basis: "unknown" };
  return { position: whole[0]!.position, basis: "group" };
};

/** Whether a date falls in one of the deputy's sitting periods. */
export const wasSitting = (periods: { from: string; to: string | null }[], date: string) =>
  periods.some((p) => p.from <= date && (p.to === null || date < p.to));
