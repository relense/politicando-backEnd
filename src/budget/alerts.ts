import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { BudgetVoteNotice } from "../db/schema.js";
import { notifyBudgetVote } from "../notifications/index.js";

/*
 * Tells readers who follow a Budget proposal ("Seguir") about each new vote on it, in the site
 * inbox (kind budget_vote). Run after each budget sync. Every vote is recorded once seen
 * (budget_vote_notices), followed or not, so a proposal followed later never brings its past
 * votes back as news. Safe to run twice.
 */

/** A vote older than this is never news, even if it's the first time we see it (a late correction). */
const FRESH_DAYS = 14;

interface NewVote extends Record<string, unknown> {
  proposal_id: number;
  seq: number;
  voted_on: string;
  phase: "committee" | "plenary" | null;
  result: "approved" | "rejected" | "superseded" | null;
  part_label: string | null;
  year: number;
  number: string;
  title: string;
  followers: number[] | null;
}

export const announceBudgetVotes = async (db: Db, { now = new Date() }: { now?: Date } = {}) =>
  db.transaction(async (tx) => {
    const fresh = new Date(now.getTime() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
    // Followers only count from the day they followed: a vote from before is old news to them.
    const rows = (
      await tx.execute<NewVote>(sql`
        with seen as (
          insert into budget_vote_notices (proposal_id, seq, voted_on)
          select proposal_id, seq, voted_on from budget_votes
          on conflict do nothing
          returning proposal_id, seq, voted_on
        )
        select s.proposal_id, s.seq, s.voted_on::text as voted_on, v.phase, v.result, v.part_label,
          p.year, p.number, p.title,
          (select array_agg(f.user_id order by f.user_id) from user_follows f
            where f.kind = 'budget_proposal' and f.target_id = s.proposal_id
              and s.voted_on >= (f.created_at at time zone 'Europe/Lisbon')::date) as followers
        from seen s
        join budget_votes v on v.proposal_id = s.proposal_id and v.seq = s.seq
        join budget_proposals p on p.id = s.proposal_id
        where s.voted_on >= ${fresh}::date
        order by s.voted_on, s.proposal_id, s.seq`)
    ).rows;
    let notified = 0;
    for (const r of rows) {
      if (!r.followers?.length) continue;
      const detail: BudgetVoteNotice = {
        year: r.year, number: r.number, title: r.title, votedOn: r.voted_on, phase: r.phase, result: r.result, partLabel: r.part_label,
      };
      await notifyBudgetVote(tx, { userIds: r.followers, proposalId: r.proposal_id, detail });
      notified += r.followers.length;
    }
    return { newVotes: rows.length, notified };
  });
