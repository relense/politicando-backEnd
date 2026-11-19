import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importContentPosts } from "../src/editorial/markdownFiles.js";
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

  it("won't let a draft replace a live post", async () => {
    await publish({ markdown: article() });
    const draft = await publish({ markdown: article("Revisão por acabar."), draft: true });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error.code).toBe("already_published");
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).json().body).toMatch(/^Texto do artigo\./);
  });

  it("keeps a repo post down once it's taken down, and its byline, across deploys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "politicando-content-"));
    await writeFile(join(dir, "teste-api.md"), article());
    await importContentPosts(db, dir);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).statusCode).toBe(200);

    await publish({ markdown: article(), author: "Ana" });
    await importContentPosts(db, dir);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).json().authorName).toBe("Ana");

    await app.inject({ method: "POST", url: "/api/v2/publish/teste-api/unpublish", headers: { authorization: `Bearer ${KEY}` } });
    await importContentPosts(db, dir);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/teste-api" })).statusCode).toBe(404);
  });

  it("stores a cover image once per content and serves it at a permanent URL", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("conteúdo da imagem")]);
    const upload = (body: Buffer, type = "image/png", key: string | null = KEY) =>
      app.inject({ method: "POST", url: "/api/v2/publish/image", payload: body, headers: { "content-type": type, ...(key && { authorization: `Bearer ${key}` }) } });

    expect((await upload(png, "image/png", null)).statusCode).toBe(401);
    const first = await upload(png);
    expect(first.statusCode).toBe(200);
    const { url, created } = first.json();
    expect(url).toMatch(/^http:\/\/localhost:4000\/media\/[0-9a-f]{64}\.png$/);
    expect(created).toBe(true);
    // The same file again: the same URL, nothing new stored.
    expect((await upload(png)).json()).toEqual({ url, created: false });

    const served = await app.inject({ method: "GET", url: new URL(url).pathname });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(served.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: "GET", url: new URL(url).pathname.replace(".png", ".jpg") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/media/nope.png" })).statusCode).toBe(404);

    // As a multipart file too, and JPG.
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]);
    const boundary = "----politicando";
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="capa.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const multipart = await app.inject({
      method: "POST", url: "/api/v2/publish/image", payload: form,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${KEY}` },
    });
    expect(multipart.json().url).toMatch(/\.jpg$/);

    // Not an image, or too big.
    expect((await upload(Buffer.from("<svg></svg>"))).json().error.code).toBe("invalid_image");
    expect((await upload(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]))).statusCode).toBe(413);
  });

  it("doesn't exist without keys", async () => {
    const closed = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });
    expect((await closed.inject({ method: "POST", url: "/api/v2/publish", payload: { markdown: article() } })).statusCode).toBe(404);
    await closed.close();
  });
});
