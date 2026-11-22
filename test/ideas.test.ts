import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins } from "../src/db/schema.js";
import { createTestDb, resetDb } from "./helpers.js";

/* The ideas board (ideias): accounts, search, similar ideas, followers, the status timeline, team replies, reply votes, duplicates. */

const { db, pool } = createTestDb();
// Nothing needs an account by default: the ideas board asks for one anyway.
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
  loginLimitPerMinute: 1000, registerLimitPerHour: 1000, loginRequired: [],
});

beforeEach(async () => {
  await resetDb(db);
  await db.insert(admins).values({ email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash: await hashPassword("correct horse battery") });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

type Headers = Record<string, string>;
const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: object, headers: Headers = {}) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers, ...(payload && { payload }), remoteAddress: headers["x-ip"] ?? "10.0.0.1" });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const register = async (username: string): Promise<Headers> => {
  const response = await app.inject({
    method: "POST", url: "/api/v2/auth/register", payload: { username, password: "palavra-passe", recaptchaToken: "t" }, remoteAddress: "10.0.0.9",
  });
  return { cookie: `politicando_session=${response.cookies.find((c) => c.name === "politicando_session")!.value}` };
};
const mod = async (): Promise<Headers> => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email: "mod@example.pt", password: "correct horse battery" } });
  return { cookie: `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}` };
};
const openIdea = async (who: Headers, title: string, body = "Seria útil.", extra: object = {}) => {
  const response = await call("POST", "/forums/ideias/threads", { title, body, ...extra }, who);
  expect(response.status).toBe(201);
  return response.body.id as number;
};
const ids = (body: { items: { id: number }[] }) => body.items.map((t) => t.id);
const setStatus = async (id: number, body: object) => call("PUT", `/admin/forum/threads/${id}/status`, { answer: null, ...body }, await mod());

describe("accounts on the ideas board", () => {
  it("needs a logged-in reader to open or vote on an idea, whatever LOGIN_REQUIRED says; other boards stay open", async () => {
    const opened = await call("POST", "/forums/ideias/threads", { title: "Modo escuro", body: "Por favor", recaptchaToken: "t" });
    expect(opened.status).toBe(401);
    expect(opened.body.error.code).toBe("login_required");

    const ana = await register("ana");
    const idea = await openIdea(ana, "Modo escuro", "Por favor", { area: "Notícias" });
    const vote = await call("POST", `/forums/threads/${idea}/vote`);
    expect(vote.status).toBe(401);
    expect(vote.body.error.code).toBe("login_required");
    // Replying keeps the forum's usual rules.
    expect((await call("POST", `/forums/threads/${idea}/posts`, { body: "Sim", recaptchaToken: "t" })).status).toBe(201);
    // Elsewhere, nothing changes.
    const general = (await call("POST", "/forums/geral/threads", { title: "Olá", body: "Olá", recaptchaToken: "t" })).body.id;
    expect((await call("POST", `/forums/threads/${general}/vote`)).body).toEqual({ score: 1 });

    expect((await call("GET", `/forums/threads/${idea}`)).body.thread).toMatchObject({ area: "Notícias" });
  });
});

