import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articleLocalOfficials, articles, folded } from "../../db/schema.js";
import { properName } from "../../elections/candidates.js";
import { partiesInList } from "../../elections/mai.js";
import { notFound } from "../../errors.js";
import { shortName } from "../../places/localOfficials.js";
import { articleColumns, articleSchema, escapeLike, foldText, visibleArticle } from "../articles/routes.js";
import { errorSchema } from "../shared.js";

/*
 * Local officials' pages: today the mayors (presidentes de câmara) elected in the autárquicas.
 * Their other public roles come from our own records, matched by full name: a seat in
 * parliament, and candidacies in other elections.
 */

const placeRef = z.object({ key: z.string(), name: z.string(), level: z.string() });

const officialSchema = z.object({
  id: z.string(),
  name: z.string().describe("In full, as on the ballot"),
  shortName: z.string().describe('First and last name, as the news writes it: "Carlos Moedas"'),
  role: z.enum(["mayor"]),
  title: z.string().describe('"Presidente da Câmara Municipal de Lisboa"'),
  place: placeRef.describe("The municipality"),
  district: placeRef.nullable(),
  list: z.string().describe('The ballot acronym: "PPD/PSD.CDS-PP"'),
  label: z.string().describe("The list's name in this municipality (local coalitions and citizens' groups)"),
  parties: z.array(z.string()).describe("Party slugs behind the list; empty for citizens' groups"),
  election: z.string().describe("Where they were elected: /elections/:id/places/:key"),
  term: z.object({ start: z.string(), end: z.string().nullable().describe("When the next autárquicas are due") }),
  current: z.boolean().describe("False once a newer election replaced them"),
  otherRoles: z
    .array(
      z.object({
        kind: z.enum(["deputy", "candidate"]),
        title: z.string(),
        detail: z.string().nullable(),
        date: z.string().nullable(),
        current: z.boolean(),
        elected: z.boolean().nullable().describe("Candidacies: whether they won a seat"),
        link: z.string().nullable().describe("An API path: /deputies/:id or /elections/:id/candidates"),
      }),
    )
    .describe("Other public roles, newest first: a seat in parliament, candidacies in other elections"),
  articles: z.array(articleSchema).describe("Latest news naming them"),
  updatedAt: z.string(),
});

const searchItemSchema = z.object({
  name: z.string().describe("As on the official map, in proper case (as in council members)"),
  organ: z.enum(["CM", "AM", "AF"]),
  role: z.enum(["presidente"]).nullable().describe("The mayor (CM) or the junta president (AF)"),
  place: placeRef.describe("The municipality (CM, AM) or the parish (AF)"),
  municipality: z.object({ key: z.string(), name: z.string() }).nullable().describe("The parish's municipality; null when the place is the municipality"),
  list: z.string(),
  label: z.string(),
  parties: z.array(z.string()),
  localOfficialId: z.string().nullable().describe("Their page, /local-officials/:id (mayors only, for now)"),
  election: z.string(),
});

/** Words of the query, folded as the names are (capitals, no accents). */
const nameWords = (q: string) => [...new Set(foldText(q).toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))].slice(0, 10);

