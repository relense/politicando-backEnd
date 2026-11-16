import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { type CaseInput, publishProblems } from "../src/cases/model.js";
import { importContracts } from "../src/contracts/import.js";
import { admins, governmentMembers } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, loginLimitPerMinute: 1000 });

const draft = (overrides: Partial<CaseInput> = {}): CaseInput => ({
  title: "Operação Exemplo",
  summary: "Investigação a contratos de uma câmara municipal.",
  crimes: ["corruption", "economic_participation"],
  status: "accusation",
  statusDate: "2026-05-01",
  startedAt: "2024-02-10",
  reviewedAt: "2026-11-15",
  people: [
    { name: "Maria Exemplo", roleAtTime: "Ministra", party: "ps", deputyId: null, governmentMemberId: "maria", status: "accused", outcome: null, final: false },
  ],
  events: [{ date: "2026-05-01", description: "O Ministério Público deduziu acusação.", sources: [1] }],
  sources: [{ url: "https://www.ministeriopublico.pt/x", title: "Comunicado", publisher: "Ministério Público", publishedAt: "2026-05-01", kind: "official" }],
  ...overrides,
});

describe("publish rules", () => {
  it("accepts a sourced, reviewed case", () => {
    expect(publishProblems(draft())).toEqual([]);
  });

  it("asks for sources, a review date and real event sources", () => {
    expect(publishProblems(draft({ sources: [], reviewedAt: null }))).toEqual([
      "Add at least one source.",
      "Set reviewedAt: when you last checked it against the sources.",
      "Event 1 cites a source that doesn't exist.",
    ]);
  });

  it("won't report a verdict on news alone", () => {
    const news = [{ url: "https://news.example/x", title: "Condenado", publisher: "Jornal", publishedAt: null, kind: "news" as const }];
    const convicted = draft({ sources: news, people: [{ ...draft().people[0]!, status: "convicted" }] });
    expect(publishProblems(convicted)).toEqual(["A court decision needs a court or official source, not only news."]);
  });

  it("keeps final decisions consistent", () => {
    const person = draft().people[0]!;
    expect(publishProblems(draft({ status: "final", people: [{ ...person, status: "convicted", final: false }] }))).toContain(
      "The case is final, but someone's decision isn't marked final.",
    );
    expect(publishProblems(draft({ people: [{ ...person, status: "accused", final: true }] }))).toEqual(["Maria Exemplo: only a decision can be final."]);
  });
});

beforeEach(async () => {
  await resetDb(db);
  await db.insert(governmentMembers).values({ id: "maria", name: "Maria Exemplo" });
  await db.insert(admins).values([
    { email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash: await hashPassword("correct horse battery") },
    { email: "author@example.pt", name: "Author", role: "author", passwordHash: await hashPassword("correct horse battery") },
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const login = async (email = "mod@example.pt") => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password: "correct horse battery" } });
  return `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}`;
};
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers: cookie ? { cookie } : {}, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};

describe("curating cases", () => {
  it("keeps drafts private until published, and logs every step", async () => {
    const cookie = await login();
    expect((await call("POST", "/admin/cases", await login("author@example.pt"), draft())).status).toBe(403);

    const created = await call("POST", "/admin/cases", cookie, draft({ reviewedAt: null }));
    expect(created).toMatchObject({ status: 201, body: { published: false, problems: ["Set reviewedAt: when you last checked it against the sources."] } });
    const id = created.body.id;
    expect((await call("GET", `/cases/${id}`)).status).toBe(404);
    expect((await call("POST", `/admin/cases/${id}/publish`, cookie)).body.error.code).toBe("not_publishable");

    await call("PUT", `/admin/cases/${id}`, cookie, draft());
    expect((await call("POST", `/admin/cases/${id}/publish`, cookie)).body).toMatchObject({ published: true, problems: [] });
    expect((await call("PUT", `/admin/cases/${id}`, cookie, draft({ sources: [] }))).body.error.code).toBe("not_publishable");

    const log = await call("GET", `/admin/audit?entity=case&entityId=${id}`, cookie);
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["case.publish", "case.update", "case.create"]);
    expect(log.body.items[1].before.reviewedAt).toBeNull();
    expect(log.body.items[1].after.reviewedAt).toBe("2026-11-15");
  });

  it("rejects unknown parties and people", async () => {
    const cookie = await login();
    const person = draft().people[0]!;
    expect((await call("POST", "/admin/cases", cookie, draft({ people: [{ ...person, party: "nope" }] }))).body.error.code).toBe("unknown_party");
    expect((await call("POST", "/admin/cases", cookie, draft({ people: [{ ...person, deputyId: 999 }] }))).body.error.code).toBe("unknown_deputy");
    expect((await call("POST", "/admin/cases", cookie, draft({ people: [{ ...person, governmentMemberId: "x" }] }))).body.error.code).toBe(
      "unknown_government_member",
    );
  });
});

