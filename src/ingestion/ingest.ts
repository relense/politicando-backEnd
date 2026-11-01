import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { articleParties, articles, parties, seenSourceUris } from "../db/schema.js";
import { matchParties, type MatchableParty } from "../matching/matchParties.js";
import { PARTY_DEFINITIONS } from "../matching/parties.js";
import type { NewsSource, SourceArticle } from "./newsSource.js";

export interface IngestStats {
  fetched: number;
  skipped: number;
  matched: number;
  rejected: number;
  failed: number;
}

/** Today and yesterday in Lisbon, so articles published near midnight aren't missed. */
export const lisbonDateWindow = (now: Date) => {
  const dateEnd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const yesterday = new Date(`${dateEnd}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { dateStart: yesterday.toISOString().slice(0, 10), dateEnd };
};

const loadMatchableParties = async (db: Db): Promise<MatchableParty[]> => {
  const rows = await db.select().from(parties);
  const termsBySlug = new Map(PARTY_DEFINITIONS.map((party) => [party.slug, party.terms]));
  return rows.flatMap((row) => {
    const terms = termsBySlug.get(row.slug);
    return terms ? [{ id: row.id, acronym: row.acronym, terms }] : [];
  });
};

const findKnownUris = async (db: Db, uris: string[]) => {
  if (uris.length === 0) return new Set<string>();
  const [stored, seen] = await Promise.all([
    db.select({ uri: articles.sourceUri }).from(articles).where(inArray(articles.sourceUri, uris)),
    db
      .select({ uri: seenSourceUris.sourceUri })
      .from(seenSourceUris)
      .where(inArray(seenSourceUris.sourceUri, uris)),
  ]);
  return new Set([...stored, ...seen].map((row) => row.uri));
};

const saveArticle = async (
  db: Db,
  article: SourceArticle,
  matches: ReturnType<typeof matchParties>,
) => {
  await db.transaction(async (tx) => {
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
};

export interface IngestOptions {
  db: Db;
  source: NewsSource;
  maxPages: number;
  now?: Date;
  onArticleError?: (sourceUri: string, error: unknown) => void;
}

/**
 * Rejected articles are never stored, so they can't appear in the API. A fetch
 * failure rejects, but anything already saved stays saved and the next run is safe.
 */
export const ingest = async (
  { db, source, maxPages, now = new Date(), onArticleError }: IngestOptions,
  stats: IngestStats = { fetched: 0, skipped: 0, matched: 0, rejected: 0, failed: 0 },
): Promise<IngestStats> => {
  const matchable = await loadMatchableParties(db);
  if (matchable.length === 0) throw new Error("No parties found: run the seed first");

  const window = lisbonDateWindow(now);
  for (let page = 1, lastPage = 1; page <= Math.min(lastPage, maxPages); page++) {
    const result = await source.fetchPage({ ...window, page });
    lastPage = result.totalPages;
    stats.fetched += result.articles.length + result.malformed;
    stats.failed += result.malformed;

    const known = await findKnownUris(db, result.articles.map((article) => article.sourceUri));
    for (const article of result.articles) {
      if (known.has(article.sourceUri)) {
        stats.skipped++;
        continue;
      }
      known.add(article.sourceUri);
      try {
        const matches = matchParties(article, matchable);
        if (matches.length > 0) {
          await saveArticle(db, article, matches);
          stats.matched++;
        } else {
          await db
            .insert(seenSourceUris)
            .values({ sourceUri: article.sourceUri })
            .onConflictDoNothing();
          stats.rejected++;
        }
      } catch (error) {
        stats.failed++;
        onArticleError?.(article.sourceUri, error);
      }
    }
  }
  return stats;
};
