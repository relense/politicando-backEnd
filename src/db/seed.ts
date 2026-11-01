import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { PARTY_DEFINITIONS, SEATS_AS_OF } from "../matching/parties.js";
import { createDb, type Db } from "./client.js";
import { parties } from "./schema.js";

/** Safe to re-run: updates parties by slug, so existing IDs never change. */
export const seedParties = async (db: Db) => {
  await db
    .insert(parties)
    .values(
      PARTY_DEFINITIONS.map((party) => ({
        slug: party.slug,
        acronym: party.acronym,
        name: party.name,
        website: party.website,
        assemblySeats: party.assemblySeats,
        seatsAsOf: SEATS_AS_OF,
      })),
    )
    .onConflictDoUpdate({
      target: parties.slug,
      set: {
        acronym: sql`excluded.acronym`,
        name: sql`excluded.name`,
        website: sql`excluded.website`,
        assemblySeats: sql`excluded.assembly_seats`,
        seatsAsOf: sql`excluded.seats_as_of`,
      },
    });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
  try {
    await seedParties(db);
    console.log(`Seeded ${PARTY_DEFINITIONS.length} parties`);
  } finally {
    await pool.end();
  }
}