describe("public cases", () => {
  it("lists and shows published cases with plain-language stages", async () => {
    const cookie = await login();
    const { body } = await call("POST", "/admin/cases", cookie, draft());
    await call("POST", "/admin/cases", cookie, draft({ title: "Rascunho" }));
    await call("POST", `/admin/cases/${body.id}/publish`, cookie);

    const list = await call("GET", "/cases");
    expect(list.body).toMatchObject({ total: 1, items: [{ title: "Operação Exemplo", status: { key: "accusation", label: "Acusação deduzida" } }] });
    expect(list.body.items[0].people[0]).toMatchObject({ party: { slug: "ps" }, status: { key: "accused", label: "Acusado" }, final: false });
    expect(list.body.items[0].people[0].status.plain).toContain("Presume-se inocente");
    expect((await call("GET", "/cases?party=ps")).body.total).toBe(1);
    expect((await call("GET", "/cases?party=psd")).body.total).toBe(0);
    expect((await call("GET", "/cases?member=maria&crime=corruption")).body.total).toBe(1);
    expect((await call("GET", "/cases?status=final")).body.total).toBe(0);

    const one = await call("GET", `/cases/${body.id}`);
    expect(one.body).toMatchObject({
      events: [{ date: "2026-05-01", sources: [1] }],
      sources: [{ position: 1, kind: "official", publisher: "Ministério Público" }],
    });

    const path = await call("GET", "/people/government/maria/path");
    expect(path.body.records).toEqual({
      cases: [{ id: body.id, title: "Operação Exemplo", status: { key: "accusation", label: "Acusação deduzida" }, personStatus: { key: "accused", label: "Acusado" }, final: false }],
      interests: 0,
    });
  });

  it("explains its vocabulary", async () => {
    const { body } = await call("GET", "/cases/glossary");
    expect(body.crimes.map((c: { key: string }) => c.key)).toContain("influence_peddling");
    expect(body.personStatuses.find((s: { key: string }) => s.key === "arguido").plain).toContain("Não é uma acusação");
  });
});

describe("declared interests", () => {
  const interest = {
    personName: "Maria Exemplo", deputyId: null, governmentMemberId: "maria", kind: "company", entityName: "Exemplo, Lda",
    nif: "501426230", description: null, startDate: "2025-01-01", endDate: null, declaredAt: "2025-07-01",
    sourceUrl: "https://entidadetransparencia.pt/x", sourceTitle: "Declaração única, 2025", published: true,
  };

  it("links interests with a NIF to the contracts the entity won", async () => {
    const cookie = await login();
    const contract = (id: string, signed: string, price: number) => ({
      idcontrato: id, tipoprocedimento: "Ajuste Direto Regime Geral", objectoContrato: "Serviços", dataPublicacao: signed,
      dataCelebracaoContrato: signed, precoContratual: price, localExecucao: [],
      adjudicante: [{ nifEntContrato: "506415082", descEntContrato: "Município de Coimbra" }],
      adjudicatarios: [{ nifEntContrato: "501426230", descEntContrato: "Exemplo, Lda" }],
    });
    await importContracts(db, (async function* () { yield* [contract("1", "2024-06-01", 100), contract("2", "2025-06-01", 50)]; })());

    const created = await call("POST", "/admin/interests", cookie, interest);
    expect(created.status).toBe(201);
    await call("POST", "/admin/interests", cookie, { ...interest, entityName: "Rascunho", nif: null, published: false });

    const listed = await call("GET", "/interests?member=maria");
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      kind: { key: "company", label: "Empresa própria" },
      contracts: { won: { count: 2, total: 150 }, duringInterest: { count: 1, total: 50 } },
    });
    expect((await call("GET", "/interests/contracts")).body.items.map((i: { entityName: string }) => i.entityName)).toEqual(["Exemplo, Lda"]);
    expect((await call("GET", "/people/government/maria/path")).body.records.interests).toBe(1);

    expect((await call("PUT", `/admin/interests/${created.body.id}`, cookie, { ...interest, published: false })).body.published).toBe(false);
    expect((await call("GET", "/interests")).body.items).toEqual([]);
    expect((await call("DELETE", `/admin/interests/${created.body.id}`, cookie)).status).toBe(204);
    const log = await call("GET", `/admin/audit?entity=interest&entityId=${created.body.id}`, cookie);
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["interest.delete", "interest.update", "interest.create"]);
  });

  it("requires a source and a valid NIF", async () => {
    const cookie = await login();
    expect((await call("POST", "/admin/interests", cookie, { ...interest, sourceUrl: "" })).status).toBe(400);
    expect((await call("POST", "/admin/interests", cookie, { ...interest, nif: "123" })).status).toBe(400);
    expect((await call("POST", "/admin/interests", cookie, { ...interest, sourceUrl: "javascript:alert(1)" })).status).toBe(400);
  });
});
