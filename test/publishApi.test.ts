import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const KEY = "k".repeat(40);
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", publishKeys: ["o".repeat(40), KEY] });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const article = (body = "Texto do artigo.") => `---
slug: teste-api
kind: article
title: "Um artigo pela API"
subtitle: "Publicado com a chave"
tags: [teste, api]
featured: true
---

${body}
`;

const publish = (payload: object, key: string | null = KEY) =>
  app.inject({ method: "POST", url: "/api/v2/publish", payload, headers: key ? { authorization: `Bearer ${key}` } : {} });

describe("publishing by API key", () => {
  it("needs one of the keys", async () => {
    expect((await publish({ markdown: article() }, null)).statusCode).toBe(401);
    expect((await publish({ markdown: article() }, "x".repeat(40))).json().error.code).toBe("invalid_key");
  });

  it("publishes an article.md, updates it by slug, and says when nothing changed", async () => {
    const first = await publish({ markdown: article() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ slug: "teste-api", status: "published", created: true, changed: true, url: "https://www.politicando.pt/editorial/teste-api" });
    const live = (await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).json();
    expect(live).toMatchObject({ title: "Um artigo pela API", featured: true, authorName: "Redação Politicando", tags: ["teste", "api"] });

    expect((await publish({ markdown: article() })).json()).toMatchObject({ created: false, changed: false });
    expect((await publish({ markdown: article("Texto novo."), author: "Ana" })).json()).toMatchObject({ created: false, changed: true });
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).json()).toMatchObject({ body: expect.stringMatching(/^Texto novo\./), authorName: "Ana" });
  });

  it("stores drafts, unpublishes, and refuses files without a slug", async () => {
    expect((await publish({ markdown: article(), draft: true })).json()).toMatchObject({ status: "draft" });
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).statusCode).toBe(404);
    await publish({ markdown: article() });
    const off = await app.inject({ method: "POST", url: "/api/v2/publish/teste-api/unpublish", headers: { authorization: `Bearer ${KEY}` } });
    expect(off.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).statusCode).toBe(404);
    expect((await publish({ markdown: "---\ntitle: Sem slug\n---\nTexto" })).json().error.code).toBe("invalid_article");
  });

  it("doesn't exist without keys", async () => {
    const closed = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });
    expect((await closed.inject({ method: "POST", url: "/api/v2/publish", payload: { markdown: article() } })).statusCode).toBe(404);
    await closed.close();
  });
});
