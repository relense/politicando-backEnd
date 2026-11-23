import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  articleDeputies,
  articleGovernmentMembers,
  articleInitiatives,
  articleLocalOfficials,
  articlePresidents,
  articleParties,
  articles,
  deputies,
  governmentMembers,
  initiatives,
  parties,
  presidents,
  seenSourceUris,
} from "../db/schema.js";
import {
  countMentions,
  matchArticle,
  matchNames,
  type DeputyMatch,
  type MatchablePerson,
  type MatchableDeputy,
  type MatchableParty,
  type PartyMatch,
} from "../matching/matchParties.js";
import {
  ACTIVITY_WINDOW_DAYS,
  buildInitiativeIndex,
  matchInitiatives,
  type InitiativeIndex,
  type InitiativeMatch,
} from "../matching/matchInitiatives.js";
import { PARTY_DEFINITIONS } from "../matching/parties.js";
import { loadMatchableLocalOfficials } from "../places/localOfficials.js";
import { GOVERNMENT_ALIASES } from "../government/aliases.js";
import { PRESIDENT_ALIASES, currentPresident } from "../presidency/presidents.js";
import { DEPUTY_ALIASES } from "../parliament/aliases.js";
import { articleKind } from "./kind.js";
import { extractArticle, isGenericHeadline, pickHeadline } from "./extractArticle.js";
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

export interface Matchable {
  parties: MatchableParty[];
  deputies: MatchableDeputy[];
  initiatives: InitiativeIndex;
  government: MatchablePerson<string>[];
  president: MatchablePerson<string>[];
  /** Mayors (src/places/localOfficials.ts). */
  local?: MatchablePerson<string>[];
}

/**
 * The President in office, by full name, plus "Seguro" in an article about the presidency.
 * Empty until the Government job has stored the President, since links point to that row.
 */
export const loadMatchablePresident = async (db: Db): Promise<MatchablePerson<string>[]> => {
  const president = currentPresident();
  const [stored] = await db.select({ id: presidents.id }).from(presidents).where(eq(presidents.id, president.id));
  if (!stored) return [];
  const alias = PRESIDENT_ALIASES[president.id];
  const terms = [president.name, president.fullName];
  return [
    alias
      ? { id: president.id, terms, contextTerms: [...terms, ...alias.withContext], context: alias.context, exclude: alias.exclude }
      : { id: president.id, terms },
  ];
};


/**
 * Members of the Government, current and past, matched by their full name. A name shared
 * with a sitting deputy is left out: the news would mostly be about the deputy.
 */
export const loadMatchableGovernment = async (db: Db): Promise<MatchablePerson<string>[]> => {
  const sitting = new Set(
    (await db.select({ name: deputies.name }).from(deputies).where(eq(deputies.active, true))).map((d) => simpleName(d.name)),
  );
  return (await db.select({ id: governmentMembers.id, name: governmentMembers.name }).from(governmentMembers))
    .filter(({ name }) => name.trim().split(/\s+/).length >= 2 && !sitting.has(simpleName(name)))
    .map(({ id, name }) => {
      const alias = GOVERNMENT_ALIASES[name];
      return alias
        ? { id, terms: [name], contextTerms: [name, ...alias.withContext], context: alias.context, exclude: alias.exclude }
        : { id, terms: [name] };
    });
};

const simpleName = (name: string) =>
  name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Initiatives active recently enough to be in the news. Rarity is still measured over
 * these titles only, which is plenty: a few hundred to a few thousand.
 */
export const loadInitiativeIndex = async (db: Db, now = new Date()): Promise<InitiativeIndex> => {
  const since = new Date(now.getTime() - (ACTIVITY_WINDOW_DAYS + 7) * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: initiatives.id,
      title: initiatives.title,
      activityDate: initiatives.phaseDate,
      submittedAt: initiatives.submittedAt,
    })
    .from(initiatives)
    .where(gte(initiatives.phaseDate, since.toISOString().slice(0, 10)));
  return buildInitiativeIndex(rows);
};

/** How much of an article the initiative matcher reads: more text finds more, but less precisely. */
export const INITIATIVE_TEXT_CHARS = 1500;

export const loadMatchableParties = async (db: Db): Promise<MatchableParty[]> => {
  const rows = await db.select().from(parties);
  const termsBySlug = new Map(PARTY_DEFINITIONS.map((party) => [party.slug, party.terms]));
  return rows.flatMap((row) => {
    const terms = termsBySlug.get(row.slug);
    return terms ? [{ id: row.id, acronym: row.acronym, terms }] : [];
  });
};

/** Sitting deputies only: former ones are still in the news, but rarely as deputies. */
export const loadMatchableDeputies = async (db: Db): Promise<MatchableDeputy[]> =>
  (
    await db
      .select({ id: deputies.id, partyId: deputies.partyId, name: deputies.name })
      .from(deputies)
      .where(eq(deputies.active, true))
  ).map(({ id, partyId, name }) => {
    const aliases = DEPUTY_ALIASES[id];
    const terms = [name, ...(aliases?.standalone ?? [])];
    return aliases?.withContext
      ? { id, partyId, terms, contextTerms: [...terms, ...aliases.withContext] }
      : { id, partyId, terms };
  });

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

/**
 * Forgets URLs seen long enough ago that the scanner would skip them anyway (it never looks at
 * articles older than MAX_ARTICLE_AGE_MS): otherwise the table grows by thousands a day, for good.
 * Kept a good while past that, for listings that don't date their items.
 */
export const SEEN_KEEP_DAYS = 14;
export const pruneSeen = async (db: Db, now = new Date()) =>
  (await db.execute(sql`delete from seen_source_uris where seen_at < ${now.toISOString()}::timestamptz - make_interval(days => ${SEEN_KEEP_DAYS})`)).rowCount ?? 0;

