import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { deputies, governmentMembers, governmentPositions, presidents } from "../src/db/schema.js";
import { legislatureDates } from "../src/parliament/legislatures.js";
import { syncParliament } from "../src/parliament/sync.js";
import { deputySteps, governmentSteps, sortPath, type DeputyRecord } from "../src/people/path.js";
import { createTestDb, resetDb } from "./helpers.js";
import { loaderFor } from "./parliamentFixtures.js";

describe("path steps", () => {
  const record: DeputyRecord = {
    id: 1, constituency: "Lisboa", gender: "F", legislature: "XVII",
    sittingPeriods: [{ from: "2025-06-03", to: "2025-12-31" }, { from: "2026-02-09", to: null }],
    pastLegislatures: ["XVI", "XIV", "XVII", "Desconhecida"], positions: [], roles: [],
  };

  it("dates past legislatures by the legislature, and this one by sitting period", () => {
    const steps = sortPath(deputySteps(record));
    expect(steps.map((s) => [s.from, s.to, s.precision])).toEqual([
      ["2026-02-09", null, "day"],
      ["2025-06-03", "2025-12-31", "day"],
      ["2024-03-26", "2025-06-03", "legislature"],
      ["2019-10-25", "2022-03-29", "legislature"],
    ]);
    expect(steps[0]).toMatchObject({ title: "Deputada à Assembleia da República", detail: "XVII legislatura, eleita por Lisboa", current: true });
  });

  it("knows when each legislature ran", () => {
    expect(legislatureDates("I")).toEqual({ start: "1976-06-03", end: "1980-11-13" });
    expect(legislatureDates("XVII")).toEqual({ start: "2025-06-03", end: null });
    expect(legislatureDates("XX")).toBeNull();
  });

  it("doesn't repeat a post's area when it is the title", () => {
    expect(governmentSteps([{ title: "Primeiro-Ministro", areaName: "Primeiro-Ministro", startDate: "2025-06-05", endDate: null, url: "u" }])[0])
      .toMatchObject({ detail: null, current: true, kind: "government" });
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

beforeEach(async () => {
  await resetDb(db);
  await syncParliament(db, loaderFor());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};

const ID = "0123456789abcdef0123456789abcdef";
const addMinister = async (deputyId: number | null) => {
  await db.insert(governmentMembers).values({ id: ID, name: "Francisco César", deputyId });
  await db.insert(governmentPositions).values({
    id: "p1", memberId: ID, government: "gc25", kind: "minister", title: "Ministro da Cultura", area: "cultura",
    areaName: "Cultura", areaRank: 5, rank: 0, startDate: "2025-06-05", endDate: null, url: "https://www.portugal.gov.pt/x",
  });
};

describe("GET /people/:kind/:id/path", () => {
  it("joins a deputy's parliament record with their Government posts", async () => {
    await addMinister(7341);
    const fromDeputy = await get("/people/deputy/7341/path");
    expect(fromDeputy.status).toBe(200);
    expect(fromDeputy.body.person).toMatchObject({
      name: "Francisco César", party: { slug: "ps", acronym: "PS" },
      links: { deputyId: 7341, governmentMemberId: ID, presidentId: null },
    });
    const kinds = fromDeputy.body.path.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain("government");
    expect(kinds).toContain("parliament");
    expect(fromDeputy.body.path.find((s: { precision: string }) => s.precision === "legislature")).toMatchObject({ detail: "XVI legislatura" });

    // The same person from the Government side.
    const fromMember = await get(`/people/government/${ID}/path`);
    expect(fromMember.body.person.links).toEqual(fromDeputy.body.person.links);
    expect(fromMember.body.path).toEqual(fromDeputy.body.path);
  });

  it("serves Government members who were never deputies, and Presidents", async () => {
    await addMinister(null);
    const member = await get(`/people/government/${ID}/path`);
    expect(member.body.path).toEqual([expect.objectContaining({ title: "Ministro da Cultura", detail: "Cultura", source: "https://www.portugal.gov.pt/x" })]);
    expect(member.body.currentRoles).toEqual([]);

    const president = await get("/people/president/marcelo-rebelo-de-sousa/path");
    expect(president.body.path).toEqual([
      expect.objectContaining({ from: "2016-03-09", to: "2026-03-09", title: "Presidente da República", current: false }),
    ]);
  });

  it("answers 404 for people we don't know, and 400 for bad input", async () => {
    expect((await get("/people/deputy/999/path")).status).toBe(404);
    expect((await get("/people/deputy/abc/path")).status).toBe(404);
    expect((await get(`/people/government/${"f".repeat(32)}/path`)).status).toBe(404);
    expect((await get("/people/president/nobody/path")).status).toBe(404);
    expect((await get("/people/mayor/1/path")).status).toBe(400);
  });
});

describe("GET /people/featured", () => {
  it("lists the President, the Prime Minister and party leaders who sit in parliament", async () => {
    await db.insert(presidents).values({ id: "antonio-jose-seguro", name: "António José Seguro", fullName: "x", termStart: "2026-03-09" });
    await db.insert(governmentMembers).values({ id: ID, name: "Luís Montenegro" });
    await db.insert(governmentPositions).values({
      id: "pm", memberId: ID, government: "gc25", kind: "prime_minister", title: "Primeiro-Ministro", area: "primeiro-ministro",
      areaName: "Primeiro-Ministro", areaRank: 0, rank: 0, startDate: "2025-06-05", endDate: null, url: "u",
    });
    await db.update(deputies).set({ parliamentRole: "Presidente" }).where(eq(deputies.id, 817));
    const { body } = await get("/people/featured");
    expect(body.items.map((i: { kind: string; role: string }) => [i.kind, i.role])).toEqual([
      ["president", "Presidente da República"],
      ["government", "Primeiro-Ministro"],
      ["deputy", "Presidente da Assembleia da República"],
    ]);
  });
});
