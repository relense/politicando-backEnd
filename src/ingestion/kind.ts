/*
 * Whether an article is news or something else an outlet lists with it: opinion (columns,
 * chronicles, editorials), podcasts and radio or TV programmes, newsletters. Only news makes
 * stories (src/stories); the rest stays an article, labelled.
 *
 * Outlets mark these in the URL, as a whole path segment ("/opiniao/", Público's
 * "/2026/11/23/ciencia/opiniao/…", DN's "/opiniao-dn/", Observador's "/programas/…"). Their
 * page metadata says "NewsArticle" for all of them, so it's only a backup: DN's section reads
 * "Opinião DN". Checked against every outlet in sources.ts in November 2026.
 */

export const ARTICLE_KINDS = ["news", "opinion", "podcast", "newsletter"] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];

/** Path segments, folded. Migration 0054 applied the same list to articles stored before. */
const SEGMENTS: Record<string, Exclude<ArticleKind, "news">> = {
  opiniao: "opinion", "opiniao-dn": "opinion", opinion: "opinion", cronica: "opinion", cronicas: "opinion",
  colunista: "opinion", colunistas: "opinion", editorial: "opinion",
  podcast: "podcast", podcasts: "podcast", programas: "podcast",
  newsletter: "newsletter", newsletters: "newsletter",
};

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The article's kind from its URL, else from the section its page gives ("Opinião"). */
export const articleKind = (url: string, section?: string | null): ArticleKind => {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "news";
  }
  for (const raw of path.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // A malformed escape: compare it as it is.
    }
    const kind = SEGMENTS[fold(segment)];
    if (kind) return kind;
  }
  if (section && /^opini/.test(fold(section.trim()))) return "opinion";
  return "news";
};
