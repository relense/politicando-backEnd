import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { parseEuroparlMeetings } from "../src/agenda/europarl.js";
import { parseParliamentAgenda, plenaryTitle } from "../src/agenda/parliament.js";
import { parsePresidentAgenda } from "../src/agenda/president.js";
import { type AgendaInput, syncAgendaSource } from "../src/agenda/store.js";
import { syncAgenda } from "../src/agenda/sync.js";
import { htmlToText } from "../src/agenda/text.js";
import { fromLisbon, lisbonDay, toLisbonIso } from "../src/agenda/time.js";
import { buildApp } from "../src/app.js";
import { admins, agendaEvents, places } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";
import { loaderFor } from "./parliamentFixtures.js";

describe("Lisbon time", () => {
  it("knows winter and summer time", () => {
    expect(fromLisbon("2026-11-17", "15:00").toISOString()).toBe("2026-11-17T15:00:00.000Z");
    expect(fromLisbon("2026-07-01", "15:00").toISOString()).toBe("2026-07-01T14:00:00.000Z");
    expect(toLisbonIso(new Date("2026-07-01T14:00:00Z"))).toBe("2026-07-01T15:00:00+01:00");
    expect(toLisbonIso(new Date("2026-11-17T15:00:00Z"))).toBe("2026-11-17T15:00:00+00:00");
    expect(lisbonDay(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    // The night the clocks go back: 01:30 happens twice; we take the first.
    expect(fromLisbon("2026-10-25", "00:30").toISOString()).toBe("2026-10-24T23:30:00.000Z");
  });

  it("turns escaped HTML into lines of text", () => {
    expect(htmlToText("&lt;p&gt;14h30 - Um grupo&lt;br /&gt;15h30 - Outro&lt;/p&gt;")).toBe("14h30 - Um grupo\n15h30 - Outro");
    expect(htmlToText("ORDEM DO DIA&nbsp;<br>Debate do Or&ccedil;amento")).toBe("ORDEM DO DIA\nDebate do Orçamento");
  });
});

const arItem = (over: Record<string, unknown>) => ({
  Id: 1, Section: "Plenário", Title: "Plenário", Subtitle: "Reunião n.º 17", InternetText: null, OrgDes: null, Local: "Plenário",
  Link: null, AllDayEvent: false, EventStartDate: "18/11/2026", EventStartTime: "10:00:00", EventEndDate: "18/11/2026", EventEndTime: "23:59:00",
  ...over,
});

describe("parliament agenda", () => {
  it("keeps sittings, committees and audiences, and leaves out visits", () => {
    const events = parseParliamentAgenda([
      arItem({ InternetText: "&lt;p&gt;ORDEM DO DIA&lt;br&gt;10H00&lt;br&gt;1 - Debate na especialidade do Or&amp;ccedil;amento&lt;/p&gt;" }),
      arItem({ Id: 2, Section: "Comissões Parlamentares", Title: "Comissão de Saúde", OrgDes: "Comissão de Saúde", Local: "Sala 1", EventStartTime: "14:30:00", Link: "https://www.parlamento.pt/sites/com/x" }),
      arItem({ Id: 3, Section: "Grupos Parlamentares / Partidos / DURP / Ninsc", Title: "Audiências do Grupo Parlamentar do PCP", EventStartTime: null, InternetText: "10h30 - Sindicato" }),
      arItem({ Id: 4, Section: "Visitas ao Palácio de S. Bento", Title: "Visitas guiadas" }),
      arItem({ Id: 5, Section: "Conferência de Líderes", Title: "Conferência de Líderes", EventStartTime: "15:00:00", EventEndTime: "16:00:00" }),
    ]);
    expect(events.map((e) => [e.id, e.kind, e.title, e.startTime, e.endTime, e.attend.open])).toEqual([
      ["ar-1", "parliament", "Debate na especialidade do Orçamento", "10:00", null, true],
      ["ar-2", "committee", "Comissão de Saúde", "14:30", null, true],
      ["ar-3", "party", "Audiências do Grupo Parlamentar do PCP", null, null, false],
      ["ar-5", "parliament", "Conferência de Líderes", "15:00", "16:00", false],
    ]);
    expect(events[0]).toMatchObject({ online: { label: "Canal Parlamento" }, place: { district: "Lisboa", address: "Palácio de São Bento, Lisboa" } });
    expect(events[1]).toMatchObject({ sourceUrl: "https://www.parlamento.pt/sites/com/x", place: { address: "Palácio de São Bento, Lisboa (Sala 1)" } });
    expect(events[2]).toMatchObject({ allDay: true, partySlugs: ["pcp"], summary: "10h30 - Sindicato" });
  });

  it("skips one item with an odd date or link, not the whole agenda", () => {
    const events = parseParliamentAgenda([arItem({ Id: 1, EventStartDate: "2026-11-18" }), arItem({ Id: 2, Link: "httpfoo:x" })]);
    expect(events.map((e) => e.id)).toEqual(["ar-2"]);
    expect(events[0]!.sourceUrl).toMatch(/^https:\/\//);
  });

  it("titles a sitting by its first item of business", () => {
    expect(plenaryTitle("Sessão Solene Evocativa do 25 de novembro de 1975\nTempos: 2m30s")).toBe("Sessão Solene Evocativa do 25 de novembro de 1975");
    expect(plenaryTitle("")).toBe("Reunião plenária");
  });
});

const presidentPage = (events: object[]) => `
  <div id="v-pills-2026-11-16"></div><div id="v-pills-2026-11-17"></div>
  ${events.map((e) => `<a class="icalendar-btn" data-event='${JSON.stringify(e).replace(/'/g, "&#39;")}'>+</a>`).join("")}`;
const gazeta = {
  FileName: "premios-gazeta", Subject: "Cerimónia dos Prémios Gazeta", Description: "Promovidos pelo Clube de Jornalistas",
  Location: "Salão Nobre da Câmara Municipal de Lisboa, Lisboa", Begin: "11/16/2026 06:00 PM", End: "11/16/2026 07:00 PM",
};

describe("President's agenda", () => {
  it("reads each event's calendar data, without the placeholder end", () => {
    const { days, events } = parsePresidentAgenda(presidentPage([gazeta, gazeta]), (m) => (m === "Lisboa" ? "Lisboa" : null));
    expect(days).toEqual(["2026-11-16", "2026-11-17"]);
    expect(events).toEqual([
      expect.objectContaining({
        id: "pr-2026-11-16-premios-gazeta", kind: "president", startDay: "2026-11-16", startTime: "18:00", endTime: null,
        place: expect.objectContaining({ name: "Salão Nobre da Câmara Municipal de Lisboa", municipality: "Lisboa", district: "Lisboa" }),
      }),
    ]);
  });
});

describe("European Parliament", () => {
  it("joins consecutive sitting days in one city into a session", () => {
    const day = (d: string, city = "FRA_SXB") => ({ activity_date: d, had_activity_type: "def/ep-activities/PLENARY_SITTING", hasLocality: `http://x/place/${city}` });
    const events = parseEuroparlMeetings({
      data: [day("2026-11-24"), day("2026-11-23"), day("2026-11-25"), day("2026-12-02", "BEL_BRU"), day("2026-12-03", "BEL_BRU")],
    });
    expect(events.map((e) => [e.id, e.startDay, e.endDay, e.place?.municipality])).toEqual([
      ["pe-2026-11-23", "2026-11-23", "2026-11-25", "Estrasburgo"],
      ["pe-2026-12-02", "2026-12-02", "2026-12-03", "Bruxelas"],
    ]);
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, loginLimitPerMinute: 1000 });

beforeEach(async () => {
  await resetDb(db);
  const passwordHash = await hashPassword("correct horse battery");
  await db.insert(admins).values([
    { email: "ana@example.pt", name: "Ana", role: "author", passwordHash },
    { email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash },
  ]);
  await db.insert(places).values([
    { key: "d-11", name: "Lisboa", level: "district", dicofre: "11" },
    { key: "m-1106", name: "Lisboa", level: "municipality", parentKey: "d-11", dicofre: "1106" },
    { key: "d-13", name: "Porto", level: "district", dicofre: "13" },
    { key: "m-1312", name: "Porto", level: "municipality", parentKey: "d-13", dicofre: "1312" },
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const login = async (email: string) => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password: "correct horse battery" } });
  return `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}`;
};
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers: cookie ? { cookie } : {}, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};

const input = (over: Partial<AgendaInput>): AgendaInput => ({
  id: "x", kind: "parliament", title: "Evento", summary: null, allDay: false, startDay: "2030-03-05", startTime: "10:00", endDay: null,
  endTime: null, status: "scheduled", place: null, online: null, attend: { open: false, how: null, url: null }, organizer: null,
  partySlugs: [], sourceUrl: null, ...over,
});

describe("syncing a source", () => {
  const now = new Date("2030-03-04T12:00:00Z");

  it("replaces what the source lists, keeping the editors' featured and hidden", async () => {
    await syncAgendaSource(db, "parliament", [input({ id: "ar-1" }), input({ id: "ar-2", startDay: "2030-03-06" })], { fromDay: "2030-03-05", toDay: "2030-03-06" }, now);
    await db.update(agendaEvents).set({ featured: true }).where(eq(agendaEvents.id, "ar-1"));
    const result = await syncAgendaSource(db, "parliament", [input({ id: "ar-1", title: "Novo título" })], { fromDay: "2030-03-05", toDay: "2030-03-06" }, now);
    expect(result).toEqual({ source: "parliament", upserted: 1, removed: 1 });
    expect(await db.select({ id: agendaEvents.id, title: agendaEvents.title, featured: agendaEvents.featured }).from(agendaEvents)).toEqual([
      { id: "ar-1", title: "Novo título", featured: true },
    ]);
  });

  it("never removes past events, or anything when the source lists nothing", async () => {
    await syncAgendaSource(db, "parliament", [input({ id: "ar-old", startDay: "2030-03-01" }), input({ id: "ar-1" })], { fromDay: "2030-03-01", toDay: "2030-03-05" }, now);
    expect(await syncAgendaSource(db, "parliament", [], { fromDay: "2030-03-01", toDay: "2030-03-05" }, now)).toMatchObject({ removed: 0 });
    await syncAgendaSource(db, "parliament", [input({ id: "ar-2" })], { fromDay: "2030-03-01", toDay: "2030-03-05" }, now);
    expect((await db.select({ id: agendaEvents.id }).from(agendaEvents)).map((r) => r.id).sort()).toEqual(["ar-2", "ar-old"]);
  });

  it("imports every source, each failing on its own", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("presidencia.pt")) return new Response(presidentPage([{ ...gazeta, Begin: "11/16/2030 06:00 PM" }]));
      if (url.includes("year=2030")) return new Response(JSON.stringify({ data: [{ activity_date: "2030-11-20", hasLocality: "x/FRA_SXB" }] }));
      if (url.includes("year=2031")) return new Response("");
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const results = await syncAgenda(db, {
      parliament: loaderFor({ agenda: [arItem({ EventStartDate: "18/11/2030" })] }),
      fetch: fetchImpl,
      now: new Date("2030-11-16T09:00:00Z"),
    });
    expect(results).toEqual({
      parliament: { source: "parliament", upserted: 1, removed: 0 },
      president: { source: "president", upserted: 1, removed: 0 },
      europarl: [{ source: "europarl", upserted: 1, removed: 0 }],
    });
    const failing = await syncAgenda(db, { parliament: loaderFor({ agenda: "not a list" }), fetch: fetchImpl, now: new Date("2030-11-16T09:00:00Z") });
    expect(failing.parliament).toMatchObject({ error: expect.any(String) });
    expect(failing.president).toMatchObject({ upserted: 1 });
  });
});

