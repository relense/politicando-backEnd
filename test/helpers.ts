import { sql } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { articleParties, articles, parties } from "../src/db/schema.js";
import { seedParties } from "../src/db/seed.js";
import type { SourceArticle } from "../src/ingestion/newsSource.js";
import { testDatabaseUrl } from "./globalSetup.js";

export const createTestDb = () => createDb(testDatabaseUrl());

export const resetDb = async (db: Db) => {
  await db.execute(
    sql`truncate comments, article_parties, articles, seen_source_uris restart identity cascade`,
  );
  await seedParties(db);
};

export const sourceArticle = (overrides: Partial<SourceArticle> = {}): SourceArticle => ({
  sourceUri: "uri-1",
  title: "O PS e o PSD",
  content: "O PS criticou o Governo.",
  url: "https://example.pt/1",
  source: "publico.pt",
  imageUrl: null,
  publishedAt: new Date("2026-10-01T10:00:00.000Z"),
  ...overrides,
});

export const insertArticle = async (
  db: Db,
  overrides: Partial<SourceArticle> = {},
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
