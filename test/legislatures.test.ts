import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { cases, caseEvents } from "../src/db/schema.js";
import { importHistoricLegislativas } from "../src/elections/historic.js";
import { LEGISLATURE_ELECTIONS } from "../src/modules/legislatures/routes.js";
import { LEGISLATURE_EVENTS } from "../src/parliament/legislatureEvents.js";
import { LEGISLATURES, legislatureDates } from "../src/parliament/legislatures.js";
import { importPastLegislature, PAST_LEGISLATURES, pastPartySlug, toPastInitiative } from "../src/parliament/pastLegislatures.js";
import { createTestDb, resetDb } from "./helpers.js";
import { event, initiative, loaderFor, vote } from "./parliamentFixtures.js";

describe("legislature data", () => {
  it("knows which elections elected every legislature", () => {
    expect(Object.keys(LEGISLATURE_ELECTIONS)).toEqual(LEGISLATURES.map((l) => l.id));
    expect(LEGISLATURE_ELECTIONS.I).toEqual(["legislativas-1976", "legislativas-1979"]);
  });

  it("imports initiatives for every past legislature with an open data folder", () => {
    expect(PAST_LEGISLATURES[0]).toBe("I");
    expect(PAST_LEGISLATURES.at(-1)).toBe(LEGISLATURES.at(-2)!.id);
  });

  it("keeps curated events inside their legislature, in order, each with an https source", () => {
    for (const [id, events] of Object.entries(LEGISLATURE_EVENTS)) {
      const dates = legislatureDates(id);
      expect(dates, id).not.toBeNull();
      for (const e of events) {
        expect(e.date >= dates!.start && (dates!.end === null || e.date < dates!.end), `${id} ${e.title}`).toBe(true);
        expect(e.sources.length, e.title).toBeGreaterThan(0);
        for (const s of e.sources) expect(s.url, e.title).toMatch(/^https:\/\//);
        expect(e.title.length, e.title).toBeLessThanOrEqual(110);
      }
      expect(events.map((e) => e.date)).toEqual([...events.map((e) => e.date)].sort());
    }
    expect(Object.keys(LEGISLATURE_EVENTS)).toEqual(LEGISLATURES.map((l) => l.id));
  });

  it("maps old group names to today's parties, and marks what was pending as lapsed", () => {
    expect(pastPartySlug("CDS")).toBe("cds-pp");
    expect(pastPartySlug("PPD")).toBe("psd");
    expect(pastPartySlug("PRD")).toBeNull();
    const row = toPastInitiative({
      id: 1, legislature: "IV", type: "Projeto de Lei", number: "1", title: "t", status: "in_progress", phase: "Entrada",
      phaseDate: "1986-01-01", submittedAt: "1986-01-01", publishedAt: null, otherAuthor: null, textUrl: null, votes: [],
      presidency: null, topics: [], authorGroups: ["CDS", "PRD"], authorDeputyIds: [],
    });
    expect(row).toMatchObject({ status: "lapsed", partySlugs: ["cds-pp"], authorGroups: ["CDS", "PRD"] });
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};

const pastFile = () => [
  initiative(10, "Lei do PRD", [
    event("Entrada", "1986-01-10"),
    event("Votação final global", "1986-05-01", [vote("a", "Aprovado")]),
    event("Lei (Publicação DR)", "1986-06-01"),
  ], { groups: ["PRD"] }),
  initiative(11, "Projeto conjunto", [event("Entrada", "1986-02-10"), event("Votação na generalidade", "1986-03-01", [vote("b", "Rejeitado")])], { groups: ["CDS", "PRD"] }),
  initiative(12, "Proposta do Governo", [event("Entrada", "1986-02-11")], { other: "Governo" }),
];

describe("importPastLegislature", () => {
  it("replaces a legislature's initiatives, and lists groups that have no party", async () => {
    expect(await importPastLegislature(db, loaderFor({ initiatives: pastFile() }), "IV")).toEqual({
      legislature: "IV", initiatives: 3, groupsWithoutParty: ["PRD"],
    });
    expect(await importPastLegislature(db, loaderFor({ initiatives: pastFile().slice(0, 1) }), "IV")).toMatchObject({ initiatives: 1 });
    expect((await get("/legislatures")).body.items.find((l: { id: string }) => l.id === "IV").initiatives).toBe(1);
  });

  it("refuses the current legislature", async () => {
    await expect(importPastLegislature(db, loaderFor(), "XVII")).rejects.toThrow(/not a past legislature/);
  });
});

describe("legislature endpoints", () => {
  it("lists every legislature newest first, with its prime ministers", async () => {
    const { body } = await get("/legislatures");
    expect(body.items).toHaveLength(LEGISLATURES.length);
    expect(body.items[0]).toMatchObject({ id: "XVII", current: true, end: null, primeMinisters: ["Luís Montenegro"] });
    expect(body.items.at(-1)).toMatchObject({ id: "Constituinte", name: "Assembleia Constituinte", elections: ["legislativas-1975"] });
    // The outgoing government stayed on a week into the XVI as caretaker; it didn't govern it.
    expect(body.items.find((l: { id: string }) => l.id === "XVI").primeMinisters).toEqual(["Luís Montenegro"]);
  });

  it("shows who was elected, who governed, what was proposed and what happened", async () => {
    await importHistoricLegislativas(db);
    await importPastLegislature(db, loaderFor({ initiatives: pastFile() }), "IV");
    await db.insert(cases).values({ title: "Caso X", summary: "s", crimes: ["corruption"], status: "investigation", published: true, startedAt: "2010-01-01" });
    const [old] = await db
      .insert(cases)
      .values({ title: "Caso antigo", summary: "s", crimes: ["corruption"], status: "investigation", published: true, startedAt: "1990-01-01" })
      .returning();
    await db.insert(caseEvents).values({ caseId: old!.id, position: 0, date: "1986-03-01", description: "Buscas", sources: [] });

    const { status, body } = await get("/legislatures/IV");
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "IV", name: "IV Legislatura", start: "1985-11-04", end: "1987-08-13", primeMinisters: ["Aníbal Cavaco Silva"] });
    expect(body.governments.map((g: { code: string }) => g.code)).toEqual(["gc10"]);
    expect(body.presidents.map((p: { id: string }) => p.id)).toEqual(["antonio-ramalho-eanes", "mario-soares"]);
    expect(body.elections[0]).toMatchObject({ id: "legislativas-1985", totalMandates: 250 });
    expect(body.elections[0].seats[0]).toMatchObject({ list: "PPD/PSD", mandates: 88, partySlugs: ["psd"] });
    expect(body.elections[0].seats.reduce((n: number, s: { mandates: number }) => n + s.mandates, 0)).toBe(250);

    expect(body.initiatives).toMatchObject({ submitted: 3, approved: 1, rejected: 1, pending: 1, laws: 1 });
    expect(body.initiatives.byAuthor).toEqual([
      expect.objectContaining({ key: "PRD", name: "Partido Renovador Democrático", partySlug: null, submitted: 2, approved: 1, rejected: 1 }),
      expect.objectContaining({ key: "cds-pp", partySlug: "cds-pp", submitted: 1, rejected: 1 }),
      expect.objectContaining({ key: "Governo", name: "Governo", submitted: 1, pending: 1 }),
    ]);
    expect(body.events.length).toBe(LEGISLATURE_EVENTS.IV!.length);
    expect(body.cases.map((c: { title: string }) => c.title)).toEqual(["Caso antigo"]);
  });

  it("counts the current legislature's initiatives from the daily sync, and 404s unknown ids", async () => {
    expect((await get("/legislatures/XVII")).body.initiatives).toMatchObject({ submitted: 0, byAuthor: [] });
    expect((await get("/legislatures/XVIII")).status).toBe(404);
  });
});
