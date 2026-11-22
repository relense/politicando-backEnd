import { spawn } from "node:child_process";
import * as cheerio from "cheerio";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgetBills, budgetSchedule, budgetScheduleDocuments } from "../db/schema.js";
import type { PoliteClient } from "../ingestion/politeClient.js";

/*
 * Which Budget proposals each voting day takes, before the vote (docs/budget-api.md). The
 * parliament's own Budget data only says what was voted once it has been; but the Budget
 * committee (COFAP) publishes, days ahead, a voting script ("guião de votações") per day and
 * venue: every proposal to be voted, in order ("Votação da Proposta: 486C-1"). They're PDFs on
 * the committee's page for that Budget, under a heading per day ("4.º Dia de Votações | 23-11-2026").
 *
 * The page's address has the legislature and the committee's folder in it: the folder (5COFAP,
 * the 5th committee) is set by each legislature, so check it when a new one starts.
 */
export const BUDGET_COMMITTEE_FOLDER = "5COFAP";

export const schedulePageUrl = (legislature: string, year: number) =>
  `https://www.parlamento.pt/sites/COM/${legislature}Leg/${BUDGET_COMMITTEE_FOLDER}/Paginas/OE${year}.aspx`;

export type Venue = "committee" | "plenary";

export interface ScriptLink {
  url: string;
  title: string;
  votingDay: string;
  venue: Venue;
  /** "… - consolidado": a newer version of a script with the same title, which replaces it. */
  consolidated: boolean;
  /** The title without its version marks, to match a script with its consolidated version. */
  base: string;
}

/**
 * The voting day in a heading, as YYYY-MM-DD. The Budget for `year` is voted in the autumn before
 * (or, after an election, early in its own year): a year outside those is a typo on the page
 * ("23-11-2024" for OE2027), and the day and month are kept.
 */
export const headingDay = (heading: string, year: number): string | null => {
  const match = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(heading);
  if (!match) return null;
  const [day, month, written] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const actual = written === year - 1 || written === year ? written : month >= 9 ? year - 1 : year;
  return `${actual}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const SCRIPT = /^(?:\d+\.\d+\s+)?Gui[aã]o\s+(?:para\s+vota[cç][aã]o\s+(?:em\s+)?)?(Comiss[aã]o|Plen[aá]rio)\b/i;
const CONSOLIDATED = /[\s-]*consolidad[oa]\s*$/i;

/** The voting scripts on the committee's page for a Budget, in the page's order. */
export const parseSchedulePage = (html: string, year: number, pageUrl: string): ScriptLink[] => {
  const $ = cheerio.load(html);
  const links: ScriptLink[] = [];
  $(".ms-webpart-chrome").each((_, part) => {
    const heading = $(part).find(".ms-webpart-titleText").first().text().replace(/\s+/g, " ").trim();
    if (!/dia de vota/i.test(heading)) return;
    const votingDay = headingDay(heading, year);
    if (!votingDay) return;
    $(part)
      .find("a[href]")
      .each((_, a) => {
        const title = $(a).text().replace(/\s+/g, " ").trim();
        const kind = SCRIPT.exec(title);
        const href = $(a).attr("href");
        if (!kind || !href) return;
        let url: string;
        try {
          url = new URL(href, pageUrl).toString();
        } catch {
          return;
        }
        const consolidated = CONSOLIDATED.test(title);
        const base = title.replace(/^\d+\.\d+\s+/, "").replace(CONSOLIDATED, "").trim().toLowerCase();
        links.push({ url, title, votingDay, venue: /^comiss/i.test(kind[1]!) ? "committee" : "plenary", consolidated, base });
      });
  });
  return links;
};

/** The scripts that count: a consolidated version replaces the others with its title, that day. */
export const currentScripts = (links: ScriptLink[]): ScriptLink[] => {
  const key = (l: ScriptLink) => `${l.votingDay}|${l.venue}|${l.base}`;
  const replaced = new Set(links.filter((l) => l.consolidated).map(key));
  const seen = new Set<string>();
  return links.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return l.consolidated || !replaced.has(key(l));
  });
};

const PROPOSAL = /Vota[cç][aã]o\s+da\s+Proposta:\s*(\d+[A-Z]+(?:-\d+)?)/g;

/** The proposals a script puts to the vote, in order, each once (a proposal voted in parts comes up again). */
export const scriptProposals = (text: string): string[] => [...new Set([...text.matchAll(PROPOSAL)].map((m) => m[1]!))];

export type PdfText = (pdf: Uint8Array) => Promise<string>;

/**
 * A PDF's text, through Poppler's pdftotext (installed in the Docker image). The parliament's
 * scripts come out of an old iTextSharp with streams pdf.js refuses; Poppler reads them.
 */
export const popplerText: PdfText = (pdf) =>
  new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-enc", "UTF-8", "-q", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`pdftotext exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(pdf));
  });

export interface ScheduleResult {
  scripts: number;
  read: number;
  failed: number;
  proposals: number;
}

const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Reads the Budget committee's page for `year`, reads the scripts not read yet (each once; one
 * that failed is tried again next run), and rebuilds that year's schedule from the current ones.
 * Safe to run twice. When the page can't be read, or shows no scripts, the schedule is kept.
 */