describe("GET /agenda", () => {
  const seed = async () => {
    await syncAgendaSource(db, "parliament", [
      input({ id: "ar-1", title: "Plenário", startDay: "2030-03-05", startTime: "10:00", attend: { open: true, how: "Galerias", url: null }, place: { name: "AR", address: null, municipality: "Lisboa", district: "Lisboa", lat: 1, lng: 2 }, partySlugs: ["ps", "nope"] }),
      input({ id: "ar-2", kind: "committee", title: "Comissão", startDay: "2030-03-06", startTime: "14:30", endTime: "16:00" }),
      input({ id: "ar-3", kind: "party", title: "Congresso", allDay: true, startTime: null, startDay: "2030-07-10", endDay: "2030-07-12" }),
      input({ id: "ar-old", title: "Já passou", startDay: "2020-01-01" }),
    ], { fromDay: "2020-01-01", toDay: "2030-12-31" }, new Date("2019-12-31T00:00:00Z"));
  };

  it("lists what hasn't ended, soonest first, in the contract's shape", async () => {
    await seed();
    const { status, body } = await call("GET", "/agenda");
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["ar-1", "ar-2", "ar-3"]);
    expect(body.items[0]).toEqual({
      id: "ar-1", kind: "parliament", title: "Plenário", summary: null, start: "2030-03-05T10:00:00+00:00", end: null, allDay: false,
      status: "scheduled", place: { name: "AR", address: null, municipality: "Lisboa", district: "Lisboa", lat: 1, lng: 2 }, online: null,
      attend: { open: true, how: "Galerias", url: null }, organizer: null, parties: [{ slug: "ps", acronym: "PS" }], sourceUrl: null, featured: false,
    });
    expect(body.items[1]).toMatchObject({ start: "2030-03-06T14:30:00+00:00", end: "2030-03-06T16:00:00+00:00" });
    expect(body.items[2]).toMatchObject({ start: "2030-07-10", end: "2030-07-12", allDay: true });
  });

  it("filters by kind, district, openness and day, and pages with a stable total", async () => {
    await seed();
    const ids = async (q: string) => (await call("GET", `/agenda?${q}`)).body.items.map((i: { id: string }) => i.id);
    expect(await ids("kind=committee,party")).toEqual(["ar-2", "ar-3"]);
    expect(await ids("district=Lisboa")).toEqual(["ar-1"]);
    expect(await ids("open=true")).toEqual(["ar-1"]);
    expect(await ids("from=2030-07-01")).toEqual(["ar-3"]);
    const first = await call("GET", "/agenda?limit=2");
    const second = await call("GET", `/agenda?limit=2&cursor=${first.body.nextCursor}`);
    expect([first.body.total, second.body.total, second.body.nextCursor]).toEqual([3, 3, null]);
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual(["ar-3"]);
    expect((await call("GET", "/agenda?cursor=bad")).status).toBe(400);
    expect((await call("GET", "/agenda?district=Narnia")).status).toBe(400);
    expect((await call("GET", "/agenda?from=2026-02-31")).status).toBe(400);
    expect((await call("GET", "/agenda?from=2026-13-01")).status).toBe(400);
  });

  it("leaves hidden events out", async () => {
    await seed();
    await db.update(agendaEvents).set({ hidden: true }).where(eq(agendaEvents.id, "ar-2"));
    expect((await call("GET", "/agenda")).body.total).toBe(2);
  });
});

