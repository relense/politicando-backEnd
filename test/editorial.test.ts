import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, comments, editorialPosts, editorialViews } from "../src/db/schema.js";
import { parseMedia, slugify } from "../src/editorial/media.js";
import { cleanBody, parseFrontMatter, parseMarkdownPost, saveMarkdownPosts } from "../src/editorial/markdownFiles.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

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
const revalidate = vi.fn(async () => {});
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, loginLimitPerMinute: 1000, revalidate });

beforeEach(async () => {
  await resetDb(db);
  revalidate.mockClear();
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

    // Going live for the first time makes it a front-page highlight.
    expect((await call("POST", `/admin/editorial/${id}/publish`, ana)).body).toMatchObject({ status: "published", featured: true });
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

  it("tells the site to refresh the blog when a change shows there, and never lets it be cached", async () => {
    const ana = await login("ana@example.pt");
    const mod = await login("mod@example.pt");
    const { body } = await call("POST", "/admin/editorial", ana, post());
    await call("PUT", `/admin/editorial/${body.id}`, ana, post({ subtitle: "Ainda rascunho" }));
    expect(revalidate).not.toHaveBeenCalled();
    for (const [step, who] of [["publish", ana], ["feature", mod], ["unfeature", mod]] as const) {
      revalidate.mockClear();
      await call("POST", `/admin/editorial/${body.id}/${step}`, who);
      expect(revalidate).toHaveBeenCalledWith(["blog"]);
    }
    revalidate.mockClear();
    await call("PUT", `/admin/editorial/${body.id}`, ana, post({ subtitle: "Corrigido" }));
    expect(revalidate).toHaveBeenCalledWith(["blog"]);
    revalidate.mockClear();
    await call("POST", `/admin/editorial/${body.id}/unpublish`, ana);
    expect(revalidate).toHaveBeenCalledWith(["blog"]);
    revalidate.mockClear();
    await call("POST", `/admin/editorial/${body.id}/unpublish`, ana);
    expect(revalidate).not.toHaveBeenCalled();

    for (const url of ["/admin/editorial", `/admin/editorial/${body.id}`, "/admin/audit"]) {
      const response = await app.inject({ method: "GET", url: `/api/v2${url}`, headers: { cookie: mod } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
    expect((await app.inject({ method: "GET", url: "/api/v2/admin/editorial" })).headers["cache-control"]).toBe("private, no-store");
  });

  it("takes a body as long as its limit in multibyte text", async () => {
    const ana = await login("ana@example.pt");
    // 100,000 characters of up to 3 bytes: far past the API's general 64 KB.
    const long = await call("POST", "/admin/editorial", ana, post({ body: "ação€".repeat(20_000) }));
    expect(long.status).toBe(201);
    expect((await call("PUT", `/admin/editorial/${long.body.id}`, ana, post({ body: "€".repeat(100_000) }))).status).toBe(200);
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

  it("features a new post unless the file says false, and an edit never features it again", async () => {
    const featured = async (slug = "oe-explicado") => (await app.inject({ method: "GET", url: `/api/v2/editorial/${slug}` })).json().featured;
    await saveMarkdownPosts(db, [parseMarkdownPost(file)!], { authorName: "R", publish: true });
    expect(await featured()).toBe(true);
    // A moderator took it off: an edit without `featured` leaves it off.
    await db.update(editorialPosts).set({ featured: false });
    await saveMarkdownPosts(db, [parseMarkdownPost(file.replace("# ", "# Revisto: "))!], { authorName: "R", publish: true });
    expect(await featured()).toBe(false);
    // Opted out in the file.
    const optOut = file.replace("slug: oe-explicado", "slug: sem-destaque\nfeatured: false");
    await saveMarkdownPosts(db, [parseMarkdownPost(optOut)!], { authorName: "R", publish: true });
    expect(await featured("sem-destaque")).toBe(false);
    // A draft isn't featured; it is once it goes live.
    const draft = file.replace("slug: oe-explicado", "slug: rascunho");
    await saveMarkdownPosts(db, [parseMarkdownPost(draft)!], { authorName: "R", publish: false });
    expect((await db.select({ featured: editorialPosts.featured }).from(editorialPosts).where(eq(editorialPosts.slug, "rascunho")))[0]!.featured).toBe(false);
    await saveMarkdownPosts(db, [parseMarkdownPost(draft)!], { authorName: "R", publish: true });
    expect(await featured("rascunho")).toBe(true);
  });

  it("publishes, then updates by slug keeping the first publication date and featured", async () => {
    const first = new Date("2026-11-16T10:00:00Z");
    expect(await saveMarkdownPosts(db, [parseMarkdownPost(file)!], { authorName: "Redação Politicando", publish: true, now: first }))
      .toEqual([{ slug: "oe-explicado", created: true, changed: true }]);
    await db.update(editorialPosts).set({ featured: true });

    const edited = parseMarkdownPost(file.replace("Intro.", "Nova intro."))!;
    expect(await saveMarkdownPosts(db, [edited], { authorName: "Redação Politicando", publish: true, now: new Date("2026-11-17T10:00:00Z") }))
      .toEqual([{ slug: "oe-explicado", created: false, changed: true }]);
    // The same file again (each deploy): nothing changes, not even the date.
    const [before] = await db.select({ updatedAt: editorialPosts.updatedAt }).from(editorialPosts);
    expect(await saveMarkdownPosts(db, [edited], { authorName: "Redação Politicando", publish: true, now: new Date("2026-11-18T10:00:00Z") }))
      .toEqual([{ slug: "oe-explicado", created: false, changed: false }]);
    const [after] = await db.select({ updatedAt: editorialPosts.updatedAt }).from(editorialPosts);
    expect(after!.updatedAt).toEqual(before!.updatedAt);

    const response = await app.inject({ method: "GET", url: "/api/v2/editorial/oe-explicado" });
    expect(response.json()).toMatchObject({ authorName: "Redação Politicando", featured: true, publishedAt: first.toISOString() });
    expect(response.json().body).toMatch(/^Nova intro\./);
  });
});

describe("most read", () => {
  const publish = async (slug: string, status: "published" | "draft" = "published") => {
    const [row] = await db
      .insert(editorialPosts)
      .values({ slug, title: slug, kind: "article", body: "texto", authorName: "Ana", tags: [], status, publishedAt: status === "published" ? new Date() : null })
      .returning();
    return row!;
  };
  const read = (slug: string, ip = "10.0.0.1", headers: Record<string, string> = {}, payload?: string) =>
    app.inject({ method: "POST", url: `/api/v2/editorial/${slug}/view`, remoteAddress: ip, headers, ...(payload !== undefined && { payload }) });

  it("counts beacons once per reader per post per day, whatever they send", async () => {
    const post = await publish("orcamento");
    await publish("rascunho", "draft");
    expect((await read("orcamento", "1.1.1.1", { "content-type": "text/plain;charset=UTF-8" }, "")).statusCode).toBe(204);
    expect((await read("orcamento", "1.1.1.1")).statusCode).toBe(204);
    expect((await read("orcamento", "2.2.2.2", { "content-type": "application/json" }, "{}")).statusCode).toBe(204);
    expect((await read("orcamento", "3.3.3.3", { "content-type": "application/json" }, "")).statusCode).toBe(204);
    expect((await read("rascunho")).statusCode).toBe(404);
    expect((await read("nao-existe")).statusCode).toBe(404);
    const rows = await db.select().from(editorialViews);
    expect(rows).toEqual([{ postId: post.id, day: expect.any(String), views: 3 }]);
  });

  it("lists the most read in the last days, with their reads", async () => {
    const a = await publish("a");
    const b = await publish("b");
    await publish("never-read");
    await db.insert(editorialViews).values([
      { postId: a.id, day: sql`(now() at time zone 'Europe/Lisbon')::date`, views: 2 },
      { postId: b.id, day: sql`(now() at time zone 'Europe/Lisbon')::date - 1`, views: 5 },
      { postId: a.id, day: sql`(now() at time zone 'Europe/Lisbon')::date - 30`, views: 100 },
    ]);
    const popular = (await app.inject({ method: "GET", url: "/api/v2/editorial?sort=popular&days=7" })).json();
    // Sorted by reads in the window; views is still every read since publication.
    expect(popular).toMatchObject({
      total: 2,
      items: [
        { slug: "b", recentViews: 5, views: 5 },
        { slug: "a", recentViews: 2, views: 102 },
      ],
    });
    const month = (await app.inject({ method: "GET", url: "/api/v2/editorial?sort=popular&days=90&limit=1" })).json();
    expect(month).toMatchObject({ total: 2, items: [{ slug: "a", recentViews: 102, views: 102 }] });
    const newest = (await app.inject({ method: "GET", url: "/api/v2/editorial" })).json();
    expect(newest.total).toBe(3);
    expect(Object.fromEntries(newest.items.map((p: { slug: string; views: number }) => [p.slug, p.views]))).toEqual({ a: 102, b: 5, "never-read": 0 });
    expect(newest.items[0].recentViews).toBeUndefined();
    const post = (await app.inject({ method: "GET", url: "/api/v2/editorial/a" })).json();
    expect(post.views).toBe(102);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/never-read" })).json().views).toBe(0);
  });
});

describe("comments on editorial posts", () => {
  const publish = async (slug: string, status: "published" | "draft" = "published") => {
    const [row] = await db
      .insert(editorialPosts)
      .values({ slug, title: slug, kind: "opinion", body: "texto", authorName: "Ana", tags: [], status, publishedAt: status === "published" ? new Date() : null })
      .returning();
    return row!;
  };
  const comment = (slug: string, payload: object) =>
    app.inject({ method: "POST", url: `/api/v2/editorial/${slug}/comments`, payload: { recaptchaToken: "t", ...payload } });

  it("takes comments and replies like news, counts them, and lets moderators hide them", async () => {
    const post = await publish("opiniao");
    await publish("rascunho", "draft");
    const first = await comment("opiniao", { username: "Zé", body: "Concordo" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ postId: post.id, username: "Zé", body: "Concordo", parentId: null });
    const reply = await comment("opiniao", { body: "Eu não", parentId: first.json().id });
    expect(reply.json()).toMatchObject({ parentId: first.json().id, parentUsername: "Zé", username: null });
    expect((await comment("rascunho", { body: "x" })).statusCode).toBe(404);

    const article = await insertArticle(db);
    const [onNews] = await db.insert(comments).values({ articleId: article.id, body: "noutra notícia" }).returning();
    expect((await comment("opiniao", { body: "x", parentId: onNews!.id })).json().error.code).toBe("invalid_parent");

    const listed = (await app.inject({ method: "GET", url: "/api/v2/editorial/opiniao/comments" })).json();
    expect(listed.map((c: { body: string }) => c.body)).toEqual(["Concordo", "Eu não"]);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/opiniao" })).json().commentCount).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial" })).json().items[0].commentCount).toBe(2);

    const cookie = await login("mod@example.pt");
    const queue = await call("GET", "/admin/comments", cookie);
    expect(queue.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.json().id, postId: post.id, postSlug: "opiniao", articleId: null, articleTitle: null })]),
    );
    expect((await call("POST", `/admin/comments/${first.json().id}/hide`, cookie)).status).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v2/editorial/opiniao" })).json().commentCount).toBe(1);
  });

  it("allows a comment on exactly one thing", async () => {
    const post = await publish("um-so");
    const article = await insertArticle(db);
    await expect(db.insert(comments).values({ articleId: article.id, editorialPostId: post.id, body: "x" })).rejects.toThrow();
    await expect(db.insert(comments).values({ body: "x" })).rejects.toThrow();
  });
});
