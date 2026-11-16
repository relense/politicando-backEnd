import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agendaEvents, type AgendaAttend, type AgendaOnline, type AgendaPlace } from "../db/schema.js";
import { endOfLisbonDay, fromLisbon, lisbonDay } from "./time.js";

export const AGENDA_KINDS = ["parliament", "committee", "government", "president", "party", "local", "election", "european", "media", "other"] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];
export type AgendaSource = (typeof agendaEvents.$inferSelect)["source"];

/** An event as a source or an editor describes it, in Lisbon dates and times. */
export interface AgendaInput {
  id: string;
  kind: AgendaKind;
  title: string;
  summary: string | null;
  allDay: boolean;
  startDay: string;
  /** "15:00", Lisbon; ignored for all-day events. */
  startTime: string | null;
  /** Last day (inclusive) for all-day events; the end's day for timed ones, when it differs. */
  endDay: string | null;
  endTime: string | null;
  status: "scheduled" | "cancelled" | "postponed";
  place: AgendaPlace | null;
  online: AgendaOnline | null;
  attend: AgendaAttend;
  organizer: string | null;
  partySlugs: string[];
  sourceUrl: string | null;
}

/** The stored columns, with the instants worked out from the Lisbon dates and times. */
export const toRow = (input: AgendaInput, source: AgendaSource) => {
  const timed = !input.allDay && input.startTime !== null;
  const startsAt = fromLisbon(input.startDay, timed ? input.startTime! : "00:00");
  const endsAt = timed && input.endTime ? fromLisbon(input.endDay ?? input.startDay, input.endTime) : null;
  const endDay = !timed && input.endDay && input.endDay > input.startDay ? input.endDay : null;
  const until = endsAt && endsAt > startsAt ? endsAt : endOfLisbonDay(endDay ?? input.endDay ?? input.startDay);
  return {
    id: input.id,
    source,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    allDay: !timed,
    startsAt,
    endsAt: endsAt && endsAt > startsAt ? endsAt : null,
    startDay: input.startDay,
    endDay,
    until,
    status: input.status,
    place: input.place,
    district: input.place?.district ?? null,
    online: input.online,
    attend: input.attend,
    organizer: input.organizer,
    partySlugs: input.partySlugs,
    sourceUrl: input.sourceUrl,
  };
};

/**
 * Replaces a source's events between two days with what it lists now. Events it no longer
 * lists are removed (we can't tell a cancellation from a correction), but only from today on,
 * and never when it lists nothing, so a broken page can't empty the calendar. The editors'
 * `featured` and `hidden` survive.
 */
export const syncAgendaSource = async (
  db: Db,
  source: Exclude<AgendaSource, "editorial">,
  inputs: AgendaInput[],
  window: { fromDay: string; toDay: string },
  now = new Date(),
) => {
  const rows = [...new Map(inputs.map((input) => [input.id, toRow(input, source)])).values()];
  if (rows.length === 0) return { source, upserted: 0, removed: 0 };
  await db
    .insert(agendaEvents)
    .values(rows)
    .onConflictDoUpdate({
      target: agendaEvents.id,
      set: Object.fromEntries(
        [
          "kind", "title", "summary", "allDay", "startsAt", "endsAt", "startDay", "endDay", "until", "status",
          "place", "district", "online", "attend", "organizer", "partySlugs", "sourceUrl",
        ].map((key) => [key, sql.raw(`excluded.${toSnake(key)}`)]),
      ),
    });
  await db.update(agendaEvents).set({ updatedAt: now }).where(inArray(agendaEvents.id, rows.map((r) => r.id)));
  const today = lisbonDay(now);
  const removed = await db
    .delete(agendaEvents)
    .where(
      and(
        eq(agendaEvents.source, source),
        gte(agendaEvents.startDay, window.fromDay > today ? window.fromDay : today),
        lte(agendaEvents.startDay, window.toDay),
        notInArray(agendaEvents.id, rows.map((r) => r.id)),
      ),
    )
    .returning({ id: agendaEvents.id });
  return { source, upserted: rows.length, removed: removed.length };
};

const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
