import { deflateRawSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { readFirstSheet, unzip } from "../src/elections/xlsx.js";
import { electionCandidates, electionResults, elections, electionTurnout, places } from "../src/db/schema.js";
import { importLocalElected, membersOf, parseElectedSheet, type LocalElectedFile } from "../src/places/localElected.js";
import { syncLocalOfficials } from "../src/places/localOfficials.js";
import { createTestDb, resetDb } from "./helpers.js";

/** A zip with the given files, the first stored and the rest deflated. */
const makeZip = (files: Record<string, string>) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], i) => {
    const raw = Buffer.from(content, "utf8");
    const data = i === 0 ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(i === 0 ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(i === 0 ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

describe("reading the official map's spreadsheet", () => {
  it("unzips stored and deflated files, and reads a sheet's shared, rich and inline strings", () => {
    const xlsx = makeZip({
      "xl/sharedStrings.xml": `<?xml version="1.0"?><sst><si><t>III - ELEITOS</t></si><si><t xml:space="preserve"> Águeda </t></si><si><r><t>CM</t></r></si><si><t>ANA EXEMPLO</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c></row>
        <row r="3"><c r="A3"><v>10100</v></c><c r="B3" t="s"><v>1</v></c><c r="D3" t="s"><v>2</v></c></row>
        <row r="4"><c r="B4" t="inlineStr"><is><t>PS</t></is></c></row>
        <row r="5"><c r="B5" t="s"><v>3</v></c></row>
      </sheetData></worksheet>`,
    });
    expect([...unzip(xlsx).keys()]).toEqual(["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
    expect(readFirstSheet(xlsx)).toEqual([["III - ELEITOS"], [], ["10100", "Águeda", null, "CM"], [null, "PS"], [null, "ANA EXEMPLO"]]);
  });

  it("splits the sheet into bodies, including parish codes with letters", () => {
    const bodies = parseElectedSheet([
      ["III - ELEITOS"],
      ["CÓD", "CONC", "FREG", "ÓRG"],
      ["10100", "Águeda", null, "CM"],
      ["PS", "CH", null, null],
      ["ANA", "RUI"],
      ["0302FA", "Barcelos", "União das freguesias de Milhazes", "AF"],
      ["PS"],
    ]);
    expect(bodies).toEqual([
      { code: "10100", municipality: "Águeda", parish: null, organ: "CM", rows: [["PS", "CH"], ["ANA", "RUI"]] },
      { code: "0302FA", municipality: "Barcelos", parish: "União das freguesias de Milhazes", organ: "AF", rows: [["PS"]] },
    ]);
  });

  it("reads names down each list's column, across a second row of lists, matching codes loosely", () => {
    const winners = new Set(["MTG 2030", "PS", "CH", "IL", "Junceira Viva"]);
    expect(
      membersOf(
        [
          ["MTG2030", "PS", "CH", "XYZ"],
          ["ANA UM", "RUI DOIS", "EVA TRÊS", "ZÉ NINGUÉM"],
          ["LUÍS QUATRO", null, null, null],
          // A citizens' group whose code has spaces starts a new group of columns.
          ["IL", "junceira viva"],
          ["PEDRO CINCO", "MARTA SEIS"],
        ],
        winners,
      ),
    ).toEqual([
      { list: "MTG 2030", position: 1, name: "ANA UM" },
      { list: "PS", position: 1, name: "RUI DOIS" },
      { list: "CH", position: 1, name: "EVA TRÊS" },
      { list: "MTG 2030", position: 2, name: "LUÍS QUATRO" },
      { list: "IL", position: 1, name: "PEDRO CINCO" },
      { list: "Junceira Viva", position: 1, name: "MARTA SEIS" },
    ]);
    expect(membersOf([], winners)).toBeNull();
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
  return { status: response.statusCode, body: response.json(), headers: response.headers };
};

const ELECTION = "autarquicas-2025";

/** Águeda (CM, AM) with two parishes: one with an official code, one created in 2025 with a key of ours. */
const seed = async () => {
  await db.insert(elections).values({
    id: ELECTION, type: "autarquicas", name: "Autárquicas 2025", date: "2025-10-12", organs: ["CM", "AM", "AF"], sourceUrl: "https://example.test", importedAt: new Date(),
  });
  await db.insert(places).values([
    { key: "LOCAL-010000", name: "Aveiro", level: "district", parentKey: null, dicofre: "01" },
    { key: "LOCAL-010100", name: "Águeda", level: "municipality", parentKey: "LOCAL-010000", dicofre: "0101" },
    { key: "LOCAL-010103", name: "Aguada de Cima", level: "parish", parentKey: "LOCAL-010100", dicofre: "010103" },
    { key: "AUTARQUICAS2025-99", name: "Borralha", level: "parish", parentKey: "LOCAL-010100", dicofre: null },
  ]);
  const result = (placeKey: string, organ: string, list: string, votes: number, mandates: number, label: string | null = null) => ({
    electionId: ELECTION, organ, placeKey, list, label, votes, pct: votes / 10, validPct: votes / 10, mandates,
  });
  await db.insert(electionResults).values([
    result("LOCAL-010100", "CM", "PPD/PSD.MPT", 600, 2, "Viva Águeda"),
    result("LOCAL-010100", "CM", "PS", 400, 1),
    result("LOCAL-010100", "AM", "PPD/PSD.MPT", 600, 2, "Viva Águeda"),
    result("LOCAL-010100", "AM", "PS", 400, 2),
    result("LOCAL-010103", "AF", "PS", 300, 2),
    result("LOCAL-010103", "AF", "PPD/PSD.MPT", 200, 1),
    result("AUTARQUICAS2025-99", "AF", "MBV", 60, 1),
  ]);
  await db.insert(electionTurnout).values(
    [["LOCAL-010100", "CM", 3], ["LOCAL-010100", "AM", 4], ["LOCAL-010103", "AF", 3], ["AUTARQUICAS2025-99", "AF", 1]].map(([placeKey, organ, total]) => ({
      electionId: ELECTION, organ: organ as string, placeKey: placeKey as string, voters: 1000, turnoutPct: 50, blank: 0, null: 0, totalMandates: total as number,
    })),
  );
  // The mayor, from the results site, with a page of their own.
  await db.insert(electionCandidates).values({
    electionId: ELECTION, placeKey: "LOCAL-010100", list: "PPD/PSD.MPT", kind: "effective", position: 1, name: "Jorge Almeida", elected: true, deputyId: null,
  });
  await syncLocalOfficials(db);
};

const FILE: LocalElectedFile = {
  election: ELECTION,
  source: { name: "CNE, Mapa Oficial n.º 2-B/2025", url: "https://www.cne.pt/content/eleicoes-autarquicas-2025", asOf: "2026-08-06" },
  bodies: [
    { code: "10100", municipality: "Águeda", parish: null, organ: "CM", rows: [["PPD/PSD.MPT", "PS"], ["JORGE ALMEIDA", "FRANCISCO VITORINO"], ["MARLENE GAIO"]] },
    // The map is missing one of the PS names here: that list shows none rather than the wrong people.
    { code: "10100", municipality: "Águeda", parish: null, organ: "AM", rows: [["PPD/PSD.MPT", "PS"], ["JOSÉ PEREIRA", "JOÃO FERNANDES"], ["MARIA RIBEIRO"]] },
    { code: "10103", municipality: "Águeda", parish: "Aguada de Cima", organ: "AF", rows: [["PS", "PPD/PSD.MPT"], ["RUI DE SOUSA", "ANA COSTA"], ["EVA DIAS"]] },
    // Created in 2025: the map has a code of its own, we match it by name.
    { code: "10133", municipality: "Águeda", parish: "BORRALHA", organ: "AF", rows: [["MBV"], ["LUÍS DA BORRALHA"]] },
    { code: "10199", municipality: "Águeda", parish: "Nenhures", organ: "AF", rows: [["PS"], ["X"]] },
  ],
};

describe("local elected officials by name", () => {
  it("imports the map once, reporting what didn't line up, and skips it while unchanged", async () => {
    await seed();
    expect(await importLocalElected(db, FILE)).toEqual({
      election: ELECTION, bodies: 5, members: 10, unmatched: ["AF Águeda / Nenhures"], unreadable: [], mismatched: ["AM Águeda: PS 1/2"],
    });
    expect(await importLocalElected(db, FILE)).toEqual({ election: ELECTION, skipped: "unchanged" });

    // A rectification replaces the names.
    const fixed = structuredClone(FILE);
    fixed.bodies[1]!.rows.push([null, "CARLA TAVARES"]);
    fixed.source.asOf = "2026-09-01";
    expect(await importLocalElected(db, fixed)).toMatchObject({ members: 11, mismatched: [] });
    const [row] = (await db.execute<{ as_of: string }>(sql`select as_of::text from local_elected_sources`)).rows;
    expect(row?.as_of).toBe("2026-09-01");
  });

  it("waits for the election's results before loading names", async () => {
    expect(await importLocalElected(db, FILE)).toEqual({ election: ELECTION, skipped: "election not imported" });
  });

  it("lists each list's members on the place page, with the mayor and the junta president", async () => {
    await seed();
    // Before the names are loaded, seats have no members field and there's no source.
    const before = (await get("/places/LOCAL-010100")).body;
    expect(before.council.source).toBeNull();
    expect(before.council.organs[0].seats[0]).not.toHaveProperty("members");

    await importLocalElected(db, FILE);
    const town = await get("/places/LOCAL-010100");
    expect(town.status).toBe(200);
    expect(town.body.juntaPresident).toBeNull();
    expect(town.body.council.source).toEqual({ name: "CNE, Mapa Oficial n.º 2-B/2025", url: "https://www.cne.pt/content/eleicoes-autarquicas-2025", asOf: "2026-08-06" });
    const [cm, am] = town.body.council.organs;
    expect(cm.seats).toEqual([
      expect.objectContaining({
        list: "PPD/PSD.MPT", label: "Viva Águeda", mandates: 2,
        members: [
          { name: "Jorge Almeida", position: 1, role: "presidente", localOfficialId: "jorge-almeida-agueda" },
          { name: "Marlene Gaio", position: 2, role: null, localOfficialId: null },
        ],
      }),
      expect.objectContaining({ list: "PS", members: [{ name: "Francisco Vitorino", position: 1, role: null, localOfficialId: null }] }),
    ]);
    // No one presides over the assembleia municipal by election; a list missing names shows none.
    expect(am.seats.map((s: { list: string; members: { role: string | null }[] }) => [s.list, s.members.length, s.members.some((m) => m.role)])).toEqual([
      ["PPD/PSD.MPT", 2, false], ["PS", 0, false],
    ]);

    const parish = await get("/places/LOCAL-010103");
    expect(parish.body.juntaPresident).toEqual({ name: "Rui de Sousa", list: "PS", label: "PS", parties: ["ps"], election: ELECTION });
    expect(parish.body.council.organs[0].seats[0].members[0]).toEqual({ name: "Rui de Sousa", position: 1, role: "presidente", localOfficialId: null });

    const restored = await get("/places/AUTARQUICAS2025-99");
    expect(restored.body.juntaPresident).toMatchObject({ name: "Luís da Borralha", list: "MBV" });
  });
});
