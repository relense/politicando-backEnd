import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { refreshBudgetBillsInProgress, syncCurrentBudgetBills } from "../src/budget/bills.js";
import { type ProvisionalBillVote, withProvisionalVotes } from "../src/budget/provisional.js";
import { initiatives } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";
import { event, initiative, loaderFor, vote } from "./parliamentFixtures.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const generalidade = {
  id: "g", date: "2026-10-28", phase: "Votação na generalidade", result: "Aprovado", unanimous: false,
  favor: [{ party: "psd", count: null }], against: [], abstention: [], absent: [], named: [],
};
const finalVote = { ...generalidade, id: "f", date: "2026-11-24", phase: "Votação final global" };
const provisional: ProvisionalBillVote[] = [{ initiativeId: 377352, vote: { ...finalVote, id: "p" }, source: { name: "RTP", url: "https://www.rtp.pt/x" } }];
const bill = (votes: (typeof generalidade)[], status = "in_progress") => ({ initiativeId: 377352, status, votes });

describe("Budget bill votes before the open data has them", () => {
  it("adds a provisional vote, with its source, until the official one of that phase comes in", () => {
    expect(withProvisionalVotes(bill([generalidade]), provisional)).toEqual({
      initiativeId: 377352, status: "approved",
      votes: [generalidade, { ...finalVote, id: "p", provisional: true, source: { name: "RTP", url: "https://www.rtp.pt/x" } }],
    });
    // The official vote replaces it; the bill's own status stands.
    expect(withProvisionalVotes(bill([generalidade, finalVote], "approved"), provisional)).toEqual(bill([generalidade, finalVote], "approved"));
    expect(withProvisionalVotes({ ...bill([generalidade]), initiativeId: 1 }, provisional).votes).toEqual([generalidade]);
  });

  it("shows OE2027's final vote on /budget/2027/summary", async () => {
    await db.insert(initiatives).values({
      id: 377352, legislature: "XVII", type: "Proposta de Lei", number: "110", title: "Orçamento do Estado para 2027",
      status: "in_progress", phase: "Votação na generalidade", phaseDate: "2026-10-28", votes: [generalidade],
    });
    await syncCurrentBudgetBills(db);
    const [summary] = (await app.inject({ method: "GET", url: "/api/v2/budget" })).json().items[0].bills;
    expect(summary.status).toBe("approved");
    expect(summary.votes.at(-1)).toMatchObject({
      phase: "Votação final global", result: "Aprovado", provisional: true, source: { name: "RTP" },
      favor: [{ party: "psd" }, { party: "cds-pp" }], abstention: [{ party: "ps" }, { party: "jpp" }],
    });
  });

  it("re-reads a Budget bill still in progress from the open data, and nothing once it's settled", async () => {
    await db.insert(initiatives).values({
      id: 377352, legislature: "XVII", type: "Proposta de Lei", number: "110", title: "Orçamento do Estado para 2027",
      status: "in_progress", phase: "Votação na generalidade", phaseDate: "2026-10-28", votes: [generalidade],
    });
    await syncCurrentBudgetBills(db);
    const file = [
      { ...initiative(377352, "Orçamento do Estado para 2027", [
        event("Entrada", "2026-10-10"),
        event("Votação na generalidade", "2026-10-28", [vote("v1", "Aprovado")]),
        event("Votação final global", "2026-11-24", [vote("v2", "Aprovado", "A Favor: <I>PSD</I>, <I> CDS-PP</I><BR>Abstenção:<I>PS</I>")]),
      ], { other: "Governo" }), IniDescTipo: "Proposta de Lei", IniTipo: "P", IniNr: "110" },
      initiative(9, "Outra coisa", [event("Entrada", "2026-10-01")]),
    ];
    expect(await refreshBudgetBillsInProgress(db, loaderFor({ initiatives: file }), "XVII")).toBe(1);
    expect(await syncCurrentBudgetBills(db)).toBe(1);
    const [summary] = (await app.inject({ method: "GET", url: "/api/v2/budget" })).json().items[0].bills;
    expect(summary.status).toBe("approved");
    // The official vote, not the provisional one.
    expect(summary.votes.map((v: { phase: string; provisional?: boolean }) => [v.phase, v.provisional ?? false])).toEqual([
      ["Votação na generalidade", false], ["Votação final global", false],
    ]);
    // Only the Budget bill was touched; and with nothing in progress, the file isn't read at all.
    expect((await db.select({ id: initiatives.id }).from(initiatives)).map((r) => r.id)).toEqual([377352]);
    expect(await refreshBudgetBillsInProgress(db, { json: async () => [], items: () => { throw new Error("read"); } }, "XVII")).toBeNull();
  });
});
