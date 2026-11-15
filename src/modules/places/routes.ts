import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { partiesInList } from "../../elections/mai.js";
import { notFound } from "../../errors.js";
import { photoUrl } from "../parliament/routes.js";
import { errorSchema } from "../shared.js";

/*
 * Places (districts, municipalities, parishes) and who represents them: the mayor, the câmara
 * and assembly, the deputies elected by the district, recent results and public contracts.
 * Keys are the same as in the elections API (LOCAL-xxxxxx, DICOFRE-based).
 */

const placeKey = z.string().regex(/^LOCAL-\d{6}$/);
/** Any stored place, as the elections API names them (LOCAL-, FOREIGN-, GLOBAL-, AUTARQUICAS2025-…). */
const anyPlaceKey = z.string().regex(/^(?:(?:LOCAL|FOREIGN|GLOBAL)-\d{6}|[A-Z]+\d{4}-\d+)$/);
const levelSchema = z.enum(["district", "municipality", "parish"]);
const ref = z.object({ key: z.string(), name: z.string(), level: z.string() });
const placeRef = ref.extend({ dicofre: z.string().nullable() });

const mayorSchema = z
  .object({
    name: z.string().describe("As published, usually in full"),
    list: z.string().describe('The ballot acronym, e.g. "PPD/PSD.CDS-PP"'),
    label: z.string().describe("The list's name in this municipality (local coalitions and citizens' groups)"),
    parties: z.array(z.string()).describe("Party slugs behind the list; empty for citizens' groups"),
    election: z.string(),
  })
  .nullable();

const seatSchema = z.object({
  list: z.string(),
  label: z.string(),
  parties: z.array(z.string()),
  votes: z.number(),
  validPct: z.number().nullable(),
  mandates: z.number(),
});

/** "PPD/PSD.CDS-PP" → psd, cds-pp; local coalition names keep the acronym's parties. */
const partiesOf = (list: string) => partiesInList(list);

