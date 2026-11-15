import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { articleDeputies, articles } from "../db/schema.js";
import { loadMatchableDeputies, loadMatchableParties } from "../ingestion/ingest.js";
import { countMentions, matchDeputies } from "../matching/matchParties.js";

const BATCH = 500;

/**
 * Links stored articles to the deputies they mention. The full text isn't kept, so
 * this only sees the headline and excerpt; new articles are linked by the scanner
 * with the full text. Replaces automatic links and never touches manual ones.
 */
export const linkStoredArticles = async (db: Db, { since }: { since?: Date } = {}) => {
  const matchable = await loadMatchableDeputies(db);
  const parties = await loadMatchableParties(db);
  let linked = 0;
  let scanned = 0;
  let lastId = 0;

  for (;;) {
    const rows = await db
      .select({ id: articles.id, title: articles.title, excerpt: articles.excerpt })
      .from(articles)
      .where(and(gt(articles.id, lastId), since ? gt(articles.publishedAt, since) : undefined))
      .orderBy(asc(articles.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    lastId = rows.at(-1)!.id;
    scanned += rows.length;

    // These articles were already judged political when stored, so there's no party gate.
    const links = rows.flatMap((row) => {
      const text = `${row.title}\n${row.excerpt}`;
      const mentioned = (partyId: number) =>
        parties.some((party) => party.id === partyId && countMentions(text, [party]) > 0);
      return matchDeputies({ title: row.title, content: row.excerpt }, matchable, mentioned).map((d) => ({
        articleId: row.id,
        deputyId: d.deputyId,
        mentionCount: d.mentions,
      }));
    });

    await db.transaction(async (tx) => {
      await tx.delete(articleDeputies).where(
        and(inArray(articleDeputies.articleId, rows.map((r) => r.id)), eq(articleDeputies.linkedBy, "auto")),
      );
      if (links.length > 0) await tx.insert(articleDeputies).values(links).onConflictDoNothing();
    });
    linked += links.length;
  }
  return { scanned, linked };
};
