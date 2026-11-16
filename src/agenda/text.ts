import * as cheerio from "cheerio";

/** HTML (or entity-escaped HTML) → plain text, one line per paragraph or line break. */
export const htmlToText = (html: string | null | undefined): string => {
  if (!html) return "";
  // Some sources escape their HTML once more ("&lt;p&gt;"): decode, then parse what's left.
  const decoded = /&lt;\/?[a-z]/i.test(html) ? cheerio.load(html).root().text() : html;
  const $ = cheerio.load(decoded);
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4").each((_, element) => {
    $(element).append("\n");
  });
  return $.root()
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
};

/** Cut at a word boundary, with an ellipsis. */
export const truncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).trimEnd()}…`;
};
