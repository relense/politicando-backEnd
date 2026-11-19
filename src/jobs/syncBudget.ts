import { importPastBudgetBills, syncCurrentBudgetBills } from "../budget/bills.js";
import { syncBudget } from "../budget/sync.js";
import { PAST_LEGISLATURES } from "../parliament/pastLegislatures.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createRevalidator } from "../revalidate.js";

/*
 * The State Budget's amendment proposals and how each party voted (docs/budget-api.md).
 *
 *   node dist/jobs/syncBudget.js                      the current legislature's Budgets (the cron)
 *   node dist/jobs/syncBudget.js --legislature=XVI    another legislature's
 *   node dist/jobs/syncBudget.js --all                every Budget since 2004, and each Budget bill's own votes (a backfill)
 */
const config = loadParliamentConfig();
const args = process.argv.slice(2);
const legislature = args.find((a) => a.startsWith("--legislature="))?.slice("--legislature=".length);
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const { results, warnings } = await syncBudget(db, { legislatures: args.includes("--all") ? "all" : [legislature ?? config.PARLIAMENT_LEGISLATURE] });
  for (const result of results) console.log(JSON.stringify(result));
  for (const warning of warnings) console.error(`Budget: ${warning}`);
  // Each Budget's own votes (generalidade, final global): the current ones every run, earlier ones with --all.
  const bills = await syncCurrentBudgetBills(db);
  console.log(JSON.stringify({ budgetBills: bills }));
  if (args.includes("--all")) {
    // Every earlier legislature: Budget bills (and their votes, where recorded) go back to the 1980s.
    for (const past of PAST_LEGISLATURES) {
      try {
        console.log(JSON.stringify({ legislature: past, budgetBills: await importPastBudgetBills(db, createOpenDataClient({ legislature: past, retryDelaysMs: [] }), past) }));
      } catch (error) {
        console.error(`Budget bills of the ${past} legislature:`, error instanceof Error ? error.message : error);
      }
    }
  }
  if (results.some((r) => r.changed) || bills > 0) await createRevalidator()(["budget"]);
  if (results.length === 0) process.exitCode = 1;
} catch (error) {
  console.error("Budget sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
