import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { agendaEvents, initiatives, notifications, predictions, type VoteRecord } from "../src/db/schema.js";
import { record, resolvePredictions, settle } from "../src/predictions/index.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", loginLimitPerMinute: 1000, registerLimitPerHour: 1000 });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = (method: "GET" | "PUT" | "DELETE" | "POST", url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url: `/api/v2${url}`, payload, headers: cookie ? { cookie: `politicando_session=${cookie}` } : {} });
const register = async (username: string) =>
  (await call("POST", "/auth/register", undefined, { username, password: "palavra-passe", recaptchaToken: "t" })).cookies.find((c) => c.name === "politicando_session")!.value;

const vote = (date: string, result: string, phase = "Votação na generalidade"): VoteRecord => ({
  id: `${date}-${phase}`, date, phase, result, unanimous: false, favor: [], against: [], abstention: [], absent: [], named: [],
});
const initiative = (id: number, overrides: Partial<typeof initiatives.$inferInsert> = {}) =>
  db.insert(initiatives).values({
    id, legislature: "XVII", type: "Projeto de Lei", number: String(id), title: `Iniciativa ${id}`, status: "in_progress",
    phase: "Admissão", phaseDate: "2026-11-01", ...overrides,
  });

describe("settling a prediction", () => {
  const at = new Date("2026-11-10T15:00:00Z");
  it("uses the first deciding vote from the next day on", () => {
    expect(settle({ pick: "pass", updatedAt: at }, { open: true, votes: [] })).toBeNull();
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-11", "Aprovado")] })).toMatchObject({ outcome: "hit", voteDate: "2026-11-11" });
    expect(settle({ pick: "fail", updatedAt: at }, { open: false, votes: [vote("2026-11-12", "Aprovado")] })).toMatchObject({ outcome: "miss" });
    // A vote the same day doesn't count (it may already be in the news); procedural votes neither.
    expect(settle({ pick: "pass", updatedAt: at }, { open: true, votes: [vote("2026-11-10", "Rejeitado"), vote("2026-11-11", "Aprovado", "Requerimento")] })).toBeNull();
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-10", "Rejeitado")] })).toMatchObject({ outcome: "void", voteDate: null });
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-13", "Prejudicado")] })).toMatchObject({ outcome: "void" });
  });

  it("keeps a private record with the current run of hits", () => {
    const r = (outcome: "hit" | "miss" | "void" | null, day: number) => ({ outcome, resolvedAt: outcome ? new Date(2026, 10, day) : null });
    expect(record([r("hit", 5), r("hit", 4), r("miss", 3), r("hit", 2), r("void", 6), r(null, 0)])).toEqual({ hits: 3, misses: 1, pending: 1, streak: 2 });
  });
});

describe("Passa ou chumba?", () => {
  it("lists open initiatives, agenda first, and shows the split only after picking", async () => {
    await initiative(1, { phaseDate: "2026-11-10" });
    await initiative(2, { phaseDate: "2026-11-01", phase: "Discussão generalidade" });
    await initiative(3, { status: "approved", phase: "Votação final global" });
    await db.insert(agendaEvents).values({
      id: "plen-1", source: "parliament", kind: "parliament", title: "Plenário", summary: "Votações\nProjeto de Lei n.º 2/XVII/2.ª (PS)",
      allDay: false, startsAt: new Date(Date.now() + 86_400_000), until: new Date(Date.now() + 90_000_000), startDay: "2030-01-01",
      attend: { open: false, how: null, url: null },
    } as typeof agendaEvents.$inferInsert);

    const open = (await call("GET", "/predictions/open")).json().items;
    expect(open.map((i: { id: number }) => i.id)).toEqual([2, 1]);
    expect(open[0]).toMatchObject({ onAgenda: true, myPick: null, split: null });

    expect((await call("PUT", "/predictions/1", undefined, { pick: "pass" })).statusCode).toBe(401);
    const ana = await register("ana");
    const rui = await register("rui");
    await call("PUT", "/predictions/1", rui, { pick: "fail" });
    expect((await call("PUT", "/predictions/1", ana, { pick: "pass" })).json()).toEqual({ pick: "pass", split: { pass: 1, fail: 1 } });
    expect((await call("PUT", "/predictions/3", ana, { pick: "pass" })).statusCode).toBe(409);
    expect((await call("PUT", "/predictions/99", ana, { pick: "pass" })).statusCode).toBe(404);
    const mine = (await call("GET", "/predictions/open", ana)).json().items.find((i: { id: number }) => i.id === 1);
    expect(mine).toMatchObject({ myPick: "pass", split: { pass: 1, fail: 1 } });
  });

  it("settles after the parliament sync, tells the reader, and keeps their record", async () => {
    await initiative(1);
    await initiative(2);
    const ana = await register("ana");
    await call("PUT", "/predictions/1", ana, { pick: "pass" });
    await call("PUT", "/predictions/2", ana, { pick: "pass" });
    // Predicted a few days ago; the vote comes after.
    await db.update(predictions).set({ updatedAt: sql`now() - interval '5 days'` });
    expect(await resolvePredictions(db)).toEqual({ hit: 0, miss: 0, void: 0 });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db.update(initiatives).set({ status: "rejected", votes: [vote(yesterday, "Rejeitado")] }).where(eq(initiatives.id, 1));
    await db.update(initiatives).set({ status: "withdrawn" }).where(eq(initiatives.id, 2));
    expect(await resolvePredictions(db)).toEqual({ hit: 0, miss: 1, void: 1 });
    expect(await resolvePredictions(db)).toEqual({ hit: 0, miss: 0, void: 0 });

    expect(await db.select().from(notifications)).toMatchObject([{ kind: "prediction_result", targetId: 1 }]);
    const inbox = (await call("GET", "/me/notifications", ana)).json().items;
    expect(inbox[0].prediction).toEqual({ initiativeTitle: "Iniciativa 1", pick: "pass", outcome: "miss", result: "Rejeitado" });

    const me = (await call("GET", "/me/predictions", ana)).json();
    expect(me.record).toEqual({ hits: 0, misses: 1, pending: 0, streak: 0 });
    expect(me.items.find((i: { initiativeId: number }) => i.initiativeId === 1)).toMatchObject({ outcome: "miss", voteResult: "Rejeitado", split: { pass: 1, fail: 0 } });
    // Decided: can't be changed or taken back.
    expect((await call("PUT", "/predictions/1", ana, { pick: "fail" })).statusCode).toBe(409);
  });
});
