import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  budgetInDiscussion,
  currentScripts,
  headingDay,
  parseSchedulePage,
  popplerText,
  schedulePageUrl,
  scriptProposals,
  syncBudgetSchedule,
  type PdfText,
} from "../src/budget/schedule.js";
import { budgetBills, budgetProposals, budgetSchedule, budgetScheduleDocuments, budgetSources, type VoteRecord } from "../src/db/schema.js";
import type { FetchResult } from "../src/ingestion/politeClient.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const PAGE = schedulePageUrl("XVII", 2027);
const doc = (name: string) => `https://app.parlamento.pt/webutils/docs/doc.pdf?path=abc&fich=${encodeURIComponent(name)}.pdf&Inline=true`;
/** The committee page as SharePoint draws it: a web part per voting day, its documents as links. */
const day = (heading: string, links: string[]) => `
  <div class="ms-webpart-chrome ms-webpart-chrome-vertical">
    <div class="ms-webpart-chrome-title"><span><h2 class="ms-webpart-titleText"><img alt="" />&#160;<span>${heading}</span></h2></span></div>
    <div class="ms-WPBody">${links.map((t) => `<div class="archive-item"><a class="TextoRegular" href="${doc(t)}">${t}</a></div>`).join("")}</div>
  </div>`;
const page = (...days: string[]) => `<html><body>
  <div class="ms-webpart-chrome"><h2 class="ms-webpart-titleText"><span>Resultados de Votações</span></h2>
    <a class="TextoRegular" href="${doc("Resultado das votações - 19-11-2026")}">Resultado das votações Plenário - 19-11-2026</a></div>
  ${days.join("")}
  <div class="ms-webpart-chrome"><h2 class="ms-webpart-titleText"><span>Contributos</span></h2><a href="${doc("Contributo")}">Contributo</a></div>
</body></html>`;

/** What pdftotext gives for a script: each proposal's vote, and article votes in between. */
const script = (...numbers: string[]) =>
  numbers.map((n) => `□ Votação da Proposta: ${n}\n     Proponente: PCP\n     Objeto: Eliminação - Alínea a)\n□ Votação: Corpo, Artigo 135.º\n`).join("");
const PDF = (name: string) => new TextEncoder().encode(`%PDF-1.4 ${name}`);

const fakeParliament = (html: string, scripts: Record<string, string>, failing: string[] = []) => {
  const byUrl = new Map(Object.entries(scripts).map(([name, text]) => [doc(name), { name, text }]));
  return {
    client: {
      get: vi.fn(async (url: string): Promise<FetchResult> => (url === PAGE ? { status: "ok", body: html } : { status: "blocked", reason: "HTTP 404" })),
      getBytes: vi.fn(async (url: string): Promise<FetchResult<{ status: "ok"; bytes: Uint8Array; contentType: string | null }>> => {
        const found = byUrl.get(url);
        if (!found) return { status: "blocked", reason: "HTTP 404" };
        // The parliament's broken links answer 200 with an HTML "Recurso Não Encontrado" page.
        if (failing.includes(found.name)) return { status: "ok", bytes: new TextEncoder().encode("<html>Recurso Não Encontrado"), contentType: "text/html" };
        return { status: "ok", bytes: PDF(found.name), contentType: "application/pdf" };
      }),
    },
    pdfText: vi.fn<PdfText>(async (pdf) => {
      const name = new TextDecoder().decode(pdf).slice("%PDF-1.4 ".length);
      return byUrl.get(doc(name))!.text;
    }),
  };
};

describe("reading the Budget committee's page", () => {
  it("finds each day's scripts, fixing a mistyped year, and lets a consolidated one replace the first", () => {
    const html = page(
      day("3.º Dia de Votações | 20-11-2026", [
        "01.0 Guião Comissão - Artigos 114.º a 129.º-A",
        "01.1 Dossier de Acompanhamento Comissão - Artigos 114.º a 129.º-A",
        "02.0 Guião Comissão - Artigos 114.º a 129.º-A - consolidado",
        "Guião Plenário - Artigos remetidos a Plenário e normas avocadas",
      ]),
      day("4.º Dia de Votações | 23-11-2024", ["Guião Comissão - Artigos 130.º a 139.º", "Guião Comissão - Artigos 53.º+53.º-A+7.º+7.º-A+1.º"]),
    );
    const links = parseSchedulePage(html, 2027, PAGE);
    expect(links.map((l) => [l.votingDay, l.venue, l.consolidated])).toEqual([
      ["2026-11-20", "committee", false],
      ["2026-11-20", "committee", true],
      ["2026-11-20", "plenary", false],
      ["2026-11-23", "committee", false],
      ["2026-11-23", "committee", false],
    ]);
    expect(currentScripts(links).map((l) => l.title)).toEqual([
      "02.0 Guião Comissão - Artigos 114.º a 129.º-A - consolidado",
      "Guião Plenário - Artigos remetidos a Plenário e normas avocadas",
      "Guião Comissão - Artigos 130.º a 139.º",
      "Guião Comissão - Artigos 53.º+53.º-A+7.º+7.º-A+1.º",
    ]);
    // A Budget delayed by an election is voted early in its own year.
    expect(headingDay("1.º Dia | 05-02-2020", 2020)).toBe("2020-02-05");
    expect(headingDay("Sem data", 2027)).toBeNull();
  });

  it("takes each proposal once, in the script's order", () => {
    expect(scriptProposals(script("486C-1", "1929C", "486C-1", "77C"))).toEqual(["486C-1", "1929C", "77C"]);
  });
});