export const placeRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    /** Mayors from the latest autárquicas with candidates, keyed by municipality. */
    const mayors = async (keys: string[] | null) => {
      const rows = await db.execute<{ place_key: string; name: string; list: string; label: string | null; election_id: string }>(sql`
        with latest as (
          select e.id from elections e where e.type = 'autarquicas'
            and exists (select 1 from election_candidates c where c.election_id = e.id)
          order by e.date desc limit 1
        )
        select c.place_key, c.name, c.list, r.label, c.election_id
        from election_candidates c
        join latest on latest.id = c.election_id
        left join election_results r on r.election_id = c.election_id and r.organ = 'CM' and r.place_key = c.place_key and r.list = c.list
        where c.elected ${keys ? sql`and c.place_key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})` : sql``}`);
      return new Map(
        rows.rows.map((r) => [
          r.place_key,
          { name: r.name, list: r.list, label: r.label ?? r.list, parties: partiesOf(r.list), election: r.election_id },
        ]),
      );
    };

    app.get(
      "/places",
      {
        schema: {
          tags: ["places"],
          summary: "Districts, municipalities or parishes, with each municipality's mayor (for maps)",
          querystring: z.object({
            level: levelSchema.default("municipality"),
            parent: placeKey.optional().describe("Only places inside this one"),
          }),
          response: {
            200: z.object({
              items: z.array(ref.extend({ parentKey: z.string().nullable(), dicofre: z.string().nullable(), mayor: mayorSchema })),
            }),
            400: errorSchema,
          },
        },
      },
      async (request) => {
        const { level, parent } = request.query;
        const rows = await db.execute<{ key: string; name: string; level: string; parent_key: string | null; dicofre: string | null }>(sql`
          select key, name, level, parent_key, dicofre from places
          where key like 'LOCAL-%' and level = ${level} ${parent ? sql`and parent_key = ${parent}` : sql``}
          order by name`);
        const byPlace = level === "municipality" ? await mayors(null) : new Map();
        return {
          items: rows.rows.map((r) => ({
            key: r.key, name: r.name, level: r.level, parentKey: r.parent_key, dicofre: r.dicofre, mayor: byPlace.get(r.key) ?? null,
          })),
        };
      },
    );

    app.get(
      "/places/:key",
      {
        schema: {
          tags: ["places"],
          summary: "One place: who represents it, how it voted, and the public contracts carried out there",
          params: z.object({ key: anyPlaceKey }),
          response: {
            200: placeRef.extend({
              parent: placeRef.nullable(),
              children: z.array(placeRef),
              mayor: mayorSchema.describe("Municipalities only: the presidente da câmara"),
              council: z
                .object({ election: z.string(), organs: z.array(z.object({ organ: z.enum(["CM", "AM", "AF"]), totalMandates: z.number().nullable(), seats: z.array(seatSchema) })) })
                .nullable()
                .describe("Seats in the câmara (CM), assembleia municipal (AM) or de freguesia (AF), from the latest autárquicas"),
              deputies: z
                .object({
                  circle: ref,
                  items: z.array(z.object({ id: z.number(), name: z.string(), photoUrl: z.string(), party: z.object({ slug: z.string(), acronym: z.string() }).nullable() })),
                })
                .nullable()
                .describe("Deputies elected by the district (círculo) this place is in"),
              elections: z
                .array(
                  z.object({
                    election: z.string(),
                    name: z.string(),
                    date: z.string(),
                    organ: z.string(),
                    turnoutPct: z.number().nullable(),
                    winner: z.object({ list: z.string(), label: z.string(), validPct: z.number().nullable() }).nullable(),
                  }),
                )
                .describe("The latest election of each type here, newest first; see /elections/:id/places/:key"),
              contracts: z.object({
                carriedOut: z.object({ count: z.number(), total: z.number() }).describe("Public contracts carried out here (BASE, from 2024)"),
                council: z
                  .object({ nif: z.string(), name: z.string(), count: z.number(), total: z.number(), directAwards: z.number() })
                  .nullable()
                  .describe("Municipalities: contracts the câmara awarded; see /contracts/parties/:nif"),
              }),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const { key } = request.params;
        const found = await db.execute<{ key: string; name: string; level: string; dicofre: string | null; parent_key: string | null }>(
          sql`select key, name, level, dicofre, parent_key from places where key = ${key}`,
        );
        const place = found.rows[0];
        if (!place) throw notFound("Place");
        const local = ["district", "municipality", "parish"].includes(place.level);

        // Ancestors: parish → municipality → district.
        const chain = await db.execute<{ key: string; name: string; level: string; dicofre: string | null; depth: number }>(sql`
          with recursive up as (
            select key, name, level, dicofre, parent_key, 0 as depth from places where key = ${key}
            union all
            select p.key, p.name, p.level, p.dicofre, p.parent_key, up.depth + 1 from places p join up on p.key = up.parent_key
          ) select key, name, level, dicofre, depth from up where depth > 0 order by depth`);
        const parent = chain.rows[0] ?? null;
        const district = !local ? undefined : place.level === "district" ? place : chain.rows.find((r) => r.level === "district");
        const children = await db.execute<{ key: string; name: string; level: string; dicofre: string | null }>(
          sql`select key, name, level, dicofre from places where parent_key = ${key} order by name`,
        );

        const mayor = place.level === "municipality" ? ((await mayors([key])).get(key) ?? null) : null;

        // Council seats from the latest autárquicas that has results here.
        const councilRows = await db.execute<{
          election_id: string; organ: "CM" | "AM" | "AF"; list: string; label: string | null; votes: number; valid_pct: number | null; mandates: number; total: number | null;
        }>(sql`
          with latest as (
            select e.id from elections e where e.type = 'autarquicas' and e.imported_at is not null
              and exists (select 1 from election_results r where r.election_id = e.id and r.place_key = ${key})
            order by e.date desc limit 1
          )
          select r.election_id, r.organ, r.list, coalesce(r.label, l.name, r.list) as label, r.votes, r.valid_pct, r.mandates, t.total_mandates as total
          from election_results r
          join latest on latest.id = r.election_id
          left join election_lists l on l.election_id = r.election_id and l.list = r.list
          left join election_turnout t on t.election_id = r.election_id and t.organ = r.organ and t.place_key = r.place_key
          where r.place_key = ${key} and coalesce(r.mandates, 0) > 0
            and r.organ in (${place.level === "parish" ? sql`'AF'` : sql`'CM', 'AM'`})
          order by r.organ, r.mandates desc, r.votes desc`);
        const council = councilRows.rows.length
          ? {
              election: councilRows.rows[0]!.election_id,
              organs: (["CM", "AM", "AF"] as const).flatMap((organ) => {
                const seats = councilRows.rows.filter((r) => r.organ === organ);
                return seats.length
                  ? [{
                      organ,
                      totalMandates: seats[0]!.total,
                      seats: seats.map((r) => ({ list: r.list, label: r.label ?? r.list, parties: partiesOf(r.list), votes: r.votes, validPct: r.valid_pct, mandates: r.mandates })),
                    }]
                  : [];
              }),
            }
          : null;

        // Deputies of the círculo (deputies record their constituency by name).
        let deputies = null;
        if (district) {
          const rows = await db.execute<{ id: number; name: string; slug: string | null; acronym: string | null }>(sql`
            select d.id, d.name, p.slug, p.acronym from deputies d left join parties p on p.id = d.party_id
            where d.active and d.constituency = ${district.name} order by p.assembly_seats desc nulls last, d.name`);
          deputies = {
            circle: { key: district.key, name: district.name, level: "district" },
            items: rows.rows.map((r) => ({ id: r.id, name: r.name, photoUrl: photoUrl(r.id), party: r.slug && r.acronym ? { slug: r.slug, acronym: r.acronym } : null })),
          };
        }

        // The latest election of each type with results here, and who came first.
        const electionRows = await db.execute<{
          election_id: string; name: string; date: string; organ: string; turnout_pct: number | null; list: string | null; label: string | null; valid_pct: number | null;
        }>(sql`
          select distinct on (e.type) e.id as election_id, e.name, e.date::text as date, e.organs[1] as organ, t.turnout_pct,
            w.list, w.label, w.valid_pct
          from elections e
          join election_turnout t on t.election_id = e.id and t.organ = e.organs[1] and t.place_key = ${key}
          left join lateral (
            select r.list, coalesce(r.label, l.name, r.list) as label, r.valid_pct from election_results r
            left join election_lists l on l.election_id = r.election_id and l.list = r.list
            where r.election_id = e.id and r.organ = e.organs[1] and r.place_key = ${key}
            order by r.votes desc limit 1
          ) w on true
          where e.imported_at is not null
          order by e.type, e.date desc`);
        const elections = electionRows.rows
          .map((r) => ({
            election: r.election_id, name: r.name, date: r.date, organ: r.organ, turnoutPct: r.turnout_pct,
            winner: r.list ? { list: r.list, label: r.label ?? r.list, validPct: r.valid_pct } : null,
          }))
          .sort((a, b) => b.date.localeCompare(a.date));

        const [carried] = (
          await db.execute<{ count: number; total: number }>(sql`
            select count(*)::int as count, round(coalesce(sum(price), 0)::numeric, 2)::float8 as total
            from contracts where place_keys @> array[${key}]::text[]`)
        ).rows;

        // The câmara as a contracting entity: "Município de X", the NIF with most contracts here.
        let councilContracts = null;
        if (place.level === "municipality") {
          const name = place.name.replace(/\s*\([^)]*\)\s*$/, "");
          const rows = await db.execute<{ nif: string; name: string; count: number; total: number; direct: number }>(sql`
            select p.nif, max(p.name) as name, count(*)::int as count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as total,
              (count(*) filter (where c.procedure_kind in ('direct_award', 'direct_award_simplified')))::int as direct,
              count(*) filter (where c.place_keys @> array[${key}]::text[]) as here
            from contract_parties p join contracts c on c.id = p.contract_id
            where p.role = 'entity' and p.nif <> ''
              and p.name ~* ${`^munic[ií]pio d(e|a|o|as|os) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |\\(|,|$)`}
            group by p.nif order by here desc, count desc limit 1`);
          const r = rows.rows[0];
          if (r) councilContracts = { nif: r.nif, name: r.name, count: r.count, total: r.total, directAwards: r.direct };
        }

        return {
          key: place.key, name: place.name, level: place.level, dicofre: place.dicofre,
          parent: parent ? { key: parent.key, name: parent.name, level: parent.level, dicofre: parent.dicofre } : null,
          children: children.rows.sort((a, b) => a.name.localeCompare(b.name, "pt")),
          mayor,
          council,
          deputies,
          elections,
          contracts: { carriedOut: carried ?? { count: 0, total: 0 }, council: councilContracts },
        };
      },
    );
  };
