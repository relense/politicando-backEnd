import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { comments } from "../src/db/schema.js";
import type { RecaptchaVerifier } from "../src/modules/comments/recaptcha.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const verifyRecaptcha = vi.fn<RecaptchaVerifier>();

const makeApp = (commentLimitPerMinute = 1_000) =>
  buildApp({
    db,
    corsOrigins: ["https://politicando.example"],
    verifyRecaptcha,
    commentLimitPerMinute,
  });
const app = await makeApp();

beforeEach(async () => {
  await resetDb(db);
  verifyRecaptcha.mockReset();
  verifyRecaptcha.mockResolvedValue(true);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};
const postComment = async (articleId: number | string, payload: object) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/v2/articles/${articleId}/comments`,
    payload: { recaptchaToken: "token", ...payload },
  });
  return { status: response.statusCode, body: response.json() };
};
const insertArticles = async (count: number, sameTime = false) => {
  for (let i = 1; i <= count; i++) {
    await insertArticle(db, {
      sourceUri: `uri-${i}`,
      title: `Artigo ${i}`,
      publishedAt: sameTime
        ? new Date("2026-10-01T10:00:00.000Z")
        : new Date(Date.UTC(2026, 9, i)),
    });
  }
};

describe("parties", () => {
  it("lists parties", async () => {
    const { status, body } = await get("/parties");
    expect(status).toBe(200);
    expect(body).toHaveLength(24);
    expect(body.find((party: { slug: string }) => party.slug === "psd")).toEqual({
      slug: "psd",
      acronym: "PSD",
      name: "Partido Social Democrata",
      website: "https://www.psd.pt/",
      assemblySeats: 89,
      seatsAsOf: "2026-10-08",
      governmentMembers: 0,
      lastElection: null,
      leader: {
        name: "Luís Montenegro",
        title: "Presidente do PSD",
        deputyId: null,
        governmentMemberId: "6d6019aee9774dde80cc8342401a7065",
        photoUrl: null,
        asOf: "2026-11-15",
      },
    });
    expect(body.find((party: { slug: string }) => party.slug === "ppm").leader).toBeNull();
  });
});

describe("article list", () => {
  it("returns newest first with counts, parties and an excerpt", async () => {
    await insertArticle(db, { sourceUri: "old", publishedAt: new Date("2026-01-01T00:00:00Z") });
    const article = await insertArticle(
      db,
      {
        sourceUri: "new",
        excerpt: "Resumo curto",
        publishedAt: new Date("2026-02-01T00:00:00Z"),
      },
      ["psd", "ps"],
    );
    await postComment(article.id, { body: "Olá" });
    await postComment(article.id, { body: "Adeus" });

    const { status, body } = await get("/articles");
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: article.id,
      commentCount: 2,
      publishedAt: "2026-02-01T00:00:00.000Z",
      parties: [{ slug: "psd" }, { slug: "ps" }],
    });
    expect(body.items[0].excerpt).toBe("Resumo curto");
    expect(body.items[1].commentCount).toBe(0);
  });

  it("pages through every article exactly once", async () => {
    await insertArticles(5);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const { body } = await get(`/articles?limit=2${query}`);
      seen.push(...body.items.map((item: { id: number }) => item.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  it("does not lose articles that share a timestamp across pages", async () => {
    await insertArticles(4, true);
    const first = await get("/articles?limit=2");
    const second = await get(`/articles?limit=2&cursor=${first.body.nextCursor}`);
    const ids = [...first.body.items, ...second.body.items].map((item) => item.id);
    expect(ids).toEqual([4, 3, 2, 1]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("has no next page when the last page is exactly full", async () => {
    await insertArticles(2);
    expect((await get("/articles?limit=2")).body.nextCursor).toBeNull();
  });

  it("filters by party, including across pages", async () => {
    await insertArticle(db, { sourceUri: "a", publishedAt: new Date("2026-01-03T00:00:00Z") }, ["ps"]);
    await insertArticle(db, { sourceUri: "b", publishedAt: new Date("2026-01-02T00:00:00Z") }, ["il"]);
    await insertArticle(db, { sourceUri: "c", publishedAt: new Date("2026-01-01T00:00:00Z") }, ["ps", "il"]);

    const first = await get("/articles?party=ps&limit=1");
    expect(first.body.items[0].id).toBe(1);
    const second = await get(`/articles?party=ps&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0].id).toBe(3);
    expect(second.body.nextCursor).toBeNull();
  });

  it.each(["not-a-cursor", Buffer.from('{"id":"x"}').toString("base64url")])(
    "returns 400 for bad cursor %s",
    async (cursor) => {
      const { status, body } = await get(`/articles?cursor=${cursor}`);
      expect(status).toBe(400);
      expect(body.error.code).toBe("invalid_cursor");
    },
  );

  it.each(["limit=0", "limit=51", "limit=abc"])("returns 400 for %s", async (query) => {
    const { status, body } = await get(`/articles?${query}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 404 for an unknown party", async () => {
    expect((await get("/articles?party=nope")).status).toBe(404);
  });

  it("finds every word of q in the title or excerpt, ignoring accents and case", async () => {
    await insertArticle(db, { sourceUri: "a", title: "Crédito à Habitação", excerpt: "O Governo aprovou.", source: "Observador", publishedAt: new Date("2026-10-03") });
    await insertArticle(db, { sourceUri: "b", title: "Habitação jovem", excerpt: "Nada.", source: "publico.pt", publishedAt: new Date("2026-10-02") });
    await insertArticle(db, { sourceUri: "c", title: "Orçamento", excerpt: "Sem casas.", source: "Observador" });
    const titles = async (query: string) => (await get(`/articles?${query}`)).body.items.map((a: { title: string }) => a.title);
    expect(await titles("q=habitacao")).toEqual(["Crédito à Habitação", "Habitação jovem"]);
    expect(await titles("q=HABITACAO%20governo")).toEqual(["Crédito à Habitação"]);
    expect(await titles("q=habitacao&source=Observador")).toEqual(["Crédito à Habitação"]);
    expect(await titles("q=100%25")).toEqual([]);
    expect(await titles("source=Observador&party=ps")).toEqual(["Crédito à Habitação", "Orçamento"]);

    const first = await get("/articles?q=habitacao&limit=1");
    const second = await get(`/articles?q=habitacao&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((a: { title: string }) => a.title)).toEqual(["Habitação jovem"]);
    expect(second.body.nextCursor).toBeNull();

    expect((await get("/articles/sources")).body).toEqual({
      items: [{ name: "Observador", count: 2 }, { name: "publico.pt", count: 1 }],
    });
  });

  it("takes several parties and sources: any within a list, both lists together, with a total", async () => {
    await insertArticle(db, { sourceUri: "a", title: "A", source: "publico.pt", publishedAt: new Date("2026-10-05") }, ["ps"]);
    await insertArticle(db, { sourceUri: "b", title: "B", source: "expresso.pt", publishedAt: new Date("2026-10-04") }, ["psd"]);
    await insertArticle(db, { sourceUri: "c", title: "C", source: "dn.pt", publishedAt: new Date("2026-10-03") }, ["ps"]);
    await insertArticle(db, { sourceUri: "d", title: "D", source: "publico.pt", publishedAt: new Date("2026-10-02") }, ["chega"]);
    await insertArticle(db, { sourceUri: "e", title: "E", source: "publico.pt", publishedAt: new Date("2026-10-01") }, ["ps", "psd"]);
    const titles = async (query: string) => (await get(`/articles?${query}`)).body.items.map((a: { title: string }) => a.title);

    expect(await titles("party=ps,psd")).toEqual(["A", "B", "C", "E"]);
    expect(await titles("source=publico.pt,expresso.pt")).toEqual(["A", "B", "D", "E"]);
    expect(await titles("party=ps,psd&source=publico.pt,%20expresso.pt,")).toEqual(["A", "B", "E"]);
    expect(await titles("party=ps")).toEqual(["A", "C", "E"]);

    const first = await get("/articles?party=ps,psd&source=publico.pt,expresso.pt&limit=2");
    expect(first.body).toMatchObject({ total: 3 });
    const second = await get(`/articles?party=ps,psd&source=publico.pt,expresso.pt&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body).toMatchObject({ total: 3, nextCursor: null });
    expect(second.body.items.map((a: { title: string }) => a.title)).toEqual(["E"]);

    expect(await get("/articles?party=ps,nope,psd")).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "Party not found: nope" } } });
    expect((await get("/articles?source=nada.pt,outro.pt")).body).toEqual({ items: [], nextCursor: null, total: 0 });
    expect((await get("/articles?party=,")).status).toBe(400);
  });

  it("sorts by visible comments within the last hours", async () => {
    const now = Date.now();
    const old = await insertArticle(db, { sourceUri: "old", title: "Antigo", publishedAt: new Date(now - 48 * 3_600_000) });
    const one = await insertArticle(db, { sourceUri: "one", title: "Um", publishedAt: new Date(now - 3_600_000) });
    const two = await insertArticle(db, { sourceUri: "two", title: "Dois", publishedAt: new Date(now - 2 * 3_600_000) });
    await insertArticle(db, { sourceUri: "none", title: "Nenhum", publishedAt: new Date(now - 3_600_000) });
    await db.insert(comments).values([
      { articleId: old.id, body: "a" }, { articleId: old.id, body: "b" }, { articleId: old.id, body: "c" },
      { articleId: one.id, body: "a" }, { articleId: one.id, body: "hidden", hiddenAt: new Date() }, { articleId: one.id, body: "hidden", hiddenAt: new Date() },
      { articleId: two.id, body: "a" }, { articleId: two.id, body: "b" },
    ]);
    const first = await get("/articles?sort=comments&since=24h&limit=1");
    expect(first.body.items.map((a: { title: string; commentCount: number }) => [a.title, a.commentCount])).toEqual([["Dois", 2]]);
    const second = await get(`/articles?sort=comments&since=24&limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((a: { title: string }) => a.title)).toEqual(["Um"]);
    expect(second.body.nextCursor).toBeNull();
    expect((await get("/articles?sort=comments")).body.items.map((a: { title: string }) => a.title)).toEqual(["Antigo", "Dois", "Um"]);
    expect((await get("/articles?since=1d")).status).toBe(400);
  });
});

