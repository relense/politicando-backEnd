import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { electionLists, electionResults, electionTurnout, elections, places } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

const levelSchema = z.enum(["global", "national", "foreign", "district", "municipality", "parish"]);
const placeSchema = z.object({ key: z.string(), name: z.string(), level: levelSchema, dicofre: z.string().nullable() });

const listResultSchema = z.object({
  list: z.string().describe('As on the ballot: "PPD/PSD.CDS-PP", "B.E.", or a candidate\'s name'),
  name: z.string().nullable().describe("Full name of the party, coalition or citizens' group"),
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
          name: electionLists.name,
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
          summary: "Elections since 2011, newest first, with who won",
          querystring: z.object({ type: electionSummarySchema.shape.type.optional() }),
          response: {
            200: z.object({
              items: z.array(
                electionSummarySchema.extend({
                  turnout: turnoutSchema.nullable(),
                  winner: listResultSchema.nullable().describe("Most votes in the main body, whole country"),
                  imported: z.boolean().describe("False while results are still being imported"),
                }),
              ),
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
            };
          }),
        );
        return { items };
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
          params: z.object({ id: z.string().regex(/^[a-z]+-\d{4}$/), key: z.string().regex(/^(LOCAL|FOREIGN|GLOBAL)-\d{6}$/) }),
          querystring: organQuery,
          response: { 200: placeResultSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => placeResult(request.params.id, request.query.organ, request.params.key),
    );

    app.get(
      "/places/:key",
      {
        schema: {
          tags: ["elections"],
          summary: "A place and the places inside it",
          params: z.object({ key: z.string().regex(/^(LOCAL|FOREIGN|GLOBAL)-\d{6}$/) }),
          response: {
            200: placeSchema.extend({ parent: placeSchema.nullable(), children: z.array(placeSchema) }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const columns = { key: places.key, name: places.name, level: places.level, dicofre: places.dicofre };
        const [place] = await db.select({ ...columns, parentKey: places.parentKey }).from(places).where(eq(places.key, request.params.key));
        if (!place) throw notFound("Place");
        const { parentKey, ...rest } = place;
        const [parent] = parentKey ? await db.select(columns).from(places).where(eq(places.key, parentKey)) : [];
        const children = await db.select(columns).from(places).where(eq(places.parentKey, place.key));
        children.sort((a, b) => a.name.localeCompare(b.name, "pt"));
        return { ...rest, parent: parent ?? null, children };
      },
    );
  };
