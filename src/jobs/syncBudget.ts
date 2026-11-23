import { announceBudgetVotes } from "../budget/alerts.js";
import { importPastBudgetBills, syncCurrentBudgetBills } from "../budget/bills.js";
import { enrichBudget } from "../budget/enrich.js";
import { budgetInDiscussion, syncBudgetSchedule } from "../budget/schedule.js";
import { syncBudget } from "../budget/sync.js";
import { createPoliteClient } from "../ingestion/politeClient.js";
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
 *   node dist/jobs/syncBudget.js --force              a full run even outside a Budget's discussion
 *
 * The cron runs hourly, but does the full work only while a Budget is being discussed (from its
 * bill's submission to a month after its final overall vote: budgetInDiscussion). Outside that,
 * one full run a day (06:xx UTC) keeps corrections coming in, and the other runs stop after a
 * quick look at the Budget bills, which is how a new Budget is noticed (within the hour).
 */
const DAILY_RUN_HOUR_UTC = 6;
const config = loadParliamentConfig();
const args = process.argv.slice(2);
const legislature = args.find((a) => a.startsWith("--legislature="))?.slice("--legislature=".length);
const { db, pool } = createDb(config.DATABASE_URL);

try {
  // Each Budget's own votes (generalidade, final global): the current ones every run, earlier ones
  // with --all. From our own copy of the initiatives, so it's quick: it also says whether a Budget is on.
  const bills = await syncCurrentBudgetBills(db);
  console.log(JSON.stringify({ budgetBills: bills }));
  const discussed = await budgetInDiscussion(db, config.PARLIAMENT_LEGISLATURE);
  const full = args.includes("--all") || args.includes("--force") || legislature !== undefined || discussed !== null || new Date().getUTCHours() === DAILY_RUN_HOUR_UTC;
  if (!full) {
    console.log(JSON.stringify({ quiet: "no Budget in discussion; the full run is daily" }));
    if (bills > 0) await createRevalidator()(["budget"]);
  } else {
    const { results, warnings } = await syncBudget(db, { legislatures: args.includes("--all") ? "all" : [legislature ?? config.PARLIAMENT_LEGISLATURE] });
    for (const result of results) console.log(JSON.stringify(result));
    for (const warning of warnings) console.error(`Budget: ${warning}`);
    // New votes on proposals readers follow go to their inbox. Best effort: never fails the sync.
    if (results.some((r) => r.changed)) {
      try {
        console.log(JSON.stringify({ alerts: await announceBudgetVotes(db) }));
      } catch (error) {
        console.error("Budget alerts:", error instanceof Error ? error.message : error);
      }
    }
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
    // The voting scripts: which proposals each coming voting day takes (src/budget/schedule.ts).
    // Only while that Budget is discussed: they're published in its voting weeks.
    let scheduled = false;
    if (discussed !== null) {
      try {
        const schedule = await syncBudgetSchedule(db, { client: createPoliteClient(), year: discussed, legislature: config.PARLIAMENT_LEGISLATURE });
        console.log(JSON.stringify({ schedule }));
        scheduled = "read" in schedule && schedule.read > 0;
      } catch (error) {
        console.error("Budget schedule:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
    // Then summaries, news and statements for proposals that lack them (src/budget/enrich.ts). Its
    // own step: a failure there (the model, a PDF) never fails the sync above.
    let enriched = false;
    try {
      const enrichment = await enrichBudget(db, { client: createPoliteClient() });
      console.log(JSON.stringify({ enrichment }));
      enriched = !("skipped" in enrichment) && enrichment.summaries.summarized + enrichment.news.linked > 0;
    } catch (error) {
      console.error("Budget summaries:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
    if (results.some((r) => r.changed) || bills > 0 || enriched || scheduled) await createRevalidator()(["budget"]);
    if (results.length === 0) process.exitCode = 1;
  }
} catch (error) {
  console.error("Budget sync failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