describe("syncing the schedule", () => {
  const seedYear = async () => {
    await db.insert(budgetSources).values({ year: 2027, url: "https://x/oe2027.json", hash: "h" });
    const base = { year: 2027, title: "Artigo", status: "Aguarda votação", authorLabel: "PCP", authorParties: ["pcp"] };
    await db.insert(budgetProposals).values([
      { ...base, id: 1, number: "486C-1", result: "sent_to_plenary" },
      { ...base, id: 2, number: "1929C", result: "pending" },
      { ...base, id: 3, number: "77C", result: "pending" },
      { ...base, id: 4, number: "12C", result: "approved", lastVotedOn: "2026-11-20" },
    ]);
  };
  const html = page(
    day("4.º Dia de Votações | 23-11-2026", ["Guião Comissão - Artigos 130.º a 139.º", "Guião Comissão - Artigos 53.º", "Guião Plenário - Normas avocadas"]),
  );

  it("puts each proposal on its day in order, retries a broken link, and shows it in the API", async () => {
    await seedYear();
    const parliament = fakeParliament(
      html,
      { "Guião Comissão - Artigos 130.º a 139.º": script("1929C", "77C"), "Guião Comissão - Artigos 53.º": script("77C", "12C"), "Guião Plenário - Normas avocadas": script("486C-1") },
      ["Guião Comissão - Artigos 53.º"],
    );
    const run = () => syncBudgetSchedule(db, { ...parliament, year: 2027, legislature: "XVII" });

    expect(await run()).toEqual({ scripts: 3, read: 2, failed: 1, proposals: 3 });
    expect((await db.select().from(budgetScheduleDocuments)).find((d) => d.title.includes("53.º"))).toMatchObject({ readAt: null, error: "not a PDF, or too large" });

    // Next run: the link works now. Scripts already read aren't fetched again.
    parliament.client.getBytes.mockClear();
    const fixed = fakeParliament(html, {
      "Guião Comissão - Artigos 130.º a 139.º": script("1929C", "77C"),
      "Guião Comissão - Artigos 53.º": script("77C", "12C"),
      "Guião Plenário - Normas avocadas": script("486C-1"),
    });
    expect(await syncBudgetSchedule(db, { ...fixed, year: 2027, legislature: "XVII" })).toEqual({ scripts: 3, read: 1, failed: 0, proposals: 4 });
    expect(fixed.client.getBytes).toHaveBeenCalledTimes(1);
    expect(
      (await db.select().from(budgetSchedule).orderBy(budgetSchedule.venue, budgetSchedule.position)).map((r) => [r.number, r.venue, r.position]),
    ).toEqual([
      ["1929C", "committee", 1],
      ["77C", "committee", 2],
      ["12C", "committee", 3],
      ["486C-1", "plenary", 1],
    ]);

    const list = (await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals?scheduledOn=2026-11-23&sort=scheduled" })).json();
    expect(list.total).toBe(4);
    expect(list.items.map((p: { number: string }) => p.number)).toEqual(["1929C", "77C", "12C", "486C-1"]);
    expect(list.items[3].scheduled).toEqual([{ date: "2026-11-23", venue: "plenary", position: 1, scriptUrl: doc("Guião Plenário - Normas avocadas") }]);
    expect((await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals?scheduledOn=2026-11-24" })).json().total).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals?sort=scheduled" })).json().error.code).toBe("scheduled_on_required");

    const detail = (await app.inject({ method: "GET", url: "/api/v2/budget/2027/proposals/2" })).json();
    expect(detail.scheduled).toMatchObject([{ date: "2026-11-23", venue: "committee", position: 1 }]);
    expect((await app.inject({ method: "GET", url: "/api/v2/budget/2027/summary" })).json().votingDays).toEqual([
      { date: "2026-11-23", venue: "committee", proposals: 3, pending: 2 },
      { date: "2026-11-23", venue: "plenary", proposals: 1, pending: 1 },
    ]);
  });

  it("keeps the schedule when the page can't be read or shows no scripts", async () => {
    await seedYear();
    const parliament = fakeParliament(html, {
      "Guião Comissão - Artigos 130.º a 139.º": script("1929C"),
      "Guião Comissão - Artigos 53.º": script("77C"),
      "Guião Plenário - Normas avocadas": script("486C-1"),
    });
    await syncBudgetSchedule(db, { ...parliament, year: 2027, legislature: "XVII" });
    parliament.client.get.mockResolvedValueOnce({ status: "unavailable", reason: "timeout" });
    expect(await syncBudgetSchedule(db, { ...parliament, year: 2027, legislature: "XVII" })).toEqual({ unavailable: "unavailable: timeout" });
    parliament.client.get.mockResolvedValueOnce({ status: "ok", body: page() });
    expect(await syncBudgetSchedule(db, { ...parliament, year: 2027, legislature: "XVII" })).toMatchObject({ scripts: 0 });
    expect(await db.select().from(budgetSchedule)).toHaveLength(3);
  });

  it("swaps in a consolidated script when it's published", async () => {
    await seedYear();
    const first = page(day("4.º Dia de Votações | 23-11-2026", ["Guião Comissão - Artigos 130.º a 139.º"]));
    const scripts = { "Guião Comissão - Artigos 130.º a 139.º": script("1929C", "77C"), "Guião Comissão - Artigos 130.º a 139.º - consolidado": script("77C") };
    await syncBudgetSchedule(db, { ...fakeParliament(first, scripts), year: 2027, legislature: "XVII" });
    const later = page(day("4.º Dia de Votações | 23-11-2026", ["Guião Comissão - Artigos 130.º a 139.º", "Guião Comissão - Artigos 130.º a 139.º - consolidado"]));
    expect(await syncBudgetSchedule(db, { ...fakeParliament(later, scripts), year: 2027, legislature: "XVII" })).toMatchObject({ scripts: 1, proposals: 1 });
    expect((await db.select().from(budgetSchedule)).map((r) => r.number)).toEqual(["77C"]);
  });
});

