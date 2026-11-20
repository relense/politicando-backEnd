import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { articleGovernmentMembers, articleParties, articles, governmentMembers, parties, seenSourceUris } from "../src/db/schema.js";
import { canonicalUrl, ingest, pruneSeen, refreshGenericHeadlines, toExcerpt } from "../src/ingestion/ingest.js";
import { createPoliteClient } from "../src/ingestion/politeClient.js";
import type { NewsSource } from "../src/ingestion/sources.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const NOW = new Date("2026-11-01T12:00:00Z");
const RECENT = "Sun, 01 Nov 2026 10:00:00 GMT";
const FEED = "https://a.pt/feed";
const sources = (politics = false): NewsSource[] => [
  { domain: "a.pt", listings: [{ url: FEED, kind: "rss", politics }] },
];

const item = (path: string, title: string, description = "", date = RECENT) =>
  `<item><title>${title}</title><link>https://a.pt${path}</link><description>${description}</description><pubDate>${date}</pubDate></item>`;
const feed = (...items: string[]) => `<rss><channel>${items.join("")}</channel></rss>`;
const page = (text: string) => `<article><p>${text} ${"com texto suficiente para contar. ".repeat(3)}</p></article>`;

const run = async (routes: Record<string, [number, string]>, options: { politics?: boolean; maxPages?: number; list?: NewsSource[] } = {}) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const route = routes[String(input)];
    return route ? new Response(route[1], { status: route[0] }) : new Response("", { status: 404 });
  });
  const stats = await ingest({
    db,
    client: createPoliteClient({ fetch, sleep: async () => undefined }),
    sources: options.list ?? sources(options.politics),
    maxPagesPerSource: options.maxPages ?? 40,
    now: NOW,
  });
  const urls = fetch.mock.calls.map(([url]) => String(url)).filter((url) => !url.endsWith("robots.txt"));
  return { stats, first: stats[0]!, urls };
};

const storedUrls = async () =>
  (await db.select({ url: articles.url }).from(articles).orderBy(asc(articles.url))).map((r) => r.url);
const seenUrls = async () =>
  (await db.select({ url: seenSourceUris.sourceUri }).from(seenSourceUris)).map((r) => r.url);

