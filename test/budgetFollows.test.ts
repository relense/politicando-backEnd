import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { announceBudgetVotes } from "../src/budget/alerts.js";
import { budgetProposals, budgetVotes } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", registerLimitPerHour: 1000 });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url: `/api/v2${url}`, payload, headers: cookie ? { cookie: `politicando_session=${cookie}` } : {} });
const register = async (username: string) => {
  const response = await call("POST", "/auth/register", undefined, { username, password: "palavra-passe", recaptchaToken: "t" });
  return response.cookies.find((c) => c.name === "politicando_session")!.value;
};

/** A day relative to today in Lisbon, as the votes store it. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
const proposal = (id: number, number: string) => ({ id, year: 2027, number, title: `N.º ${id}, Artigo 91.º`, status: "Aguarda Voto em Comissão", result: "pending" });
const vote = (proposalId: number, seq: number, votedOn: string, extra: Partial<typeof budgetVotes.$inferInsert> = {}) => ({
  proposalId, seq, votedOn, phase: "committee", result: "approved", votes: [], ...extra,
});

describe("following Budget proposals", () => {
  it("follows, lists and unfollows, privately", async () => {
    const ana = await register("ana");
    await db.insert(budgetProposals).values([proposal(1, "1C-1"), proposal(2, "2C")]);

    expect((await call("PUT", "/me/follows/budget_proposal/1")).statusCode).toBe(401);
    expect((await call("PUT", "/me/follows/budget_proposal/999", ana)).statusCode).toBe(404);
    expect((await call("PUT", "/me/follows/budget_proposal/1", ana)).statusCode).toBe(204);
    expect((await call("PUT", "/me/follows/budget_proposal/2", ana)).statusCode).toBe(204);
    expect((await call("PUT", "/me/follows/budget_proposal/2", ana)).statusCode).toBe(204);
    expect((await call("GET", "/me/state", ana)).json().follows).toEqual({ stories: [], threads: [], budgetProposals: [2, 1] });

    const list = await call("GET", "/me/follows/budget_proposals", ana);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.json()).toEqual({
      items: [expect.objectContaining({ id: 2, number: "2C", year: 2027, votes: [], scheduled: [] }), expect.objectContaining({ id: 1 })],
      nextCursor: null,
    });
    expect((await call("GET", "/me/follows/budget_proposals")).statusCode).toBe(401);
    expect((await call("GET", "/me/follows/budget_proposals?cursor=nope", ana)).statusCode).toBe(400);

    expect((await call("DELETE", "/me/follows/budget_proposal/2", ana)).statusCode).toBe(204);
    expect((await call("GET", "/me/follows/budget_proposals", ana)).json().items.map((p: { id: number }) => p.id)).toEqual([1]);
  });

  it("pages the followed list 20 at a time", async () => {
    const ana = await register("ana");
    await db.insert(budgetProposals).values(Array.from({ length: 21 }, (_, i) => proposal(i + 1, `${i + 1}C`)));
    for (let id = 1; id <= 21; id++) await call("PUT", `/me/follows/budget_proposal/${id}`, ana);
    const first = (await call("GET", "/me/follows/budget_proposals", ana)).json();
    expect(first.items).toHaveLength(20);
    expect(first.items[0].id).toBe(21);
    const second = (await call("GET", `/me/follows/budget_proposals?cursor=${first.nextCursor}`, ana)).json();
    expect(second).toEqual({ items: [expect.objectContaining({ id: 1 })], nextCursor: null });
  });

  it("tells followers about each new vote, once, and never old ones", async () => {
    const [ana, rui] = [await register("ana"), await register("rui")];
    await db.insert(budgetProposals).values([proposal(1, "1C-1"), proposal(2, "2C")]);
    // Voted before anyone followed: seen, never announced.
    await db.insert(budgetVotes).values(vote(1, 1, day(-3)));
    expect(await announceBudgetVotes(db)).toEqual({ newVotes: 1, notified: 0 });

    await call("PUT", "/me/follows/budget_proposal/1", ana);
    await call("PUT", "/me/follows/budget_proposal/2", ana);
    await call("PUT", "/me/follows/budget_proposal/1", rui);
    await db.insert(budgetVotes).values([
      // Voted in two parts: one line each.
      vote(2, 1, day(0), { partLabel: "N.º 1", result: "approved" }),
      vote(2, 2, day(0), { partLabel: "N.º 2", result: "rejected" }),
      vote(1, 2, day(0), { phase: "plenary", result: "rejected" }),
      // A late correction from a month ago isn't news.
      vote(1, 3, day(-30)),
    ]);
    expect(await announceBudgetVotes(db)).toEqual({ newVotes: 3, notified: 4 });
    expect(await announceBudgetVotes(db)).toEqual({ newVotes: 0, notified: 0 });

    expect((await call("GET", "/me/notifications/unread", ana)).json().count).toBe(3);
    const items = (await call("GET", "/me/notifications", ana)).json().items;
    expect(items).toHaveLength(3);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "budget_vote", read: false, count: 1,
        link: expect.objectContaining({ budgetProposalId: 2, budgetYear: 2027 }),
        budgetProposal: { number: "2C", title: "N.º 2, Artigo 91.º", votedOn: day(0), phase: "committee", result: "rejected", partLabel: "N.º 2" },
      }),
    );
    expect((await call("GET", "/me/notifications", rui)).json().items).toEqual([
      expect.objectContaining({ kind: "budget_vote", budgetProposal: expect.objectContaining({ number: "1C-1", phase: "plenary", result: "rejected" }) }),
    ]);

    // The sync replaces the year's rows: the same votes coming back aren't news again.
    await db.delete(budgetProposals);
    await db.insert(budgetProposals).values([proposal(1, "1C-1"), proposal(2, "2C")]);
    await db.insert(budgetVotes).values([vote(1, 1, day(-3)), vote(2, 1, day(0)), vote(2, 2, day(0)), vote(1, 2, day(0)), vote(1, 3, day(-30))]);
    expect(await announceBudgetVotes(db)).toEqual({ newVotes: 0, notified: 0 });
  });
});
