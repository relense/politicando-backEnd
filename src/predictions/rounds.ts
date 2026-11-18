import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { forumThreads, voteRounds } from "../db/schema.js";
import { OPEN_FOR_PREDICTION } from "./index.js";

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

const lisbonDate = (instant: Date) =>
  instant.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", weekday: "long", day: "numeric", month: "long" });

export const openVoteRounds = async (db: Db, now = new Date()) => {
  const until = new Date(now.getTime() + OPEN_DAYS * 24 * 3_600_000);
  // The earliest upcoming plenary session naming each open initiative ("Projeto de Lei n.º 512/XVII/2.ª").
  const candidates = (
    await db.execute<{ id: number; type: string; number: string; title: string; event_id: string; starts_at: Date | string }>(sql`
      select distinct on (initiatives.id) initiatives.id, initiatives.type, initiatives.number, initiatives.title, e.id as event_id, e.starts_at
      from initiatives
      join agenda_events e on e.source = 'parliament' and e.kind = 'parliament' and not e.hidden and e.status = 'scheduled'
        and e.starts_at > ${now.toISOString()}::timestamptz and e.starts_at <= ${until.toISOString()}::timestamptz
        and strpos(coalesce(e.summary, '') || ' ' || e.title, initiatives.type || ' n.º ' || initiatives.number || '/' || initiatives.legislature) > 0
      where initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}
      order by initiatives.id, e.starts_at`)
  ).rows;

  let opened = 0;
  let moved = 0;
  for (const c of candidates) {
    const startsAt = new Date(c.starts_at);
    const [round] = await db.select().from(voteRounds).where(eq(voteRounds.initiativeId, c.id));
    if (round && round.closesAt > now) continue;
    if (round) {
      // The vote didn't happen on the day (postponed): it reopens for the new date.
      await db.update(voteRounds).set({ agendaEventId: c.event_id, closesAt: startsAt }).where(eq(voteRounds.initiativeId, c.id));
      if (round.threadId) await db.update(forumThreads).set({ pinned: true }).where(eq(forumThreads.id, round.threadId));
      moved++;
      continue;
    }
    const name = `${c.type} n.º ${c.number}`;
    const title = `Passa ou chumba? ${name}: ${c.title}`;
    const [thread] = await db
      .insert(forumThreads)
      .values({
        board: VOTES_BOARD,
        title: title.length > 150 ? `${title.slice(0, 149)}…` : title,
        body: `${name}: ${c.title}\n\nVai a votos em plenário (${lisbonDate(startsAt)}). Faz a tua previsão e defende-a aqui: cada resposta mostra o lado de quem a escreve.`,
        nickname: "Politicando",
        posterId: TEAM_POSTER,
        pinned: true,
        initiativeId: c.id,
      })
      .returning({ id: forumThreads.id });
    await db.insert(voteRounds).values({ initiativeId: c.id, agendaEventId: c.event_id, closesAt: startsAt, threadId: thread!.id }).onConflictDoNothing();
    opened++;
  }

  // A couple of days after the vote, its megathread steps down (it stays open for the aftermath).
  const unpinned = await db.execute(sql`
    update forum_threads set pinned = false
    where pinned and id in (select thread_id from vote_rounds where closes_at < ${now.toISOString()}::timestamptz - make_interval(days => ${PINNED_AFTER_DAYS}))`);
  return { opened, moved, unpinned: unpinned.rowCount ?? 0 };
};
