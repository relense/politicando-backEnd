import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { articleDeputies, articleGovernmentMembers, articleInitiatives, articles, initiatives } from "../db/schema.js";
import { loadMatchableDeputies, loadMatchableGovernment, loadMatchableParties } from "../ingestion/ingest.js";
import { buildInitiativeIndex, matchInitiatives } from "../matching/matchInitiatives.js";
import { countMentions, matchDeputies, matchNames } from "../matching/matchParties.js";

const BATCH = 500;

/**
 * Links stored articles to the deputies, members of the Government and initiatives they mention. The full text isn't
 * kept, so this only sees the headline and excerpt; new articles are linked by the scanner
 * with more text. By default it only adds links, so it never undoes the scanner's better
 * ones. With `replace`, automatic links are recomputed from scratch (use after changing
 * matching rules). Manual links are never touched.
 */
export const linkStoredArticles = async (
  db: Db,
  { since, replace = false }: { since?: Date; replace?: boolean } = {},
) => {
  const deputies = await loadMatchableDeputies(db);
  const parties = await loadMatchableParties(db);
  const government = await loadMatchableGovernment(db);
  const index = buildInitiativeIndex(
    await db
      .select({
        id: initiatives.id,
        title: initiatives.title,
        activityDate: initiatives.phaseDate,
        submittedAt: initiatives.submittedAt,
      })
      .from(initiatives),
  );
  const totals = { scanned: 0, deputyLinks: 0, governmentLinks: 0, initiativeLinks: 0 };
  let lastId = 0;

  for (;;) {
    const rows = await db
      .select({ id: articles.id, title: articles.title, excerpt: articles.excerpt, publishedAt: articles.publishedAt })
      .from(articles)
      .where(and(gt(articles.id, lastId), since ? gt(articles.publishedAt, since) : undefined))
      .orderBy(asc(articles.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    lastId = rows.at(-1)!.id;
    totals.scanned += rows.length;

    const deputyLinks = rows.flatMap((row) => {
      const text = `${row.title}\n${row.excerpt}`;
      // Already judged political when stored, so there's no party gate; a party mention
      // only unlocks common short names ("Ventura" next to Chega).
      const mentioned = (partyId: number) =>
        parties.some((party) => party.id === partyId && countMentions(text, [party]) > 0);
      return matchDeputies({ title: row.title, content: row.excerpt }, deputies, mentioned).map((d) => ({
        articleId: row.id,
        deputyId: d.deputyId,
        mentionCount: d.mentions,
      }));
    });
    const governmentLinks = rows.flatMap((row) =>
      matchNames({ title: row.title, content: row.excerpt }, government).map((m) => ({
        articleId: row.id,
        memberId: m.id,
        mentionCount: m.mentions,
      })),
    );
    const initiativeLinks = rows.flatMap((row) =>
      matchInitiatives(index, { text: `${row.title}\n${row.excerpt}`, publishedAt: row.publishedAt }).map((m) => ({
        articleId: row.id,
        initiativeId: m.initiativeId,
        score: m.score,
      })),
    );

    await db.transaction(async (tx) => {
      const ids = rows.map((r) => r.id);
      if (replace) {
        await tx.delete(articleDeputies).where(and(inArray(articleDeputies.articleId, ids), eq(articleDeputies.linkedBy, "auto")));
        await tx
          .delete(articleGovernmentMembers)
          .where(and(inArray(articleGovernmentMembers.articleId, ids), eq(articleGovernmentMembers.linkedBy, "auto")));
        await tx
          .delete(articleInitiatives)
          .where(and(inArray(articleInitiatives.articleId, ids), eq(articleInitiatives.linkedBy, "auto")));
      }
      if (deputyLinks.length > 0) {
        const added = await tx.insert(articleDeputies).values(deputyLinks).onConflictDoNothing().returning();
        totals.deputyLinks += added.length;
      }
      if (governmentLinks.length > 0) {
        const added = await tx.insert(articleGovernmentMembers).values(governmentLinks).onConflictDoNothing().returning();
        totals.governmentLinks += added.length;
      }
      if (initiativeLinks.length > 0) {
        const added = await tx.insert(articleInitiatives).values(initiativeLinks).onConflictDoNothing().returning();
        totals.initiativeLinks += added.length;
      }
    });
  }
  return totals;
};
