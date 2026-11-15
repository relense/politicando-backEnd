import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ElectionDef } from "../src/elections/catalog.js";
import { importElection, type ElectionSource } from "../src/elections/import.js";
import { dicofreOf, levelOf, maiUrls, parseResults, partiesInList } from "../src/elections/mai.js";
import { placeNameKey, v3Urls } from "../src/elections/maiV3.js";
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

  it("reads the newest platform's shape and works out the share of valid votes", () => {
    const parsed = parseResults({
      data: {
        currentResults: {
          totalVoters: 1000, subscribedVoters: 2000, percentageVoters: 50, blankVotes: 60, nullVotes: 40, totalMandates: 7,
          resultsParty: [{ id: 1758, acronym: "PS", votes: 450, percentage: 45, mandates: 4, presidents: 1 }],
        },
      },
    })!;
    expect(parsed.turnout.voters).toBe(1000);
    expect(parsed.lists[0]).toMatchObject({ list: "PS", optionId: 1758, pct: 45, validPct: 50, presidents: 1 });
  });

  it("matches place names across elections", () => {
    expect(placeNameKey("Belazaima do Chão, Castanheira do Vouga e Agadão")).toBe("belazaima do chao castanheira do vouga e agadao");
    expect(placeNameKey("ÁGUEDA")).toBe(placeNameKey("Águeda"));
  });

  it("knows our parties in ballot lists, including coalitions", () => {
    expect(partiesInList("PPD/PSD.CDS-PP")).toEqual(["psd", "cds-pp"]);
    expect(partiesInList("PPD/PSD.CDS-PP.PPM")).toEqual(["psd", "cds-pp", "ppm"]);
    expect(partiesInList("B.E.")).toEqual(["be"]);
    expect(partiesInList("R.I.R.")).toEqual(["rir"]);
    expect(partiesInList("PCP-PEV")).toEqual(["pcp", "pev"]);
    expect(partiesInList("CH")).toEqual(["chega"]);
    expect(partiesInList("ADN")).toEqual(["adn"]);
    expect(partiesInList("PS.L")).toEqual(["ps", "livre"]);
    expect(partiesInList("P.N.R.")).toEqual([]);
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
    expect(await importElection(db, source, LEGISLATIVAS)).toEqual({ places: 5, skipped: 0, missing: 0, lists: 3, unmatched: 0 });
    expect(requested.some((u) => u.includes("LOCAL-010103"))).toBe(false); // No parishes for AR by default.

    const again = sourceFor(siteFor(LEGISLATIVAS));
    expect(await importElection(db, again.source, LEGISLATIVAS)).toMatchObject({ places: 0, skipped: 5 });
    expect(again.requested.some((u) => u.includes("territory-results"))).toBe(false);

    const autarquicas = sourceFor(siteFor(AUTARQUICAS));
    // No global total: starts at the national level. CM stops at municipalities, AF reaches parishes.
    expect(await importElection(db, autarquicas.source, AUTARQUICAS)).toMatchObject({ places: 3 + 5, missing: 2 });
  });
});

const AUTARQUICAS_2025: ElectionDef = {
  id: "autarquicas-2025", type: "autarquicas", name: "Autárquicas 2025", date: "2025-10-12",
  site: "autarquicas2025", platform: "v3", organs: ["CM", "AF"],
};

/** The newest platform: numeric ids, no codes. Águeda now has a parish restored in 2025. */
const v3SiteFiles = () => {
  const u = v3Urls(AUTARQUICAS_2025);
  const res = (voters: number, lists: [number, string, number][]) => ({
    data: {
      currentResults: {
        totalVoters: voters, subscribedVoters: voters * 2, percentageVoters: 50, blankVotes: 0, nullVotes: 0, totalMandates: 0,
        resultsParty: lists.map(([id, acronym, votes]) => ({ id, acronym, votes, percentage: (votes / voters) * 100, mandates: null, presidents: null })),
      },
    },
  });
  const files: Record<string, unknown> = {
    [u.settings]: { electionId: 1 },
    [u.election(1)]: {
      data: { mainTerritories: [{ id: 1, description: "PORTUGAL" }], organs: [{ id: 4, key: "CM" }, { id: 6, key: "AF" }] },
    },
    [u.options(1)]: {
      data: [
        { id: 10, typeId: 1, name: "PS", description: "Partido Socialista" },
        { id: 20, typeId: 2, name: "PPD/PSD.CDS-PP", description: "Viva Águeda" },
        { id: 21, typeId: 2, name: "PPD/PSD.CDS-PP", description: "AD Aveiro" },
        { id: 30, typeId: 3, name: "MBV", description: "Movimento Borralha Viva" },
      ],
    },
    [u.children(1, 1)]: { data: [{ id: 2, parentId: 1, typeId: 5, descriptionShort: "Aveiro" }] },
    [u.children(1, 2)]: { data: [{ id: 3, parentId: 2, typeId: 6, descriptionShort: "ÁGUEDA" }] },
    [u.children(1, 3)]: {
      data: [
        { id: 4, parentId: 3, typeId: 7, descriptionShort: "Aguada de Cima" },
        { id: 5, parentId: 3, typeId: 7, descriptionShort: "Barrô" },
        { id: 99, parentId: 3, typeId: 7, descriptionShort: "Borralha" },
      ],
    },
  };
  for (const organ of [4, 6]) {
    for (const t of [1, 2, 3]) files[u.results(1, t, organ)] = res(900, [[20, "PPD/PSD.CDS-PP", 500], [10, "PS", 400]]);
  }
  files[u.results(1, 4, 6)] = res(300, [[10, "PS", 200], [20, "PPD/PSD.CDS-PP", 100]]);
  files[u.results(1, 5, 6)] = res(500, [[20, "PPD/PSD.CDS-PP", 300], [10, "PS", 200]]);
  files[u.results(1, 99, 6)] = res(100, [[30, "MBV", 60], [10, "PS", 40]]);
  return files;
};

