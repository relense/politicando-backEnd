import type { VoteRecord } from "../db/schema.js";
import type { Position } from "./deputyVotes.js";

/*
 * How a party voted, from the group-level record. A group can split ("3-PS" for, "PS"
 * against): the position is then the one most of the group took, with `split` set.
 */

export type PartyVoteResult =
  /** The group voted this way (some members may have voted otherwise: see split). */
  | { position: Position; split: boolean; basis: "group" }
  /** Unanimous, recorded without a breakdown. */
  | { position: "favor"; split: false; basis: "unanimous" }
  | { position: null; split: false; basis: "absent" }
  /** Not in the record, or split with no clear majority position. */
  | { position: null; split: boolean; basis: "unknown" };

const POSITIONS: Position[] = ["favor", "against", "abstention"];

export const partyVote = (
  vote: Pick<VoteRecord, Position | "absent" | "unanimous" | "result">,
  party: string,
): PartyVoteResult => {
  const entries = POSITIONS.flatMap((position) =>
    vote[position].filter((v) => v.party === party).map((v) => ({ position, count: v.count })),
  );
  if (entries.length === 0) {
    if (vote.absent.includes(party)) return { position: null, split: false, basis: "absent" };
    const noBreakdown = POSITIONS.every((position) => vote[position].length === 0);
    return vote.unanimous && noBreakdown && vote.result === "Aprovado"
      ? { position: "favor", split: false, basis: "unanimous" }
      : { position: null, split: false, basis: "unknown" };
  }
  // The group as a whole is listed without a count; the parts that broke away carry one.
  const whole = entries.filter((e) => e.count === null);
  const split = entries.length > 1;
  if (whole.length !== 1) return { position: null, split, basis: "unknown" };
  return { position: whole[0]!.position, split, basis: "group" };
};