describe("finding ideas", () => {
  it("searches titles and bodies ignoring accents and case, most relevant first, then most voted", async () => {
    const ana = await register("ana");
    const rui = await register("rui");
    const map = await openIdea(ana, "Mapa de contratos por distrito", "Ver os contratos públicos num mapa");
    const filter = await openIdea(ana, "Filtrar notícias", "Por distrito e concelho");
    const dark = await openIdea(ana, "Modo escuro", "Para ler à noite");
    const alerts = await openIdea(ana, "Alertas", "Quando há contratos novos do meu distrito");
    await call("POST", `/forums/threads/${alerts}/vote`, undefined, rui);

    const search = (q: string) => call("GET", `/forums/ideias/threads?q=${encodeURIComponent(q)}&limit=3`);
    // "distrito" is in map's title (2 points) and in the others' bodies (1 each): alerts has a vote, filter none.
    expect(ids((await search("DISTRITO")).body)).toEqual([map, alerts, filter]);
    expect((await search("DISTRITO")).body.total).toBe(3);
    expect(ids((await search("contratos distrito")).body)).toEqual([map, alerts, filter]);
    expect(ids((await search("noite")).body)).toEqual([dark]);
    expect(ids((await search("notícias")).body)).toEqual([filter]);
    expect(ids((await search("noticias")).body)).toEqual([filter]);
    expect((await search("xyzzy")).body).toEqual({ items: [], total: 0 });
    expect((await search("ab")).status).toBe(400);
  });

  it("finds similar ideas on the same board, never the idea itself", async () => {
    const ana = await register("ana");
    const idea = await openIdea(ana, "Mapa dos contratos públicos");
    const alike = await openIdea(ana, "Contratos públicos num mapa");
    const body = await openIdea(ana, "Ver gastos", "Um mapa com os contratos");
    await openIdea(ana, "Modo escuro", "Contratos não");
    await call("POST", "/forums/geral/threads", { title: "Mapa dos contratos públicos", body: "x", recaptchaToken: "t" });

    const similar = await call("GET", `/forums/threads/${idea}/similar?limit=3`);
    expect(ids(similar.body)).toEqual([alike, body]);
    expect(similar.body.items[0]).toMatchObject({ id: alike, board: "ideias", followers: 1 });
    expect((await call("GET", "/forums/threads/999999/similar")).status).toBe(404);
  });
});

describe("following and the status timeline", () => {
  it("counts followers; voting follows; a status change is timed, dated and tells every follower", async () => {
    const [ana, rui, eva] = [await register("ana"), await register("rui"), await register("eva")];
    const idea = await openIdea(ana, "Modo escuro");
    expect((await call("GET", "/forums/ideias/threads")).body.items[0]).toMatchObject({ followers: 1, expectedOn: null, duplicateOf: null });
    await call("POST", `/forums/threads/${idea}/vote`, undefined, rui);
    expect((await call("GET", `/forums/threads/${idea}`)).body.thread.followers).toBe(2);

    const planned = await setStatus(idea, { status: "planned", expectedOn: "2026-12-15" });
    expect(planned.body).toMatchObject({ status: "planned", expectedOn: "2026-12-15", duplicateOf: null });
    // The answer alone changing isn't a new step, and leaving expectedOn out keeps it.
    await setStatus(idea, { status: "planned", answer: "Em dezembro" });
    await setStatus(idea, { status: "in_progress" });

    const { thread } = (await call("GET", `/forums/threads/${idea}`)).body;
    expect(thread.expectedOn).toBe("2026-12-15");
    expect(thread.statusHistory.map((s: { status: string | null }) => s.status)).toEqual([null, "planned", "in_progress"]);
    expect(thread.statusHistory[0].at).toBe(thread.createdAt);

    for (const reader of [ana, rui]) {
      const items = (await call("GET", "/me/notifications", undefined, reader)).body.items;
      expect(items).toEqual([
        expect.objectContaining({ kind: "idea_status", count: 2, status: "in_progress", threadTitle: "Modo escuro", link: expect.objectContaining({ threadId: idea }) }),
      ]);
    }
    expect((await call("GET", "/me/notifications", undefined, eva)).body.items).toEqual([]);
    expect((await setStatus(idea, { status: "done", expectedOn: null })).body.expectedOn).toBeNull();
  });
});