describe("whether a Budget is being discussed", () => {
  const vote = (phase: string, date: string) => ({ id: phase, date, phase, result: "Aprovado", unanimous: false, favor: [], against: [], abstention: [], absent: [], named: [] }) as VoteRecord;
  const bill = (votes: VoteRecord[], updatedAt = new Date("2026-10-10T12:00:00Z")) =>
    db.insert(budgetBills).values({ initiativeId: 1, year: 2027, legislature: "XVII", number: "110", title: "Orçamento do Estado para 2027", status: "x", votes, updatedAt });

  it("from the bill's submission to a month after its final vote", async () => {
    expect(await budgetInDiscussion(db, "XVII", new Date("2026-11-22"))).toBeNull();
    await bill([]);
    expect(await budgetInDiscussion(db, "XVII", new Date("2026-10-20"))).toBe(2027);
    await db.update(budgetBills).set({ votes: [vote("Votação na generalidade", "2026-10-31")] });
    expect(await budgetInDiscussion(db, "XVII", new Date("2026-11-22"))).toBe(2027);
    // Rejected on the general vote: it fades two months later.
    expect(await budgetInDiscussion(db, "XVII", new Date("2027-01-15"))).toBeNull();
    await db.update(budgetBills).set({ votes: [vote("Votação na generalidade", "2026-10-31"), vote("Votação final global", "2026-11-24")] });
    expect(await budgetInDiscussion(db, "XVII", new Date("2026-12-20"))).toBe(2027);
    expect(await budgetInDiscussion(db, "XVII", new Date("2027-01-10"))).toBeNull();
    expect(await budgetInDiscussion(db, "XVIII", new Date("2026-11-22"))).toBeNull();
  });
});

const hasPoppler = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPoppler)("pdftotext", () => {
  it("reads a script's proposals out of a PDF", async () => {
    // A one-page PDF with the line a script has (ASCII: the pattern also takes "Votacao").
    const content = "BT /F1 12 Tf 72 720 Td (Votacao da Proposta: 486C-1) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const offsets = objects.map((o, i) => {
      const at = body.length;
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
      return at;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    expect(scriptProposals(await popplerText(new TextEncoder().encode(body)))).toEqual(["486C-1"]);
  });
});
