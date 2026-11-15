import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { articleParties, articles, parties, seenSourceUris } from "../db/schema.js";
import {
  countMentions,
  matchParties,
  type MatchableParty,
  type PartyMatch,
} from "../matching/matchParties.js";
import { PARTY_DEFINITIONS } from "../matching/parties.js";
import { extractArticle } from "./extractArticle.js";
import { parseNewsSitemap, parseRss, type ListingItem } from "./parseListing.js";
import type { PoliteClient } from "./politeClient.js";
import type { NewsSource } from "./sources.js";

const MAX_ARTICLE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const EXCERPT_LENGTH = 300;
/** Feed text this long is treated as the full article, so the page isn't requested. */
const FULL_TEXT_CHARS = 800;
const FOREIGN_SECTION = /\/(mundo|internacional|world)(\/|$)/i;
const POLITICS_SECTION = /\/(pol(i|%C3%AD|í)tica|parlamento|presidencia-republica)(\/|-|$)/i;

export interface SourceStats {
  domain: string;
  listed: number;
  new: number;
  pagesRead: number;
  matched: number;
  rejected: number;
  /** Over this run's page budget, or temporarily unavailable. Retried next run. */
  deferred: number;
  skippedForeign: number;
  malformed: number;
  failed: number;
  /** Why a listing couldn't be read, if it couldn't. */
  listingError: string | null;
}

export interface IngestOptions {
  db: Db;
  client: PoliteClient;
  sources: NewsSource[];
  maxPagesPerSource: number;
  now?: Date;
  onArticleError?: (url: string, error: unknown) => void;
}

const loadMatchableParties = async (db: Db): Promise<MatchableParty[]> => {
  const rows = await db.select().from(parties);
  const termsBySlug = new Map(PARTY_DEFINITIONS.map((party) => [party.slug, party.terms]));
  return rows.flatMap((row) => {
    const terms = termsBySlug.get(row.slug);
    return terms ? [{ id: row.id, acronym: row.acronym, terms }] : [];
  });
};

/** Drops tracking parameters and fragments so one article has one identity. */
export const canonicalUrl = (url: string) => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.protocol = "https:";
  return parsed.href;
};

const belongsTo = (url: string, domain: string) => {
  const { hostname } = new URL(url);
  return hostname === domain || hostname.endsWith(`.${domain}`);
};

export const toExcerpt = (text: string) => {
  if (text.length <= EXCERPT_LENGTH) return text;
  const cut = text.slice(0, EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

const findKnownUrls = async (db: Db, urls: string[]) => {
  if (urls.length === 0) return new Set<string>();
  const [stored, seen] = await Promise.all([
    db.select({ url: articles.sourceUri }).from(articles).where(inArray(articles.sourceUri, urls)),
    db
      .select({ url: seenSourceUris.sourceUri })
      .from(seenSourceUris)
      .where(inArray(seenSourceUris.sourceUri, urls)),
  ]);
  return new Set([...stored, ...seen].map((row) => row.url));
};

const markSeen = (db: Db, url: string) =>
  db.insert(seenSourceUris).values({ sourceUri: url }).onConflictDoNothing();

const saveArticle = (
  db: Db,
  article: typeof articles.$inferInsert,
  matches: PartyMatch[],
) =>
  db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(articles)
      .values(article)
      .onConflictDoNothing({ target: articles.sourceUri })
      .returning({ id: articles.id });
    if (!inserted) return;
    await tx.insert(articleParties).values(
      matches.map((match) => ({
        articleId: inserted.id,
        partyId: match.partyId,
        mentionCount: match.mentions,
      })),
    );
  });

const scanSource = async (
  source: NewsSource,
  matchable: MatchableParty[],
  { db, client, maxPagesPerSource, now = new Date(), onArticleError }: IngestOptions,
): Promise<SourceStats> => {
  const stats: SourceStats = {
    domain: source.domain, listed: 0, new: 0, pagesRead: 0, matched: 0, rejected: 0,
    deferred: 0, skippedForeign: 0, malformed: 0, failed: 0, listingError: null,
  };

  const candidates = new Map<string, { item: ListingItem; politics: boolean }>();
  for (const listing of source.listings) {
    const result = await client.get(listing.url);
    if (result.status !== "ok") {
      stats.listingError = `${result.status}: ${result.reason}`;
      continue;
    }
    let parsed;
    try {
      parsed = listing.kind === "rss" ? parseRss(result.body) : parseNewsSitemap(result.body);
    } catch (error) {
      stats.listingError = `unparseable: ${String(error)}`;
      continue;
    }
    stats.malformed += parsed.malformed;
    for (const item of parsed.items) {
      stats.listed++;
      const age = now.getTime() - item.publishedAt.getTime();
      if (age > MAX_ARTICLE_AGE_MS || age < -MAX_FUTURE_SKEW_MS) continue;
      if (!belongsTo(item.url, source.domain)) {
        stats.malformed++;
        continue;
      }
      const url = canonicalUrl(item.url);
      if (!candidates.has(url)) {
        candidates.set(url, { item, politics: Boolean(listing.politics) });
      }
    }
  }

  const known = await findKnownUrls(db, [...candidates.keys()]);
  for (const [url, { item, politics }] of candidates) {
    if (known.has(url)) continue;
    stats.new++;
    try {
      if (FOREIGN_SECTION.test(url)) {
        stats.skippedForeign++;
        await markSeen(db, url);
        continue;
      }

      const listedText = `${item.title}\n${item.description}\n${item.fullText}`;
      // Only open pages that look relevant, to keep requests to each site low.
      const worthReading =
        politics || POLITICS_SECTION.test(url) || countMentions(listedText, matchable) > 0;
      let bodyText = item.fullText;
      let description = item.description;
      let imageUrl = item.imageUrl;
      let pageUnavailable = false;

      if (worthReading && item.fullText.length < FULL_TEXT_CHARS) {
        if (stats.pagesRead >= maxPagesPerSource) {
          stats.deferred++;
          continue;
        }
        stats.pagesRead++;
        const page = await client.get(item.url);
        if (page.status === "ok") {
          const extracted = extractArticle(page.body);
          bodyText = extracted.text || bodyText;
          description ||= extracted.description;
          // The page's share image is more reliable than the one in the listing.
          imageUrl = extracted.imageUrl ?? imageUrl;
        } else if (page.status === "unavailable") {
          pageUnavailable = true;
        }
      }

      const matches = matchParties(
        { title: item.title, content: `${description}\n${bodyText}` },
        matchable,
      );
      if (matches.length > 0) {
        await saveArticle(
          db,
          {
            sourceUri: url,
            title: item.title,
            excerpt: toExcerpt(description || bodyText),
            url,
            source: source.domain,
            imageUrl,
            publishedAt: item.publishedAt,
          },
          matches,
        );
        stats.matched++;
      } else if (pageUnavailable) {
        stats.deferred++;
      } else {
        await markSeen(db, url);
        stats.rejected++;
      }
    } catch (error) {
      stats.failed++;
      onArticleError?.(url, error);
    }
  }
  return stats;
};

/** One failing source never stops the others. Safe to re-run at any time. */
export const ingest = async (options: IngestOptions): Promise<SourceStats[]> => {
  const matchable = await loadMatchableParties(options.db);
  if (matchable.length === 0) throw new Error("No parties found: run the seed first");
  return Promise.all(options.sources.map((source) => scanSource(source, matchable, options)));
};
