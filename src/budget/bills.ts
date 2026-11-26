import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgetBills, initiatives, type VoteRecord } from "../db/schema.js";
import { foldText } from "../modules/articles/routes.js";
import type { OpenDataLoader } from "../parliament/openData.js";
import { overwriteAll } from "../db/upsert.js";
import { type ParsedInitiative, parseInitiative } from "../parliament/parse.js";

/*
 * Each Budget's own bill and its votes (generalidade, final global…), next to the amendment
 * proposals. The current legislature's come from our initiatives table; earlier ones are read
 * once from the parliament's initiatives file of each legislature.
 */

/** The Budget's year when this is a Budget bill (a "Proposta de Lei" titled "[Aprova o] Orçamento do Estado para 2027"). */
export const budgetBillYear = (type: string, title: string) => {
  if (!foldText(type).includes("proposta de lei")) return null;
  // "Orçamento do Estado para 2010." up to 2011; "Aprova o Orçamento do Estado para 2012" since.
  const match = /^(?:aprova o )?orcamento do estado para (\d{4})\.?$/.exec(foldText(title).replace(/\s+/g, " ").trim());
  return match ? Number(match[1]) : null;
};

type Bill = typeof budgetBills.$inferInsert;

const store = async (db: Db, bills: Bill[]) => {
  if (bills.length === 0) return 0;
  const changed = await db
    .insert(budgetBills)
    .values(bills)
    .onConflictDoUpdate({
      target: budgetBills.initiativeId,
      set: {
        year: sql`excluded.year`, legislature: sql`excluded.legislature`, number: sql`excluded.number`,
        title: sql`excluded.title`, status: sql`excluded.status`, votes: sql`excluded.votes`, updatedAt: sql`now()`,
      },
      // The same bill seen again isn't a change: the count says what changed.
      setWhere: sql`(${budgetBills.year}, ${budgetBills.number}, ${budgetBills.title}, ${budgetBills.status}, ${budgetBills.votes})
        is distinct from (excluded.year, excluded.number, excluded.title, excluded.status, excluded.votes)`,
    })
    .returning({ id: budgetBills.initiativeId });
  return changed.length;
};

/** The current legislature's Budget bills (returns how many are new or changed), from the initiatives the parliament sync keeps. */
export const syncCurrentBudgetBills = async (db: Db) => {
  const rows = await db
    .select({ id: initiatives.id, legislature: initiatives.legislature, type: initiatives.type, number: initiatives.number, title: initiatives.title, status: initiatives.status, votes: initiatives.votes })
    .from(initiatives)
    .where(sql`${initiatives.type} ilike 'Proposta de Lei%' and ${initiatives.title} ilike '%amento do Estado para%'`);
  const bills = rows.flatMap((r) => {
    const year = budgetBillYear(r.type, r.title);
    return year ? [{ initiativeId: r.id, year, legislature: r.legislature, number: r.number, title: r.title, status: r.status, votes: r.votes }] : [];
  });
  return store(db, bills);
};

/** An earlier legislature's Budget bills, read from its initiatives file. */
export const importPastBudgetBills = async (db: Db, load: OpenDataLoader, legislature: string) => {
  const bills: Bill[] = [];
  for await (const item of load.items("initiatives")) {
    for (const parsed of parseInitiative(item)) {
      const year = budgetBillYear(parsed.type, parsed.title);
      if (!year) continue;
      // Still "in progress" when its legislature ended: it lapsed.
      const status = parsed.status === "in_progress" ? "lapsed" : parsed.status;
      bills.push({ initiativeId: parsed.id, year, legislature: parsed.legislature || legislature, number: parsed.number, title: parsed.title, status, votes: parsed.votes as VoteRecord[] });
    }
  }
  return store(db, bills);
};

/**
 * While one of the legislature's Budget bills is still in progress, re-reads those bills from the
 * parliament's initiatives file (as the daily parliament sync does, for them only), so a new vote
 * reaches the site within the hour it's published rather than at the next 04:00 UTC sync. Returns
 * null when no bill is in progress (nothing read), else how many of our initiatives changed.
 */
export const refreshBudgetBillsInProgress = async (db: Db, load: OpenDataLoader, legislature: string) => {
  const open = await db
    .select({ id: budgetBills.initiativeId })
    .from(budgetBills)
    .where(and(eq(budgetBills.legislature, legislature), eq(budgetBills.status, "in_progress")));
  if (open.length === 0) return null;
  const ids = new Set(open.map((b) => b.id));
  const found: ParsedInitiative[] = [];
  for await (const item of load.items("initiatives")) for (const parsed of parseInitiative(item)) if (ids.has(parsed.id)) found.push(parsed);
  if (found.length === 0) return 0;
  const changed = await db
    .insert(initiatives)
    // Authors are the parliament sync's; a Budget bill's never change.
    .values(found.map(({ authorGroups: _groups, authorDeputyIds: _deputies, ...initiative }) => ({ ...initiative, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: initiatives.id,
      set: overwriteAll(initiatives),
      setWhere: sql`(${initiatives.status}, ${initiatives.votes}) is distinct from (excluded.status, excluded.votes)`,
    })
    .returning({ id: initiatives.id });
  return changed.length;
};
