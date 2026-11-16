import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseContract, parseResources, placeMatcher, procedureKind, type StoredPlace } from "../src/contracts/base.js";
import { importContracts } from "../src/contracts/import.js";
import { contractImports, places } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";

/** A record shaped like the BASE files on dados.gov.pt. */
const record = (overrides: Record<string, unknown> = {}) => ({
  idcontrato: "100",
  idprocedimento: "900",
  tipoprocedimento: "Ajuste Direto Regime Geral",
  tipoContrato: ["Aquisição de serviços"],
  objectoContrato: "Refeições escolares",
  descContrato: "Refeições escolares",
  adjudicante: [{ nifEntContrato: "506415082", descEntContrato: "Município de Coimbra", codPaisEntContrato: "PRT" }],
  adjudicatarios: [{ nifEntContrato: "501426230", descEntContrato: "ICA - Indústria e Comércio Alimentar, S.A.", codPaisEntContrato: "PRT" }],
  dataPublicacao: "2026-10-26",
  dataCelebracaoContrato: "2026-09-11",
  precoContratual: 906352.76,
  CPV: [{ cpvID: "55524000-9", cpvdescricao: "Serviços de fornecimento de refeições para escolas", cpvValor: 906352.76, CPVObjeto: "Principal" }],
  prazoExecucao: 365,
  localExecucao: ["Portugal, Coimbra, Coimbra"],
  fundamentacao: "Artigo 20.º, n.º 1, alínea d) do Código dos Contratos Públicos",
  ProcedimentoCentralizado: "Não",
  DescrAcordoQuadro: "",
  precoBaseProcedimento: 0,
  dataFechoContrato: "",
  PrecoTotalEfetivo: 0,
  fundamentAjusteDireto: "",
  linkPecasProc: "",
  entidadesConvidadas: [],
  estadoContrato: "",
  ...overrides,
});

const PLACES: StoredPlace[] = [
  { key: "LOCAL-060000", name: "Coimbra", level: "district", parentKey: null },
  { key: "LOCAL-060300", name: "Coimbra", level: "municipality", parentKey: "LOCAL-060000" },
  { key: "LOCAL-080000", name: "Faro", level: "district", parentKey: null },
  { key: "LOCAL-080600", name: "Lagoa", level: "municipality", parentKey: "LOCAL-080000" },
  { key: "LOCAL-400000", name: "Açores", level: "district", parentKey: null },
  { key: "LOCAL-420200", name: "Lagoa", level: "municipality", parentKey: "LOCAL-400000" },
];

