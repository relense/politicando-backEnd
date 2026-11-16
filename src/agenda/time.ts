/** Lisbon wall-clock time, for sources that give local dates and times without an offset. */

const ZONE = "Europe/Lisbon";
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "longOffset" });
const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Lisbon's offset from UTC at an instant, in minutes: 0 in winter, 60 in summer. */
export const lisbonOffsetMinutes = (instant: Date) => {
  const name = offsetFormat.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
};

/** "2026-11-17" and "15:00" (Lisbon) → the instant. Without a time, midnight. */
export const fromLisbon = (day: string, time = "00:00") => {
  const d = DAY.exec(day);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (!d || !t) throw new Error(`Bad Lisbon date or time: ${day} ${time}`);
  const asUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Correct by the offset, then once more in case the first guess sat across a clock change.
  const first = asUtc - lisbonOffsetMinutes(new Date(asUtc)) * 60_000;
  return new Date(asUtc - lisbonOffsetMinutes(new Date(first)) * 60_000);
};

const parts = (instant: Date) =>
  Object.fromEntries(partsFormat.formatToParts(instant).map((p) => [p.type, p.value])) as Record<string, string>;

/** The day in Lisbon, "2026-11-17". */
export const lisbonDay = (instant: Date) => {
  const p = parts(instant);
  return `${p.year}-${p.month}-${p.day}`;
};

/** "2026-11-17T15:00:00+00:00": Lisbon wall time with its offset. */
export const toLisbonIso = (instant: Date) => {
  const p = parts(instant);
  const offset = lisbonOffsetMinutes(instant);
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
};

/** The day after, "2026-11-30" → "2026-12-01". */
export const nextDay = (day: string) => {
  const d = DAY.exec(day);
  if (!d) throw new Error(`Bad date: ${day}`);
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1)).toISOString().slice(0, 10);
};

/** Midnight in Lisbon at the end of that day: when an event on it stops being listed. */
export const endOfLisbonDay = (day: string) => fromLisbon(nextDay(day));