export const syncBudgetSchedule = async (
  db: Db,
  {
    client,
    year,
    legislature,
    pdfText = popplerText,
    now = new Date(),
  }: { client: Pick<PoliteClient, "get" | "getBytes">; year: number; legislature: string; pdfText?: PdfText; now?: Date },
): Promise<ScheduleResult | { unavailable: string }> => {
  const pageUrl = schedulePageUrl(legislature, year);
  const page = await client.get(pageUrl);
  if (page.status !== "ok") return { unavailable: `${page.status}: ${page.reason}` };
  const scripts = currentScripts(parseSchedulePage(page.body, year, pageUrl));
  if (scripts.length === 0) return { scripts: 0, read: 0, failed: 0, proposals: 0 };

  const known = new Map(
    (await db.select({ url: budgetScheduleDocuments.url, readAt: budgetScheduleDocuments.readAt }).from(budgetScheduleDocuments).where(eq(budgetScheduleDocuments.year, year))).map(
      (d) => [d.url, d.readAt],
    ),
  );
  let read = 0;
  let failed = 0;
  for (const script of scripts) {
    if (known.get(script.url)) continue;
    const row = { url: script.url, year, title: script.title, votingDay: script.votingDay, venue: script.venue, triedAt: now };
    const save = (fields: { numbers?: string[]; readAt?: Date | null; error: string | null }) =>
      db
        .insert(budgetScheduleDocuments)
        .values({ ...row, ...fields })
        .onConflictDoUpdate({ target: budgetScheduleDocuments.url, set: { ...row, ...fields } });
    const fetched = await client.getBytes(script.url);
    // The parliament's links sometimes answer with a "Recurso Não Encontrado" page: not a PDF.
    if (fetched.status !== "ok" || fetched.bytes.length > MAX_PDF_BYTES || !String.fromCharCode(...fetched.bytes.slice(0, 5)).startsWith("%PDF")) {
      failed++;
      await save({ error: fetched.status === "ok" ? "not a PDF, or too large" : `${fetched.status}: ${fetched.reason}` });
      continue;
    }
    try {
      await save({ numbers: scriptProposals(await pdfText(fetched.bytes)), readAt: now, error: null });
      read++;
    } catch (error) {
      failed++;
      await save({ error: `pdftotext: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) });
    }
  }

  // The schedule: every current script's proposals, in page order within each day and venue.
  const urls = scripts.map((s) => s.url);
  const documents = new Map(
    (
      await db
        .select({ url: budgetScheduleDocuments.url, numbers: budgetScheduleDocuments.numbers })
        .from(budgetScheduleDocuments)
        .where(and(eq(budgetScheduleDocuments.year, year), sql`${budgetScheduleDocuments.url} in ${urls}`))
    ).map((d) => [d.url, d.numbers]),
  );
  const rows: (typeof budgetSchedule.$inferInsert)[] = [];
  const positions = new Map<string, number>();
  const placed = new Set<string>();
  for (const script of scripts) {
    for (const number of documents.get(script.url) ?? []) {
      const slot = `${script.votingDay}|${script.venue}`;
      if (placed.has(`${slot}|${number}`)) continue;
      placed.add(`${slot}|${number}`);
      const position = (positions.get(slot) ?? 0) + 1;
      positions.set(slot, position);
      rows.push({ year, number, votingDay: script.votingDay, venue: script.venue, position, documentUrl: script.url });
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(budgetSchedule).where(eq(budgetSchedule.year, year));
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(budgetSchedule).values(rows.slice(i, i + 1000));
  });
  return { scripts: scripts.length, read, failed, proposals: rows.length };
};

/** Days after the final overall vote during which the Budget is still followed closely (late results, news). */
const AFTER_FINAL_VOTE_DAYS = 30;
/** A bill with no final vote is followed while its last vote (or, before any, its last change) is this recent. */
const WITHOUT_FINAL_VOTE_DAYS = 60;

/**
 * The Budget being discussed now, if any: the legislature's latest Budget bill, from when it's
 * submitted until a month after its final overall vote. A bill rejected on the general vote (or
 * withdrawn) stops counting two months after its last vote. Outside that, the hourly Budget job
 * only does a daily check.
 */
export const budgetInDiscussion = async (db: Db, legislature: string, now = new Date()): Promise<number | null> => {
  const [bill] = await db
    .select({ year: budgetBills.year, votes: budgetBills.votes, updatedAt: budgetBills.updatedAt })
    .from(budgetBills)
    .where(eq(budgetBills.legislature, legislature))
    .orderBy(desc(budgetBills.year), desc(budgetBills.updatedAt))
    .limit(1);
  if (!bill) return null;
  const daysSince = (day: string | Date) => (now.getTime() - new Date(day).getTime()) / 86_400_000;
  const final = bill.votes.find((v) => /final\s+global/i.test(v.phase ?? ""));
  if (final?.date) return daysSince(final.date) <= AFTER_FINAL_VOTE_DAYS ? bill.year : null;
  const last = bill.votes.map((v) => v.date).filter((d): d is string => Boolean(d)).sort().at(-1);
  return daysSince(last ?? bill.updatedAt) <= WITHOUT_FINAL_VOTE_DAYS ? bill.year : null;
};
