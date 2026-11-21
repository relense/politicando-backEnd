import { enrichBudget } from "../budget/enrich.js";
import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
import { createRevalidator } from "../revalidate.js";

/*
 * Budget proposals' summaries, news and statements (docs/budget-api.md), by hand: the hourly
 * politicando-budget cron does the same with small batches. For the backlog:
 *
 *   node dist/jobs/budgetSummaries.js                          200 summaries, 150 news checks
 *   node dist/jobs/budgetSummaries.js --summaries=2000 --news=500
 */
const config = loadParliamentConfig();
const number = (name: string, fallback: number) => {
  const value = Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const result = await enrichBudget(db, { client: createPoliteClient(), summaries: number("summaries", 200), news: number("news", 150) });
  console.log(JSON.stringify(result));
  if ("skipped" in result) process.exitCode = 1;
  else if (result.summaries.summarized + result.news.linked > 0) await createRevalidator()(["budget"]);
} catch (error) {
  console.error("Budget summaries failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
