import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

export interface ListingItem {
  url: string;
  title: string;
  /** Publisher's summary, as plain text. */
  description: string;
  /** Full text when the feed includes it. Used for matching, never stored. */
  fullText: string;
  publishedAt: Date;
  imageUrl: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  // News feeds legitimately use many entities, so the default cap is too low.
  processEntities: { enabled: true, maxTotalExpansions: 1_000_000, maxExpandedLength: 50_000_000 },
  htmlEntities: true,
});

const asArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const rawText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  const text = asRecord(value)["#text"];
  return typeof text === "string" ? text : "";
};

const MAX_DECODE_PASSES = 3;

/** Repeats because some feeds escape twice, such as CNN Portugal's `&lt;p&gt;` inside CDATA. */
export const toPlainText = (value: string): string => {
  let text = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    // Some feeds escape their CDATA markers, so they arrive here as literal text.
    const unwrapped = text.replace(/<!\[CDATA\[|\]\]>/g, "");
    const decoded = /[<&]/.test(unwrapped)
      ? cheerio.load(`<body>${unwrapped}</body>`)("body").text()
      : unwrapped;
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/\s+/g, " ").trim();
};

const httpUrl = (value: unknown): string | null => {
  const text = rawText(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * An http(s) URL that can be an image. A path ending in "/" is a folder, not a
 * file: Notícias ao Minuto's sitemap lists ".../1920/" for every article.
 */
export const imageUrl = (value: unknown): string | null => {
  const url = httpUrl(value);
  return url && !new URL(url).pathname.endsWith("/") ? url : null;
};

const firstUrl = (values: unknown[], attribute: string): string | null => {
  for (const value of values) {
    const url = imageUrl(asRecord(value)[attribute]);
    if (url) return url;
  }
  return null;
};

const build = (fields: {
  link: unknown;
  title: unknown;
  description?: unknown;
  fullText?: unknown;
  date: unknown;
  imageUrl: string | null;
}): ListingItem | null => {
  const url = httpUrl(fields.link);
  const title = toPlainText(rawText(fields.title));
  const publishedAt = new Date(rawText(fields.date).trim());
  if (!url || !title || Number.isNaN(publishedAt.getTime())) return null;
  return {
    url,
    title,
    description: toPlainText(rawText(fields.description)),
    fullText: toPlainText(rawText(fields.fullText)),
    publishedAt,
    imageUrl: fields.imageUrl,
  };
};

export interface ParsedListing {
  items: ListingItem[];
  malformed: number;
}

const collect = (entries: unknown[], toItem: (entry: Record<string, unknown>) => ListingItem | null) => {
  const items = entries.map((entry) => toItem(asRecord(entry))).filter((item) => item !== null);
  return { items, malformed: entries.length - items.length };
};

export const parseRss = (xml: string): ParsedListing => {
  const channel = asRecord(asRecord(asRecord(parser.parse(xml)).rss).channel);
  return collect(asArray(channel.item), (item) =>
    build({
      // Not every feed has <link>: Correio da Manhã only has <guid> and <atom:link>.
      link: item.link || item.guid || asRecord(asArray(item["atom:link"])[0])["@_href"],
      title: item.title,
      description: item.description,
      fullText: item["content:encoded"],
      date: item.pubDate,
      imageUrl:
        firstUrl(asArray(item.enclosure), "@_url") ??
        firstUrl(asArray(item["media:content"]), "@_url") ??
        firstUrl(asArray(item["media:thumbnail"]), "@_url"),
    }),
  );
};

export const parseNewsSitemap = (xml: string): ParsedListing => {
  const urlset = asRecord(asRecord(parser.parse(xml)).urlset);
  return collect(asArray(urlset.url), (entry) => {
    const news = asRecord(entry["news:news"]);
    return build({
      link: entry.loc,
      title: news["news:title"],
      date: news["news:publication_date"],
      imageUrl: firstUrl(asArray(entry["image:image"]), "image:loc"),
    });
  });
};
