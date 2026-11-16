import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { places } from "../src/db/schema.js";
import type { RecaptchaVerifier } from "../src/modules/comments/recaptcha.js";
import { contains, inverseTm, PROJECTIONS, simplifyRing } from "../src/places/geo.js";
import { municipalityAt, type ShapeFile } from "../src/places/locate.js";
import { createTestDb, resetDb } from "./helpers.js";

describe("geometry", () => {
  it("converts CAOP's projections to degrees", () => {
    // The mainland projection's origin is its reference point.
    expect(inverseTm(PROJECTIONS.mainland, 0, 0).map((v) => v.toFixed(6))).toEqual(["-8.133108", "39.668258"]);
    // UTM: the central meridian at the false easting.
    const [lon, lat] = inverseTm(PROJECTIONS.utm28, 500_000, 3_615_000);
    expect(lon).toBeCloseTo(-15, 6);
    expect(lat).toBeCloseTo(32.67, 1);
  });

  it("treats holes as outside", () => {
    const square = (a: number, b: number) => [a, a, b, a, b, b, a, b];
    expect(contains([square(0, 10)], 5, 5)).toBe(true);
    expect(contains([square(0, 10), square(4, 6)], 5, 5)).toBe(false);
    expect(contains([square(0, 10), square(4, 6)], 2, 2)).toBe(true);
  });

  it("simplifies a ring but keeps it a polygon", () => {
    const ring: [number, number][] = [[0, 0], [5, 0.01], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyRing(ring, 1)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it("falls back to the nearest municipality just outside every outline", () => {
    const file: ShapeFile = {
      source: "test",
      municipalities: { "0001": { name: "A", bbox: [0, 0, 1, 1], rings: [[0, 0, 1, 0, 1, 1, 0, 1]] } },
    };
    expect(municipalityAt(0.5, 0.5, file)).toBe("0001");
    expect(municipalityAt(0.5, 1.005, file)).toBe("0001");
    expect(municipalityAt(0.5, 1.05, file)).toBeNull();
  });
});

describe("CAOP 2024 outlines", () => {
  it.each([
    ["Lisboa", 38.72, -9.14, "1106"],
    ["Porto", 41.1496, -8.611, "1312"],
    ["Faro", 37.0194, -7.9304, "0805"],
    ["Funchal", 32.6669, -16.9241, "3103"],
    ["Ponta Delgada", 37.7412, -25.6756, "4203"],
    ["Corvo", 39.7, -31.11, "4901"],
    ["Madrid", 40.4168, -3.7038, null],
    ["the Atlantic", 38.5, -12, null],
  ])("puts %s in %s", (_name, lat, lon, code) => {
    expect(municipalityAt(lat, lon)).toBe(code);
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: vi.fn<RecaptchaVerifier>() });

describe("GET /places/locate", () => {
  beforeEach(async () => {
    await resetDb(db);
    await db.insert(places).values([
      { key: "LOCAL-110000", name: "Lisboa", level: "district", parentKey: null, dicofre: "11" },
      { key: "LOCAL-110600", name: "Lisboa", level: "municipality", parentKey: "LOCAL-110000", dicofre: "1106" },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  const get = async (query: string) => {
    const response = await app.inject({ method: "GET", url: `/api/v2/places/locate?${query}` });
    return { status: response.statusCode, body: response.json() };
  };

  it("returns the municipality at the point", async () => {
    expect(await get("lat=38.72&lon=-9.14")).toEqual({
      status: 200,
      body: { key: "LOCAL-110600", name: "Lisboa", level: "municipality", parentKey: "LOCAL-110000", dicofre: "1106" },
    });
  });

  it("answers 404 outside Portugal and 400 for bad coordinates", async () => {
    expect(await get("lat=40.41&lon=-3.70")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect((await get("lat=abc&lon=-9")).status).toBe(400);
    expect((await get("lat=95&lon=-9")).status).toBe(400);
    expect((await get("lat=38")).status).toBe(400);
  });
});