export const localOfficialRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/local-officials/search",
      {
        schema: {
          tags: ["places"],
          summary: "Everyone elected locally (câmara, assembleia municipal, assembleia de freguesia), searched by name",
          querystring: z.object({
            q: z.string().trim().min(3).max(200).describe("Every word must appear in the name, ignoring case and accents; parts of words count"),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
          response: { 200: z.object({ items: z.array(searchItemSchema), total: z.number() }), 400: errorSchema },
        },
      },
      async (request) => {
        const { q, limit } = request.query;
        const words = nameWords(q);
        if (!words.length) return { items: [], total: 0 };
        // Names padded with spaces and with punctuation as spaces, to tell whole words and word starts apart.
        const padded = sql`' ' || regexp_replace(${folded(sql`e.name`)}, '[^A-Z0-9]+', ' ', 'g') || ' '`;
        const matches = sql.join(words.map((w) => sql`${folded(sql`e.name`)} like ${`%${escapeLike(w)}%`}`), sql` and `);
        // Best name match first: the whole name, then whole words (2 each), then word starts (1 each).
        const score = sql.join(
          [
            sql`(case when ${padded} = ${` ${words.join(" ")} `} then 100 else 0 end)`,
            ...words.map((w) => sql`(case when ${padded} like ${`% ${escapeLike(w)} %`} then 2 when ${padded} like ${`% ${escapeLike(w)}%`} then 1 else 0 end)`),
          ],
          sql` + `,
        );
        const rows = await db.execute<{
          name: string; organ: "CM" | "AM" | "AF"; presides: boolean; place_key: string; place_name: string; place_level: string;
          municipality_key: string | null; municipality_name: string | null; list: string; label: string; official_id: string | null;
          election_id: string; total: number;
        }>(sql`
          with latest as (
            select s.election_id from local_elected_sources s join elections el on el.id = s.election_id order by el.date desc limit 1
          ),
          hits as (
            select e.election_id, e.place_key, e.organ, e.list, e.position, e.name, ${score} as score
            from local_elected e join latest using (election_id)
            where ${matches}
          ),
          -- The same people as council members on the place page: lists with seats whose names add
          -- up to them, and the first name on the most-voted list presiding (CM, AF).
          shown as (
            select h.*, r.label as result_label,
              h.organ <> 'AM' and h.position = 1 and h.list = (
                select w.list from election_results w
                where w.election_id = h.election_id and w.place_key = h.place_key and w.organ = h.organ and coalesce(w.mandates, 0) > 0
                order by w.votes desc, w.mandates desc limit 1
              ) as presides
            from hits h
            join election_results r on r.election_id = h.election_id and r.place_key = h.place_key and r.organ = h.organ and r.list = h.list
            where coalesce(r.mandates, 0) > 0
              and r.mandates = (select count(*) from local_elected x
                where x.election_id = h.election_id and x.place_key = h.place_key and x.organ = h.organ and x.list = h.list)
          )
          select s.name, s.organ, s.presides, p.key as place_key, p.name as place_name, p.level as place_level,
            m.key as municipality_key, m.name as municipality_name, s.list, coalesce(s.result_label, l.name, s.list) as label,
            case when s.presides and s.organ = 'CM' then o.id end as official_id, s.election_id,
            (count(*) over ())::int as total
          from shown s
          join places p on p.key = s.place_key
          left join places m on m.key = p.parent_key and p.level = 'parish'
          left join election_lists l on l.election_id = s.election_id and l.list = s.list
          left join local_officials o on o.election_id = s.election_id and o.place_key = s.place_key and o.list = s.list
          order by s.score desc, s.presides desc, array_position(array['CM', 'AM', 'AF'], s.organ), length(s.name), s.name, p.name
          limit ${limit}`);
        return {
          items: rows.rows.map((r) => ({
            name: properName(r.name),
            organ: r.organ,
            role: r.presides ? ("presidente" as const) : null,
            place: { key: r.place_key, name: r.place_name, level: r.place_level },
            municipality: r.municipality_key ? { key: r.municipality_key, name: r.municipality_name! } : null,
            list: r.list,
            label: r.label,
            parties: partiesInList(r.list),
            localOfficialId: r.official_id,
            election: r.election_id,
          })),
          total: rows.rows[0]?.total ?? 0,
        };
      },
    );

    app.get(
      "/local-officials/:id",
      {
        schema: {
          tags: ["places"],
          summary: "A local official (today, a mayor): their term, list, other public roles and news",
          params: z.object({ id: z.string().regex(/^[a-z0-9-]{1,120}$/) }),
          response: { 200: officialSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const found = await db.execute<{
          id: string; name: string; role: "mayor"; list: string; election_id: string; term_start: string; term_end: string | null;
          current: boolean; updated_at: string; place_key: string; place_name: string; place_level: string;
          district_key: string | null; district_name: string | null; label: string | null;
        }>(sql`
          select o.id, o.name, o.role, o.list, o.election_id, o.term_start::text, o.term_end::text, o.current,
            to_char(o.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
            p.key as place_key, p.name as place_name, p.level as place_level, d.key as district_key, d.name as district_name,
            coalesce(r.label, l.name) as label
          from local_officials o
          join places p on p.key = o.place_key
          left join places d on d.key = p.parent_key and d.level = 'district'
          left join election_results r on r.election_id = o.election_id and r.organ = 'CM' and r.place_key = o.place_key and r.list = o.list
          left join election_lists l on l.election_id = o.election_id and l.list = o.list
          where o.id = ${id}`);
        const o = found.rows[0];
        if (!o) throw notFound("Local official");

        // Same full name, ignoring case and accents: candidate lists are often in capitals. Both
        // sides use the indexed expression (deputies_full_name_folded_idx, election_candidates_name_folded_idx).
        const key = folded(sql`${o.name}::text`);
        const [deputyRows, candidacyRows, news] = await Promise.all([
          db.execute<{ id: number; gender: string | null; active: boolean; constituency: string }>(sql`
            select id, gender, active, constituency from deputies where ${folded(sql`full_name`)} = ${key}`),
          db.execute<{ election_id: string; election_name: string; date: string; place: string; list: string; kind: string; position: number; elected: boolean }>(sql`
            select c.election_id, e.name as election_name, e.date::text as date, p.name as place, c.list, c.kind, c.position, c.elected
            from election_candidates c join elections e on e.id = c.election_id join places p on p.key = c.place_key
            where ${folded(sql`c.name`)} = ${key} and not (c.election_id = ${o.election_id} and c.place_key = ${o.place_key})
            order by e.date desc`),
          db
            .select(articleColumns)
            .from(articleLocalOfficials)
            .innerJoin(articles, eq(articles.id, articleLocalOfficials.articleId))
            .where(sql`${articleLocalOfficials.officialId} = ${id} and ${visibleArticle}`)
            .orderBy(desc(articles.publishedAt))
            .limit(10),
        ]);

        const otherRoles = [
          ...deputyRows.rows.map((d) => ({
            kind: "deputy" as const,
            title: d.gender === "F" ? "Deputada à Assembleia da República" : "Deputado à Assembleia da República",
            detail: `${d.gender === "F" ? "Eleita" : "Eleito"} pelo círculo de ${d.constituency}`,
            date: null,
            current: d.active,
            elected: null,
            link: `/deputies/${d.id}`,
          })),
          ...candidacyRows.rows.map((c) => ({
            kind: "candidate" as const,
            title: `Candidatura às ${c.election_name}`,
            detail: `${c.kind === "alternate" ? "Suplente nº" : "Nº"} ${c.position} da lista ${c.list}, ${c.place}`,
            date: c.date,
            current: false,
            elected: c.elected,
            link: `/elections/${c.election_id}/candidates`,
          })),
        ];

        return {
          id: o.id,
          name: o.name,
          shortName: shortName(o.name),
          role: o.role,
          title: `Presidente da Câmara Municipal de ${o.place_name}`,
          place: { key: o.place_key, name: o.place_name, level: o.place_level },
          district: o.district_key ? { key: o.district_key, name: o.district_name!, level: "district" } : null,
          list: o.list,
          label: o.label ?? o.list,
          parties: partiesInList(o.list),
          election: o.election_id,
          term: { start: o.term_start, end: o.term_end },
          current: o.current,
          otherRoles,
          articles: news.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
          updatedAt: o.updated_at,
        };
      },
    );
  };
