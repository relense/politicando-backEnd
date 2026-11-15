import { getTableColumns, inArray, notInArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import {
  deputies,
  initiativeDeputies,
  initiativeParties,
  initiatives,
  parties,
} from "../db/schema.js";
import { partySlugForGroup } from "./groups.js";
import type { OpenDataLoader } from "./openData.js";
import { parseDeputies, parseInitiative, type ParsedDeputy, type ParsedInitiative } from "./parse.js";
import { SEAT_ASSIGNMENTS } from "./seatAssignments.js";
import { SEATS } from "./seatMap.js";

export interface SyncStats {
  deputies: number;
  activeDeputies: number;
  initiatives: number;
  seatsAssigned: number;
  warnings: string[];
}

const CHUNK = 500;

/** `set` for an upsert that overwrites every column except the key. */
const overwriteAll = (table: PgTable, except = "id") =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => key !== except)
      .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)]),
  );
const chunks = <T>(items: T[]) =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/** Applies SEAT_ASSIGNMENTS, dropping any entry that contradicts the official map. */
export const resolveSeats = (
  parsed: ParsedDeputy[],
  assignments: Readonly<Record<number, number>>,
  warnings: string[],
) => {
  const seatGroup = new Map(SEATS.map(([seat, group]) => [seat, group]));
  const byId = new Map(parsed.map((deputy) => [deputy.id, deputy]));
  const taken = new Map<number, number>();
  const seats = new Map<number, number>();
  for (const [key, seat] of Object.entries(assignments)) {
    const deputy = byId.get(Number(key));
    if (!deputy?.active) {
      warnings.push(`Seat ${seat}: deputy ${key} is not sitting`);
    } else if (seatGroup.get(seat) !== deputy.parliamentaryGroup) {
      warnings.push(`Seat ${seat} belongs to ${seatGroup.get(seat) ?? "no group"}, not ${deputy.name} (${deputy.parliamentaryGroup})`);
    } else if (taken.has(seat)) {
      warnings.push(`Seat ${seat} is given to both ${taken.get(seat)} and ${deputy.id}`);
    } else {
      taken.set(seat, deputy.id);
      seats.set(deputy.id, seat);
    }
  }
  return seats;
};

/** Checks that the seat map still fits the chamber: one seat per sitting deputy, per group. */
const checkSeatMap = (parsed: ParsedDeputy[], warnings: string[]) => {
  const count = (groups: (string | null)[]) =>
    groups.reduce((map, group) => map.set(group ?? "none", (map.get(group ?? "none") ?? 0) + 1), new Map<string, number>());
  const seated = count(parsed.filter((d) => d.active).map((d) => d.parliamentaryGroup));
  const mapped = count(SEATS.map(([, group]) => group));
  for (const group of new Set([...seated.keys(), ...mapped.keys()])) {
    if (seated.get(group) !== mapped.get(group)) {
      warnings.push(`Seat map has ${mapped.get(group) ?? 0} seats for ${group}, but ${seated.get(group) ?? 0} deputies sit for it`);
    }
  }
};

/**
 * Replaces this legislature's deputies and initiatives with the parliament's current data.
 * Safe to re-run. Deputies missing from the data are kept but marked as not sitting.
 */
export const syncParliament = async (
  db: Db,
  load: OpenDataLoader,
  assignments: Readonly<Record<number, number>> = SEAT_ASSIGNMENTS,
): Promise<SyncStats> => {
  const parsedDeputies = parseDeputies(await load.json("deputies"), await load.json("biographies"));
  if (parsedDeputies.filter((d) => d.active).length < 200) {
    // A half-empty file would wipe the chamber; better to fail and keep yesterday's data.
    throw new Error(`Only ${parsedDeputies.length} deputies in the parliament data, refusing to sync`);
  }
  // Over 100 MB: read one initiative at a time and keep only the parsed fields.
  const parsedInitiatives: ParsedInitiative[] = [];
  for await (const item of load.items("initiatives")) parsedInitiatives.push(...parseInitiative(item));

  const warnings: string[] = [];
  checkSeatMap(parsedDeputies, warnings);
  const seats = resolveSeats(parsedDeputies, assignments, warnings);

  const partyRows = await db.select({ id: parties.id, slug: parties.slug }).from(parties);
  const partyBySlug = new Map(partyRows.map((p) => [p.slug, p.id]));
  for (const deputy of parsedDeputies) {
    if (deputy.active && deputy.parliamentaryGroup && !deputy.partySlug) {
      warnings.push(`Unknown parliamentary group ${deputy.parliamentaryGroup} (${deputy.name}): add it to src/parliament/groups.ts`);
    }
  }

  await db.transaction(async (tx) => {
    const now = new Date();
    for (const batch of chunks(parsedDeputies)) {
      await tx
        .insert(deputies)
        .values(
          batch.map(({ partySlug, ...deputy }) => ({
            ...deputy,
            partyId: partySlug ? (partyBySlug.get(partySlug) ?? null) : null,
            seat: seats.get(deputy.id) ?? null,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: deputies.id,
          set: overwriteAll(deputies),
        });
    }
    const ids = parsedDeputies.map((d) => d.id);
    await tx.update(deputies).set({ active: false, seat: null }).where(notInArray(deputies.id, ids));

    const knownDeputies = new Set(ids);
    for (const batch of chunks(parsedInitiatives)) {
      await tx
        .insert(initiatives)
        // Authors go in their own tables below.
        .values(batch.map(({ authorGroups, authorDeputyIds, ...initiative }) => ({ ...initiative, updatedAt: now })))
        .onConflictDoUpdate({
          target: initiatives.id,
          set: overwriteAll(initiatives),
        });

      const batchIds = batch.map((i) => i.id);
      await tx.delete(initiativeParties).where(inArray(initiativeParties.initiativeId, batchIds));
      await tx.delete(initiativeDeputies).where(inArray(initiativeDeputies.initiativeId, batchIds));
      const partyLinks = batch.flatMap((i) =>
        i.authorGroups.flatMap((group) => {
          const slug = partySlugForGroup(group);
          const partyId = slug ? partyBySlug.get(slug) : undefined;
          return partyId ? [{ initiativeId: i.id, partyId }] : [];
        }),
      );
      const deputyLinks = batch.flatMap((i) =>
        i.authorDeputyIds.filter((id) => knownDeputies.has(id)).map((deputyId) => ({ initiativeId: i.id, deputyId })),
      );
      if (partyLinks.length) await tx.insert(initiativeParties).values(partyLinks).onConflictDoNothing();
      if (deputyLinks.length) await tx.insert(initiativeDeputies).values(deputyLinks).onConflictDoNothing();
    }
  });

  return {
    deputies: parsedDeputies.length,
    activeDeputies: parsedDeputies.filter((d) => d.active).length,
    initiatives: parsedInitiatives.length,
    seatsAssigned: seats.size,
    warnings,
  };
};
