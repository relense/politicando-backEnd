import type { VoteRecord } from "../db/schema.js";
import { foldText } from "../modules/articles/routes.js";

/*
 * Budget bill votes the parliament's open data hasn't published yet, written by hand from the
 * news, each with its source. Shown with `provisional: true` until the official record has a
 * vote of the same phase, which then replaces it on its own (no need to remove the entry, though
 * old ones can go). The official data usually lags a few days behind the plenary.
 */

export interface ProvisionalBillVote {
  /** The Budget bill's initiative id (budget_bills.initiative_id). */
  initiativeId: number;
  vote: VoteRecord;
  source: { name: string; url: string };
}

export const PROVISIONAL_BILL_VOTES: ProvisionalBillVote[] = [
  {
    // OE2027, Proposta de Lei 110/XVII: final overall vote, 24 Nov 2026.
    initiativeId: 377352,
    vote: {
      id: "provisional-377352-final",
      date: "2026-11-24",
      phase: "Votação final global",
      result: "Aprovado",
      unanimous: false,
      favor: [{ party: "psd", count: null }, { party: "cds-pp", count: null }],
      abstention: [{ party: "ps", count: null }, { party: "jpp", count: null }],
      against: [
        { party: "chega", count: null }, { party: "il", count: null }, { party: "livre", count: null },
        { party: "pcp", count: null }, { party: "be", count: null }, { party: "pan", count: null },
      ],
      absent: [],
      named: [],
    },
    source: {
      name: "RTP",
      url: "https://www.rtp.pt/noticias/economia/proposta-de-orcamento-do-estado-para-2027-aprovada-em-votacao-final-global_e1781227",
    },
  },
];

const samePhase = (a: string, b: string) => foldText(a).replace(/\s+/g, " ").trim() === foldText(b).replace(/\s+/g, " ").trim();
const isFinal = (phase: string) => /final global/.test(foldText(phase));

type BillVote = VoteRecord & { provisional?: true; source?: { name: string; url: string } };

/**
 * The bill with its provisional votes added where the official record lacks that phase. A
 * provisional final overall vote also settles a bill still "in_progress" (approved or rejected).
 */
export const withProvisionalVotes = <T extends { initiativeId: number; status: string; votes: VoteRecord[] }>(
  bill: T,
  provisional: readonly ProvisionalBillVote[] = PROVISIONAL_BILL_VOTES,
): T & { votes: BillVote[] } => {
  const extra = provisional.filter((p) => p.initiativeId === bill.initiativeId && !bill.votes.some((v) => samePhase(v.phase, p.vote.phase)));
  if (!extra.length) return bill;
  const votes: BillVote[] = [...bill.votes, ...extra.map((p) => ({ ...p.vote, provisional: true as const, source: p.source }))].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const final = extra.find((p) => isFinal(p.vote.phase));
  const status =
    bill.status === "in_progress" && final ? (/^aprovad/i.test(final.vote.result) ? "approved" : /^rejeitad/i.test(final.vote.result) ? "rejected" : bill.status) : bill.status;
  return { ...bill, status, votes };
};
