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
    });
  });
});

describe("article list", () => {
  it("returns newest first with counts, parties and an excerpt", async () => {
    await insertArticle(db, { sourceUri: "old", publishedAt: new Date("2026-01-01T00:00:00Z") });
    const article = await insertArticle(
      db,
      {
        sourceUri: "new",
        content: "x".repeat(1_000),
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
    expect(body.items[0].excerpt).toHaveLength(300);
    expect(body.items[0].content).toBeUndefined();
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
});

describe("article detail", () => {
  it("returns full content and parties", async () => {
    const article = await insertArticle(db, { content: "y".repeat(1_000) });
    const { status, body } = await get(`/articles/${article.id}`);
    expect(status).toBe(200);
    expect(body.content).toHaveLength(1_000);
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
      "/api/v2/articles",
      "/api/v2/articles/{id}",
      "/api/v2/articles/{id}/comments",
      "/api/v2/parties",
    ]);
  });
});
