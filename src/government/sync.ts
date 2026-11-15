import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { overwriteAll } from "../db/upsert.js";
import { deputies, governmentMembers, governmentPositions, governments } from "../db/schema.js";
import type { FetchResult } from "../ingestion/politeClient.js";
import {
  PORTAL_ORIGIN,
  PORTAL_SITEMAP,
  nextData,
  parsePage,
  parseSitemap,
  type PortalGovernment,
  type PortalMember,
  type PortalPosition,
} from "./portal.js";

/** Below this many sitting ministers the portal is probably mid-change or broken: don't sync. */
const MIN_CURRENT_MINISTERS = 10;

export interface GovernmentSource {
  get(url: string): Promise<FetchResult>;
}

/** Spelling-tolerant name key: no accents, case, hyphens, "e", or doubled letters. */
export const nameKey = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && word !== "e")
    .map((word) => word.replace(/(.)\1/g, "$1"))
    .join(" ");

type Period = { from: string; to: string | null };
const DAY = 24 * 60 * 60 * 1000;
/** A few days' slack: a deputy's seat is suspended a day or two after they take office. */
const overlaps = (a: Period, b: Period, slackDays = 3) =>
  Date.parse(a.from) + slackDays * DAY < Date.parse(b.to ?? "9999-12-31") &&
  Date.parse(b.from) + slackDays * DAY < Date.parse(a.to ?? "9999-12-31");

/**
 * Finds a member's deputy record by name. Seats in parliament and posts in the Government
 * can't be held at once, so a deputy who sat while the member was in office is someone
 * else with the same name. The name must match the parliamentary name, or every word of it
 * must appear in the full civil name with the same first and last word.
 */
export const matchDeputy = (
  member: { name: string; posts: Period[] },
  candidates: { id: number; name: string; fullName: string; sittingPeriods: Period[] }[],
) => {
  const wanted = nameKey(member.name).split(" ");
  const within = (full: string[]) => {
    if (full[0] !== wanted[0] || full.at(-1) !== wanted.at(-1)) return false;
    let i = 0;
    for (const word of full) if (word === wanted[i]) i++;
    return i === wanted.length;
  };
  const found = candidates.filter(
    (d) =>
      (nameKey(d.name) === wanted.join(" ") || within(nameKey(d.fullName).split(" "))) &&
      !d.sittingPeriods.some((sat) => member.posts.some((post) => overlaps(sat, post))),
  );
  return found.length === 1 ? found[0]!.id : null;
};

export const syncGovernment = async (db: Db, source: GovernmentSource) => {
  const warnings: string[] = [];
  const sitemap = await source.get(PORTAL_SITEMAP);
  if (sitemap.status !== "ok") throw new Error(`Could not read the portal's sitemap: ${sitemap.reason}`);
  const found = parseSitemap(sitemap.body);
  if (!found) throw new Error("The portal's sitemap lists no government pages");

  let government: PortalGovernment | null = null;
  const members = new Map<string, { member: PortalMember; current: boolean }>();
  const positions: PortalPosition[] = [];
  let failedPages = 0;

  for (const page of found.pages) {
    const response = await source.get(`${PORTAL_ORIGIN}${page.path}`);
    const data = response.status === "ok" ? nextData(response.body) : null;
    const parsed = data ? parsePage(data, page) : null;
    if (!parsed) {
      failedPages += 1;
      warnings.push(`Could not read ${page.path}: ${response.status === "ok" ? "unexpected page" : response.reason}`);
      continue;
    }
    government ??= parsed.government;
    positions.push(...parsed.positions);
    for (const member of parsed.members) {
      const current = parsed.positions.some((p) => p.memberId === member.id && p.endDate === null);
      const known = members.get(member.id);
      // The same person can appear on several pages; keep the biography from their current post.
      if (!known || (current && !known.current)) members.set(member.id, { member, current });
    }
  }

  const sitting = positions.filter((p) => p.endDate === null);
  const primeMinister = sitting.filter((p) => p.kind === "prime_minister");
  const ministers = sitting.filter((p) => p.kind === "minister");
  if (!government || primeMinister.length !== 1 || ministers.length < MIN_CURRENT_MINISTERS) {
    throw new Error(
      `The portal lists ${primeMinister.length} prime ministers and ${ministers.length} ministers in office; refusing to sync`,
    );
  }

  const candidates = await db
    .select({ id: deputies.id, name: deputies.name, fullName: deputies.fullName, sittingPeriods: deputies.sittingPeriods })
    .from(deputies);
  const now = new Date();
  const memberRows = [...members.values()].map(({ member }) => ({
    ...member,
    deputyId: matchDeputy(
      {
        name: member.name,
        posts: positions
          .filter((p) => p.memberId === member.id && p.startDate)
          .map((p) => ({ from: p.startDate!, to: p.endDate })),
      },
      candidates,
    ),
    updatedAt: now,
  }));
  const positionRows = positions.map((position) => ({ ...position, government: found.code, updatedAt: now }));

  await db.transaction(async (tx) => {
    await tx
      .insert(governments)
      .values({ code: found.code, name: government.name, startDate: government.startDate, updatedAt: now })
      .onConflictDoUpdate({ target: governments.code, set: overwriteAll(governments, "code") });
    await tx
      .insert(governmentMembers)
      .values(memberRows)
      .onConflictDoUpdate({ target: governmentMembers.id, set: overwriteAll(governmentMembers) });
    await tx
      .insert(governmentPositions)
      .values(positionRows)
      .onConflictDoUpdate({ target: governmentPositions.id, set: overwriteAll(governmentPositions) });
    // Posts the portal no longer lists were removed there. Only trust that when every page was read.
    if (failedPages === 0) {
      await tx.delete(governmentPositions).where(
        and(
          eq(governmentPositions.government, found.code),
          notInArray(
            governmentPositions.id,
            positionRows.map((p) => p.id),
          ),
        ),
      );
    }
  });

  return {
    government: found.code,
    pages: found.pages.length,
    members: memberRows.length,
    positions: positionRows.length,
    inOffice: sitting.length,
    deputiesMatched: memberRows.filter((m) => m.deputyId !== null).length,
    warnings,
  };
};
