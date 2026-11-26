import { asc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgetAfterVote, budgetImplementations } from "../db/schema.js";

/*
 * What happened to a Budget after the vote: announcements that approved proposals will or won't
 * be applied (e.g. the Government invoking the lei-travão). Written by hand by the team, never
 * generated, each with its source (docs/budget-api.md, "After the vote").
 *
 * Wording: who announced what, and the reason they gave, without judging it. "O Governo
 * anunciou que não vai aplicar…, invocando a lei-travão", not "O Governo ignorou o Parlamento".
 *
 * A note can set the status of the proposals it names. A proposal's status is the one from the
 * newest note that sets it, so a later note (say, the Government backing down) replaces it.
 * Only approved or partially approved proposals show a status; others are ignored.
 *
 * The seed copies them into budget_after_vote and budget_implementations on every deploy.
 */

export const IMPLEMENTATION_STATUSES = ["applied", "not_applied", "disputed"] as const;
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];

export interface AfterVoteNote {
  /** The Budget's year (OE2027 → 2027). */
  year: number;
  /** When it was announced: YYYY-MM-DD. */
  date: string;
  /** One or two sentences, in Portuguese: who announced what, and why, in neutral words. */
  text: string;
  source: { name: string; url: string };
  /** The proposals it's about (budget_proposals.id); [] when none in particular. */
  proposals: {
    id: number;
    /** Omit to name the proposal without changing its status. */
    status?: ImplementationStatus;
    /** A short note for the proposal's own page (optional). */
    note?: string;
  }[];
}

export const AFTER_VOTE_NOTES: AfterVoteNote[] = [];

/** The notes as stored: one row per note, and each proposal's status from the newest note that sets it. */
export const afterVoteRows = (notes: readonly AfterVoteNote[]) => {
  // Oldest first, so a newer note's status overwrites an older one's.
  const ordered = [...notes].sort((a, b) => a.year - b.year || a.date.localeCompare(b.date) || a.text.localeCompare(b.text));
  const implementations = new Map<number, typeof budgetImplementations.$inferInsert>();
  for (const n of ordered) {
    for (const p of n.proposals) {
      if (!p.status) continue;
      implementations.set(p.id, {
        proposalId: p.id, year: n.year, status: p.status, date: n.date, note: p.note ?? null, sourceName: n.source.name, sourceUrl: n.source.url,
      });
    }
  }
  return {
    notes: ordered.map((n) => ({ year: n.year, date: n.date, text: n.text, sourceName: n.source.name, sourceUrl: n.source.url, proposalIds: n.proposals.map((p) => p.id) })),
    implementations: [...implementations.values()].sort((a, b) => a.proposalId - b.proposalId),
  };
};

/**
 * Copies the notes into the database (run by the seed on every deploy), so the version still
 * serving during a deploy already answers with them when the site is told to refresh.
 * Returns whether anything changed: only then is the site told.
 */
export const syncAfterVoteNotes = async (db: Db, notes: readonly AfterVoteNote[] = AFTER_VOTE_NOTES) => {
  const wanted = afterVoteRows(notes);
  const stored = {
    notes: await db
      .select({
        year: budgetAfterVote.year, date: budgetAfterVote.date, text: budgetAfterVote.text,
        sourceName: budgetAfterVote.sourceName, sourceUrl: budgetAfterVote.sourceUrl, proposalIds: budgetAfterVote.proposalIds,
      })
      .from(budgetAfterVote)
      .orderBy(asc(budgetAfterVote.id)),
    implementations: await db.select().from(budgetImplementations).orderBy(asc(budgetImplementations.proposalId)),
  };
  if (JSON.stringify(stored) === JSON.stringify(wanted)) return { notes: wanted.notes.length, changed: false };
  await db.transaction(async (tx) => {
    await tx.delete(budgetAfterVote);
    await tx.delete(budgetImplementations);
    if (wanted.notes.length) await tx.insert(budgetAfterVote).values(wanted.notes);
    if (wanted.implementations.length) await tx.insert(budgetImplementations).values(wanted.implementations);
  });
  return { notes: wanted.notes.length, changed: true };
};
