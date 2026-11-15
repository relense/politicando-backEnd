import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ElectionDef } from "../src/elections/catalog.js";
import { importElection, type ElectionSource } from "../src/elections/import.js";
import { dicofreOf, levelOf, maiUrls, parseResults, partiesInList } from "../src/elections/mai.js";
import { createTestDb, resetDb } from "./helpers.js";

const results = (voters: number, lists: [string, number, number | null][], totalMandates = 0) => ({
  currentResults: {
    numberVoters: voters,
    subscribedVoters: voters * 2,
    percentageVoters: 50,
    blankVotes: 10,
    nullVotes: 5,
    totalMandates,
    resultsParty: lists.map(([acronym, votes, mandates]) => ({
      acronym, votes, mandates, percentage: (votes / voters) * 100, validVotesPercentage: (votes / (voters - 15)) * 100, presidents: null,
    })),
  },
});

const LEGISLATIVAS: ElectionDef = {
  id: "legislativas-2025", type: "legislativas", name: "Legislativas 2025", date: "2025-05-18",
  site: "legislativas2025", platform: "new", organs: ["AR"],
};
const AUTARQUICAS: ElectionDef = {
  id: "autarquicas-2017", type: "autarquicas", name: "Autárquicas 2017", date: "2017-10-01",
  site: "autarquicas2017", platform: "old", organs: ["CM", "AF"],
};

/** A tiny country: one district with one municipality of two parishes, plus abroad. */
const siteFor = (election: ElectionDef): Record<string, unknown> => {
  const u = maiUrls(election);
  const files: Record<string, unknown> = {};
  for (const organ of election.organs) {
    if (election.type === "legislativas") {
      files[u.results("GLOBAL-990000", organ)] = results(1000, [["PPD/PSD.CDS-PP", 500, 2], ["PS", 300, 1], ["B.E.", 185, 0]], 3);
      files[u.results("FOREIGN-600000", organ)] = results(100, [["PS", 60, 0], ["PPD/PSD.CDS-PP", 25, 0]]);
    }
    files[u.results("LOCAL-500000", organ)] = results(900, [["PPD/PSD.CDS-PP", 475, 2], ["PS", 240, 1], ["B.E.", 170, 0]]);
    files[u.results("LOCAL-010000", organ)] = results(900, [["PPD/PSD.CDS-PP", 475, 2], ["PS", 240, 1], ["B.E.", 170, 0]], 3);
    files[u.results("LOCAL-010100", organ)] = results(900, [["PS", 480, null], ["PPD/PSD.CDS-PP", 405, null]]);
    files[u.results("LOCAL-010103", organ)] = results(400, [["PS", 300, null], ["PPD/PSD.CDS-PP", 85, null]]);
    files[u.results("LOCAL-010121", organ)] = results(500, [["PPD/PSD.CDS-PP", 320, null], ["PS", 165, null]]);
    files[u.lists(organ)] = [
      { acronym: "PPD/PSD.CDS-PP", name: "AD - COLIGAÇÃO PSD/CDS", coalition: true, groupOfCitizens: false },
      { acronym: "PS", name: "Partido Socialista", coalition: false, groupOfCitizens: false },
      { acronym: "B.E.", name: "Bloco de Esquerda", coalition: false, groupOfCitizens: false },
    ];
  }
  files[u.children("LOCAL-500000")] = [{ name: "Aveiro", territoryKey: "LOCAL-010000" }];
  files[u.children("LOCAL-010000")] = [{ name: "Águeda", territoryKey: "LOCAL-010100" }];
  files[u.children("LOCAL-010100")] = [
    { name: "Barrô", territoryKey: "LOCAL-010121" },
    { name: "Aguada de Cima", territoryKey: "LOCAL-010103" },
  ];
  files[u.children("FOREIGN-600000")] = [];
  return files;
};

const sourceFor = (files: Record<string, unknown>) => {
  const requested: string[] = [];
  const source: ElectionSource = {
    get: async (url) => {
      requested.push(url);
      return url in files ? { status: "ok", body: JSON.stringify(files[url]) } : { status: "blocked", reason: "HTTP 404" };
    },
  };
  return { source, requested };
};

