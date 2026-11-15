import { asc, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { parties } from "../../db/schema.js";
import { curatedPartiesSql } from "../../government/parties.js";

const lastElectionSchema = z
  .object({
    id: z.string().describe('e.g. "legislativas-2025"; see GET /elections/:id'),
    date: z.string(),
    votes: z.number().describe("Votes of every list the party ran in, whole country"),
    validPct: z.number().nullable().describe("Share of valid votes, summed the same way"),
    mandates: z.number().describe("Seats those lists won, shared with coalition partners"),
    lists: z.array(z.string()).describe('Ballot lists it ran in, e.g. ["PPD/PSD.CDS-PP"]'),
    coalition: z.boolean().describe("True if any of those lists was a coalition: the votes are shared with partners"),
  })
  .nullable()
  .describe("Latest legislative election with results imported; null if the party didn't run");

const partySchema = z.object({
  slug: z.string(),
  acronym: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  assemblySeats: z.number(),
  seatsAsOf: z.string().nullable(),
  governmentMembers: z.number().describe("Members of the Government in office from this party (deputy records, plus our curated list)"),
  lastElection: lastElectionSchema,
});

type Party = z.infer<typeof partySchema>;

const SORTS: Record<string, (a: Party, b: Party) => number> = {
  name: () => 0, // Already by name.
  seats: (a, b) => b.assemblySeats - a.assemblySeats,
  votes: (a, b) => (b.lastElection?.votes ?? -1) - (a.lastElection?.votes ?? -1),
};

export const partyRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/parties",
      {
        schema: {
          tags: ["parties"],
          summary: "All parties, with seats, votes in the latest legislativas and Government members",
          querystring: z.object({
            sort: z.enum(["name", "seats", "votes"]).default("name").describe("seats and votes: most first, then by name"),
          }),
          response: { 200: z.array(partySchema) },
        },
      },
      async (request) => {
        const rows = await db
          .select({
            id: parties.id,
            slug: parties.slug,
            acronym: parties.acronym,
            name: parties.name,
            website: parties.website,
            assemblySeats: parties.assemblySeats,
            seatsAsOf: parties.seatsAsOf,
          })
          .from(parties)
          .orderBy(asc(parties.name));

        // Deputies' parties first, then the curated list for members who aren't deputies.
        const government = await db.execute<{ party_id: number; members: number }>(sql`
          select coalesce(d.party_id, cp.id) as party_id, count(distinct m.id)::int as members
          from government_members m
          join government_positions p on p.member_id = m.id and p.end_date is null
          left join deputies d on d.id = m.deputy_id
          left join ${curatedPartiesSql()} on d.party_id is null and curated.name = m.name
          left join parties cp on cp.slug = curated.slug
          where coalesce(d.party_id, cp.id) is not null
          group by 1`);
        const members = new Map(government.rows.map((r) => [r.party_id, r.members]));

        // The whole-country total: with votes abroad if the site has it.
        const votes = await db.execute<{
          election_id: string;
          date: string;
          slug: string;
          votes: number;
          valid_pct: number | null;
          mandates: number;
          lists: string[];
          coalition: boolean;
        }>(sql`
          with latest as (
            select id, date from elections
            where type = 'legislativas' and imported_at is not null
            order by date desc limit 1
          ), top as (
            select t.place_key from election_turnout t, latest
            where t.election_id = latest.id and t.organ = 'AR' and t.place_key in ('GLOBAL-990000', 'LOCAL-500000')
            order by t.place_key limit 1
          )
          select latest.id as election_id, latest.date::text as date, slug,
                 sum(r.votes)::int as votes, round(sum(r.valid_pct)::numeric, 2)::float as valid_pct,
                 coalesce(sum(r.mandates), 0)::int as mandates,
                 array_agg(r.list order by r.votes desc) as lists,
                 bool_or(l.coalition or cardinality(l.party_slugs) > 1) as coalition
          from latest
          join election_results r on r.election_id = latest.id and r.organ = 'AR' and r.place_key = (select place_key from top)
          join election_lists l on l.election_id = r.election_id and l.list = r.list
          cross join lateral unnest(l.party_slugs) as slug
          group by latest.id, latest.date, slug`);
        const bySlug = new Map(votes.rows.map((r) => [r.slug, r]));

        const items: Party[] = rows.map(({ id, ...party }) => {
          const result = bySlug.get(party.slug);
          return {
            ...party,
            governmentMembers: members.get(id) ?? 0,
            lastElection: result
              ? {
                  id: result.election_id,
                  date: result.date,
                  votes: result.votes,
                  validPct: result.valid_pct,
                  mandates: result.mandates,
                  lists: result.lists,
                  coalition: result.coalition,
                }
              : null,
          };
        });
        // Array.sort is stable, so ties stay in name order.
        return items.sort(SORTS[request.query.sort]);
      },
    );
  };
