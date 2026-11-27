import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { places } from "../db/schema.js";
import type { OpenDataLoader } from "../parliament/openData.js";
import { europarlMeetingsUrl, parseEuroparlMeetings } from "./europarl.js";
import { parseParliamentAgenda } from "./parliament.js";
import { parsePresidentAgenda, PRESIDENT_AGENDA_URL } from "./president.js";
import { type AgendaInput, syncAgendaSource } from "./store.js";
import { lisbonDay } from "./time.js";
import { fetchText, RETRY_DELAYS_MS } from "../ingestion/retry.js";

const USER_AGENT = "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

export interface AgendaSyncDeps {
  parliament: OpenDataLoader;
  fetch?: typeof fetch;
  now?: Date;
  retryDelaysMs?: readonly number[];
}

const span = (events: AgendaInput[]) => {
  const days = events.flatMap((e) => [e.startDay, e.endDay ?? e.startDay]).sort();
  return { fromDay: days[0]!, toDay: days.at(-1)! };
};

/** Municipality name → its district, as the frontend's district filter writes it. */
export const loadDistricts = async (db: Db) => {
  const district = alias(places, "district");
  const rows = await db
    .select({ municipality: places.name, district: district.name })
    .from(places)
    .innerJoin(district, eq(district.key, places.parentKey))
    .where(eq(places.level, "municipality"));
  const map = new Map(rows.map((r) => [r.municipality.toLowerCase(), r.district]));
  return (municipality: string) => map.get(municipality.toLowerCase()) ?? null;
};

/** Imports every source; each fails on its own and is reported as an error. */
export const syncAgenda = async (db: Db, { parliament, fetch: fetchImpl = fetch, now = new Date(), retryDelaysMs = RETRY_DELAYS_MS }: AgendaSyncDeps) => {
  // Tried again on a timeout, a dropped connection or a 5xx.
  const get = (url: string, accept = "text/html") =>
    fetchText(url, { fetchFn: fetchImpl, timeoutMs: 60_000, init: { headers: { "User-Agent": USER_AGENT, Accept: accept } }, delaysMs: retryDelaysMs });
  const results: Record<string, unknown> = {};
  const run = async (name: string, task: () => Promise<unknown>) => {
    try {
      results[name] = await task();
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  };

  await run("parliament", async () => {
    const events = parseParliamentAgenda(await parliament.json("agenda"));
    return events.length ? syncAgendaSource(db, "parliament", events, span(events), now) : { upserted: 0, removed: 0 };
  });

  await run("president", async () => {
    const { days, events, empty } = parsePresidentAgenda(await get(PRESIDENT_AGENDA_URL), await loadDistricts(db));
    // Nothing on the agenda: keep what we have (an event already imported may still happen).
    if (empty) return { upserted: 0, removed: 0, empty: true };
    if (days.length === 0) throw new Error("No days on the President's agenda page: has it changed?");
    return syncAgendaSource(db, "president", events, { fromDay: days[0]!, toDay: days.at(-1)! }, now);
  });

  await run("europarl", async () => {
    const year = Number(lisbonDay(now).slice(0, 4));
    const out = [];
    for (const y of [year, year + 1]) {
      // Next year's calendar comes out late in the year: until then the API answers empty.
      const text = await get(europarlMeetingsUrl(y), "application/ld+json");
      if (!text.trim()) continue;
      const events = parseEuroparlMeetings(JSON.parse(text));
      out.push(await syncAgendaSource(db, "europarl", events, { fromDay: `${y}-01-01`, toDay: `${y}-12-31` }, now));
    }
    return out;
  });

  return results;
};