const saveArticle = (
  db: Db,
  article: typeof articles.$inferInsert,
  matches: {
    parties: PartyMatch[];
    deputies: DeputyMatch[];
    initiatives: InitiativeMatch[];
    government: { id: string; mentions: number }[];
    president: { id: string; mentions: number }[];
    local?: { id: string; mentions: number }[];
  },
) =>
  db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(articles)
      .values(article)
      .onConflictDoNothing({ target: articles.sourceUri })
      .returning({ id: articles.id });
    if (!inserted) return;
    await tx.insert(articleParties).values(
      matches.parties.map((match) => ({
        articleId: inserted.id,
        partyId: match.partyId,
        mentionCount: match.mentions,
      })),
    );
    if (matches.deputies.length > 0) {
      await tx.insert(articleDeputies).values(
        matches.deputies.map((match) => ({
          articleId: inserted.id,
          deputyId: match.deputyId,
          mentionCount: match.mentions,
        })),
      );
    }
    if (matches.government.length > 0) {
      await tx.insert(articleGovernmentMembers).values(
        matches.government.map((match) => ({
          articleId: inserted.id,
          memberId: match.id,
          mentionCount: match.mentions,
        })),
      );
    }
    if (matches.president.length > 0) {
      await tx.insert(articlePresidents).values(
        matches.president.map((match) => ({
          articleId: inserted.id,
          presidentId: match.id,
          mentionCount: match.mentions,
        })),
      );
    }
    if (matches.local?.length) {
      await tx.insert(articleLocalOfficials).values(
        matches.local.map((match) => ({ articleId: inserted.id, officialId: match.id, mentionCount: match.mentions })),
      );
    }
    if (matches.initiatives.length > 0) {
      await tx.insert(articleInitiatives).values(
        matches.initiatives.map((match) => ({
          articleId: inserted.id,
          initiativeId: match.initiativeId,
          score: match.score,
        })),
      );
    }
  });

const scanSource = async (
  source: NewsSource,
  matchable: Matchable,
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
        politics || POLITICS_SECTION.test(url) || countMentions(listedText, [...matchable.parties, ...matchable.deputies]) > 0;
      let title = item.title;
      let bodyText = item.fullText;
      let description = item.description;
      let imageUrl = item.imageUrl;
      let pageUnavailable = false;
      let section: string | null = null;

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
          const headline = pickHeadline(item.title, extracted.headline, source.domain);
          title = headline.title;
          // A generic feed headline comes with a generic summary too: use the page's.
          description = (headline.fromPage && extracted.description) || description || extracted.description;
          // The page's share image is more reliable than the one in the listing.
          imageUrl = extracted.imageUrl ?? imageUrl;
          section = extracted.section;
        } else if (page.status === "unavailable") {
          pageUnavailable = true;
        }
      }

      const text = { title, content: `${description}\n${bodyText}` };
      const matches = matchArticle(text, matchable.parties, matchable.deputies);
      if (matches.parties.length > 0) {
        const initiativeMatches = matchInitiatives(matchable.initiatives, {
          text: `${title}\n${description}\n${bodyText}`.slice(0, INITIATIVE_TEXT_CHARS),
          publishedAt: item.publishedAt,
        });
        await saveArticle(
          db,
          {
            sourceUri: url,
            title,
            excerpt: toExcerpt(description || bodyText),
            url,
            source: source.domain,
            imageUrl,
            publishedAt: item.publishedAt,
            kind: articleKind(url, section),
          },
          { ...matches, initiatives: initiativeMatches, government: matchNames(text, matchable.government),
            president: matchNames(text, matchable.president),
            local: matchNames(text, matchable.local ?? []),
          },
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
  const matchable: Matchable = {
    parties: await loadMatchableParties(options.db),
    deputies: await loadMatchableDeputies(options.db),
    initiatives: await loadInitiativeIndex(options.db, options.now),
    government: await loadMatchableGovernment(options.db),
    president: await loadMatchablePresident(options.db),
    local: await loadMatchableLocalOfficials(options.db),
  };
  if (matchable.parties.length === 0) throw new Error("No parties found: run the seed first");
  return Promise.all(options.sources.map((source) => scanSource(source, matchable, options)));
};

/** How far back, and how many pages per run, to look again at articles stored with a placeholder headline. */
const RECHECK_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const RECHECK_MAX_PAGES = 10;

/**
 * Articles stored while their headline was still a placeholder ("As notícias das 8h") get the
 * real headline and summary once the page has them. Returns how many were updated.
 */
export const refreshGenericHeadlines = async ({ db, client, now = new Date() }: Pick<IngestOptions, "db" | "client" | "now">) => {
  const recent = await db
    .select({ id: articles.id, title: articles.title, url: articles.url, source: articles.source })
    .from(articles)
    .where(and(gte(articles.publishedAt, new Date(now.getTime() - RECHECK_WINDOW_MS))))
    .orderBy(desc(articles.publishedAt));
  let updated = 0;
  for (const article of recent.filter((a) => isGenericHeadline(a.title)).slice(0, RECHECK_MAX_PAGES)) {
    const page = await client.get(article.url);
    if (page.status !== "ok") continue;
    const extracted = extractArticle(page.body);
    const headline = pickHeadline(article.title, extracted.headline, article.source);
    if (!headline.fromPage || isGenericHeadline(headline.title)) continue;
    await db
      .update(articles)
      .set({
        title: headline.title,
        ...(extracted.description ? { excerpt: toExcerpt(extracted.description) } : {}),
        ...(extracted.imageUrl ? { imageUrl: extracted.imageUrl } : {}),
      })
      .where(eq(articles.id, article.id));
    updated++;
  }
  return updated;
};
