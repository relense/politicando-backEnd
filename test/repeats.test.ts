import { asc } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { articles } from "../src/db/schema.js";
import { hideRepeats } from "../src/ingestion/repeats.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await pool.end();
});

const now = new Date("2026-11-25T12:00:00.000Z");
let n = 0;
const add = (source: string, title: string, at: string, hiddenAt: Date | null = null) => {
  n++;
  return insertArticle(db, { sourceUri: `uri-${n}`, url: `https://${source}/${n}`, source, title, publishedAt: new Date(at), hiddenAt });
};
const visible = async () =>
  (await db.select().from(articles).orderBy(asc(articles.id))).filter((a) => !a.hiddenAt).map((a) => `${a.source} ${a.title}`);

describe("hideRepeats", () => {
  it("hides an outlet's later copies of the same headline, and nothing else", async () => {
    // RTP files the same piece under two sections; Expresso re-dates the slug the next morning.
    await add("rtp.pt", "Governo terá de avaliar impactos do PRR", "2026-11-24T22:09:00Z");
    await add("rtp.pt", "Governo terá de avaliar impactos do PRR ", "2026-11-24T22:09:00Z");
    await add("expresso.pt", "Oposição aumenta pressão sobre Moedas", "2026-11-24T22:44:00Z");
    await add("expresso.pt", "oposição aumenta pressão sobre moedas", "2026-11-25T07:05:00Z");
    await add("expresso.pt", "Oposição aumenta pressão sobre Moedas", "2026-11-25T09:00:00Z");
    // The same agency headline from another outlet is coverage, not a repeat.
    await add("cmjornal.pt", "Oposição aumenta pressão sobre Moedas", "2026-11-25T08:00:00Z");
    // Placeholder headlines are a different bulletin each time.
    await add("rtp.pt", "As notícias das 8h", "2026-11-24T08:00:00Z");
    await add("rtp.pt", "As notícias das 8h", "2026-11-25T08:00:00Z");
    // Weeks apart: a new article that happens to share a headline.
    await add("publico.pt", "Orçamento aprovado", "2026-11-10T10:00:00Z");
    await add("publico.pt", "Orçamento aprovado", "2026-11-24T10:00:00Z");
    // When a moderator hid the first copy, the second one isn't hidden for it.
    await add("dn.pt", "Ministro demite-se", "2026-11-24T10:00:00Z", now);
    await add("dn.pt", "Ministro demite-se", "2026-11-24T11:00:00Z");

    expect(await hideRepeats(db, now)).toBe(3);
    expect(await visible()).toEqual([
      "rtp.pt Governo terá de avaliar impactos do PRR",
      "expresso.pt Oposição aumenta pressão sobre Moedas",
      "cmjornal.pt Oposição aumenta pressão sobre Moedas",
      "rtp.pt As notícias das 8h",
      "rtp.pt As notícias das 8h",
      "publico.pt Orçamento aprovado",
      "publico.pt Orçamento aprovado",
      "dn.pt Ministro demite-se",
    ]);
    expect(await hideRepeats(db, now)).toBe(0);
  });
});
