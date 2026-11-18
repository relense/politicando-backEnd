import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { agendaEvents, forumThreads, initiatives, notifications, predictions, voteRounds, type VoteRecord } from "../src/db/schema.js";
import { record, resolvePredictions, settle } from "../src/predictions/index.js";
import { openVoteRounds } from "../src/predictions/rounds.js";
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
/** A plenary session `days` from now whose agenda names these initiatives. */
const plenary = (id: string, days: number, numbers: number[]) =>
  db.insert(agendaEvents).values({
    id, source: "parliament", kind: "parliament", title: "Plenário", allDay: false,
    summary: `Votações\n${numbers.map((n) => `Projeto de Lei n.º ${n}/XVII/2.ª (PS)`).join("\n")}`,
    startsAt: new Date(Date.now() + days * 86_400_000), until: new Date(Date.now() + days * 86_400_000 + 3_600_000), startDay: "2030-01-01",
    attend: { open: false, how: null, url: null },
  } as typeof agendaEvents.$inferInsert);
const initiative = (id: number, overrides: Partial<typeof initiatives.$inferInsert> = {}) =>
  db.insert(initiatives).values({
    id, legislature: "XVII", type: "Projeto de Lei", number: String(id), title: `Iniciativa ${id}`, status: "in_progress",
    phase: "Admissão", phaseDate: "2026-11-01", ...overrides,
  });

describe("settling a prediction", () => {
  const at = new Date("2026-11-10T15:00:00Z");
  it("uses the first deciding vote from the day of the last change on", () => {
    expect(settle({ pick: "pass", updatedAt: at }, { open: true, votes: [] })).toBeNull();
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-11", "Aprovado")] })).toMatchObject({ outcome: "hit", voteDate: "2026-11-11" });
    expect(settle({ pick: "fail", updatedAt: at }, { open: false, votes: [vote("2026-11-12", "Aprovado")] })).toMatchObject({ outcome: "miss" });
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-10", "Rejeitado")] })).toMatchObject({ outcome: "miss" });
    // Votes before the pick don't count; procedural votes neither.
    expect(settle({ pick: "pass", updatedAt: at }, { open: true, votes: [vote("2026-11-09", "Rejeitado"), vote("2026-11-11", "Aprovado", "Requerimento")] })).toBeNull();
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-09", "Rejeitado")] })).toMatchObject({ outcome: "void", voteDate: null });
    expect(settle({ pick: "pass", updatedAt: at }, { open: false, votes: [vote("2026-11-13", "Prejudicado")] })).toMatchObject({ outcome: "void" });
  });

  it("keeps a private record with the current run of hits", () => {
    const r = (outcome: "hit" | "miss" | "void" | null, day: number) => ({ outcome, resolvedAt: outcome ? new Date(2026, 10, day) : null });
    expect(record([r("hit", 5), r("hit", 4), r("miss", 3), r("hit", 2), r("void", 6), r(null, 0)])).toEqual({ hits: 3, misses: 1, pending: 1, streak: 2 });
  });
});

describe("Passa ou chumba?", () => {
  it("opens only votes on the agenda within the week, each with a megathread where picks show", async () => {
    await initiative(1);
    await initiative(2);
    await initiative(3);
    await initiative(4, { status: "approved", phase: "Votação final global" });
    await plenary("soon", 2, [2, 4]);
    await plenary("later", 10, [3]);
    expect((await call("GET", "/predictions/open")).json().items).toEqual([]);

    expect(await openVoteRounds(db)).toEqual({ opened: 1, moved: 0, unpinned: 0 });
    expect(await openVoteRounds(db)).toEqual({ opened: 0, moved: 0, unpinned: 0 });
    const open = (await call("GET", "/predictions/open")).json().items;
    expect(open).toEqual([expect.objectContaining({ id: 2, myPick: null, split: null, threadId: expect.any(Number), closesAt: expect.any(String) })]);
    const [thread] = await db.select().from(forumThreads);
    expect(thread).toMatchObject({ board: "votacoes", pinned: true, initiativeId: 2, title: "Passa ou chumba? Projeto de Lei n.º 2: Iniciativa 2" });

    // Not on the agenda yet (or too far off): closed.
    const ana = await register("ana");
    const rui = await register("rui");
    expect((await call("PUT", "/predictions/1", ana, { pick: "pass" })).statusCode).toBe(409);
    expect((await call("PUT", "/predictions/3", ana, { pick: "pass" })).statusCode).toBe(409);
    expect((await call("PUT", "/predictions/99", ana, { pick: "pass" })).statusCode).toBe(404);
    expect((await call("PUT", "/predictions/2", undefined, { pick: "pass" })).statusCode).toBe(401);

    await call("PUT", "/predictions/2", rui, { pick: "fail" });
    expect((await call("PUT", "/predictions/2", ana, { pick: "pass" })).json()).toEqual({ pick: "pass", split: { pass: 1, fail: 1 } });
    expect((await call("GET", "/predictions/open", ana)).json().items[0]).toMatchObject({ myPick: "pass", split: { pass: 1, fail: 1 } });
    // Picking followed the megathread; replies there show each side.
    expect((await call("GET", "/me/state", ana)).json().follows.threads).toEqual([thread!.id]);
    await call("POST", `/forums/threads/${thread!.id}/posts`, ana, { body: "Passa, há maioria" });
    await call("POST", `/forums/threads/${thread!.id}/posts`, rui, { body: "Chumba, o PS vota contra" });
    const posts = (await call("GET", `/forums/threads/${thread!.id}`)).json().posts;
    expect(posts.map((p: { pick: string }) => p.pick)).toEqual(["pass", "fail"]);
    // Readers can't open threads in the votes board themselves.
    expect((await call("POST", "/forums/votacoes/threads", ana, { title: "Outra", body: "Texto" })).statusCode).toBe(403);

    // The session starts: picks lock. Postponed: it reopens for the new date, pinned again.
    await db.update(voteRounds).set({ closesAt: new Date(Date.now() - 3 * 86_400_000) });
    expect((await call("PUT", "/predictions/2", ana, { pick: "fail" })).statusCode).toBe(409);
    expect(await openVoteRounds(db)).toEqual({ opened: 0, moved: 1, unpinned: 0 });
    expect((await call("GET", "/predictions/open")).json().items).toHaveLength(1);
    await db.update(voteRounds).set({ closesAt: new Date(Date.now() - 3 * 86_400_000) });
    await db.delete(agendaEvents);
    expect(await openVoteRounds(db)).toEqual({ opened: 0, moved: 0, unpinned: 1 });
  });

  it("settles after the parliament sync, tells the reader, and keeps their record", async () => {
    await initiative(1);
    await initiative(2);
    await plenary("soon", 1, [1, 2]);
    await openVoteRounds(db);
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
