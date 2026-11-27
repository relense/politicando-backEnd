import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgetProposals, budgetSources, budgetVotes } from "../db/schema.js";
import { findFolderLink } from "../parliament/openData.js";
import { fetchText, RETRY_DELAYS_MS } from "../ingestion/retry.js";
import { parseProposals } from "./parse.js";

/*
 * Imports the State Budget's amendment proposals and their votes from the parliament's open
 * data. A Budget's file is read whole (a few MB) and, when it changed since the last run, the
 * year is replaced in one transaction: safe to run twice, and never half-written.
 */

const SITE = "https://www.parlamento.pt";
export const BUDGET_DATASET_PAGE = `${SITE}/Cidadania/Paginas/DAOE.aspx`;

const decode = (href: string) => href.replace(/&amp;/g, "&");

/** The ordinary Budgets' proposal files in a legislature's folder: "OEPropostasAlteracao2027Or_json.txt". */
export const findProposalFiles = (html: string) =>
  [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>\s*OEPropostasAlteracao(\d{4})Or_json\.txt\s*<\/a>/g)].map((m) => ({
    year: Number(m[2]),
    url: new URL(decode(m[1]!), SITE).href,
  }));

/** Every legislature with a folder on the dataset page, oldest first ("X", …, "XVII"). */
export const findLegislatures = (html: string) => {
  const roman = (r: string) => [...r].reduce((n, c, i, a) => {
    const v = { I: 1, V: 5, X: 10, L: 50, C: 100 }[c as "I"] ?? 0;
    const next = { I: 1, V: 5, X: 10, L: 50, C: 100 }[a[i + 1] as "I"] ?? 0;
    return n + (v < next ? -v : v);
  }, 0);
  return [...new Set([...html.matchAll(/title="Pasta ([IVXLC]+) Legislatura"/g)].map((m) => m[1]!))].sort((a, b) => roman(a) - roman(b));
};

export interface BudgetSyncResult {
  year: number;
  proposals: number;
  votes: number;
  ambiguous: number;
  changed: boolean;
}

const CHUNK = 500;

/** Replaces one year's proposals and votes with the file's, unless it's the file already stored. */
export const storeBudgetYear = async (db: Db, year: number, url: string, text: string): Promise<BudgetSyncResult> => {
  const hash = createHash("sha256").update(text).digest("hex");
  const proposals = parseProposals(JSON.parse(text.replace(/^﻿/, "")), year);
  const votes = proposals.flatMap((p) => p.votes.map((v) => ({ ...v, proposalId: p.id })));
  const result = { year, proposals: proposals.length, votes: votes.length, ambiguous: votes.filter((v) => v.ambiguity).length };
  const [stored] = await db.select({ hash: budgetSources.hash }).from(budgetSources).where(eq(budgetSources.year, year));
  if (stored?.hash === hash) return { ...result, changed: false };
  // An empty file (a Budget rejected before amendments, or a bad download) never wipes a year we have.
  if (proposals.length === 0) {
    const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)::int` }).from(budgetProposals).where(eq(budgetProposals.year, year));
    if (count > 0) return { ...result, changed: false };
  }
  await db.transaction(async (tx) => {
    await tx.delete(budgetProposals).where(eq(budgetProposals.year, year));
    for (let i = 0; i < proposals.length; i += CHUNK) {
      await tx.insert(budgetProposals).values(proposals.slice(i, i + CHUNK).map(({ votes: _votes, ...p }) => p));
    }
    for (let i = 0; i < votes.length; i += CHUNK) await tx.insert(budgetVotes).values(votes.slice(i, i + CHUNK));
    await tx
      .insert(budgetSources)
      .values({ year, url, hash, syncedAt: new Date() })
      .onConflictDoUpdate({ target: budgetSources.year, set: { url, hash, syncedAt: new Date() } });
  });
  return { ...result, changed: true };
};

/** Syncs every Budget in these legislatures' folders (the current one by default). */
export const syncBudget = async (
  db: Db,
  {
    legislatures,
    fetchFn = fetch,
    timeoutMs = 120_000,
    retryDelaysMs = RETRY_DELAYS_MS,
  }: { legislatures: string[] | "all"; fetchFn?: typeof fetch; timeoutMs?: number; retryDelaysMs?: readonly number[] },
) => {
  // Tried again on a timeout or a 5xx: one slow answer from parlamento.pt shouldn't fail the run.
  const get = (url: string) =>
    fetchText(url, { fetchFn, timeoutMs, delaysMs: retryDelaysMs, onRetry: (error, wait) => console.warn(`${error instanceof Error ? error.message : String(error)}; trying again in ${wait / 1000} s`) });
  const page = await get(BUDGET_DATASET_PAGE);
  const wanted = legislatures === "all" ? findLegislatures(page) : legislatures;
  const results: BudgetSyncResult[] = [];
  const warnings: string[] = [];
  for (const legislature of wanted) {
    const folder = findFolderLink(page, legislature);
    if (!folder) {
      warnings.push(`No ${legislature} folder on the Budget dataset page`);
      continue;
    }
    let files: ReturnType<typeof findProposalFiles>;
    try {
      files = findProposalFiles(await get(folder));
    } catch (error) {
      warnings.push(`${legislature} folder: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const file of files) {
      try {
        results.push(await storeBudgetYear(db, file.year, file.url, await get(file.url)));
      } catch (error) {
        warnings.push(`OE${file.year}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { results, warnings };
};
