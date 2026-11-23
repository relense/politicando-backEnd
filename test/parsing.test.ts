import { describe, expect, it } from "vitest";
import { extractArticle, isGenericHeadline, pickHeadline, stripSiteSuffix } from "../src/ingestion/extractArticle.js";
import { parseNewsSitemap, parseRss, toPlainText } from "../src/ingestion/parseListing.js";

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="c" xmlns:media="m"><channel>
<item><title><![CDATA[O PS &amp; o <b>PSD</b>]]></title><link>https://a.pt/1?utm=x</link>
  <description><![CDATA[<p>Resumo &eacute; bom</p>]]></description>
  <content:encoded><![CDATA[<p>Texto inteiro</p>]]></content:encoded>
  <pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate><enclosure url="https://a.pt/i.jpg" type="image/jpeg"/></item>
<item><title>Sem data</title><link>https://a.pt/2</link></item>
<item><title>Link mau</title><link>javascript:alert(1)</link><pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Imagem media</title><link>https://a.pt/3</link><pubDate>Sun, 01 Nov 2026 11:00:00 +0100</pubDate><media:content url="https://a.pt/m.jpg"/></item>
</channel></rss>`;

const SITEMAP = `<?xml version="1.0"?><urlset xmlns:news="n" xmlns:image="i">
<url><loc>https://a.pt/1</loc><news:news><news:publication><news:name>A</news:name></news:publication>
  <news:publication_date>2026-11-01T10:00:00+00:00</news:publication_date><news:title>Chega quer debate</news:title></news:news>
  <image:image><image:loc>https://a.pt/i.jpg</image:loc></image:image></url>
<url><loc>https://a.pt/2</loc></url>
</urlset>`;

describe("parseRss", () => {
  it("normalises items and counts the unusable ones", () => {
    const { items, malformed } = parseRss(RSS);
    expect(malformed).toBe(2);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      url: "https://a.pt/1?utm=x",
      title: "O PS & o PSD",
      description: "Resumo é bom",
      fullText: "Texto inteiro",
      publishedAt: new Date("2026-11-01T10:00:00Z"),
      imageUrl: "https://a.pt/i.jpg",
    });
    expect(items[1]?.imageUrl).toBe("https://a.pt/m.jpg");
  });

  it("handles a single item and an empty or foreign document", () => {
    const one = `<rss><channel><item><title>T</title><link>https://a.pt/1</link><pubDate>2026-11-01</pubDate></item></channel></rss>`;
    expect(parseRss(one).items).toHaveLength(1);
    expect(parseRss("<html><body>not a feed</body></html>").items).toEqual([]);
  });

  it("handles escaped CDATA markers and feeds with no <link>", () => {
    const xml = `<rss xmlns:atom="a"><channel>
      <item><guid isPermaLink="false">https://a.pt/guid</guid><title>&lt;![CDATA[ Título com guid ]]&gt;</title><pubDate>Sun, 01 Nov 2026 11:09:00 Z</pubDate></item>
      <item><atom:link href="https://a.pt/atom"/><title>Título com atom</title><pubDate>Sun, 01 Nov 2026 11:09:00 Z</pubDate></item>
    </channel></rss>`;
    const { items, malformed } = parseRss(xml);
    expect(malformed).toBe(0);
    expect(items.map((i) => [i.url, i.title])).toEqual([
      ["https://a.pt/guid", "Título com guid"],
      ["https://a.pt/atom", "Título com atom"],
    ]);
    expect(items[0]?.publishedAt).toEqual(new Date("2026-11-01T11:09:00Z"));
  });

  it("copes with far more entities than the parser's default limit", () => {
    const title = "&amp;".repeat(2_000);
    const xml = `<rss><channel><item><title>${title}</title><link>https://a.pt/1</link><pubDate>2026-11-01</pubDate></item></channel></rss>`;
    expect(parseRss(xml).items).toHaveLength(1);
  });
});

describe("toPlainText", () => {
  it.each([
    ["&lt;p&gt;Duplo&lt;/p&gt;", "Duplo"],
    ["&amp;lt;p&amp;gt;Triplo&amp;lt;/p&amp;gt;", "Triplo"],
    ["<p>Simples &eacute;</p>", "Simples é"],
    ["Sem marcas", "Sem marcas"],
    ["<![CDATA[ Dentro ]]>", "Dentro"],
    ["PS &amp; PSD", "PS & PSD"],
  ])("cleans %s", (input, expected) => {
    expect(toPlainText(input)).toBe(expected);
  });

  it("reads the double-escaped summary CNN Portugal really sends", () => {
    const xml = `<rss><channel><item><title>T</title><guid>https://a.pt/1</guid><pubDate>2026-11-01</pubDate>
      <description><img src="https://a.pt/i.jpg"/><![CDATA[ &lt;p&gt;Anabela Neves &#xe7;&lt;/p&gt; ]]></description></item></channel></rss>`;
    expect(parseRss(xml).items[0]?.description).toBe("Anabela Neves ç");
  });
});

