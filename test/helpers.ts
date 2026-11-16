import { sql } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { articleParties, articles, parties } from "../src/db/schema.js";
import { seedParties } from "../src/db/seed.js";
import { testDatabaseUrl } from "./globalSetup.js";

export const createTestDb = () => createDb(testDatabaseUrl());

export const resetDb = async (db: Db) => {
  await db.execute(
    sql`truncate past_initiatives, comments, article_parties, article_deputies, article_initiatives, articles, seen_source_uris,
      initiative_parties, initiative_deputies, initiatives, article_government_members, government_positions,
      government_members, governments, article_presidents, presidents, election_results, election_turnout,
      election_lists, elections, contract_parties, contracts, contract_imports, places, deputies, audit_log,
      admin_sessions, admins, case_people, case_events, case_sources, cases, interests, reports, forum_posts,
      forum_threads, editorial_posts, newsletter_subscribers restart identity cascade`,
  );
  await seedParties(db);
};

type NewArticle = typeof articles.$inferInsert;

export const sourceArticle = (overrides: Partial<NewArticle> = {}): NewArticle => ({
  sourceUri: "uri-1",
  title: "O PS e o PSD",
  excerpt: "O PS criticou o Governo.",
  url: "https://example.pt/1",
  source: "publico.pt",
  imageUrl: null,
  publishedAt: new Date("2026-10-01T10:00:00.000Z"),
  ...overrides,
});

export const insertArticle = async (
  db: Db,
  overrides: Partial<NewArticle> = {},
  partySlugs: string[] = ["ps"],
) => {
  const [article] = await db.insert(articles).values(sourceArticle(overrides)).returning();
  if (!article) throw new Error("Insert returned no row");
  const rows = await db.select().from(parties);
  for (const [index, slug] of partySlugs.entries()) {
    const party = rows.find((row) => row.slug === slug);
    if (!party) throw new Error(`Unknown party ${slug}`);
    await db.insert(articleParties).values({
      articleId: article.id,
      partyId: party.id,
      mentionCount: partySlugs.length - index,
    });
  }
  return article;
};