describe("BASE records", () => {
  it("groups procedures into kinds", () => {
    expect(procedureKind("Ajuste Direto Regime Geral")).toBe("direct_award");
    expect(procedureKind("Ajuste direto simplificado ao abrigo da Lei n.º 30/2021, de 21.05")).toBe("direct_award_simplified");
    expect(procedureKind("Consulta Prévia Simplificada")).toBe("prior_consultation");
    expect(procedureKind("Concurso público simplificado")).toBe("public_tender");
    expect(procedureKind("Ao abrigo de acordo-quadro (art.º 259.º)")).toBe("framework_agreement");
    expect(procedureKind("Contratação excluída II")).toBe("excluded");
    expect(procedureKind("Setores especiais – isenção parte II")).toBe("special_sectors");
    expect(procedureKind("Diálogo concorrencial")).toBe("other");
  });

  it("parses a contract, keeping what we show", () => {
    expect(parseContract(record())).toMatchObject({
      id: "100",
      procedureKind: "direct_award",
      object: "Refeições escolares",
      description: null,
      price: 906352.76,
      basePrice: null,
      effectivePrice: null,
      publishedAt: "2026-10-26",
      signedAt: "2026-09-11",
      cpv: "55524000-9",
      centralized: false,
      invited: null,
      parties: [
        { role: "entity", position: 1, nif: "506415082", name: "Município de Coimbra", country: "PRT" },
        { role: "supplier", position: 1, nif: "501426230", name: "ICA - Indústria e Comércio Alimentar, S.A.", country: "PRT" },
      ],
    });
  });

  it("decodes HTML entities and drops placeholder NIFs", () => {
    const parsed = parseContract(
      record({
        objectoContrato: "Projetos de I&amp;D​",
        adjudicatarios: [
          { nifEntContrato: "-", descEntContrato: " João Silva " },
          { nifEntContrato: "-", descEntContrato: "João Silva" },
        ],
      }),
    );
    expect(parsed?.object).toBe("Projetos de I&D");
    expect(parsed?.parties.filter((p) => p.role === "supplier")).toEqual([
      { role: "supplier", position: 1, nif: "", name: "João Silva", country: null },
    ]);
  });

  it("only reports an effective price once the contract has closed", () => {
    expect(parseContract(record({ PrecoTotalEfetivo: 5 }))?.effectivePrice).toBeNull();
    expect(parseContract(record({ PrecoTotalEfetivo: 5, dataFechoContrato: "2026-11-01" }))?.effectivePrice).toBe(5);
  });

  it("rejects records without the essentials", () => {
    expect(parseContract(record({ idcontrato: "" }))).toBeNull();
    expect(parseContract(record({ precoContratual: null }))).toBeNull();
    expect(parseContract(record({ dataPublicacao: "26/10/2026" }))).toBeNull();
    expect(parseContract("nope")).toBeNull();
  });

  it("matches places to municipalities and districts", () => {
    const match = placeMatcher(PLACES);
    expect(match("Portugal, Coimbra, Coimbra")).toEqual(["LOCAL-060300", "LOCAL-060000"]);
    expect(match("Portugal, Faro, Lagoa")).toEqual(["LOCAL-080600", "LOCAL-080000"]);
    expect(match("Portugal, Região Autónoma dos Açores, Lagoa")).toEqual(["LOCAL-420200", "LOCAL-400000"]);
    expect(match("Portugal, Coimbra")).toEqual(["LOCAL-060000"]);
    expect(match("Portugal, Distrito não determinado, Concelho não determinado")).toEqual([]);
    expect(match("Espanha, Madrid, Madrid")).toEqual([]);
    expect(match("Portugal")).toEqual([]);
  });

  it("finds the yearly zips in the dataset listing", () => {
    expect(
      parseResources({
        resources: [
          { title: "contratos2026.zip", latest: "https://x/r/1", last_modified: "2026-11-15T10:06:42" },
          { title: "contratos2026.xlsx", latest: "https://x/r/2", last_modified: "2026-11-08T10:00:00" },
        ],
      }),
    ).toEqual([{ year: 2026, url: "https://x/r/1", modified: "2026-11-15T10:06:42" }]);
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

async function* stream(items: unknown[]) {
  yield* items;
}

const seed = async () => {
  await db.insert(places).values(PLACES.map((p) => ({ ...p, level: p.level as "district" | "municipality", dicofre: null })));
  return importContracts(
    db,
    stream([
      record(),
      record({
        idcontrato: "101", tipoprocedimento: "Concurso público", precoContratual: 2_000_000, dataPublicacao: "2025-03-01", dataCelebracaoContrato: "2025-02-20",
        objectoContrato: "Construção de escola", localExecucao: ["Portugal, Faro, Lagoa"],
        adjudicante: [{ nifEntContrato: "506804240", descEntContrato: "Município de Lagoa (Algarve)" }],
      }),
      record({ idcontrato: "102", precoContratual: 10_000, dataPublicacao: "2026-01-05", objectoContrato: "Limpeza de escolas", localExecucao: ["Portugal"] }),
      { idcontrato: "bad" },
    ]),
  );
};

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

describe("importContracts", () => {
  it("stores contracts and their parties, and replaces them on re-import", async () => {
    expect(await seed()).toEqual({ read: 4, imported: 3, invalid: 1, unplaced: 0 });
    await importContracts(db, stream([record({ precoContratual: 1, adjudicatarios: [] })]));
    const { body } = await get("/contracts/100");
    expect(body).toMatchObject({ price: 1, suppliers: [], entities: [{ nif: "506415082" }] });
  });
});

describe("contract routes", () => {
  beforeEach(async () => {
    await seed();
    await db.insert(contractImports).values({ year: 2026, sourceModified: "2026-11-15", contracts: 3 });
  });

  it("lists newest first and pages with a cursor", async () => {
    const first = await get("/contracts?limit=2");
    expect(first.body.items.map((c: { id: string }) => c.id)).toEqual(["100", "102"]);
    expect(first.body.items[0]).toMatchObject({
      procedure: { kind: "direct_award", label: "Ajuste direto", published: "Ajuste Direto Regime Geral" },
      entities: [{ nif: "506415082", name: "Município de Coimbra" }],
      baseUrl: "https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=100",
    });
    const second = await get(`/contracts?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toMatchObject({ items: [{ id: "101" }], nextCursor: null });
  });

  it("sorts by price and filters", async () => {
    expect((await get("/contracts?sort=price")).body.items.map((c: { id: string }) => c.id)).toEqual(["101", "100", "102"]);
    const ids = async (query: string) => (await get(`/contracts?${query}`)).body.items.map((c: { id: string }) => c.id);
    expect(await ids("procedure=direct_award")).toEqual(["100", "102"]);
    expect(await ids("place=LOCAL-080000")).toEqual(["101"]);
    expect(await ids("entity=506804240")).toEqual(["101"]);
    expect(await ids("supplier=501426230")).toEqual(["100", "102", "101"]);
    expect(await ids("q=escola")).toEqual(["100", "102", "101"]);
    expect(await ids("q=limpeza")).toEqual(["102"]);
    expect(await ids("from=2026-01-01&minPrice=50000")).toEqual(["100"]);
    expect((await get("/contracts?cursor=nope")).status).toBe(400);
  });

  it("shows one contract in full", async () => {
    const { body } = await get("/contracts/100");
    expect(body).toMatchObject({
      municipalities: [{ key: "LOCAL-060300", name: "Coimbra" }],
      cpv: { code: "55524000-9" },
      legalBasis: "Artigo 20.º, n.º 1, alínea d) do Código dos Contratos Públicos",
    });
    expect(body.procedureExplained).toContain("sem concorrência aberta");
    expect((await get("/contracts/999")).status).toBe(404);
  });

  it("explains procedures with counts", async () => {
    const { body } = await get("/contracts/procedures");
    expect(body.items.find((p: { kind: string }) => p.kind === "direct_award")).toMatchObject({ count: 2, total: 916352.76 });
    expect(body.items.find((p: { kind: string }) => p.kind === "public_tender")).toMatchObject({ count: 1, total: 2_000_000 });
  });

  it("groups by year, entity and municipality", async () => {
    // Only 2026 is imported: a contract dated 2025 is left out of the years (not of the totals).
    const years = await get("/contracts/stats?by=year");
    expect(years.body).toMatchObject({
      items: [{ key: "2026", count: 2 }],
      totals: { count: 3, total: 2_916_352.76 },
      years: [2026],
      source: "https://dados.gov.pt/pt/datasets/66d72d488ca4b7cb2de28712/",
    });
    await db.insert(contractImports).values({ year: 2025, sourceModified: "2026-11-15", contracts: 1 });
    expect((await get("/contracts/stats?by=year")).body).toMatchObject({
      items: [{ key: "2025", count: 1 }, { key: "2026", count: 2 }],
      years: [2025, 2026],
    });
    expect(years.body.updatedAt).not.toBeNull();
    const entities = await get("/contracts/stats?by=entity");
    expect(entities.body.items.map((i: { label: string }) => i.label)).toEqual(["Município de Lagoa (Algarve)", "Município de Coimbra"]);
    const municipalities = await get("/contracts/stats?by=municipality&procedure=direct_award");
    expect(municipalities.body.items).toEqual([{ key: "LOCAL-060300", label: "Coimbra", count: 1, total: 906352.76 }]);
    const procedures = await get("/contracts/stats?by=procedure");
    expect(procedures.body.items[0]).toMatchObject({ key: "public_tender", label: "Concurso público" });
  });

  it("summarises one party on both sides", async () => {
    const { body } = await get("/contracts/parties/501426230");
    expect(body).toMatchObject({
      name: "ICA - Indústria e Comércio Alimentar, S.A.",
      asEntity: { count: 0, total: 0 },
      asSupplier: { count: 3, directAwards: 2 },
    });
    expect(body.asSupplier.counterparts[0]).toMatchObject({ key: "506804240", total: 2_000_000 });
    expect(body.latest).toHaveLength(3);
    expect((await get("/contracts/parties/000")).status).toBe(404);
  });
});
