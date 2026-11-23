import * as cheerio from "cheerio";
import { z } from "zod";
import { slugify } from "../editorial/media.js";
import type { AgendaInput } from "./store.js";
import { truncate } from "./text.js";

/**
 * The President's public agenda on presidencia.pt. The page shows a tab per day (today and
 * the next few) and each event carries its details for "add to calendar" as JSON; that's what
 * we read. Its end is always the start plus an hour, a placeholder, so we leave it out.
 * When nothing is scheduled, the page shows a single "Próximos Dias" tab (`v-pills-no-events`)
 * saying "Sem informação para apresentar": that's `empty`, not a changed page.
 */
export const PRESIDENT_AGENDA_URL = "https://www.presidencia.pt/atualidade/agenda";

const eventSchema = z.object({
  FileName: z.string(),
  Subject: z.string(),
  Description: z.string().nullish(),
  Location: z.string().nullish(),
  Begin: z.string(),
});

/** "11/16/2026 06:00 PM" → ["2026-11-16", "18:00"] */
const parseBegin = (begin: string): [string, string] | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) (AM|PM)$/.exec(begin.trim());
  if (!m) return null;
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0);
  return [`${m[3]}-${m[1]}-${m[2]}`, `${String(hour).padStart(2, "0")}:${m[5]}`];
};

/** The page's days and its events. `districtOf` turns the town at the end of "…, Lisboa" into its district. */
export const parsePresidentAgenda = (html: string, districtOf: (municipality: string) => string | null) => {
  const $ = cheerio.load(html);
  const days = [...new Set($("[id^=v-pills-]").map((_, el) => /v-pills-(\d{4}-\d{2}-\d{2})$/.exec($(el).attr("id") ?? "")?.[1]).get())]
    .filter(Boolean)
    .sort() as string[];
  const events = new Map<string, AgendaInput>();
  $("[data-event]").each((_, el) => {
    let parsed;
    try {
      parsed = eventSchema.safeParse(JSON.parse($(el).attr("data-event") ?? ""));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const event = parsed.data;
    const begin = parseBegin(event.Begin);
    if (!begin) return;
    const [day, time] = begin;
    const location = event.Location?.trim() || null;
    const municipality = location?.split(",").at(-1)?.trim() || null;
    const district = municipality ? districtOf(municipality) : null;
    const id = `pr-${day}-${slugify(event.FileName || event.Subject)}`;
    events.set(id, {
      id,
      kind: "president",
      title: truncate(event.Subject.trim(), 200),
      summary: event.Description?.trim() || null,
      allDay: false,
      startDay: day,
      startTime: time,
      endDay: null,
      endTime: null,
      status: "scheduled",
      place: location
        ? { name: location.split(",")[0]!.trim(), address: location, municipality: district ? municipality : null, district, lat: null, lng: null }
        : null,
      online: null,
      attend: { open: false, how: null, url: null },
      organizer: "Presidência da República",
      partySlugs: [],
      sourceUrl: PRESIDENT_AGENDA_URL,
    });
  });
  const empty = days.length === 0 && $("#v-pills-no-events").length > 0;
  return { days, events: [...events.values()], empty };
};
