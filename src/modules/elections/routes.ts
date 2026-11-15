import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { electionCandidates, electionLists, electionResults, electionTurnout, elections, places } from "../../db/schema.js";
import { properName } from "../../elections/candidates.js";
import { dhondt } from "../../elections/dhondt.js";
import { UPCOMING_ELECTIONS } from "../../elections/upcoming.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

const levelSchema = z.enum(["global", "national", "foreign", "district", "municipality", "parish"]);
const placeSchema = z.object({
  key: z.string(),
  name: z.string(),
  level: levelSchema,
  dicofre: z.string().nullable().describe("Official code; null abroad, and for parishes restored in 2025 until codes are loaded"),
});

/** "LOCAL-010100"; places first seen in autárquicas 2025 are "AUTARQUICAS2025-123". */
const placeKeySchema = z.string().regex(/^(?:(?:LOCAL|FOREIGN|GLOBAL)-\d{6}|[A-Z]+\d{4}-\d+)$/);

const listResultSchema = z.object({
  list: z.string().describe('As on the ballot: "PPD/PSD.CDS-PP", "B.E.", or a candidate\'s name'),
  name: z
    .string()
    .nullable()
    .describe("Full name of the party, coalition or citizens' group; in autárquicas, the list's local name"),
  partySlugs: z.array(z.string()).describe("Our parties in it, for colours and links"),
  coalition: z.boolean(),
  citizens: z.boolean().describe("Citizens' group (independents), autárquicas only"),
  votes: z.number(),
  pct: z.number().describe("Share of all votes cast, blank and null included"),
  validPct: z.number().nullable().describe("Share of valid votes (the usual headline figure)"),
  mandates: z.number().nullable().describe("Seats won here"),
  presidents: z.number().nullable().describe("Autárquicas: câmaras or juntas won in this area"),
});

const turnoutSchema = z.object({
  registered: z.number().nullable(),
  voters: z.number(),
  turnoutPct: z.number().nullable(),
  blank: z.number(),
  null: z.number(),
  totalMandates: z.number().nullable(),
});

const electionSummarySchema = z.object({
  id: z.string(),
  type: z.enum(["legislativas", "autarquicas", "europeias", "presidenciais"]),
  name: z.string(),
  date: z.string(),
  organs: z.array(z.string()).describe("AR, PE, PR; autárquicas: CM (câmara), AM (assembleia municipal), AF (freguesia)"),
  sourceUrl: z.string(),
});

const placeResultSchema = z.object({
  election: electionSummarySchema,
  organ: z.string(),
  place: placeSchema,
  breadcrumb: z.array(placeSchema).describe("From the top down to the parent"),
  turnout: turnoutSchema,
  lists: z.array(listResultSchema).describe("Most votes first"),
  children: z
    .array(
      placeSchema.extend({
        turnoutPct: z.number().nullable(),
        winner: listResultSchema.pick({ list: true, partySlugs: true, votes: true, validPct: true }).nullable(),
      }),
    )
    .describe("Places inside this one, with who came first, for maps and drill-down"),
});

const TOP_PLACES = ["GLOBAL-990000", "LOCAL-500000"];

