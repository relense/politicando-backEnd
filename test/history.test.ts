import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { GOVERNMENTS, LEGISLATIVE_ELECTION_DATES, portalUrl } from "../src/government/history.js";
import { PRESIDENTS } from "../src/presidency/presidents.js";
import { createTestDb, resetDb } from "./helpers.js";

describe("the curated history", () => {
  it("has no gaps or overlaps: each government ends the day the next one starts", () => {
    for (let i = 1; i < GOVERNMENTS.length; i++) expect(GOVERNMENTS[i]!.start).toBe(GOVERNMENTS[i - 1]!.end);
    expect(GOVERNMENTS.filter((g) => g.end === null)).toEqual([GOVERNMENTS.at(-1)]);
    expect(new Set(GOVERNMENTS.map((g) => g.code)).size).toBe(GOVERNMENTS.length);
  });

  it("numbers the constitutional governments I to XXV with the portal's codes", () => {
    const constitutional = GOVERNMENTS.filter((g) => g.kind === "constitutional");
    expect(constitutional.map((g) => g.code)).toEqual(Array.from({ length: 25 }, (_, i) => `gc${String(i + 1).padStart(2, "0")}`));
    expect(constitutional[0]).toMatchObject({ primeMinister: "Mário Soares", start: "1976-07-23" });
  });

  it("matches the dates on the Government's list of heads of government", () => {
    // From "Chefes do Governo desde 1821" on portugal.gov.pt, checked 2026-11-15.
    const official: [string, string][] = [
      ["gc03", "1978-08-29"], ["gc06", "1980-01-03"], ["gc07", "1981-01-09"], ["gc10", "1985-11-06"],
      ["gc13", "1995-10-28"], ["gc15", "2002-04-06"], ["gc16", "2004-07-17"], ["gc19", "2011-06-21"],
    ];
    for (const [code, start] of official) expect(GOVERNMENTS.find((g) => g.code === code)?.start).toBe(start);
  });

  it("keeps Presidents' terms back to back, and elections in order", () => {
    for (let i = 1; i < PRESIDENTS.length; i++) expect(PRESIDENTS[i]!.termStart).toBe(PRESIDENTS[i - 1]!.termEnd);
    expect([...LEGISLATIVE_ELECTION_DATES].sort()).toEqual(LEGISLATIVE_ELECTION_DATES);
  });

  it("links to the portal only where it has pages", () => {
    expect(portalUrl("gc21")).toBe("https://www.portugal.gov.pt/pt/gc21");
    expect(portalUrl("gc20")).toBeNull();
    expect(portalUrl("gp6")).toBeNull();
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

describe("GET /governments/history", () => {
  it("lists every government newest first, with parties and how it ended", async () => {
    const { body } = await get("/governments/history");
    expect(body.items).toHaveLength(31);
    expect(body.items[0]).toMatchObject({ code: "gc25", current: true, end: null, endReason: "in_office", portalUrl: "https://www.portugal.gov.pt/pt/gc25" });
    const ad = body.items.find((g: { code: string }) => g.code === "gc06");
    expect(ad.parties.map((p: { slug: string }) => p.slug)).toEqual(["psd", "cds-pp", "ppm"]);
    expect(ad).toMatchObject({ endReason: "death", days: 372, current: false });
    expect(body.items.at(-1)).toMatchObject({ code: "gp1", kind: "provisional", parties: [] });
  });
});

describe("GET /timeline", () => {
  it("puts governments, elections and Presidents on one line, newest first", async () => {
    const { body } = await get("/timeline");
    const kinds = new Set(body.items.map((i: { kind: string }) => i.kind));
    expect(kinds).toEqual(new Set(["government", "election", "president"]));
    const dates = body.items.map((i: { date: string }) => i.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(body.items).toContainEqual({
      kind: "election", date: "1975-04-25", endDate: null, title: "Eleições para a Assembleia Constituinte", detail: null, ref: null,
    });
  });

  it("filters by kind and by period", async () => {
    const presidents = await get("/timeline?kinds=president");
    expect(presidents.body.items.map((i: { ref: { id: string } }) => i.ref.id)).toEqual(
      [...PRESIDENTS].reverse().map((p) => p.id),
    );
    // Spans that overlap the period count; Cavaco Silva's term ended in 2016.
    const recent = await get("/timeline?kinds=president,government&from=2016-01-01&to=2016-12-31");
    expect(recent.body.items.map((i: { title: string }) => i.title)).toEqual([
      "Presidente da República: Marcelo Rebelo de Sousa",
      "XXI Governo Constitucional",
      "Presidente da República: Aníbal Cavaco Silva",
    ]);
    expect((await get("/timeline?kinds=wars")).status).toBe(400);
  });
});
