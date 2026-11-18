import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { loadDatabaseConfig } from "../config.js";
import { PARTY_DEFINITIONS, SEATS_AS_OF } from "../matching/parties.js";
import { syncLocalOfficials } from "../places/localOfficials.js";
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

/** Everything the seed sets: safe to run on every deploy (migrate.ts does). */
export const seed = async (db: Db) => {
  await seedParties(db);
  console.log(`Seeded ${PARTY_DEFINITIONS.length} parties`);
  // Cheap, and keeps local officials in step with the election data after each deploy.
  console.log(JSON.stringify(await syncLocalOfficials(db)));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
  try {
    await seed(db);
  } finally {
    await pool.end();
  }
}
