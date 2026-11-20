import { createHash } from "node:crypto";
import { z } from "zod";
import { partySlugForGroup } from "../parliament/groups.js";
import type { AgendaInput } from "./store.js";
import { htmlToText, truncate } from "./text.js";

/**
 * The Assembleia da República's agenda, from its open data ("Agenda Parlamentar": the
 * coming days' plenary sittings, committee meetings, working groups, the Leaders' Conference
 * and the parliamentary groups' audiences). Visits and school groups are left out.
 */

const itemSchema = z.object({
  Id: z.number(),
  Section: z.string().nullable(),
  Title: z.string().nullable(),
  Subtitle: z.string().nullable(),
  InternetText: z.string().nullable(),
  OrgDes: z.string().nullable(),
  Local: z.string().nullable(),
  Link: z.string().nullable(),
  AllDayEvent: z.boolean().nullable(),
  EventStartDate: z.string(),
  EventStartTime: z.string().nullable(),
  EventEndDate: z.string().nullable(),
  EventEndTime: z.string().nullable(),
});

export const PARLIAMENT_AGENDA_URL = "https://agenda.parlamento.pt/";
const AR_PLACE = {
  name: "Assembleia da República",
  address: "Palácio de São Bento, Lisboa",
  municipality: "Lisboa",
  district: "Lisboa",
  lat: 38.7135,
  lng: -9.1561,
};
const OPEN_HOW = "Entrada pelo Palácio de São Bento, indicando a reunião. Lugares limitados; é preciso documento de identificação.";
const CLOSED = { open: false, how: null, url: null };

/** "18/11/2026" → "2026-11-18" */
const isoDay = (day: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(day.trim());
  if (!m) throw new Error(`Bad parliament date: ${day}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
};
/** "14:30:00" → "14:30"; "23:59" is how the agenda says it doesn't know the end. */
const hhmm = (time: string | null) => (time && !time.startsWith("23:59") ? time.slice(0, 5) : null);

/** The plenary's first item of business: "ORDEM DO DIA / 10H00 / 1 - Debate …" → "Debate …". */
export const plenaryTitle = (text: string) => {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\d+\s*[-–.)]\s*/, "").trim())
    .find((l) => l && !/^ordem do dia/i.test(l) && !/^\d{1,2}\s*h\s*\d{0,2}$/i.test(l) && !/^tempos/i.test(l));
  return line ? truncate(line, 140) : "Reunião plenária";
};

const webLink = (value: string | null | undefined) => {
  try {
    return value && /^https?:$/.test(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
};

/** "15h30 - Tabaqueira", "9h – ANEM", "10:30 - X": one hearing per line with a time. */
export const hearingsIn = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^(\d{1,2})\s*[hH:.]\s*(\d{2})?\s*(?:m(?:in)?)?\s*[-–—:]\s*(.+)$/.exec(line);
      if (!match) return [];
      const hours = Number(match[1]);
      const minutes = Number(match[2] ?? "0");
      if (hours > 23 || minutes > 59 || !match[3]!.trim()) return [];
      return [{ time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`, who: match[3]!.trim(), line }];
    });

/** "ar-7" and 14:30 "Liga Portuguesa…" → "ar-7-1430-3f9a1c2b": the same hearing keeps its id. */
export const hearingId = (itemId: string, hearing: { time: string; who: string }) => {
  const who = hearing.who
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${itemId}-${hearing.time.replace(":", "")}-${createHash("sha1").update(who).digest("hex").slice(0, 8)}`;
};

export const parseParliamentAgenda = (raw: unknown): AgendaInput[] => {
  const items = z.array(z.unknown()).parse(raw);
  const events: AgendaInput[] = [];
  for (const entry of items) {
    const parsed = itemSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    // One odd date skips that item, not the whole day's agenda.
    let startDay: string;
    let endDay: string | null;
    try {
      startDay = isoDay(item.EventStartDate);
      endDay = item.EventEndDate ? isoDay(item.EventEndDate) : null;
    } catch {
      continue;
    }
    const section = item.Section ?? "";
    const text = htmlToText(item.InternetText);
    const startTime = item.AllDayEvent ? null : hhmm(item.EventStartTime);
    const base = {
      id: `ar-${item.Id}`,
      summary: text ? truncate(text, 1500) : null,
      allDay: startTime === null,
      startDay,
      startTime,
      endDay: endDay && endDay !== startDay ? endDay : null,
      endTime: startTime ? hhmm(item.EventEndTime) : null,
      status: "scheduled" as const,
      organizer: "Assembleia da República",
      partySlugs: [] as string[],
      sourceUrl: webLink(item.Link) ?? PARLIAMENT_AGENDA_URL,
      online: null,
    };
    const room = item.Local?.trim() && item.Local.trim() !== "Plenário" ? ` (${item.Local.trim()})` : "";
    const place = { ...AR_PLACE, address: `${AR_PLACE.address}${room}` };

    if (section === "Plenário") {
      events.push({
        ...base,
        kind: "parliament",
        title: plenaryTitle(text),
        place,
        online: { url: "https://canal.parlamento.pt/", label: "Canal Parlamento" },
        attend: { open: true, how: OPEN_HOW, url: null },
      });
    } else if (section === "Comissões Parlamentares" || section === "Grupo de Trabalho") {
      const name = (item.OrgDes ?? item.Title ?? "Reunião de comissão").trim();
      events.push({
        ...base,
        kind: "committee",
        title: name,
        organizer: name,
        place,
        attend: { open: true, how: `${OPEN_HOW} Algumas reuniões são à porta fechada.`, url: null },
      });
    } else if (section === "Conferência de Líderes") {
      events.push({ ...base, kind: "parliament", title: "Conferência de Líderes", place, attend: CLOSED });
    } else if (section.startsWith("Grupos Parlamentares")) {
      const group = /Grupo Parlamentar d[oa]s?\s+(.+)$/i.exec(item.Title ?? "")?.[1]?.trim();
      const slug = partySlugForGroup(group?.replace(/^B\.E\.$/, "BE"));
      const party = {
        ...base,
        kind: "party" as const,
        organizer: group ? `Grupo Parlamentar do ${group}` : "Assembleia da República",
        partySlugs: slug ? [slug] : [],
        place,
        attend: CLOSED,
      };
      // The day's hearings come as one item, a line each ("15h30 - Tabaqueira"): one event per
      // hearing, at its time. Without times, the day stays one event.
      const hearings = hearingsIn(text);
      if (hearings.length === 0) {
        events.push({ ...party, title: item.Title?.trim() || "Audiências de grupo parlamentar" });
      } else {
        const used = new Set<string>();
        hearings.forEach((hearing) => {
          // From the hearing itself, not its line number: a hearing added above another mustn't
          // move the editors' hidden/featured flags onto a different event.
          let id = hearingId(base.id, hearing);
          for (let n = 2; used.has(id); n++) id = `${hearingId(base.id, hearing)}-${n}`;
          used.add(id);
          events.push({
            ...party,
            id,
            title: truncate(`Audiência do ${group ?? "grupo parlamentar"}: ${hearing.who}`, 140),
            summary: hearing.line,
            allDay: false,
            startTime: hearing.time,
            endDay: null,
            endTime: null,
          });
        });
      }
    }
  }
  return events;
};
