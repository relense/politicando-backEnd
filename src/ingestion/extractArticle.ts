import * as cheerio from "cheerio";
import { imageUrl as toImageUrl, toPlainText } from "./parseListing.js";

export interface ExtractedArticle {
  /** Empty when the page is marked subscriber-only: we don't read paid content. */
  text: string;
  description: string;
  imageUrl: string | null;
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
  if (isPaywalled(nodes)) return { text: "", description, imageUrl };

  const articleBody = nodes
    .map((node) => node.articleBody)
    .find((body): body is string => typeof body === "string" && body.trim() !== "");
  if (articleBody) return { text: toPlainText(articleBody), description, imageUrl };

  $("script, style, nav, header, footer, aside, form").remove();
  const inArticle = $("article p").toArray();
  const paragraphs = (inArticle.length > 0 ? inArticle : $("p").toArray())
    .map((element) => clean($(element).text()))
    .filter((text) => text.length >= MIN_PARAGRAPH_CHARS);
  return { text: paragraphs.join("\n"), description, imageUrl };
};
