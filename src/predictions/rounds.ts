import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type VoteRecord, forumThreads, initiatives, voteRounds } from "../db/schema.js";
import { OPEN_FOR_PREDICTION, settle } from "./index.js";

/*
 * When "Passa ou chumba?" opens: only for initiatives named in a plenary agenda within the next
 * week, so predicting happens while the vote is in the air. Each open vote gets a megathread in
 * the "votacoes" board, pinned until a couple of days after the vote, where readers defend
 * their pick. Run after every agenda sync (and the parliament sync).
 */

export const VOTES_BOARD = "votacoes";
/** How far ahead of the session a vote opens. */
export const OPEN_DAYS = 7;
/** How long the megathread stays pinned after the session. */
const PINNED_AFTER_DAYS = 2;
/** The megathread's poster: the team, not a reader. */
export const TEAM_POSTER = "redacao";

/** True when this agenda event (aliased `e`) names the initiative ("Projeto de Lei n.º 512/XVII/2.ª"). */
export const AGENDA_NAMES_INITIATIVE = sql`e.source = 'parliament' and e.kind = 'parliament' and not e.hidden and e.status = 'scheduled'
  and strpos(coalesce(e.summary, '') || ' ' || e.title, initiatives.type || ' n.º ' || initiatives.number || '/' || initiatives.legislature) > 0`;

/** The deciding vote that settled a round (the first one from the day it opened), if it happened. */
export const roundVote = (openedAt: Date, votes: VoteRecord[]) => {
  const result = settle({ pick: "pass", updatedAt: openedAt }, { votes, open: true });
  return result?.voteDate ? { voteDate: result.voteDate, voteResult: result.voteResult } : null;
};

const lisbonDate = (instant: Date) =>
  instant.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", weekday: "long", day: "numeric", month: "long" });

/** Rounds are known this far ahead (as upcoming), so "Votações desta semana" can say when each opens. */
export const LOOKAHEAD_DAYS = OPEN_DAYS * 2;
const DAY = 24 * 3_600_000;

/** The vote's megathread, created when picks open (by the sync, or the first pick, whichever comes first). */
export const ensureThread = async (db: Db, initiativeId: number) => {
  const [row] = await db
    .select({ threadId: voteRounds.threadId, closesAt: voteRounds.closesAt, type: initiatives.type, number: initiatives.number, title: initiatives.title })
    .from(voteRounds)
    .innerJoin(initiatives, eq(initiatives.id, voteRounds.initiativeId))
    .where(eq(voteRounds.initiativeId, initiativeId));
  if (!row) return null;
  if (row.threadId) return row.threadId;
  const name = `${row.type} n.º ${row.number}`;
  const title = `Passa ou chumba? ${name}: ${row.title}`;
  return db.transaction(async (tx) => {
    // Two at once (the sync and a first pick): the second waits and reuses the first one's thread.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('vote_thread'), ${initiativeId})`);
    const [again] = await tx.select({ threadId: voteRounds.threadId }).from(voteRounds).where(eq(voteRounds.initiativeId, initiativeId));
    if (again?.threadId) return again.threadId;
    const [thread] = await tx
      .insert(forumThreads)
      .values({
        board: VOTES_BOARD,
        title: title.length > 150 ? `${title.slice(0, 149)}…` : title,
        body: `${name}: ${row.title}\n\nVai a votos em plenário (${lisbonDate(row.closesAt)}). Faz a tua previsão e defende-a aqui: cada resposta mostra o lado de quem a escreve.`,
        nickname: "Politicando",
        posterId: TEAM_POSTER,
        pinned: true,
        initiativeId,
      })
      .returning({ id: forumThreads.id });
    await tx.update(voteRounds).set({ threadId: thread!.id }).where(eq(voteRounds.initiativeId, initiativeId));
    return thread!.id;
  });
};

export const openVoteRounds = async (db: Db, now = new Date()) => {
  const until = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY);
  // The earliest upcoming plenary session naming each initiative still waiting for a vote.
  const candidates = (
    await db.execute<{ id: number; event_id: string; starts_at: Date | string }>(sql`
      select distinct on (initiatives.id) initiatives.id, e.id as event_id, e.starts_at
      from initiatives
      join agenda_events e on ${AGENDA_NAMES_INITIATIVE}
        and e.starts_at > ${now.toISOString()}::timestamptz and e.starts_at <= ${until.toISOString()}::timestamptz
      where initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}
      order by initiatives.id, e.starts_at`)
  ).rows;

  let scheduled = 0;
  let moved = 0;
  for (const c of candidates) {
    const startsAt = new Date(c.starts_at);
    const opensAt = new Date(startsAt.getTime() - OPEN_DAYS * DAY);
    const [round] = await db.select().from(voteRounds).where(eq(voteRounds.initiativeId, c.id));
    if (!round) {
      // A week before the session, or now when it reached the agenda later than that.
      await db.insert(voteRounds).values({ initiativeId: c.id, agendaEventId: c.event_id, opensAt: opensAt < now ? now : opensAt, closesAt: startsAt }).onConflictDoNothing();
      scheduled++;
      continue;
    }
    if (round.closesAt > now) {
      // Brought forward on the agenda: follow it.
      if (startsAt < round.closesAt) {
        await db.update(voteRounds).set({ agendaEventId: c.event_id, opensAt: round.opensAt < opensAt ? round.opensAt : opensAt, closesAt: startsAt }).where(eq(voteRounds.initiativeId, c.id));
      }
      continue;
    }
    // Already settled (its vote happened): it stays as history. Predictions are one per reader
    // per initiative, so a later vote on the same initiative doesn't reopen it.
    const [initiative] = await db.select({ votes: initiatives.votes }).from(initiatives).where(eq(initiatives.id, c.id));
    if (roundVote(round.openedAt, initiative?.votes ?? [])) continue;
    // The vote didn't happen on the day (postponed): it reopens for the new date (now, if that's within the week).
    await db.update(voteRounds).set({ agendaEventId: c.event_id, opensAt: opensAt < now ? now : opensAt, closesAt: startsAt }).where(eq(voteRounds.initiativeId, c.id));
    if (round.threadId) await db.update(forumThreads).set({ pinned: true }).where(eq(forumThreads.id, round.threadId));
    moved++;
  }

  // Picks open: each gets its megathread.
  const due = await db
    .select({ id: voteRounds.initiativeId })
    .from(voteRounds)
    .where(and(isNull(voteRounds.threadId), lte(voteRounds.opensAt, now), gt(voteRounds.closesAt, now)));
  for (const { id } of due) await ensureThread(db, id);

  // A couple of days after the vote, its megathread steps down (it stays open for the aftermath).
  const unpinned = await db.execute(sql`
    update forum_threads set pinned = false
    where pinned and id in (select thread_id from vote_rounds where closes_at < ${now.toISOString()}::timestamptz - make_interval(days => ${PINNED_AFTER_DAYS}))`);
  return { scheduled, opened: due.length, moved, unpinned: unpinned.rowCount ?? 0 };
};