describe("ingest", () => {
  it("uses the page text to match and stores only an excerpt", async () => {
    const secret = "FRASE-DO-CORPO-DO-ARTIGO";
    const { first } = await run({
      [FEED]: [200, feed(item("/1", "PS responde", "Resumo do editor"))],
      "https://a.pt/1": [200, page(`${secret} O PSD e a IL reagiram.`)],
    });
    expect(first).toMatchObject({ matched: 1, pagesRead: 1 });

    const [stored] = await db.select().from(articles);
    expect(stored).toMatchObject({
      title: "PS responde",
      excerpt: "Resumo do editor",
      url: "https://a.pt/1",
      source: "a.pt",
    });
    expect(JSON.stringify(stored)).not.toContain(secret);

    const links = await db
      .select({ slug: parties.slug })
      .from(articleParties)
      .innerJoin(parties, eq(parties.id, articleParties.partyId))
      .orderBy(asc(parties.slug));
    expect(links.map((l) => l.slug)).toEqual(["il", "ps", "psd"]);
  });

  it("strips double-escaped HTML before cutting the excerpt to length", async () => {
    const summary = `&amp;lt;p&amp;gt;${"palavra ".repeat(36).trim()}&amp;lt;/p&amp;gt;`;
    await run({
      [FEED]: [200, feed(item("/1", "PS responde", summary))],
      "https://a.pt/1": [200, page("x")],
    });
    const [stored] = await db.select().from(articles);
    expect(stored?.excerpt).toBe("palavra ".repeat(36).trim());
    expect(stored?.excerpt).not.toContain("<");
  });

  it("doesn't open pages for articles with no sign of politics", async () => {
    const { first, urls } = await run({
      [FEED]: [200, feed(item("/futebol", "Benfica vence", "Golo no fim"))],
      "https://a.pt/futebol": [200, page("O PS e o PSD")],
    });
    expect(urls).toEqual([FEED]);
    expect(first).toMatchObject({ rejected: 1, pagesRead: 0 });
    expect(await seenUrls()).toEqual(["https://a.pt/futebol"]);
  });

  it("opens every page from a politics listing or politics URL", async () => {
    const list = feed(item("/x", "Debate no Parlamento"));
    const fromListing = await run(
      { [FEED]: [200, list], "https://a.pt/x": [200, page("O PS e o PS")] },
      { politics: true },
    );
    expect(fromListing.first.matched).toBe(1);

    const fromUrl = await run({
      [FEED]: [200, feed(item("/politica/y", "Debate no Parlamento"))],
      "https://a.pt/politica/y": [200, page("O PSD e o PSD")],
    });
    expect(fromUrl.first.matched).toBe(1);
  });

  it.each(["/pol%C3%ADtica/y", "/parlamento/y", "/presidencia-republica/y"])(
    "treats %s as a politics URL",
    async (path) => {
      const { first } = await run({
        [FEED]: [200, feed(item(path, "Debate no Parlamento"))],
        [`https://a.pt${path}`]: [200, page("O PSD e o PSD")],
      });
      expect(first.matched).toBe(1);
    },
  );

  it("second run requests no article pages and adds nothing", async () => {
    const routes: Record<string, [number, string]> = {
      [FEED]: [200, feed(item("/1", "PS responde"), item("/2", "Debate"))],
      "https://a.pt/1": [200, page("O PS")],
    };
    await run(routes);
    const second = await run(routes);
    expect(second.urls).toEqual([FEED]);
    expect(second.first).toMatchObject({ new: 0, matched: 0, rejected: 0 });
    expect(await db.select().from(articles)).toHaveLength(1);
  });

  it("still uses the headline when a site refuses the page", async () => {
    const { first } = await run({
      [FEED]: [200, feed(item("/1", "Chega quer debate"))],
      "https://a.pt/1": [403, ""],
    });
    expect(first.matched).toBe(1);
    expect(await storedUrls()).toEqual(["https://a.pt/1"]);
  });

  it("obeys robots.txt for article pages", async () => {
    const { first, urls } = await run({
      "https://a.pt/robots.txt": [200, "User-agent: *\nDisallow: /artigos/"],
      [FEED]: [200, feed(item("/artigos/1", "PS responde"))],
      "https://a.pt/artigos/1": [200, page("texto")],
    });
    expect(urls).toEqual([FEED]);
    expect(first.matched).toBe(1);
  });

  it("doesn't use subscriber-only text", async () => {
    const paid = `<script type="application/ld+json">{"isAccessibleForFree":false,"articleBody":"O PS e o PS e o PS"}</script>`;
    const { first } = await run(
      { [FEED]: [200, feed(item("/1", "Debate"))], "https://a.pt/1": [200, paid] },
      { politics: true },
    );
    expect(first.rejected).toBe(1);
  });

  it("retries later when a page is temporarily down and nothing matched", async () => {
    const list = feed(item("/1", "Debate"));
    const down = await run(
      { [FEED]: [200, list], "https://a.pt/1": [503, ""] },
      { politics: true },
    );
    expect(down.first.deferred).toBe(1);
    expect(await seenUrls()).toEqual([]);

    const up = await run(
      { [FEED]: [200, list], "https://a.pt/1": [200, page("O PS e o PS")] },
      { politics: true },
    );
    expect(up.first.matched).toBe(1);
  });

  it("leaves pages over the budget for the next run", async () => {
    const routes: Record<string, [number, string]> = {
      [FEED]: [200, feed(item("/1", "PS um"), item("/2", "PS dois"), item("/3", "PS três"))],
      "https://a.pt/1": [200, page("x")],
      "https://a.pt/2": [200, page("x")],
      "https://a.pt/3": [200, page("x")],
    };
    const first = await run(routes, { maxPages: 2 });
    expect(first.first).toMatchObject({ pagesRead: 2, deferred: 1, matched: 2 });
    const second = await run(routes, { maxPages: 2 });
    expect(second.first).toMatchObject({ pagesRead: 1, matched: 1 });
  });

  it("skips old articles and foreign sections without opening them", async () => {
    const { first, urls } = await run({
      [FEED]: [
        200,
        feed(
          item("/velho", "PS antigo", "", "Sun, 25 Oct 2026 10:00:00 GMT"),
          item("/mundo/eleicoes", "PS em França"),
        ),
      ],
    });
    expect(urls).toEqual([FEED]);
    expect(first).toMatchObject({ new: 1, skippedForeign: 1, matched: 0 });
  });

  it("ignores links to other sites and treats tracking variants as one article", async () => {
    const { first } = await run({
      [FEED]: [
        200,
        feed(
          "<item><title>PS mau</title><link>https://evil.example/1</link><pubDate>" + RECENT + "</pubDate></item>",
          item("/1?utm=a", "PS bom"),
          item("/1?utm=b", "PS bom"),
        ),
      ],
      "https://a.pt/1?utm=a": [200, page("x")],
    });
    expect(first).toMatchObject({ matched: 1, malformed: 1 });
    expect(await storedUrls()).toEqual(["https://a.pt/1"]);
  });

  it("carries on when one source fails or sends junk", async () => {
    const list: NewsSource[] = [
      { domain: "down.pt", listings: [{ url: "https://down.pt/feed", kind: "rss" }] },
      { domain: "junk.pt", listings: [{ url: "https://junk.pt/feed", kind: "rss" }] },
      ...sources(),
    ];
    const { stats } = await run(
      {
        "https://down.pt/feed": [503, ""],
        "https://junk.pt/feed": [200, "<rss><channel>"],
        [FEED]: [200, feed(item("/1", "PS bom"))],
        "https://a.pt/1": [200, page("x")],
      },
      { list },
    );
    expect(stats[0]?.listingError).toContain("unavailable");
    expect(stats[2]?.matched).toBe(1);
    expect(await storedUrls()).toEqual(["https://a.pt/1"]);
  });

  it("reads news sitemaps", async () => {
    const list: NewsSource[] = [
      { domain: "a.pt", listings: [{ url: "https://a.pt/news.xml", kind: "news-sitemap" }] },
    ];
    const { first } = await run(
      {
        "https://a.pt/news.xml": [
          200,
          `<urlset><url><loc>https://a.pt/1</loc><news:news><news:publication_date>2026-11-01T10:00:00Z</news:publication_date><news:title>AD e PS negoceiam</news:title></news:news></url></urlset>`,
        ],
        "https://a.pt/1": [200, page("x")],
      },
      { list },
    );
    expect(first.matched).toBe(1);
  });

  it("prefers the page's share image and drops folder URLs from the listing", async () => {
    const entry = (n: number) =>
      `<url><loc>https://a.pt/${n}</loc><news:news><news:publication_date>2026-11-01T10:00:00Z</news:publication_date><news:title>PS e PSD ${n}</news:title></news:news><image:image><image:loc>https://img.a.pt/1920/</image:loc></image:image></url>`;
    const list: NewsSource[] = [
      { domain: "a.pt", listings: [{ url: "https://a.pt/news.xml", kind: "news-sitemap" }] },
    ];
    await run(
      {
        "https://a.pt/news.xml": [200, `<urlset>${entry(1)}${entry(2)}</urlset>`],
        "https://a.pt/1": [200, `<meta property="og:image" content="https://img.a.pt/960/foto.webp">${page("x")}`],
        "https://a.pt/2": [200, page("x")],
      },
      { list },
    );
    const rows = await db
      .select({ url: articles.url, imageUrl: articles.imageUrl })
      .from(articles)
      .orderBy(asc(articles.url));
    expect(rows).toEqual([
      { url: "https://a.pt/1", imageUrl: "https://img.a.pt/960/foto.webp" },
      { url: "https://a.pt/2", imageUrl: null },
    ]);
  });

  it("uses the page's headline and summary when the feed's are generic", async () => {
    await run({
      [FEED]: [200, feed(item("/noticiario/7h", "As notícias das 7h", "As notícias na Rádio Observador."))],
      "https://a.pt/noticiario/7h": [
        200,
        `<meta property="og:title" content="7h. PS e PSD discutem habitação"><meta property="og:description" content="O PS e o PSD reuniram.">${page("O PS e o PSD")}`,
      ],
    }, { politics: true });
    const [stored] = await db.select().from(articles);
    expect(stored).toMatchObject({ title: "7h. PS e PSD discutem habitação", excerpt: "O PS e o PSD reuniram." });
  });

  it("links members of the Government named in the article", async () => {
    await db.insert(governmentMembers).values([
      { id: "pm", name: "Luís Montenegro" },
      { id: "fin", name: "Joaquim Miranda Sarmento" },
      { id: "other", name: "Maria Ninguém" },
    ]);
    await run({
      [FEED]: [200, feed(item("/1", "Montenegro e o PS discutem o Orçamento"))],
      "https://a.pt/1": [200, page("O primeiro-ministro e Joaquim Miranda Sarmento reuniram com o PS.")],
    });
    const links = await db
      .select({ id: articleGovernmentMembers.memberId, mentions: articleGovernmentMembers.mentionCount })
      .from(articleGovernmentMembers)
      .orderBy(asc(articleGovernmentMembers.memberId));
    expect(links).toEqual([{ id: "fin", mentions: 1 }, { id: "pm", mentions: 2 }]);
  });

  it("requires seeded parties", async () => {
    await db.delete(parties);
    await expect(run({})).rejects.toThrow("run the seed");
  });
});

