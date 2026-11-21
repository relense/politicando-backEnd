import type { Db } from "../db/client.js";
import type { PoliteClient } from "../ingestion/politeClient.js";
import { linkBudgetNews, newsJudgeFromEnv, type NewsResult } from "./news.js";
import { summarizeProposals, summarizerFromEnv, type SummarizeResult } from "./summarize.js";

/**
 * After the Budget sync: summaries for proposals without one, then their news and statements.
 * Needs ANTHROPIC_API_KEY; without it, nothing is done (and that's said in the result).
 */
export const enrichBudget = async (
  db: Db,
  { client, summaries = 200, news = 150, env = process.env }: { client: PoliteClient; summaries?: number; news?: number; env?: NodeJS.ProcessEnv },
): Promise<{ skipped: string } | { summaries: SummarizeResult; news: NewsResult }> => {
  const summarizer = summarizerFromEnv(env);
  const judge = newsJudgeFromEnv(env);
  if (!summarizer || !judge) return { skipped: "ANTHROPIC_API_KEY not set" };
  return {
    summaries: await summarizeProposals(db, { client, summarizer, limit: summaries }),
    news: await linkBudgetNews(db, { client, judge, limit: news }),
  };
};