describe("agenda admin", () => {
  const event = {
    kind: "media", title: "Entrevista ao líder do PS", summary: "Na SIC", allDay: false, start: "2030-05-04T21:00", end: "2030-05-04T22:00",
    status: "scheduled", place: { name: "Câmara Municipal do Porto", address: null, municipality: "Porto", district: null, lat: null, lng: null },
    online: { url: "https://sic.pt/direto", label: "SIC" }, attend: { open: false, how: null, url: null }, organizer: "SIC",
    partySlugs: ["ps"], sourceUrl: "https://sic.pt/x",
  };

  it("lets editors add events, filling in the district", async () => {
    expect((await call("POST", "/admin/agenda", undefined, event)).status).toBe(401);
    const ana = await login("ana@example.pt");
    const { status, body } = await call("POST", "/admin/agenda", ana, event);
    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: "ed-2030-05-04-entrevista-ao-lider-do-ps", source: "editorial", kind: "media", start: "2030-05-04T21:00:00+01:00",
      end: "2030-05-04T22:00:00+01:00", place: { district: "Porto" }, parties: [{ slug: "ps", acronym: "PS" }],
    });
    expect((await call("POST", "/admin/agenda", ana, event)).body.id).toBe("ed-2030-05-04-entrevista-ao-lider-do-ps-2");
    expect((await call("GET", "/agenda?kind=media&district=Porto")).body.total).toBe(2);
  });

  it("rejects bad dates and unknown parties", async () => {
    const ana = await login("ana@example.pt");
    expect((await call("POST", "/admin/agenda", ana, { ...event, start: "2030-05-04" })).status).toBe(400);
    expect((await call("POST", "/admin/agenda", ana, { ...event, end: "2030-05-03T10:00" })).status).toBe(400);
    expect((await call("POST", "/admin/agenda", ana, { ...event, start: "2030-05-04T25:90" })).status).toBe(400);
    expect((await call("POST", "/admin/agenda", ana, { ...event, allDay: true, start: "2030-05-04", end: "2030-05-06" })).status).toBe(201);
    expect(await call("POST", "/admin/agenda", ana, { ...event, partySlugs: ["xyz"] })).toMatchObject({ status: 400, body: { error: { code: "unknown_party" } } });
  });

  it("edits and deletes only editors' events; moderators feature and hide any", async () => {
    await syncAgendaSource(db, "parliament", [input({ id: "ar-1" })], { fromDay: "2030-03-05", toDay: "2030-03-05" }, new Date("2030-03-01"));
    const ana = await login("ana@example.pt");
    const mod = await login("mod@example.pt");
    const created = (await call("POST", "/admin/agenda", ana, event)).body;

    expect((await call("PUT", `/admin/agenda/${created.id}`, ana, { ...event, status: "postponed" })).body).toMatchObject({ status: "postponed" });
    expect(await call("PUT", "/admin/agenda/ar-1", ana, event)).toMatchObject({ status: 400, body: { error: { code: "imported" } } });
    expect((await call("DELETE", "/admin/agenda/ar-1", ana)).status).toBe(400);

    expect((await call("POST", "/admin/agenda/ar-1/feature", ana)).status).toBe(403);
    expect((await call("POST", "/admin/agenda/ar-1/feature", mod)).body).toMatchObject({ featured: true });
    expect((await call("POST", "/admin/agenda/ar-1/hide", mod)).body).toMatchObject({ hidden: true, featured: false });
    expect((await call("GET", "/agenda")).body.items.map((i: { id: string }) => i.id)).toEqual([created.id]);
    expect((await call("GET", "/admin/agenda?from=2030-01-01", ana)).body.items).toHaveLength(2);

    expect((await call("DELETE", `/admin/agenda/${created.id}`, ana)).status).toBe(204);
    expect((await call("POST", "/admin/agenda/ar-nope/feature", mod)).status).toBe(404);
  });
});
