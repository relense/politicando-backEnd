import { asc } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { parties } from "../../db/schema.js";

const partySchema = z.object({
  slug: z.string(),
  acronym: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  assemblySeats: z.number(),
  seatsAsOf: z.string().nullable(),
});

export const partyRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/parties",
      { schema: { tags: ["parties"], response: { 200: z.array(partySchema) } } },
      () =>
        db
          .select({
            slug: parties.slug,
            acronym: parties.acronym,
            name: parties.name,
            website: parties.website,
            assemblySeats: parties.assemblySeats,
            seatsAsOf: parties.seatsAsOf,
          })
          .from(parties)
          .orderBy(asc(parties.name)),
    );
  };
