import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pastInitiatives } from "../db/schema.js";
import { partySlugForGroup } from "./groups.js";
import { LEGISLATURES } from "./legislatures.js";
import type { OpenDataLoader } from "./openData.js";
import { parseInitiative, type ParsedInitiative } from "./parse.js";

/** Groups of earlier legislatures that are parties we know under another name. */
const HISTORIC_GROUPS: Record<string, string> = {
  CDS: "cds-pp",
  "CDS/PP": "cds-pp",
  PPD: "psd",
  "PPD/PSD": "psd",
  PPM: "ppm",
  MPT: "mpt",
  "Os Verdes": "pev",
  "B.E.": "be",
};

export const pastPartySlug = (group: string) => partySlugForGroup(group) ?? HISTORIC_GROUPS[group] ?? null;

/** Every legislature before the current one. The Constituent Assembly's open data folder is empty. */
export const PAST_LEGISLATURES = LEGISLATURES.slice(0, -1).map((l) => l.id).filter((id) => id !== "Constituinte");

/** A closed legislature's initiative as stored: what was still pending lapsed when it ended. */
export const toPastInitiative = (i: ParsedInitiative): typeof pastInitiatives.$inferInsert => ({
  id: i.id,
  legislature: i.legislature,
  type: i.type,
  number: i.number,
  title: i.title,
  status: i.status === "in_progress" ? "lapsed" : i.status,
  submittedAt: i.submittedAt,
  publishedAt: i.publishedAt,
  authorGroups: i.authorGroups,
  partySlugs: [...new Set(i.authorGroups.map(pastPartySlug).filter((s): s is string => s !== null))],
  otherAuthor: i.otherAuthor,
  textUrl: i.textUrl,
});

/** Replaces one past legislature's initiatives with the parliament's file. */
export const importPastLegislature = async (db: Db, load: OpenDataLoader, legislature: string) => {
  if (!PAST_LEGISLATURES.includes(legislature)) throw new Error(`${legislature} is not a past legislature`);
  const rows: (typeof pastInitiatives.$inferInsert)[] = [];
  for await (const item of load.items("initiatives")) {
    for (const parsed of parseInitiative(item)) rows.push({ ...toPastInitiative(parsed), legislature });
  }
  if (rows.length === 0) throw new Error(`No initiatives in the ${legislature} file`);
  const unknownGroups = new Set(rows.flatMap((r) => r.authorGroups.filter((g) => !pastPartySlug(g))));
  await db.transaction(async (tx) => {
    await tx.delete(pastInitiatives).where(eq(pastInitiatives.legislature, legislature));
    for (let i = 0; i < rows.length; i += 1_000) {
      await tx.insert(pastInitiatives).values(rows.slice(i, i + 1_000)).onConflictDoNothing();
    }
  });
  return { legislature, initiatives: rows.length, groupsWithoutParty: [...unknownGroups].sort() };
};
