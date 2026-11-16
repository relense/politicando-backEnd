import { z } from "zod";
import type { AgendaInput } from "./store.js";
import { nextDay } from "./time.js";

/**
 * The European Parliament's plenary calendar, from its open data API (one entry per sitting
 * day). Consecutive days in the same city become one session: a week in Strasbourg, or a
 * two-day mini-session in Brussels.
 */
export const europarlMeetingsUrl = (year: number) =>
  `https://data.europarl.europa.eu/api/v2/meetings?year=${year}&format=application%2Fld%2Bjson&offset=0&limit=500`;
const PLENARY_URL = "https://www.europarl.europa.eu/plenary/pt/home.html";

const CITIES: Record<string, { name: string; municipality: string; lat: number; lng: number }> = {
  FRA_SXB: { name: "Parlamento Europeu, Estrasburgo", municipality: "Estrasburgo", lat: 48.5974, lng: 7.7684 },
  BEL_BRU: { name: "Parlamento Europeu, Bruxelas", municipality: "Bruxelas", lat: 50.8386, lng: 4.3755 },
};

const responseSchema = z.object({
  data: z
    .array(
      z.object({
        activity_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        had_activity_type: z.string().optional(),
        hasLocality: z.string().optional(),
      }),
    )
    .default([]),
});

export const parseEuroparlMeetings = (raw: unknown): AgendaInput[] => {
  const days = responseSchema
    .parse(raw)
    .data.filter((d) => !d.had_activity_type || d.had_activity_type.endsWith("PLENARY_SITTING"))
    .map((d) => ({ day: d.activity_date, city: d.hasLocality?.split("/").at(-1) ?? "" }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const sessions: { first: string; last: string; city: string }[] = [];
  for (const { day, city } of days) {
    const current = sessions.at(-1);
    if (current && current.city === city && (day === current.last || day === nextDay(current.last))) current.last = day;
    else sessions.push({ first: day, last: day, city });
  }

  return sessions.map(({ first, last, city }) => {
    const where = CITIES[city];
    return {
      id: `pe-${first}`,
      kind: "european",
      title: where?.municipality === "Bruxelas" ? "Sessão plenária do Parlamento Europeu em Bruxelas" : "Sessão plenária do Parlamento Europeu",
      summary: null,
      allDay: true,
      startDay: first,
      startTime: null,
      endDay: last === first ? null : last,
      endTime: null,
      status: "scheduled",
      place: where ? { name: where.name, address: null, municipality: where.municipality, district: null, lat: where.lat, lng: where.lng } : null,
      online: null,
      attend: { open: false, how: null, url: null },
      organizer: "Parlamento Europeu",
      partySlugs: [],
      sourceUrl: PLENARY_URL,
    } satisfies AgendaInput;
  });
};
