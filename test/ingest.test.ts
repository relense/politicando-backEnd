import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { articleParties, articles, parties, seenSourceUris } from "../src/db/schema.js";
import { ingest, lisbonDateWindow } from "../src/ingestion/ingest.js";
import type { NewsPage, NewsSource } from "../src/ingestion/newsSource.js";
import { createTestDb, resetDb, sourceArticle } from "./helpers.js";

const { db, pool } = createTestDb();
beforeEach(() => resetDb(db));
afterAll(() => pool.end());

const sourceOf = (...pages: NewsPage[]) => {
  const fetchPage = vi.fn<NewsSource["fetchPage"]>(async ({ page }) => {
    const result = pages[page - 1];
    if (!result) throw new Error(`No page ${page}`);
    return result;
  });
  return { fetchPage };
};

const page = (articleList: NewsPage["articles"], totalPages = 1, malformed = 0): NewsPage => ({
  articles: articleList,
  totalPages,
  malformed,
});

const rejected = sourceArticle({ sourceUri: "rejected", title: "Futebol", content: "Golo." });

describe("ingest", () => {
  it("stores matched articles with real party IDs and hides rejected ones", async () => {
    const stats = await ingest({
      db,
      source: sourceOf(page([sourceArticle(), rejected])),
      maxPages: 1,
    });

    expect(stats).toEqual({ fetched: 2, skipped: 0, matched: 1, rejected: 1, failed: 0 });
    expect(await db.select({ uri: articles.sourceUri }).from(articles)).toEqual([{ uri: "uri-1" }]);
    expect(await db.select({ uri: seenSourceUris.sourceUri }).from(seenSourceUris)).toEqual([
      { uri: "rejected" },
    ]);

    const links = await db
      .select({ slug: parties.slug, mentions: articleParties.mentionCount })
      .from(articleParties)
      .innerJoin(parties, eq(parties.id, articleParties.partyId))
      .orderBy(asc(parties.slug));
    expect(links).toEqual([
      { slug: "ps", mentions: 2 },
      { slug: "psd", mentions: 1 },
    ]);
  });

  it("adds nothing and skips everything on a second run", async () => {
    const source = sourceOf(page([sourceArticle(), rejected]));
    await ingest({ db, source, maxPages: 1 });
    const second = await ingest({ db, source, maxPages: 1 });

    expect(second).toEqual({ fetched: 2, skipped: 2, matched: 0, rejected: 0, failed: 0 });
    expect(await db.select().from(articles)).toHaveLength(1);
    expect(await db.select().from(articleParties)).toHaveLength(2);
  });

  it("handles the same article appearing twice in a page", async () => {
    const stats = await ingest({
      db,
      source: sourceOf(page([sourceArticle(), sourceArticle()])),
      maxPages: 1,
    });
    expect(stats.matched).toBe(1);
    expect(stats.skipped).toBe(1);
  });

  it("stops at maxPages even if the source has more", async () => {
    const source = sourceOf(
      page([sourceArticle({ sourceUri: "a" })], 3),
      page([sourceArticle({ sourceUri: "b" })], 3),
      page([sourceArticle({ sourceUri: "c" })], 3),
    );
    await ingest({ db, source, maxPages: 2 });
    expect(source.fetchPage).toHaveBeenCalledTimes(2);
    expect(await db.select().from(articles)).toHaveLength(2);
  });

  it("stops at the source's last page", async () => {
    const source = sourceOf(page([sourceArticle()], 1));
    await ingest({ db, source, maxPages: 5 });
    expect(source.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("counts malformed results as failed and carries on", async () => {
    const stats = await ingest({ db, source: sourceOf(page([sourceArticle()], 1, 2)), maxPages: 1 });
    expect(stats).toMatchObject({ fetched: 3, failed: 2, matched: 1 });
  });

  it("carries on after one article fails to save", async () => {
    const errors: string[] = [];
    const stats = await ingest({
      db,
      source: sourceOf(
        page([
          sourceArticle({ sourceUri: "bad", publishedAt: new Date("invalid") }),
          sourceArticle({ sourceUri: "good" }),
        ]),
      ),
      maxPages: 1,
      onArticleError: (uri) => errors.push(uri),
    });
    expect(stats).toMatchObject({ failed: 1, matched: 1 });
    expect(errors).toEqual(["bad"]);
    expect(await db.select({ uri: articles.sourceUri }).from(articles)).toEqual([{ uri: "good" }]);
  });

  it("rejects on a fetch failure but keeps what it already saved", async () => {
    const source = sourceOf(page([sourceArticle()], 2));
    await expect(ingest({ db, source, maxPages: 2 })).rejects.toThrow("No page 2");
    expect(await db.select().from(articles)).toHaveLength(1);
  });

  it("requires seeded parties", async () => {
    await db.delete(parties);
    await expect(ingest({ db, source: sourceOf(page([])), maxPages: 1 })).rejects.toThrow(
      "run the seed",
    );
  });
});

describe("lisbonDateWindow", () => {
  it("uses Lisbon's date, not UTC's, during summer time", () => {
    expect(lisbonDateWindow(new Date("2026-07-01T23:30:00Z"))).toEqual({
      dateStart: "2026-07-01",
      dateEnd: "2026-07-02",
    });
  });

  it("crosses a year boundary", () => {
    expect(lisbonDateWindow(new Date("2027-01-01T12:00:00Z"))).toEqual({
      dateStart: "2026-12-31",
      dateEnd: "2027-01-01",
    });
  });
});