describe("article detail", () => {
  it("returns the excerpt and parties, with no article text", async () => {
    const article = await insertArticle(db, { excerpt: "Resumo" });
    const { status, body } = await get(`/articles/${article.id}`);
    expect(status).toBe(200);
    expect(body.excerpt).toBe("Resumo");
    expect(body.content).toBeUndefined();
    expect(body.parties).toEqual([{ slug: "ps", acronym: "PS", name: "Partido Socialista" }]);
    expect(body.commentCount).toBe(0);
  });

  it.each([
    ["999", 404],
    ["abc", 400],
    ["0", 400],
    ["99999999999", 400],
  ])("for id %s returns %i", async (id, expected) => {
    expect((await get(`/articles/${id}`)).status).toBe(expected);
  });
});

describe("comments", () => {
  it("creates anonymous and named comments and threads replies", async () => {
    const article = await insertArticle(db);
    const parent = await postComment(article.id, { username: "  Ana  ", body: "  Olá  " });
    expect(parent.status).toBe(201);
    expect(parent.body).toMatchObject({ username: "Ana", body: "Olá", parentId: null });

    const reply = await postComment(article.id, { body: "Resposta", parentId: parent.body.id });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      username: null,
      parentId: parent.body.id,
      parentUsername: "Ana",
    });

    const { body } = await get(`/articles/${article.id}/comments`);
    expect(body.map((c: { body: string }) => c.body)).toEqual(["Olá", "Resposta"]);
    expect(body[0].parentUsername).toBeNull();
    expect(body[1].parentUsername).toBe("Ana");
  });

  it("stores markup unchanged as plain text", async () => {
    const article = await insertArticle(db);
    const { body } = await postComment(article.id, { body: "<script>x</script>" });
    expect(body.body).toBe("<script>x</script>");
  });

  it("returns 404 for comments on an unknown article", async () => {
    expect((await get("/articles/999/comments")).status).toBe(404);
    expect((await postComment(999, { body: "Olá" })).status).toBe(404);
  });

  it.each([
    ["empty body", { body: "" }],
    ["blank body", { body: "   " }],
    ["long body", { body: "x".repeat(501) }],
    ["long username", { body: "ok", username: "x".repeat(51) }],
    ["unknown field", { body: "ok", commentType: "post" }],
    ["missing token", { body: "ok", recaptchaToken: undefined }],
  ])("returns 400 for %s and saves nothing", async (_name, payload) => {
    const article = await insertArticle(db);
    const { status } = await postComment(article.id, payload);
    expect(status).toBe(400);
    expect(verifyRecaptcha).not.toHaveBeenCalled();
    expect((await get(`/articles/${article.id}/comments`)).body).toEqual([]);
  });

  it("hides hidden comments from lists and counts, and blocks replies to them", async () => {
    const article = await insertArticle(db);
    const visible = await postComment(article.id, { body: "Visível" });
    const hidden = await postComment(article.id, { body: "Escondido" });
    await db.update(comments).set({ hiddenAt: new Date() }).where(eq(comments.id, hidden.body.id));

    const list = await get(`/articles/${article.id}/comments`);
    expect(list.body.map((c: { id: number }) => c.id)).toEqual([visible.body.id]);
    expect((await get(`/articles/${article.id}`)).body.commentCount).toBe(1);
    expect((await get("/articles")).body.items[0].commentCount).toBe(1);

    const reply = await postComment(article.id, { body: "x", parentId: hidden.body.id });
    expect(reply.status).toBe(400);
  });

  it("rejects a parent from another article", async () => {
    const first = await insertArticle(db, { sourceUri: "a" });
    const second = await insertArticle(db, { sourceUri: "b" });
    const parent = await postComment(first.id, { body: "Olá" });
    const { status, body } = await postComment(second.id, { body: "x", parentId: parent.body.id });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_parent");
  });

  it("returns 403 when reCAPTCHA fails and saves nothing", async () => {
    verifyRecaptcha.mockResolvedValue(false);
    const article = await insertArticle(db);
    const { status, body } = await postComment(article.id, { body: "spam" });
    expect(status).toBe(403);
    expect(body.error.code).toBe("recaptcha_failed");
    expect((await get(`/articles/${article.id}/comments`)).body).toEqual([]);
  });

  it("fails closed with 503 when reCAPTCHA is unreachable", async () => {
    verifyRecaptcha.mockRejectedValue(new Error("down"));
    const article = await insertArticle(db);
    const { status } = await postComment(article.id, { body: "x" });
    expect(status).toBe(503);
    expect((await get(`/articles/${article.id}/comments`)).body).toEqual([]);
  });

  it("rate limits comment creation", async () => {
    const limited = await makeApp(2);
    const article = await insertArticle(db);
    const send = () =>
      limited.inject({
        method: "POST",
        url: `/api/v2/articles/${article.id}/comments`,
        payload: { body: "x", recaptchaToken: "t" },
      });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(201);
    const blocked = await send();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");
    await limited.close();
  });
});

