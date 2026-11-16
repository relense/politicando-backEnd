import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, editorialPosts } from "../src/db/schema.js";
import { parseMedia, slugify } from "../src/editorial/media.js";
import { cleanBody, parseFrontMatter, parseMarkdownPost, saveMarkdownPosts } from "../src/editorial/markdownFiles.js";
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

describe("posts from Markdown files", () => {
  const file = [
    "---",
    "slug: oe-explicado",
    'title: "OE: como passa, fase a fase"',
    "subtitle: 'Sem jargão'",
    "tags: [Orçamento, parlamento, orçamento]",
    "publish: now, with an update on 24 Nov",
    "canonical_url: https://politicando.pt/editorial/outro  # placeholder",
    "---",
    "",
    "# OE: como passa, fase a fase",
    "",
    "> **Nota de edição:** publicar já.",
    "> Atualizar no dia 24.",
    "",
    "Intro.",
    "",
    "## Antes",
    "",
    "Texto.",
    "",
    "## Depois (24 de novembro)",
    "",
    "*[A preencher na noite de 24 de novembro.]*",
    "",
    "| Partido | Voto |",
    "",
    "## E depois?",
    "",
    "Fim.",
  ].join("\n");

  it("reads the front matter, ignoring keys it doesn't know and trailing comments", () => {
    const { meta } = parseFrontMatter(file);
    expect(meta).toMatchObject({ slug: "oe-explicado", title: "OE: como passa, fase a fase", subtitle: "Sem jargão", canonical_url: "https://politicando.pt/editorial/outro" });
    expect(meta.tags).toEqual(["Orçamento", "parlamento", "orçamento"]);
  });

  it("drops the repeated title, notes for editors and sections not written yet", () => {
    const post = parseMarkdownPost(file)!;
    expect(post).toMatchObject({ slug: "oe-explicado", kind: "article", subtitle: "Sem jargão", tags: ["orçamento", "parlamento"] });
    expect(post.body).toBe("Intro.\n\n## Antes\n\nTexto.\n\n## E depois?\n\nFim.\n");
    expect(cleanBody("# Outro título\n\nTexto", "Título")).toBe("# Outro título\n\nTexto\n");
  });

  it("skips files without a slug (internal write-ups), and needs a title", () => {
    expect(parseMarkdownPost("---\ntitle: Matching names\ncanonical_url: https://politicando.pt/editorial/x\n---\nBody")).toBeNull();
    expect(parseMarkdownPost("No front matter")).toBeNull();
    expect(() => parseMarkdownPost("---\nslug: sem-titulo\n---\nBody")).toThrow(/title/);
  });

  it("reads featured when the file says so", () => {
    expect(parseMarkdownPost(file)!.featured).toBeNull();
    expect(parseMarkdownPost(file.replace("slug: oe-explicado", "slug: oe-explicado\nfeatured: true"))!.featured).toBe(true);
    expect(() => parseMarkdownPost(file.replace("slug: oe-explicado", "slug: oe-explicado\nfeatured: sim"))).toThrow(/featured/);
  });

  it("features from the file, and unfeatures only when the file says false", async () => {
    const featuredFile = file.replace("slug: oe-explicado", "slug: oe-explicado\nfeatured: true");
    await saveMarkdownPosts(db, [parseMarkdownPost(featuredFile)!], { authorName: "R", publish: true });
    const featured = async () => (await app.inject({ method: "GET", url: "/api/v2/editorial/oe-explicado" })).json().featured;
    expect(await featured()).toBe(true);
    await saveMarkdownPosts(db, [parseMarkdownPost(file)!], { authorName: "R", publish: true });
    expect(await featured()).toBe(true);
    await saveMarkdownPosts(db, [parseMarkdownPost(featuredFile.replace("featured: true", "featured: false"))!], { authorName: "R", publish: true });
    expect(await featured()).toBe(false);
  });

  it("publishes, then updates by slug keeping the first publication date and featured", async () => {
    const first = new Date("2026-11-16T10:00:00Z");
    expect(await saveMarkdownPosts(db, [parseMarkdownPost(file)!], { authorName: "Redação Politicando", publish: true, now: first }))
      .toEqual([{ slug: "oe-explicado", created: true }]);
    await db.update(editorialPosts).set({ featured: true });

    const edited = parseMarkdownPost(file.replace("Intro.", "Nova intro."))!;
    expect(await saveMarkdownPosts(db, [edited], { authorName: "Redação Politicando", publish: true, now: new Date("2026-11-17T10:00:00Z") }))
      .toEqual([{ slug: "oe-explicado", created: false }]);

    const response = await app.inject({ method: "GET", url: "/api/v2/editorial/oe-explicado" });
    expect(response.json()).toMatchObject({ authorName: "Redação Politicando", featured: true, publishedAt: first.toISOString() });
    expect(response.json().body).toMatch(/^Nova intro\./);
  });
});
