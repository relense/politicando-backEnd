import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { articleLocalOfficials, articles } from "../../db/schema.js";
import { partiesInList } from "../../elections/mai.js";
import { notFound } from "../../errors.js";
import { shortName } from "../../places/localOfficials.js";
import { articleColumns, articleSchema, visibleArticle } from "../articles/routes.js";
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

export const localOfficialRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
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

        // Same full name, ignoring case and accents: candidate lists are often in capitals.
        const key = sql`translate(upper(${o.name}), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN')`;
        const folded = (column: string) =>
          sql`translate(upper(${sql.raw(column)}), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN')`;
        const [deputyRows, candidacyRows, news] = await Promise.all([
          db.execute<{ id: number; gender: string | null; active: boolean; constituency: string }>(sql`
            select id, gender, active, constituency from deputies where ${folded("full_name")} = ${key}`),
          db.execute<{ election_id: string; election_name: string; date: string; place: string; list: string; kind: string; position: number; elected: boolean }>(sql`
            select c.election_id, e.name as election_name, e.date::text as date, p.name as place, c.list, c.kind, c.position, c.elected
            from election_candidates c join elections e on e.id = c.election_id join places p on p.key = c.place_key
            where ${folded("c.name")} = ${key} and not (c.election_id = ${o.election_id} and c.place_key = ${o.place_key})
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