describe("importElection on the newest platform", () => {
  it("refuses to guess places when the previous autárquicas aren't there to match against", async () => {
    await expect(importElection(db, sourceFor(v3SiteFiles()).source, AUTARQUICAS_2025)).rejects.toThrow(/previous autárquicas/);
  });

  it("matches places by name to earlier elections, and keys new parishes by the site's id", async () => {
    await importElection(db, sourceFor(siteFor(AUTARQUICAS)).source, AUTARQUICAS);
    const stats = await importElection(db, sourceFor(v3SiteFiles()).source, AUTARQUICAS_2025);
    expect(stats).toMatchObject({ places: 3 + 6, missing: 0, lists: 3, unmatched: 1 });

    const town = await get("/elections/autarquicas-2025/places/LOCAL-010100?organ=AF");
    expect(town.status).toBe(200);
    expect(town.body.breadcrumb.map((p: { key: string }) => p.key)).toEqual(["LOCAL-500000", "LOCAL-010000"]);
    // The coalition's local name, not one of its many others.
    expect(town.body.lists[0]).toMatchObject({ list: "PPD/PSD.CDS-PP", name: "Viva Águeda", partySlugs: ["psd", "cds-pp"], validPct: 55.56 });
    expect(town.body.lists[1]).toMatchObject({ list: "PS", name: "Partido Socialista" });
    expect(town.body.children.map((c: { key: string; dicofre: string | null; winner: { list: string } }) => [c.key, c.dicofre, c.winner.list])).toEqual([
      ["LOCAL-010103", "010103", "PS"],
      ["LOCAL-010121", "010121", "PPD/PSD.CDS-PP"],
      ["AUTARQUICAS2025-99", null, "MBV"],
    ]);

    const restored = await get("/places/AUTARQUICAS2025-99");
    expect(restored.body).toMatchObject({ name: "Borralha", level: "parish", dicofre: null, parent: { key: "LOCAL-010100" } });

    // Re-running matches the restored parish to the key it got the first time.
    expect(await importElection(db, sourceFor(v3SiteFiles()).source, AUTARQUICAS_2025)).toMatchObject({ places: 0, skipped: 9 });
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

  it("ranks parties by votes in the latest legislativas, sharing coalition votes", async () => {
    const { body } = await get("/parties?sort=votes");
    expect(body.slice(0, 4).map((p: { slug: string }) => p.slug)).toEqual(["cds-pp", "psd", "ps", "be"]);
    expect(body[1].lastElection).toEqual({
      id: "legislativas-2025", date: "2025-05-18", votes: 500, validPct: 50.76, mandates: 2,
      lists: ["PPD/PSD.CDS-PP"], coalition: true,
    });
    expect(body.find((p: { slug: string }) => p.slug === "chega").lastElection).toBeNull();
    expect((await get("/parties?sort=seats")).body[0].slug).toBe("psd");
    expect((await get("/parties?sort=bogus")).status).toBe(400);
  });

  it("describes places with parent and children", async () => {
    const { body } = await get("/places/LOCAL-010100");
    expect(body).toMatchObject({ name: "Águeda", level: "municipality", dicofre: "0101", parent: { name: "Aveiro" } });
    expect(body.children.map((c: { name: string }) => c.name)).toEqual(["Aguada de Cima", "Barrô"]);
  });
});
