import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins } from "../src/db/schema.js";
import { parseMedia, slugify } from "../src/editorial/media.js";
import { createTestDb, resetDb } from "./helpers.js";

describe("media and slugs", () => {
  it("turns provider links into their embed URLs", () => {
    expect(parseMedia("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(parseMedia("https://youtu.be/dQw4w9WgXcQ")?.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(parseMedia("https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk?si=x")?.embedUrl).toBe("https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk");
    expect(parseMedia("https://vimeo.com/76979871")?.embedUrl).toBe("https://player.vimeo.com/video/76979871");
    expect(parseMedia("https://soundcloud.com/artista/episodio-1")?.provider).toBe("soundcloud");
    expect(parseMedia("https://podcasts.apple.com/pt/podcast/x/id123?i=456")?.embedUrl).toBe("https://embed.podcasts.apple.com/pt/podcast/x/id123?i=456");
  });

  it("rejects anything else", () => {
    expect(parseMedia("http://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseMedia("https://evil.example/embed")).toBeNull();
    expect(parseMedia("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseMedia("javascript:alert(1)")).toBeNull();
  });

  it("makes slugs from titles", () => {
    expect(slugify("Orçamento do Estado: o que muda?")).toBe("orcamento-do-estado-o-que-muda");
    expect(slugify("!!!")).toBe("post");
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, loginLimitPerMinute: 1000 });

beforeEach(async () => {
  await resetDb(db);
  const passwordHash = await hashPassword("correct horse battery");
  await db.insert(admins).values([
    { email: "ana@example.pt", name: "Ana", role: "author", passwordHash },
    { email: "rui@example.pt", name: "Rui", role: "author", passwordHash },
    { email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash },
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const login = async (email: string) => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password: "correct horse battery" } });
  return `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}`;
};
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers: cookie ? { cookie } : {}, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const post = (overrides: object = {}) => ({
  title: "Orçamento do Estado: o que muda?", subtitle: null, slug: null, kind: "podcast", body: "# Episódio 1\n\nTexto.",
  authorName: null, coverImageUrl: null, mediaUrl: "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", tags: ["Orçamento"], ...overrides,
});

describe("editorial", () => {
  it("drafts, publishes and features posts", async () => {
    const ana = await login("ana@example.pt");
    const created = await call("POST", "/admin/editorial", ana, post());
    expect(created).toMatchObject({
      status: 201,
      body: { slug: "orcamento-do-estado-o-que-muda", status: "draft", authorName: "Ana", tags: ["orçamento"], media: { provider: "spotify" } },
    });
    const id = created.body.id;
    expect((await call("GET", "/editorial")).body.total).toBe(0);
    expect((await call("GET", `/editorial/${created.body.slug}`)).status).toBe(404);

    expect((await call("POST", `/admin/editorial/${id}/publish`, ana)).body).toMatchObject({ status: "published" });
    expect((await call("POST", `/admin/editorial/${id}/feature`, ana)).status).toBe(403);
    const mod = await login("mod@example.pt");
    expect((await call("POST", `/admin/editorial/${id}/feature`, mod)).body.featured).toBe(true);

    const list = await call("GET", "/editorial?featured=true");
    expect(list.body).toMatchObject({ total: 1, items: [{ title: "Orçamento do Estado: o que muda?", media: { embedUrl: "https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk" } }] });
    expect(list.body.items[0].body).toBeUndefined();
    expect((await call("GET", "/editorial?tag=Orçamento&kind=podcast")).body.total).toBe(1);
    expect((await call("GET", `/editorial/${created.body.slug}`)).body.body).toContain("Episódio 1");

    const log = await call("GET", `/admin/audit?entity=editorial&entityId=${id}`, mod);
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(["editorial.feature", "editorial.publish", "editorial.create"]);
  });

  it("keeps authors to their own posts", async () => {
    const ana = await login("ana@example.pt");
    const rui = await login("rui@example.pt");
    const { body } = await call("POST", "/admin/editorial", ana, post());
    expect((await call("PUT", `/admin/editorial/${body.id}`, rui, post({ title: "Outro" }))).status).toBe(403);
    expect((await call("GET", "/admin/editorial", rui)).body.items).toEqual([]);
    expect((await call("GET", "/admin/editorial", await login("mod@example.pt"))).body.items).toHaveLength(1);
  });

  it("makes slugs unique, keeps them on edits, and rejects taken or unsupported ones", async () => {
    const ana = await login("ana@example.pt");
    const first = (await call("POST", "/admin/editorial", ana, post())).body;
    const second = (await call("POST", "/admin/editorial", ana, post())).body;
    expect(second.slug).toBe("orcamento-do-estado-o-que-muda-2");
    expect((await call("PUT", `/admin/editorial/${second.id}`, ana, post({ subtitle: "Novo" }))).body.slug).toBe("orcamento-do-estado-o-que-muda-2");
    expect((await call("PUT", `/admin/editorial/${second.id}`, ana, post({ slug: first.slug }))).body.error.code).toBe("slug_taken");
    expect((await call("POST", "/admin/editorial", ana, post({ mediaUrl: "https://evil.example/x" }))).body.error.code).toBe("unsupported_media");
  });

  it("deletes drafts only", async () => {
    const ana = await login("ana@example.pt");
    const { body } = await call("POST", "/admin/editorial", ana, post());
    await call("POST", `/admin/editorial/${body.id}/publish`, ana);
    expect((await call("DELETE", `/admin/editorial/${body.id}`, ana)).body.error.code).toBe("published");
    await call("POST", `/admin/editorial/${body.id}/unpublish`, ana);
    expect((await call("DELETE", `/admin/editorial/${body.id}`, ana)).status).toBe(204);
  });
});

describe("readingMinutes", () => {
  it("counts words at 200 a minute, rounding up, ignoring markup and link addresses", async () => {
    const { readingMinutes } = await import("../src/modules/editorial/routes.js");
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("palavra ".repeat(200))).toBe(1);
    expect(readingMinutes("palavra ".repeat(201))).toBe(2);
    expect(readingMinutes("## Título\n\n[uma ligação](https://example.pt/muito/longa) e **negrito** - ---")).toBe(1);
  });
});
