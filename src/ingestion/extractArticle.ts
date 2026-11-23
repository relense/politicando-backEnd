import * as cheerio from "cheerio";
import { imageUrl as toImageUrl, toPlainText } from "./parseListing.js";

export interface ExtractedArticle {
  /** Empty when the page is marked subscriber-only: we don't read paid content. */
  text: string;
  description: string;
  /** The page's own headline (og:title, else the JSON-LD headline), possibly with a site suffix. */
  headline: string;
  imageUrl: string | null;
  /** The page's section (JSON-LD articleSection, else article:section), as written: "Opinião DN". */
  section: string | null;
}

const MIN_PARAGRAPH_CHARS = 60;

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

const flattenJsonLd = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [record, ...flattenJsonLd(record["@graph"])];
};

const isPaywalled = (nodes: Record<string, unknown>[]) =>
  nodes.some((node) => {
    const flag = node.isAccessibleForFree;
    return flag === false || (typeof flag === "string" && flag.toLowerCase() === "false");
  });

export const extractArticle = (html: string): ExtractedArticle => {
  const $ = cheerio.load(html);

  const nodes = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((element) => {
      try {
        return flattenJsonLd(JSON.parse($(element).text()));
      } catch {
        return [];
      }
    });

  const description = toPlainText($('meta[property="og:description"]').attr("content") ?? "");
  const imageUrl = toImageUrl($('meta[property="og:image"]').attr("content"));
  const jsonLdHeadline = nodes.map((node) => node.headline).find((h): h is string => typeof h === "string");
  const headline = toPlainText($('meta[property="og:title"]').attr("content") ?? jsonLdHeadline ?? "");
  const jsonLdSection = nodes
    .map((node) => (Array.isArray(node.articleSection) ? node.articleSection[0] : node.articleSection))
    .find((s): s is string => typeof s === "string" && s.trim() !== "");
  const section = (jsonLdSection ?? $('meta[property="article:section"]').attr("content") ?? "").trim() || null;
  if (isPaywalled(nodes)) return { text: "", description, headline, imageUrl, section };

  const articleBody = nodes
    .map((node) => node.articleBody)
    .find((body): body is string => typeof body === "string" && body.trim() !== "");
  if (articleBody) return { text: toPlainText(articleBody), description, headline, imageUrl, section };

  $("script, style, nav, header, footer, aside, form").remove();
  const inArticle = $("article p").toArray();
  const paragraphs = (inArticle.length > 0 ? inArticle : $("p").toArray())
    .map((element) => clean($(element).text()))
    .filter((text) => text.length >= MIN_PARAGRAPH_CHARS);
  return { text: paragraphs.join("\n"), description, headline, imageUrl, section };
};

const simplify = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Drops a trailing " | Jornal Económico" or " - 24 Notícias" when it names the outlet. */
export const stripSiteSuffix = (headline: string, domain: string) => {
  const match = /^(.*\S)\s+[|\-–—]\s+([^|\-–—]{2,40})$/.exec(headline);
  if (!match) return headline;
  const suffix = simplify(match[2]!);
  const site = simplify(domain.split(".")[0] ?? "");
  return suffix && site && (site.includes(suffix) || suffix.includes(site)) ? match[1]! : headline;
};

/**
 * Which headline to store. Feeds and pages almost always agree, and then the feed's is kept.
 * When they really differ, the feed item is generic (Observador lists its hourly bulletins
 * as "As notícias das 7h") and the page has the real headline, so the page wins.
 */
export const pickHeadline = (listingTitle: string, pageHeadline: string, domain: string) => {
  const page = stripSiteSuffix(pageHeadline.trim(), domain);
  if (!page || simplify(page) === simplify(listingTitle)) return { title: listingTitle, fromPage: false };
  return { title: page, fromPage: true };
};

/**
 * Placeholder headlines some outlets publish first and replace later: Observador's radio
 * bulletins go out as "As notícias das 8h" and get their real headline minutes afterwards.
 */
const GENERIC_HEADLINES = [/^as not[ií]cias d[ae]s? \d{1,2}(h\d{0,2}|:\d{2})?$/i, /^notici[aá]rio( d[ae]s? \d{1,2}(h\d{0,2}|:\d{2})?)?$/i];
export const isGenericHeadline = (headline: string) => GENERIC_HEADLINES.some((pattern) => pattern.test(headline.trim()));