describe("team replies and reply votes", () => {
  it("lets the team reply as the team, and readers vote for replies on the ideas board only", async () => {
    const [ana, rui] = [await register("ana"), await register("rui")];
    const idea = await openIdea(ana, "Modo escuro");
    const first = (await call("POST", `/forums/threads/${idea}/posts`, { body: "Concordo" }, rui)).body.id;
    const team = await call("POST", `/admin/forum/threads/${idea}/posts`, { body: "Está nos planos", replyTo: first }, await mod());
    expect(team.status).toBe(201);
    expect((await call("POST", `/admin/forum/threads/${idea}/posts`, { body: "x" })).status).toBe(401);

    const posts = (await call("GET", `/forums/threads/${idea}`)).body.posts;
    expect(posts[1]).toMatchObject({ id: team.body.id, team: true, nickname: "Politicando", account: false, isOp: false, replyTo: first, score: 0 });
    // A reader's reply starts with their own vote; the team's has no reader behind it.
    expect(posts[0]).toMatchObject({ team: false, score: 1 });
    expect((await call("POST", `/forums/posts/${first}/vote`, undefined, rui)).body).toEqual({ score: 1 });
    expect((await call("GET", "/me/state", undefined, rui)).body.votes).toMatchObject({ forumPosts: [first] });
    // rui is told his reply was answered.
    expect((await call("GET", "/me/notifications", undefined, rui)).body.items[0]).toMatchObject({ kind: "forum_reply", actorName: "Politicando" });

    expect((await call("POST", `/forums/posts/${team.body.id}/vote`)).status).toBe(401);
    expect((await call("POST", `/forums/posts/${team.body.id}/vote`, undefined, ana)).body).toEqual({ score: 1 });
    expect((await call("POST", `/forums/posts/${team.body.id}/vote`, undefined, ana)).body).toEqual({ score: 1 });
    expect((await call("POST", `/forums/posts/${team.body.id}/vote`, undefined, rui)).body).toEqual({ score: 2 });
    expect((await call("GET", "/me/state", undefined, ana)).body.votes).toMatchObject({ forumPosts: [team.body.id] });

    const sorted = (sort: string) => call("GET", `/forums/threads/${idea}?sort=${sort}`).then((r) => r.body.posts.map((p: { id: number }) => p.id));
    expect(await sorted("top")).toEqual([team.body.id, first]);
    expect(await sorted("new")).toEqual([team.body.id, first]);
    expect(await sorted("old")).toEqual([first, team.body.id]);

    // Elsewhere, discussion goes by activity: no votes on replies, and top is just the usual order.
    const general = (await call("POST", "/forums/geral/threads", { title: "Olá", body: "Olá" }, ana)).body.id;
    const a = (await call("POST", `/forums/threads/${general}/posts`, { body: "1" }, ana)).body.id;
    const vote = await call("POST", `/forums/posts/${a}/vote`, undefined, rui);
    expect(vote.status).toBe(400);
    expect(vote.body.error.code).toBe("not_an_idea");
    expect((await call("POST", "/forums/posts/999999/vote", undefined, rui)).status).toBe(404);
  });
});