describe("parseNewsSitemap", () => {
  it("reads news entries and counts plain URLs as unusable", () => {
    const { items, malformed } = parseNewsSitemap(SITEMAP);
    expect(malformed).toBe(1);
    expect(items).toEqual([
      {
        url: "https://a.pt/1",
        title: "Chega quer debate",
        description: "",
        fullText: "",
        publishedAt: new Date("2026-11-01T10:00:00Z"),
        imageUrl: "https://a.pt/i.jpg",
      },
    ]);
  });
});

describe("extractArticle", () => {
  const long = "Um parágrafo suficientemente longo para contar como texto real do artigo.";
  const ld = (value: unknown) =>
    `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

  it("prefers structured articleBody, including inside @graph", () => {
    const html = `<html><head>${ld({ "@graph": [{ "@type": "NewsArticle", articleBody: "Corpo <b>JSON</b>" }] })}
      <meta property="og:description" content="Resumo"><meta property="og:image" content="https://a.pt/i.jpg"></head>
      <body><article><p>${long}</p></article></body></html>`;
    expect(extractArticle(html)).toEqual({
      text: "Corpo JSON",
      description: "Resumo",
      headline: "",
      imageUrl: "https://a.pt/i.jpg",
      section: null,
    });
  });

  it("reads the page's section, from JSON-LD or the meta tag", () => {
    expect(extractArticle(`${ld({ "@type": "NewsArticle", articleSection: "Opinião DN" })}<p>${long}</p>`).section).toBe("Opinião DN");
    expect(extractArticle(`${ld({ articleSection: ["Opinião", "Política"] })}<p>${long}</p>`).section).toBe("Opinião");
    expect(extractArticle(`<meta property="article:section" content="Política"><p>${long}</p>`).section).toBe("Política");
  });

  it("falls back to paragraphs in the article, skipping short ones and page furniture", () => {
    const html = `<body><footer><p>${long} rodapé</p></footer><article><p>Curto</p><p>${long}</p></article><p>${long} fora</p></body>`;
    expect(extractArticle(html).text).toBe(long);
  });

  it.each([false, "False"])("doesn't read a page marked subscriber-only (%s)", (flag) => {
    const html = `<head>${ld({ isAccessibleForFree: flag, articleBody: "Texto pago" })}
      <meta property="og:description" content="Público"></head><body><article><p>${long}</p></article></body>`;
    const result = extractArticle(html);
    expect(result.text).toBe("");
    expect(result.description).toBe("Público");
  });

  it("survives broken JSON-LD and ignores a non-http image", () => {
    const html = `<script type="application/ld+json">{oops</script><meta property="og:image" content="/rel.jpg"><p>${long}</p>`;
    expect(extractArticle(html)).toMatchObject({ text: long, imageUrl: null });
    const folder = `<meta property="og:image" content="https://a.pt/1920/"><p>${long}</p>`;
    expect(extractArticle(folder).imageUrl).toBeNull();
  });
});

describe("headlines", () => {
  it("reads og:title, falling back to the JSON-LD headline", () => {
    expect(extractArticle(`<meta property="og:title" content="PS &amp; PSD">`).headline).toBe("PS & PSD");
    expect(extractArticle(`<script type="application/ld+json">{"@type":"NewsArticle","headline":"Do JSON"}</script>`).headline).toBe("Do JSON");
  });

  it("strips a suffix only when it names the outlet", () => {
    expect(stripSiteSuffix("Ventura reeleito - 24 Notícias", "24noticias.sapo.pt")).toBe("Ventura reeleito");
    expect(stripSiteSuffix("Santos Silva admite eleições | Jornal Económico", "jornaleconomico.sapo.pt")).toBe("Santos Silva admite eleições");
    expect(stripSiteSuffix("Costa responde - e Ventura reage", "publico.pt")).toBe("Costa responde - e Ventura reage");
  });

  it("recognises placeholder headlines", () => {
    for (const t of ["As notícias das 8h", "As noticias das 00h", "As notícias das 13h30", "Noticiário", "Noticiário das 9h"]) expect(isGenericHeadline(t)).toBe(true);
    for (const t of ["8h. Isaltino Morais tem três julgamentos à vista", "As notícias das 8h que marcaram o dia", "Despertador: PS garante"]) expect(isGenericHeadline(t)).toBe(false);
  });

  it("keeps the feed headline when the page agrees, and the page's when the feed is generic", () => {
    expect(pickHeadline("PS quer fundo", "PS quer fundo | Jornal Económico", "jornaleconomico.sapo.pt")).toEqual({ title: "PS quer fundo", fromPage: false });
    expect(pickHeadline("“Não” ao veto", "\"Não\" ao veto", "publico.pt")).toEqual({ title: "“Não” ao veto", fromPage: false });
    expect(pickHeadline("PS quer fundo", "", "publico.pt")).toEqual({ title: "PS quer fundo", fromPage: false });
    expect(pickHeadline("As notícias das 7h", "7h. Acampadas pela Habitação", "observador.pt")).toEqual({
      title: "7h. Acampadas pela Habitação",
      fromPage: true,
    });
  });
});
