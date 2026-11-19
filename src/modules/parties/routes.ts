import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { governmentMembers, initiatives, parties } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { curatedPartiesSql } from "../../government/parties.js";
import { DECIDING_VOTES } from "../../parliament/parse.js";
import { partyVote } from "../../parliament/partyVotes.js";
import { LEADERS_AS_OF, PARTY_LEADERS_LIST } from "../../parties/leaders.js";
import { initiativeColumns, initiativeSummarySchema, photoUrl, withPlain } from "../parliament/routes.js";
import { errorSchema } from "../shared.js";

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
  leader: z
    .object({
      name: z.string(),
      title: z.string().describe('e.g. "Secretário-Geral do Partido Socialista"'),
      deputyId: z.number().nullable().describe("Link to /deputados/:id when set"),
      governmentMemberId: z.string().nullable().describe("Link to the Government member page when set"),
      photoUrl: z.string().nullable(),
      asOf: z.string().describe("When our curated list was last checked"),
    })
    .nullable()
    .describe("Who leads the party. Curated by hand for parties with seats; null for the rest"),
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

        const memberIds = PARTY_LEADERS_LIST.flatMap((l) => l.governmentMemberId ?? []);
        const memberPhotos = new Map(
          (memberIds.length
            ? await db.select({ id: governmentMembers.id, photoUrl: governmentMembers.photoUrl }).from(governmentMembers).where(inArray(governmentMembers.id, memberIds))
            : []
          ).map((m) => [m.id, m.photoUrl]),
        );
        const leaders = new Map(
          PARTY_LEADERS_LIST.map(({ party, ...l }) => [
            party,
            {
              ...l,
              photoUrl: l.deputyId !== null ? photoUrl(l.deputyId) : l.governmentMemberId ? (memberPhotos.get(l.governmentMemberId) ?? null) : null,
              asOf: LEADERS_AS_OF,
            },
          ]),
        );

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
            leader: leaders.get(party.slug) ?? null,
          };
        });
        // Array.sort is stable, so ties stay in name order.
        return items.sort(SORTS[request.query.sort]);
      },
    );

    const positionSchema = z.enum(["favor", "against", "abstention"]);
    const countsSchema = z.object({
      total: z.number(),
      favor: z.number(),
      against: z.number(),
      abstention: z.number(),
      absent: z.number(),
      unknown: z.number(),
      split: z.number().describe("Votes where part of the group voted differently"),
    });

    app.get(
      "/parties/:slug/votes",
      {
        schema: {
          tags: ["parties"],
          summary: "How a party voted in parliament, newest first, with totals and how often it voted with each other party",
          description:
            "The parliament records votes by parliamentary group, so this is the group's position. When a group split, " +
            "`position` is the one the group as a whole took and `split` is true.",
          params: z.object({ slug: z.string().max(50) }),
          querystring: z.object({
            phase: z
              .enum(["deciding", "all"])
              .default("deciding")
              .describe("deciding: votes that decide an initiative (generalidade, final global...); all: every vote"),
            position: z.enum(["favor", "against", "abstention", "absent", "split"]).optional().describe("Only votes where the party did this"),
            page: z.coerce.number().int().min(1).max(1000).default(1),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          }),
          response: {
            200: z.object({
              party: z.object({ slug: z.string(), acronym: z.string(), name: z.string() }),
              legislature: z.string().nullable().describe("Votes are from this legislature (the one we hold)"),
              summary: countsSchema.describe("Over every vote of the chosen phase, before the position filter"),
              agreement: z
                .array(
                  z.object({
                    party: z.object({ slug: z.string(), acronym: z.string() }),
                    compared: z.number().describe("Votes where both took a position, unanimous ones left out"),
                    same: z.number(),
                    pct: z.number().nullable().describe("same / compared, as a percentage"),
                  }),
                )
                .describe("Other parties, most aligned first. Unanimous votes are left out, or everyone would look aligned"),
              items: z.array(
                z.object({
                  initiative: initiativeSummarySchema,
                  vote: z.object({ id: z.string(), date: z.string(), phase: z.string(), result: z.string(), unanimous: z.boolean() }),
                  position: positionSchema.nullable(),
                  split: z.boolean(),
                  basis: z.enum(["group", "unanimous", "absent", "unknown"]),
                }),
              ),
              total: z.number().describe("Items matching the filters"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { slug } = request.params;
        const { phase, position, page, limit } = request.query;
        const [party] = await db.select({ slug: parties.slug, acronym: parties.acronym, name: parties.name }).from(parties).where(eq(parties.slug, slug));
        if (!party) throw notFound("Party");

        const rows = await db
          .select({ id: initiatives.id, legislature: initiatives.legislature, votes: initiatives.votes })
          .from(initiatives)
          .where(gt(sql`jsonb_array_length(${initiatives.votes})`, 0));
        const votes = rows
          .flatMap((r) => r.votes.filter((v) => phase === "all" || DECIDING_VOTES.has(v.phase)).map((v) => ({ initiative: r.id, legislature: r.legislature, v })))
          // A total order, so page N is the same page on every request.
          .sort((a, b) => b.v.date.localeCompare(a.v.date) || String(b.v.id).localeCompare(String(a.v.id), "en", { numeric: true }) || b.initiative - a.initiative);

        const summary = { total: votes.length, favor: 0, against: 0, abstention: 0, absent: 0, unknown: 0, split: 0 };
        const others = (await db.select({ slug: parties.slug, acronym: parties.acronym }).from(parties).where(gt(parties.assemblySeats, 0)).orderBy(desc(parties.assemblySeats)))
          .filter((p) => p.slug !== slug);
        const agreement = new Map(others.map((p) => [p.slug, { party: p, compared: 0, same: 0 }]));

        const mine = votes.map((item) => {
          const result = partyVote(item.v, slug);
          if (result.position) summary[result.position]++;
          else summary[result.basis === "absent" ? "absent" : "unknown"]++;
          if (result.split) summary.split++;
          if (result.position && result.basis === "group") {
            for (const other of agreement.values()) {
              const theirs = partyVote(item.v, other.party.slug);
              if (theirs.position && theirs.basis === "group") {
                other.compared++;
                if (theirs.position === result.position) other.same++;
              }
            }
          }
          return { ...item, result };
        });

        const matching = mine.filter(({ result }) =>
          !position ? true : position === "split" ? result.split : position === "absent" ? result.basis === "absent" : result.position === position,
        );
        const pageItems = matching.slice((page - 1) * limit, page * limit);
        const ids = [...new Set(pageItems.map((i) => i.initiative))];
        const summaries = new Map(
          (ids.length ? await db.select(initiativeColumns).from(initiatives).where(and(inArray(initiatives.id, ids))) : []).map((r) => [r.id, withPlain(r)]),
        );

        return {
          party,
          legislature: votes[0]?.legislature ?? null,
          summary,
          agreement: [...agreement.values()]
            .map((a) => ({ ...a, pct: a.compared ? Math.round((a.same / a.compared) * 1000) / 10 : null }))
            .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1)),
          items: pageItems.map(({ initiative, v, result }) => ({
            initiative: summaries.get(initiative)!,
            vote: { id: v.id, date: v.date, phase: v.phase, result: v.result, unanimous: v.unanimous },
            position: result.position,
            split: result.split,
            basis: result.basis,
          })),
          total: matching.length,
        };
      },
    );
  };