describe("paging replies", () => {
  it("pages replies in every order with nextCursor, and keeps `after` for oldest first", async () => {
    const [ana, rui, eva] = [await register("ana"), await register("rui"), await register("eva")];
    const idea = await openIdea(ana, "Modo escuro");
    const replies: number[] = [];
    for (let i = 0; i < 5; i++) replies.push((await call("POST", `/forums/threads/${idea}/posts`, { body: `Resposta ${i}` }, ana)).body.id);
    // Scores (each starts with ana's own vote): r3 = 3, r1 = 2, the rest 1.
    await call("POST", `/forums/posts/${replies[3]}/vote`, undefined, rui);
    await call("POST", `/forums/posts/${replies[3]}/vote`, undefined, eva);
    await call("POST", `/forums/posts/${replies[1]}/vote`, undefined, rui);

    const all = async (sort: string) => {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { posts: { id: number }[]; hasMore: boolean; nextCursor: string | null } } = await call(
          "GET", `/forums/threads/${idea}?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        seen.push(...page.body.posts.map((p) => p.id));
        expect(page.body.nextCursor === null).toBe(!page.body.hasMore);
        cursor = page.body.nextCursor;
      } while (cursor);
      return seen;
    };
    const [r0, r1, r2, r3, r4] = replies as [number, number, number, number, number];
    expect(await all("old")).toEqual([r0, r1, r2, r3, r4]);
    expect(await all("new")).toEqual([r4, r3, r2, r1, r0]);
    expect(await all("top")).toEqual([r3, r1, r0, r2, r4]);
    expect((await call("GET", `/forums/threads/${idea}?after=${r2}`)).body.posts.map((p: { id: number }) => p.id)).toEqual([r3, r4]);

    const newCursor = (await call("GET", `/forums/threads/${idea}?sort=new&limit=2`)).body.nextCursor;
    expect((await call("GET", `/forums/threads/${idea}?sort=top&cursor=${newCursor}`)).body.error.code).toBe("invalid_cursor");
    expect((await call("GET", `/forums/threads/${idea}?cursor=nope`)).body.error.code).toBe("invalid_cursor");
  });
});

describe("duplicates", () => {
  it("points a duplicate to its original, whose score counts each voter once, and gives the votes back when unmarked", async () => {
    const [ana, rui, eva, leo] = [await register("ana"), await register("rui"), await register("eva"), await register("leo")];
    // ana opened both, so each starts with her vote.
    const original = await openIdea(ana, "Modo escuro");
    const copy = await openIdea(ana, "Tema escuro");
    await call("POST", `/forums/threads/${original}/vote`, undefined, rui);
    await call("POST", `/forums/threads/${copy}/vote`, undefined, rui);
    await call("POST", `/forums/threads/${copy}/vote`, undefined, eva);

    expect((await setStatus(copy, { status: "duplicate" })).body.error.code).toBe("duplicate_of_required");
    expect((await setStatus(copy, { status: "duplicate", duplicateOf: copy })).body.error.code).toBe("invalid_duplicate");
    expect((await setStatus(copy, { status: "duplicate", duplicateOf: original })).body).toMatchObject({ status: "duplicate", duplicateOf: original });
    expect((await setStatus(original, { status: "duplicate", duplicateOf: copy })).body.error.code).toBe("invalid_duplicate");

    const score = async (id: number) => (await call("GET", `/forums/threads/${id}`)).body.thread.score as number;
    // ana and rui voted for both: counted once.
    expect(await score(original)).toBe(3);
    expect(await score(copy)).toBe(3);
    expect((await call("GET", `/forums/threads/${copy}`)).body.thread.duplicateOf).toEqual({ id: original, title: "Modo escuro" });
    expect(ids((await call("GET", "/forums/ideias/threads?status=duplicate")).body)).toEqual([copy]);

    // A new vote on the duplicate counts on the original too.
    await call("POST", `/forums/threads/${copy}/vote`, undefined, leo);
    expect(await score(original)).toBe(4);
    // The original's own votes are what /me/state shows as voted.
    expect((await call("GET", "/me/state", undefined, eva)).body.votes.forum).toEqual([copy]);

    await setStatus(copy, { status: "declined" });
    expect(await score(original)).toBe(2);
    expect((await call("GET", `/forums/threads/${copy}`)).body.thread.duplicateOf).toBeNull();
  });

  it("keeps a reader's own vote on the original when the duplicate they also voted on is unmarked", async () => {
    const [ana, rui] = [await register("ana"), await register("rui")];
    const original = await openIdea(ana, "Modo escuro");
    const copy = await openIdea(ana, "Tema escuro");
    await setStatus(copy, { status: "duplicate", duplicateOf: original });
    const score = async (id: number) => (await call("GET", `/forums/threads/${id}`)).body.thread.score as number;

    // rui votes on the duplicate (carried to the original), then on the original itself.
    await call("POST", `/forums/threads/${copy}/vote`, undefined, rui);
    expect((await call("GET", "/me/state", undefined, rui)).body.votes.forum).toEqual([copy]);
    // ana's own vote and rui's.
    expect((await call("POST", `/forums/threads/${original}/vote`, undefined, rui)).body).toEqual({ score: 2 });
    expect((await call("GET", "/me/state", undefined, rui)).body.votes.forum.sort()).toEqual([original, copy].sort());

    await setStatus(copy, { status: "declined" });
    expect(await score(original)).toBe(2);
    expect((await call("GET", "/me/state", undefined, rui)).body.votes.forum.sort()).toEqual([original, copy].sort());
  });
});