describe("platform", () => {
  it("takes the client IP only from the configured header, never from a forged X-Forwarded-For", async () => {
    const seen = vi.fn<RecaptchaVerifier>(async () => true);
    const proxied = await buildApp({ db, corsOrigins: [], verifyRecaptcha: seen, clientIpHeader: "True-Client-IP", commentLimitPerMinute: 2 });
    const article = await insertArticle(db);
    const send = (headers: Record<string, string>) =>
      proxied.inject({ method: "POST", url: `/api/v2/articles/${article.id}/comments`, payload: { body: "x", recaptchaToken: "t" }, headers });

    expect((await send({ "true-client-ip": "1.2.3.4", "x-forwarded-for": "6.6.6.6" })).statusCode).toBe(201);
    expect(seen).toHaveBeenLastCalledWith("t", "1.2.3.4");
    expect((await send({ "x-forwarded-for": "6.6.6.6" })).statusCode).toBe(201);
    expect(seen).toHaveBeenLastCalledWith("t", "127.0.0.1");
    // A new forged address each time doesn't get round the limit.
    expect((await send({ "true-client-ip": "1.2.3.4", "x-forwarded-for": "7.7.7.7" })).statusCode).toBe(201);
    expect((await send({ "true-client-ip": "1.2.3.4", "x-forwarded-for": "8.8.8.8" })).statusCode).toBe(429);
    expect((await send({ "true-client-ip": "5.5.5.5" })).statusCode).toBe(201);
    await proxied.close();
  });

  it("counts each reader behind the frontend, when it sends the shared key", async () => {
    const seen = vi.fn<RecaptchaVerifier>(async () => true);
    const key = "k".repeat(40);
    const behind = await buildApp({
      db, corsOrigins: [], verifyRecaptcha: seen, clientIpHeader: "True-Client-IP", commentLimitPerMinute: 1, frontendKey: key,
    });
    const article = await insertArticle(db);
    const comment = (headers: Record<string, string>) =>
      behind.inject({ method: "POST", url: `/api/v2/articles/${article.id}/comments`, payload: { body: "x", recaptchaToken: "t" }, headers: { "true-client-ip": "9.9.9.9", ...headers } });

    // The frontend server (9.9.9.9) renders for two readers: each gets their own limit.
    expect((await comment({ "x-frontend-key": key, "x-reader-ip": "1.1.1.1" })).statusCode).toBe(201);
    expect(seen).toHaveBeenLastCalledWith("t", "1.1.1.1");
    expect((await comment({ "x-frontend-key": key, "x-reader-ip": "2.2.2.2" })).statusCode).toBe(201);
    expect((await comment({ "x-frontend-key": key, "x-reader-ip": "1.1.1.1" })).statusCode).toBe(429);
    // Without the right key, X-Reader-IP is ignored: it's the caller's own address.
    expect((await comment({ "x-frontend-key": "wrong", "x-reader-ip": "3.3.3.3" })).statusCode).toBe(201);
    expect(seen).toHaveBeenLastCalledWith("t", "9.9.9.9");
    expect((await comment({ "x-reader-ip": "4.4.4.4" })).statusCode).toBe(429);

    // Renders with no reader (background revalidation) skip the general limit of 300 a minute.
    const get = (headers: Record<string, string>) => behind.inject({ method: "GET", url: "/api/v2/cases/glossary", headers: { "true-client-ip": "8.8.8.8", ...headers } });
    const statuses = async (headers: Record<string, string>) => {
      const codes = new Set<number>();
      for (let i = 0; i < 301; i++) codes.add((await get(headers)).statusCode);
      return [...codes].sort();
    };
    expect(await statuses({ "x-frontend-key": key })).toEqual([200]);
    expect(await statuses({})).toEqual([200, 429]);
    await behind.close();
  });

  it("serves the frontend over Render's private network: internal Host, no Cloudflare header", async () => {
    const seen = vi.fn<RecaptchaVerifier>(async () => true);
    const key = "k".repeat(40);
    const internal = await buildApp({
      db, corsOrigins: [], verifyRecaptcha: seen, clientIpHeader: "True-Client-IP", commentLimitPerMinute: 1, frontendKey: key,
    });
    const article = await insertArticle(db);
    const host = { host: "politicando-api:10000" };
    expect((await internal.inject({ method: "GET", url: "/api/v2/parties", headers: { ...host, "x-frontend-key": key } })).statusCode).toBe(200);
    const comment = (ip: string) =>
      internal.inject({
        method: "POST", url: `/api/v2/articles/${article.id}/comments`, payload: { body: "x", recaptchaToken: "t" },
        headers: { ...host, "x-frontend-key": key, "x-reader-ip": ip },
      });
    expect((await comment("1.1.1.1")).statusCode).toBe(201);
    expect(seen).toHaveBeenLastCalledWith("t", "1.1.1.1");
    expect((await comment("2.2.2.2")).statusCode).toBe(201);
    expect((await comment("1.1.1.1")).statusCode).toBe(429);
    await internal.close();
  });

  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("only allows configured CORS origins", async () => {
    const origin = async (value: string) =>
      (
        await app.inject({ method: "GET", url: "/api/v2/parties", headers: { origin: value } })
      ).headers["access-control-allow-origin"];
    expect(await origin("https://politicando.example")).toBe("https://politicando.example");
    expect(await origin("https://evil.example")).toBeUndefined();
  });

  it("allows a JSON POST preflight from a configured origin", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v2/articles/1/comments",
      headers: {
        origin: "https://politicando.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://politicando.example");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("content-type");
  });

  it("returns the standard error format for unknown routes", async () => {
    const { status, body } = await get("/nope");
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("documents every route in OpenAPI", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(Object.keys(response.json().paths).sort()).toEqual([
      "/api/v2/admin/admins",
      "/api/v2/admin/admins/{id}",
      "/api/v2/admin/agenda",
      "/api/v2/admin/agenda/{id}",
      "/api/v2/admin/agenda/{id}/feature",
      "/api/v2/admin/agenda/{id}/hide",
      "/api/v2/admin/agenda/{id}/unfeature",
      "/api/v2/admin/agenda/{id}/unhide",
      "/api/v2/admin/articles/{id}/hide",
      "/api/v2/admin/articles/{id}/unhide",
      "/api/v2/admin/audit",
      "/api/v2/admin/cases",
      "/api/v2/admin/cases/{id}",
      "/api/v2/admin/cases/{id}/publish",
      "/api/v2/admin/cases/{id}/unpublish",
      "/api/v2/admin/comments",
      "/api/v2/admin/comments/{id}/hide",
      "/api/v2/admin/comments/{id}/reply",
      "/api/v2/admin/comments/{id}/unhide",
      "/api/v2/admin/corrections",
      "/api/v2/admin/corrections/{id}",
      "/api/v2/admin/editorial",
      "/api/v2/admin/editorial/{id}",
      "/api/v2/admin/editorial/{id}/feature",
      "/api/v2/admin/editorial/{id}/publish",
      "/api/v2/admin/editorial/{id}/unfeature",
      "/api/v2/admin/editorial/{id}/unpublish",
      "/api/v2/admin/feedback",
      "/api/v2/admin/feedback/{id}",
      "/api/v2/admin/feedback/{id}/answer",
      "/api/v2/admin/feedback/{id}/close",
      "/api/v2/admin/feedback/{id}/correction",
      "/api/v2/admin/feedback/{id}/note",
      "/api/v2/admin/feedback/{id}/screenshot",
      "/api/v2/admin/forum/posts/{id}/hide",
      "/api/v2/admin/forum/posts/{id}/unhide",
      "/api/v2/admin/forum/threads/{id}/hide",
      "/api/v2/admin/forum/threads/{id}/lock",
      "/api/v2/admin/forum/threads/{id}/pin",
      "/api/v2/admin/forum/threads/{id}/posts",
      "/api/v2/admin/forum/threads/{id}/status",
      "/api/v2/admin/forum/threads/{id}/unhide",
      "/api/v2/admin/forum/threads/{id}/unlock",
      "/api/v2/admin/forum/threads/{id}/unpin",
      "/api/v2/admin/interests",
      "/api/v2/admin/interests/{id}",
      "/api/v2/admin/login",
      "/api/v2/admin/logout",
      "/api/v2/admin/me",
      "/api/v2/admin/password",
      "/api/v2/admin/readers",
      "/api/v2/admin/readers/stats",
      "/api/v2/admin/readers/{id}",
      "/api/v2/admin/readers/{id}/activity",
      "/api/v2/admin/readers/{id}/ban",
      "/api/v2/admin/readers/{id}/remove-content",
      "/api/v2/admin/readers/{id}/suspend",
      "/api/v2/admin/readers/{id}/unban",
      "/api/v2/admin/readers/{id}/unsuspend",
      "/api/v2/admin/reports",
      "/api/v2/admin/reports/resolve",
      "/api/v2/admin/users",
      "/api/v2/admin/users/{id}/disable",
      "/api/v2/admin/users/{id}/enable",
      "/api/v2/agenda",
      "/api/v2/articles",
      "/api/v2/articles/sources",
      "/api/v2/articles/{id}",
      "/api/v2/articles/{id}/comments",
      "/api/v2/articles/{id}/view",
      "/api/v2/articles/{id}/vote",
      "/api/v2/auth/email/confirm",
      "/api/v2/auth/login",
      "/api/v2/auth/logout",
      "/api/v2/auth/password/forgot",
      "/api/v2/auth/password/reset",
      "/api/v2/auth/register",
      "/api/v2/budget",
      "/api/v2/budget/{year}/proposals",
      "/api/v2/budget/{year}/proposals/{id}",
      "/api/v2/budget/{year}/summary",
      "/api/v2/cases",
      "/api/v2/cases/glossary",
      "/api/v2/cases/{id}",
      "/api/v2/comments/{id}/like",
      "/api/v2/contracts",
      "/api/v2/contracts/parties/{nif}",
      "/api/v2/contracts/procedures",
      "/api/v2/contracts/stats",
      "/api/v2/contracts/{id}",
      "/api/v2/corrections",
      "/api/v2/deputies/{id}",
      "/api/v2/deputies/{id}/votes",
      "/api/v2/editorial",
      "/api/v2/editorial/{slug}",
      "/api/v2/editorial/{slug}/comments",
      "/api/v2/editorial/{slug}/view",
      "/api/v2/editorial/{slug}/vote",
      "/api/v2/elections",
      "/api/v2/elections/{id}",
      "/api/v2/elections/{id}/candidates",
      "/api/v2/elections/{id}/dhondt",
      "/api/v2/elections/{id}/places/{key}",
      "/api/v2/explainers/become-deputy",
      "/api/v2/feedback",
      "/api/v2/feedback/follow/{token}",
      "/api/v2/feedback/summary",
      "/api/v2/forums",
      "/api/v2/forums/posts/{id}/vote",
      "/api/v2/forums/threads/{id}",
      "/api/v2/forums/threads/{id}/posts",
      "/api/v2/forums/threads/{id}/similar",
      "/api/v2/forums/threads/{id}/vote",
      "/api/v2/forums/{board}/threads",
      "/api/v2/government",
      "/api/v2/government/members/{id}",
      "/api/v2/governments/history",
      "/api/v2/initiatives",
      "/api/v2/initiatives/topics",
      "/api/v2/initiatives/{id}",
      "/api/v2/interests",
      "/api/v2/interests/contracts",
      "/api/v2/legislatures",
      "/api/v2/legislatures/{id}",
      "/api/v2/local-officials/search",
      "/api/v2/local-officials/{id}",
      "/api/v2/me",
      "/api/v2/me/activity",
      "/api/v2/me/email",
      "/api/v2/me/email/remind-later",
      "/api/v2/me/export",
      "/api/v2/me/follows/budget_proposals",
      "/api/v2/me/follows/{kind}/{id}",
      "/api/v2/me/hidden/{id}",
      "/api/v2/me/merge",
      "/api/v2/me/muted/{kind}/{value}",
      "/api/v2/me/newsletter",
      "/api/v2/me/notifications",
      "/api/v2/me/notifications/read",
      "/api/v2/me/notifications/unread",
      "/api/v2/me/password",
      "/api/v2/me/predictions",
      "/api/v2/me/read/{id}",
      "/api/v2/me/saved",
      "/api/v2/me/saved/{kind}/{id}",
      "/api/v2/me/state",
      "/api/v2/newsletter/confirm",
      "/api/v2/newsletter/subscribe",
      "/api/v2/newsletter/unsubscribe",
      "/api/v2/parliament",
      "/api/v2/parties",
      "/api/v2/parties/{slug}/votes",
      "/api/v2/people/featured",
      "/api/v2/people/{kind}/{id}/path",
      "/api/v2/places",
      "/api/v2/places/locate",
      "/api/v2/places/{key}",
      "/api/v2/podcast",
      "/api/v2/podcast/latest",
      "/api/v2/predictions/open",
      "/api/v2/predictions/{initiativeId}",
      "/api/v2/president",
      "/api/v2/reports",
      "/api/v2/sitemap",
      "/api/v2/sitemap/{kind}",
      "/api/v2/stories",
      "/api/v2/stories/tags",
      "/api/v2/stories/{id}",
      "/api/v2/stories/{id}/comments",
      "/api/v2/stories/{id}/vote",
      "/api/v2/timeline",
      "/api/v2/today",
      "/media/{file}",
    ]);
  });
});