describe("results files", () => {
  it("parses turnout and lists, and rejects files with no count", () => {
    const parsed = parseResults(results(1000, [["PS", 300, 1]], 3))!;
    expect(parsed.turnout).toEqual({ registered: 2000, voters: 1000, turnoutPct: 50, blank: 10, null: 5, totalMandates: 3 });
    expect(parsed.lists[0]).toMatchObject({ list: "PS", votes: 300, mandates: 1 });
    expect(parseResults({ currentResults: {} })).toBeNull();
    expect(parseResults("Not found")).toBeNull();
  });

  it("knows our parties in ballot lists, including coalitions", () => {
    expect(partiesInList("PPD/PSD.CDS-PP")).toEqual(["psd", "cds-pp"]);
    expect(partiesInList("PPD/PSD.CDS-PP.PPM")).toEqual(["psd", "cds-pp"]);
    expect(partiesInList("B.E.")).toEqual(["be"]);
    expect(partiesInList("PCP-PEV")).toEqual(["pcp"]);
    expect(partiesInList("CH")).toEqual(["chega"]);
    expect(partiesInList("ADN")).toEqual([]);
    expect(partiesInList("Marcelo Rebelo de Sousa")).toEqual([]);
  });

  it("reads levels and DICOFRE codes from keys", () => {
    expect(["GLOBAL-990000", "LOCAL-500000", "FOREIGN-800000", "LOCAL-400000", "LOCAL-010100", "LOCAL-010121"].map(levelOf)).toEqual([
      "global", "national", "foreign", "district", "municipality", "parish",
    ]);
    expect(["LOCAL-010000", "LOCAL-010100", "LOCAL-010121", "GLOBAL-990000"].map(dicofreOf)).toEqual(["01", "0101", "010121", null]);
  });

  it("builds file names for both platforms", () => {
    expect(maiUrls(LEGISLATIVAS).results("LOCAL-010000", "AR")).toBe(
      "https://www.eleicoes.mai.gov.pt/legislativas2025/assets/static/territory-results/territory-results-LOCAL-010000-AR.json",
    );
    expect(maiUrls(AUTARQUICAS).results("LOCAL-010100", "CM")).toBe(
      "https://www.eleicoes.mai.gov.pt/autarquicas2017/static-data/territory-results/TERRITORY-RESULTS-LOCAL-010100-CM.json",
    );
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

describe("importElection", () => {
  it("imports down to municipalities, skips what's stored, and goes to parishes for juntas", async () => {
    const { source, requested } = sourceFor(siteFor(LEGISLATIVAS));
    expect(await importElection(db, source, LEGISLATIVAS)).toEqual({ places: 5, skipped: 0, missing: 0, lists: 3 });
    expect(requested.some((u) => u.includes("LOCAL-010103"))).toBe(false); // No parishes for AR by default.

    const again = sourceFor(siteFor(LEGISLATIVAS));
    expect(await importElection(db, again.source, LEGISLATIVAS)).toMatchObject({ places: 0, skipped: 5 });
    expect(again.requested.some((u) => u.includes("territory-results"))).toBe(false);

    const autarquicas = sourceFor(siteFor(AUTARQUICAS));
    // No global total: starts at the national level. CM stops at municipalities, AF reaches parishes.
    expect(await importElection(db, autarquicas.source, AUTARQUICAS)).toMatchObject({ places: 3 + 5, missing: 2 });
  });
});

describe("election endpoints", () => {
  beforeEach(async () => {
    await importElection(db, sourceFor(siteFor(LEGISLATIVAS)).source, LEGISLATIVAS);
    await importElection(db, sourceFor(siteFor(AUTARQUICAS)).source, AUTARQUICAS);
  });

  it("lists elections newest first with the winner and turnout", async () => {
    const { body } = await get("/elections");
    expect(body.items.map((e: { id: string }) => e.id)).toEqual(["legislativas-2025", "autarquicas-2017"]);
    expect(body.items[0]).toMatchObject({
      imported: true,
      turnout: { voters: 1000, totalMandates: 3 },
      winner: { list: "PPD/PSD.CDS-PP", name: "AD - COLIGAÇÃO PSD/CDS", partySlugs: ["psd", "cds-pp"], mandates: 2 },
    });
    expect((await get("/elections?type=autarquicas")).body.items).toHaveLength(1);
  });

  it("returns the whole country with its children, and drills down with a breadcrumb", async () => {
    const top = await get("/elections/legislativas-2025");
    expect(top.status).toBe(200);
    expect(top.body.place).toMatchObject({ key: "GLOBAL-990000", level: "global" });
    expect(top.body.children.map((c: { key: string }) => c.key)).toEqual(["FOREIGN-600000", "LOCAL-500000"]);

    const town = await get("/elections/legislativas-2025/places/LOCAL-010100");
    expect(town.body.breadcrumb.map((p: { name: string }) => p.name)).toEqual(["Total", "Território nacional", "Aveiro"]);
    expect(town.body.lists[0]).toMatchObject({ list: "PS", votes: 480 });

    const juntas = await get("/elections/autarquicas-2017/places/LOCAL-010100?organ=AF");
    expect(juntas.body.children.map((c: { name: string; winner: { list: string } }) => [c.name, c.winner.list])).toEqual([
      ["Aguada de Cima", "PS"],
      ["Barrô", "PPD/PSD.CDS-PP"],
    ]);
    expect((await get("/elections/autarquicas-2017")).body.place.key).toBe("LOCAL-500000");
  });

  it("rejects unknown elections, bodies and places", async () => {
    expect((await get("/elections/legislativas-1999")).status).toBe(404);
    expect((await get("/elections/legislativas-2025?organ=CM")).status).toBe(400);
    expect((await get("/elections/legislativas-2025/places/LOCAL-010103")).status).toBe(404);
    expect((await get("/elections/nope")).status).toBe(400);
  });

  it("describes places with parent and children", async () => {
    const { body } = await get("/places/LOCAL-010100");
    expect(body).toMatchObject({ name: "Águeda", level: "municipality", dicofre: "0101", parent: { name: "Aveiro" } });
    expect(body.children.map((c: { name: string }) => c.name)).toEqual(["Aguada de Cima", "Barrô"]);
  });
});