describe("helpers", () => {
  it("canonicalUrl removes tracking and forces https", () => {
    expect(canonicalUrl("http://a.pt/x?utm=1#top")).toBe("https://a.pt/x");
  });

  it("toExcerpt cuts on a word boundary", () => {
    const excerpt = toExcerpt("palavra ".repeat(100));
    expect(excerpt.length).toBeLessThanOrEqual(301);
    expect(excerpt.endsWith("palavra…")).toBe(true);
    expect(toExcerpt("curto")).toBe("curto");
  });
});

describe("refreshGenericHeadlines", () => {
  it("replaces a placeholder headline once the page has the real one", async () => {
    const meta = (title: string, description: string) =>
      `<meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${page("O PS e o PSD.")}`;
    // Scanned while the page still had the placeholder.
    await run({
      [FEED]: [200, feed(item("/8h", "As notícias das 8h", "As notícias na Rádio. O PS e o PSD."))],
      "https://a.pt/8h": [200, meta("As notícias das 8h", "As notícias na Rádio.")],
    });
    expect((await db.select({ title: articles.title }).from(articles))[0]!.title).toBe("As notícias das 8h");

    const pages: Record<string, string> = { "https://a.pt/8h": meta("8h. Isaltino tem três julgamentos", "Autarca de Oeiras.") };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => new Response(pages[String(input)] ?? "", { status: pages[String(input)] ? 200 : 404 }));
    const client = createPoliteClient({ fetch, sleep: async () => undefined });
    expect(await refreshGenericHeadlines({ db, client, now: NOW })).toBe(1);
    expect(await db.select({ title: articles.title, excerpt: articles.excerpt }).from(articles)).toEqual([
      { title: "8h. Isaltino tem três julgamentos", excerpt: "Autarca de Oeiras." },
    ]);
    // Nothing generic left: no more page requests.
    fetch.mockClear();
    expect(await refreshGenericHeadlines({ db, client, now: NOW })).toBe(0);
    expect(fetch.mock.calls.filter(([u]) => !String(u).endsWith("robots.txt"))).toEqual([]);
  });
});

describe("pruneSeen", () => {
  it("forgets URLs seen more than two weeks ago, long after the scanner would skip them", async () => {
    const day = 24 * 3_600_000;
    await db.insert(seenSourceUris).values([
      { sourceUri: "https://a.pt/old", seenAt: new Date(NOW.getTime() - 15 * day) },
      { sourceUri: "https://a.pt/recent", seenAt: new Date(NOW.getTime() - 5 * day) },
    ]);
    expect(await pruneSeen(db, NOW)).toBe(1);
    expect(await seenUrls()).toEqual(["https://a.pt/recent"]);
  });
});
