import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { linkStoredArticles } from "../parliament/linkNews.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { syncParliament } from "../parliament/sync.js";
import { resolvePredictions } from "../predictions/index.js";
import { openVoteRounds } from "../predictions/rounds.js";
import { createRevalidator } from "../revalidate.js";

/** How far back to look for news that new initiatives or deputies now match. */
const RELINK_DAYS = 30;

const config = loadParliamentConfig();
const { db, pool } = createDb(config.DATABASE_URL);

/** Each step on its own: one failing doesn't skip the others, but still fails the run. */
const step = async (name: string, run: () => Promise<unknown>) => {
  try {
    const result = await run();
    if (result !== undefined) console.log(JSON.stringify({ [name]: result }));
  } catch (error) {
    console.error(`${name} failed:`, error);
    process.exitCode = 1;
  }
};

try {
  await step("parliament", async () => {
    const stats = await syncParliament(db, createOpenDataClient({ legislature: config.PARLIAMENT_LEGISLATURE }));
    for (const warning of stats.warnings) console.warn(`Warning: ${warning}`);
    return { ...stats, warnings: stats.warnings.length };
  });
  // New initiatives and deputies can match news the scanner already stored.
  const since = new Date(Date.now() - RELINK_DAYS * 24 * 60 * 60 * 1000);
  await step("relinked", () => linkStoredArticles(db, { since }));
  // "Passa ou chumba?": settle what the new votes decided, and tell the readers.
  await step("predictions", () => resolvePredictions(db));
  await step("voteRounds", () => openVoteRounds(db));
  await step("revalidate", () => createRevalidator()(["parliament", "predictions", "news"]));
} finally {
  await pool.end();
}