export const electionRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const findElection = async (id: string) => {
      const [election] = await db
        .select({
          id: elections.id,
          type: elections.type,
          name: elections.name,
          date: elections.date,
          organs: elections.organs,
          sourceUrl: elections.sourceUrl,
        })
        .from(elections)
        .where(eq(elections.id, id));
      if (!election) throw notFound("Election");
      return election;
    };

    const listRows = (electionId: string, organ: string, key: string) =>
      db
        .select({
          list: electionResults.list,
          name: sql<string | null>`coalesce(${electionResults.label}, ${electionLists.name})`,
          partySlugs: sql<string[]>`coalesce(${electionLists.partySlugs}, '{}')`,
          coalition: sql<boolean>`coalesce(${electionLists.coalition}, false)`,
          citizens: sql<boolean>`coalesce(${electionLists.citizens}, false)`,
          votes: electionResults.votes,
          pct: electionResults.pct,
          validPct: electionResults.validPct,
          mandates: electionResults.mandates,
          presidents: electionResults.presidents,
        })
        .from(electionResults)
        .leftJoin(
          electionLists,
          and(eq(electionLists.electionId, electionResults.electionId), eq(electionLists.list, electionResults.list)),
        )
        .where(
          and(eq(electionResults.electionId, electionId), eq(electionResults.organ, organ), eq(electionResults.placeKey, key)),
        )
        .orderBy(desc(electionResults.votes), asc(electionResults.list));

    const turnoutOf = async (electionId: string, organ: string, key: string) => {
      const [row] = await db
        .select({
          registered: electionTurnout.registered,
          voters: electionTurnout.voters,
          turnoutPct: electionTurnout.turnoutPct,
          blank: electionTurnout.blank,
          null: electionTurnout.null,
          totalMandates: electionTurnout.totalMandates,
        })
        .from(electionTurnout)
        .where(and(eq(electionTurnout.electionId, electionId), eq(electionTurnout.organ, organ), eq(electionTurnout.placeKey, key)));
      return row ?? null;
    };

    const topPlace = async (electionId: string, organ: string) => {
      for (const key of TOP_PLACES) if (await turnoutOf(electionId, organ, key)) return key;
      return null;
    };

    const placeResult = async (electionId: string, organWanted: string | undefined, key: string | null) => {
      const election = await findElection(electionId);
      const organ = organWanted ?? election.organs[0]!;
      if (!election.organs.includes(organ)) throw new ApiError(400, "bad_request", `This election has no body ${organ}`);
      const placeKey = key ?? (await topPlace(election.id, organ));
      if (!placeKey) throw notFound("Results");
      const turnout = await turnoutOf(election.id, organ, placeKey);
      if (!turnout) throw notFound("Results for this place");
      const [place] = await db
        .select({ key: places.key, name: places.name, level: places.level, dicofre: places.dicofre, parentKey: places.parentKey })
        .from(places)
        .where(eq(places.key, placeKey));
      if (!place) throw notFound("Place");

      const breadcrumb: z.infer<typeof placeSchema>[] = [];
      let parentKey = place.parentKey;
      while (parentKey && breadcrumb.length < 6) {
        const [parent] = await db
          .select({ key: places.key, name: places.name, level: places.level, dicofre: places.dicofre, parentKey: places.parentKey })
          .from(places)
          .where(eq(places.key, parentKey));
        if (!parent) break;
        const { parentKey: next, ...rest } = parent;
        breadcrumb.unshift(rest);
        parentKey = next;
      }

      const children = await db.execute<{
        key: string;
        name: string;
        level: z.infer<typeof levelSchema>;
        dicofre: string | null;
        turnout_pct: number | null;
        list: string | null;
        party_slugs: string[] | null;
        votes: number | null;
        valid_pct: number | null;
      }>(sql`
        select p.key, p.name, p.level, p.dicofre, t.turnout_pct, w.list, w.party_slugs, w.votes, w.valid_pct
        from places p
        join election_turnout t on t.place_key = p.key and t.election_id = ${election.id} and t.organ = ${organ}
        left join lateral (
          select r.list, coalesce(l.party_slugs, '{}') as party_slugs, r.votes, r.valid_pct
          from election_results r
          left join election_lists l on l.election_id = r.election_id and l.list = r.list
          where r.election_id = ${election.id} and r.organ = ${organ} and r.place_key = p.key
          order by r.votes desc limit 1
        ) w on true
        where p.parent_key = ${placeKey}`);

      const { parentKey: _parent, ...placeOut } = place;
      return {
        election,
        organ,
        place: placeOut,
        breadcrumb,
        turnout,
        lists: await listRows(election.id, organ, placeKey),
        children: [...children.rows].sort((a, b) => a.name.localeCompare(b.name, "pt")).map((c) => ({
          key: c.key,
          name: c.name,
          level: c.level,
          dicofre: c.dicofre,
          turnoutPct: c.turnout_pct,
          winner: c.list ? { list: c.list, partySlugs: c.party_slugs ?? [], votes: c.votes ?? 0, validPct: c.valid_pct } : null,
        })),
      };
    };

    app.get(
      "/elections",
      {
        schema: {
          tags: ["elections"],
          summary: "Elections since 2011, newest first, with who won, and the next ones",
          querystring: z.object({ type: electionSummarySchema.shape.type.optional() }),
          response: {
            200: z.object({
              items: z.array(
                electionSummarySchema.extend({
                  turnout: turnoutSchema.nullable(),
                  winner: listResultSchema.nullable().describe("Most votes in the main body, whole country"),
                  imported: z.boolean().describe("False while results are still being imported"),
                  deepestLevel: z
                    .enum(["country", "district", "municipality", "parish"])
                    .nullable()
                    .describe("The most detailed level with results: show the map and drill-down only to here"),
                  round: z.number().nullable().describe("Presidenciais: 1st or 2nd round. Null for other elections"),
                }),
              ),
              upcoming: z
                .array(
                  z.object({
                    type: z.enum(["legislativas", "autarquicas", "europeias", "presidenciais", "regionais"]),
                    name: z.string(),
                    year: z.number(),
                    date: z.string().nullable().describe("Official date, once set by decree"),
                    confirmed: z.boolean().describe("True once the date is official"),
                    imported: z.literal(false),
                    window: z.string().describe("When the law says it must happen, in Portuguese"),
                    basis: z.string().describe("The law that says so"),
                  }),
                )
                .describe("The next election of each kind, soonest first. Filtered by type when one is given"),
            }),
          },
        },
      },
      async (request) => {
        const rows = await db
          .select({
            id: elections.id,
            type: elections.type,
            name: elections.name,
            date: elections.date,
            organs: elections.organs,
            sourceUrl: elections.sourceUrl,
            importedAt: elections.importedAt,
          })
          .from(elections)
          .where(request.query.type ? eq(elections.type, request.query.type) : undefined)
          .orderBy(desc(elections.date));
        const levels = await db.execute<{ election_id: string; levels: string[] }>(sql`
          select t.election_id, array_agg(distinct p.level) as levels
          from election_turnout t join places p on p.key = t.place_key
          group by t.election_id`);
        const DEPTH = ["parish", "municipality", "district"] as const;
        const deepest = new Map<string, (typeof DEPTH)[number] | "country" | null>(
          levels.rows.map((r) => [r.election_id, DEPTH.find((level) => r.levels.includes(level)) ?? (r.levels.length ? "country" : null)]),
        );
        const items = await Promise.all(
          rows.map(async ({ importedAt, ...election }) => {
            const organ = election.organs[0]!;
            const key = await topPlace(election.id, organ);
            const lists = key ? await listRows(election.id, organ, key) : [];
            return {
              ...election,
              turnout: key ? await turnoutOf(election.id, organ, key) : null,
              winner: lists[0] ?? null,
              imported: importedAt !== null,
              deepestLevel: deepest.get(election.id) ?? null,
              // Second rounds get ids ending in "-2a-volta".
              round: election.type === "presidenciais" ? (/-2a-volta$/.test(election.id) ? 2 : 1) : null,
            };
          }),
        );
        const upcoming = UPCOMING_ELECTIONS.filter((e) => !request.query.type || e.type === request.query.type).map((e) => ({
          ...e,
          imported: false as const,
        }));
        return { items, upcoming };
      },
    );

    const organQuery = z.object({
      organ: z.string().regex(/^[A-Z]{2,3}$/).optional().describe("Body; defaults to the election's main one"),
    });

    app.get(
      "/elections/:id",
      {
        schema: {
          tags: ["elections"],
          summary: "Whole-country results of an election, with each district",
          params: z.object({ id: z.string().regex(/^[a-z]+-\d{4}$/) }),
          querystring: organQuery,
          response: { 200: placeResultSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => placeResult(request.params.id, request.query.organ, null),
    );

    app.get(
      "/elections/:id/places/:key",
      {
        schema: {
          tags: ["elections"],
          summary: "Results in one place (district, municipality or parish), with the places inside it",
          params: z.object({ id: z.string().regex(/^[a-z]+-\d{4}$/), key: placeKeySchema }),
          querystring: organQuery,
          response: { 200: placeResultSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => placeResult(request.params.id, request.query.organ, request.params.key),
    );

    app.get(
      "/elections/:id/dhondt",
      {
        schema: {
          tags: ["elections"],
          summary: "Seats recomputed from the votes with the d'Hondt method, in one place that elects seats",
          params: z.object({ id: z.string().regex(/^[a-z]+-\d{4}$/) }),
          querystring: organQuery.extend({
            place: placeKeySchema
              .optional()
              .describe("A place that elects seats: a district (legislativas), the top level (europeias), a municipality (câmara)"),
            seats: z.coerce
              .number()
              .int()
              .min(1)
              .max(250)
              .optional()
              .describe("Simulate with this many seats instead of the real number"),
          }),
          response: {
            200: z.object({
              election: electionSummarySchema,
              organ: z.string(),
              place: placeSchema,
              seats: z.number(),
              simulated: z.boolean().describe("True when `seats` was given"),
              matchesOfficial: z.boolean().nullable().describe("Whether the recomputed seats equal the official ones; null when simulated"),
              lastSeat: z.object({ list: z.string(), quotient: z.number() }).nullable(),
              firstLoser: z.object({ list: z.string(), quotient: z.number() }).nullable().describe("The first quotient that missed out"),
              lists: z.array(
                listResultSchema.pick({ list: true, name: true, partySlugs: true, votes: true }).extend({
                  seats: z.number(),
                  officialSeats: z.number().nullable(),
                  quotients: z.array(z.number()).describe("votes / 1, 2, 3… (up to 6), for the quotient table"),
                  votesShortOfNextSeat: z.number().nullable().describe("Extra votes needed, all else equal, for one more seat"),
                }),
              ),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const election = await findElection(request.params.id);
        const organ = request.query.organ ?? election.organs[0]!;
        if (!election.organs.includes(organ)) throw new ApiError(400, "bad_request", `This election has no body ${organ}`);
        const key = request.query.place ?? (await topPlace(election.id, organ));
        if (!key) throw notFound("Results");
        const turnout = await turnoutOf(election.id, organ, key);
        if (!turnout) throw notFound("Results for this place");
        const seats = request.query.seats ?? turnout.totalMandates;
        if (!seats) {
          throw new ApiError(400, "bad_request", "No seats are elected at this level; pick a district (or a municipality), or pass seats");
        }
        const [place] = await db
          .select({ key: places.key, name: places.name, level: places.level, dicofre: places.dicofre })
          .from(places)
          .where(eq(places.key, key));
        if (!place) throw notFound("Place");

        const rows = await listRows(election.id, organ, key);
        const result = dhondt(
          rows.map((r) => ({ list: r.list, name: r.name, partySlugs: r.partySlugs, votes: r.votes, officialSeats: r.mandates })),
          seats,
        );
        const simulated = request.query.seats !== undefined;
        return {
          election,
          organ,
          place,
          seats,
          simulated,
          matchesOfficial: simulated ? null : result.lists.every((l) => (l.officialSeats ?? 0) === l.seats),
          lastSeat: result.lastSeat,
          firstLoser: result.firstLoser,
          lists: result.lists,
        };
      },
    );

    const candidateSchema = z.object({
      position: z.number(),
      name: z.string().describe('Proper case, e.g. "Maria José de Aguiar"'),
      elected: z.boolean().describe("Won a seat on election night"),
      deputyId: z.number().nullable().describe("Their deputy record, if they are (or were) a deputy this legislature"),
    });

    app.get(
      "/elections/:id/candidates",
      {
        schema: {
          tags: ["elections"],
          summary: "Candidate lists in one círculo: who was on each list, in order, and who got in",
          params: z.object({ id: z.string().regex(/^[a-z]+-\d{4}$/) }),
          querystring: z.object({
            place: placeKeySchema.optional().describe("The círculo; required for legislativas (a district, FOREIGN-800000 or FOREIGN-900000)"),
            list: z.string().max(60).optional().describe('One list, as on the ballot ("PS")'),
          }),
          response: {
            200: z.object({
              election: electionSummarySchema,
              place: placeSchema,
              circles: z
                .array(placeSchema)
                .describe("Every círculo with lists in this election, to choose from"),
              lists: z.array(
                z.object({
                  list: z.string(),
                  name: z.string().nullable(),
                  partySlugs: z.array(z.string()),
                  seats: z.number().describe("Seats it won here: the cut-off line is after this many effective candidates"),
                  candidates: z.array(candidateSchema).describe("Efetivos, in order"),
                  alternates: z.array(candidateSchema).describe("Suplentes, in order"),
                }),
              ).describe("Most seats first, then by name"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const election = await findElection(request.params.id);
        const circles = await db.execute<z.infer<typeof placeSchema>>(sql`
          select distinct p.key, p.name, p.level, p.dicofre
          from election_candidates c join places p on p.key = c.place_key
          where c.election_id = ${election.id}
          order by p.name`);
        if (circles.rows.length === 0) throw notFound("Candidate lists for this election");
        const key = request.query.place ?? (circles.rows.length === 1 ? circles.rows[0]!.key : null);
        if (!key) throw new ApiError(400, "bad_request", "Pick a círculo with ?place=");
        const place = circles.rows.find((c) => c.key === key);
        if (!place) throw notFound("Candidate lists in this place");

        const rows = await db
          .select({
            list: electionCandidates.list,
            kind: electionCandidates.kind,
            position: electionCandidates.position,
            name: electionCandidates.name,
            elected: electionCandidates.elected,
            deputyId: electionCandidates.deputyId,
            listName: electionLists.name,
            partySlugs: sql<string[]>`coalesce(${electionLists.partySlugs}, '{}')`,
          })
          .from(electionCandidates)
          .leftJoin(electionLists, and(eq(electionLists.electionId, electionCandidates.electionId), eq(electionLists.list, electionCandidates.list)))
          .where(
            and(
              eq(electionCandidates.electionId, election.id),
              eq(electionCandidates.placeKey, key),
              request.query.list ? eq(electionCandidates.list, request.query.list) : undefined,
            ),
          )
          .orderBy(asc(electionCandidates.list), asc(electionCandidates.kind), asc(electionCandidates.position));

        type Out = { list: string; name: string | null; partySlugs: string[]; seats: number; candidates: z.infer<typeof candidateSchema>[]; alternates: z.infer<typeof candidateSchema>[] };
        const lists = new Map<string, Out>();
        for (const r of rows) {
          const out = lists.get(r.list) ?? { list: r.list, name: r.listName, partySlugs: r.partySlugs, seats: 0, candidates: [], alternates: [] };
          lists.set(r.list, out);
          const candidate = { position: r.position, name: properName(r.name), elected: r.elected, deputyId: r.deputyId };
          if (r.kind === "effective") {
            out.candidates.push(candidate);
            if (r.elected) out.seats++;
          } else out.alternates.push(candidate);
        }
        return {
          election,
          place,
          circles: circles.rows,
          lists: [...lists.values()].sort((a, b) => b.seats - a.seats || a.list.localeCompare(b.list, "pt")),
        };
      },
    );
  };

