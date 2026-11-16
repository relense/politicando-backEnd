export interface NewsSource {
  /** Stored on each article, and the domain its links must belong to. */
  domain: string;
  listings: { url: string; kind: "rss" | "news-sitemap"; politics?: boolean }[];
}

const rss = (url: string, politics = false) => ({ url, kind: "rss" as const, politics });
const sitemap = (url: string) => ({ url, kind: "news-sitemap" as const });

/**
 * Checked by hand on 2026-11-01 with the scanner's own user agent. News
 * sitemaps cover about 48 hours; the RSS feeds below often cover far less, which
 * is why the job should run hourly. Renascença (rr.pt) is left out because it
 * refuses the bot with HTTP 403, and we don't disguise it to get past that.
 */
export const NEWS_SOURCES: NewsSource[] = [
  { domain: "publico.pt", listings: [sitemap("https://www.publico.pt/sitemaps/news.xml")] },
  { domain: "expresso.pt", listings: [sitemap("https://expresso.pt/sitemap/news.xml")] },
  { domain: "sicnoticias.pt", listings: [sitemap("https://sicnoticias.pt/sitemap/news.xml")] },
  { domain: "dn.pt", listings: [sitemap("https://www.dn.pt/news_sitemap.xml")] },
  { domain: "jn.pt", listings: [sitemap("https://www.jn.pt/feed/news/sitemap.xml")] },
  { domain: "tsf.pt", listings: [sitemap("https://www.tsf.pt/feed/news/sitemap.xml")] },
  { domain: "eco.sapo.pt", listings: [sitemap("https://eco.sapo.pt/sitemap-news.xml")] },
  { domain: "observador.pt", listings: [rss("https://observador.pt/seccao/politica/feed", true)] },
  { domain: "rtp.pt", listings: [rss("https://www.rtp.pt/noticias/rss/politica", true)] },
  // Its robots.txt disallows /rss/, but allows this sitemap.
  { domain: "noticiasaominuto.com", listings: [sitemap("https://www.noticiasaominuto.com/sitemap.xml")] },
  {
    domain: "jornaleconomico.sapo.pt",
    listings: [rss("https://jornaleconomico.sapo.pt/politica/feed/", true)],
  },
  { domain: "visao.pt", listings: [rss("https://visao.pt/feed/")] },
  { domain: "cmjornal.pt", listings: [rss("https://www.cmjornal.pt/rss")] },
  { domain: "jornaldenegocios.pt", listings: [rss("https://www.jornaldenegocios.pt/rss")] },
  { domain: "sabado.pt", listings: [rss("https://www.sabado.pt/rss")] },
  { domain: "cnnportugal.iol.pt", listings: [rss("https://cnnportugal.iol.pt/rss.xml")] },
  { domain: "sol.iol.pt", listings: [rss("https://sol.iol.pt/rss.xml")] },
  { domain: "24noticias.sapo.pt", listings: [rss("https://24noticias.sapo.pt/feed")] },
  { domain: "dnoticias.pt", listings: [rss("https://www.dnoticias.pt/rss.xml")] },
  { domain: "acorianooriental.pt", listings: [rss("https://www.acorianooriental.pt/feed/rss.xml")] },
];
