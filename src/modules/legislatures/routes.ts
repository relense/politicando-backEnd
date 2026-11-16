import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { ApiError } from "../../errors.js";
import { LEGISLATURE_EVENTS } from "../../parliament/legislatureEvents.js";
import { LEGISLATURES, legislatureDates } from "../../parliament/legislatures.js";
import { pastPartySlug } from "../../parliament/pastLegislatures.js";
import { PRESIDENTS } from "../../presidency/presidents.js";
import { governmentSchema, historicGovernments } from "../history/routes.js";
import { errorSchema } from "../shared.js";

/** The legislative elections that elected each legislature (1979's interim election completed the I). */
export const LEGISLATURE_ELECTIONS: Readonly<Record<string, readonly string[]>> = {
  Constituinte: ["legislativas-1975"], I: ["legislativas-1976", "legislativas-1979"], II: ["legislativas-1980"],
  III: ["legislativas-1983"], IV: ["legislativas-1985"], V: ["legislativas-1987"], VI: ["legislativas-1991"],
  VII: ["legislativas-1995"], VIII: ["legislativas-1999"], IX: ["legislativas-2002"], X: ["legislativas-2005"],
  XI: ["legislativas-2009"], XII: ["legislativas-2011"], XIII: ["legislativas-2015"], XIV: ["legislativas-2019"],
  XV: ["legislativas-2022"], XVI: ["legislativas-2024"], XVII: ["legislativas-2025"],
};

/** Authors with no party page: parties that no longer exist, and authors that aren't parties. */
const AUTHOR_NAMES: Record<string, string> = {
  UDP: "União Democrática Popular",
  ASDI: "Ação Social Democrata Independente",
  "MDP/CDE": "Movimento Democrático Português",
  UEDS: "União de Esquerda para a Democracia Socialista",
  PRD: "Partido Renovador Democrático",
  ID: "Intervenção Democrática",
  PSN: "Partido de Solidariedade Nacional",
  Governo: "Governo",
  PAR: "Presidente da Assembleia da República",
  Comissões: "Comissões parlamentares",
  Cidadãos: "Cidadãos (iniciativa legislativa de cidadãos)",
  "Mesa da Assembleia": "Mesa da Assembleia da República",
};

const nameOf = (id: string) => (id === "Constituinte" ? "Assembleia Constituinte" : `${id} Legislatura`);
const LAW_TYPES = ["Projeto de Lei", "Proposta de Lei"];

const eventSchema = z.object({
  date: z.string(),
  precision: z.enum(["day", "month", "year"]).describe('"month"/"year": only that much of the date is known'),
  kind: z.enum(["law", "policy", "crisis", "controversy", "economy", "international", "society"]),
  title: z.string(),
  summary: z.string(),
  judicial: z.boolean().describe("About a criminal case; the summary gives the legal stage as of a date"),
  sources: z.array(z.object({ url: z.string(), title: z.string(), publisher: z.string() })),
});

const countsSchema = z.object({
  submitted: z.number(),
  approved: z.number(),
  rejected: z.number(),
  withdrawn: z.number(),
  pending: z.number().describe("Current legislature: still being decided. Past ones: lapsed when the legislature ended"),
});

const summarySchema = z.object({
  id: z.string().describe('"Constituinte", "I" … "XVII"'),
  name: z.string(),
  start: z.string(),
  end: z.string().nullable().describe("The day the next one began; null for the current one"),
  current: z.boolean(),
  elections: z.array(z.string()).describe("/elections/:id that elected it"),
  primeMinisters: z.array(z.string()),
  initiatives: z.number().describe("Initiatives on record (older legislatures' records are incomplete)"),
  events: z.number().describe("Curated events"),
});

const detailSchema = summarySchema.omit({ initiatives: true, events: true, elections: true }).extend({
  elections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      date: z.string(),
      totalMandates: z.number().nullable(),
      seats: z
        .array(z.object({ list: z.string(), name: z.string().nullable(), partySlugs: z.array(z.string()), votes: z.number(), mandates: z.number() }))
        .describe("Lists that won seats, most seats first"),
    }),
  ),
  governments: z.array(governmentSchema).describe("Governments in office during it, oldest first"),
  presidents: z.array(z.object({ id: z.string(), name: z.string(), termStart: z.string(), termEnd: z.string().nullable() })),
  initiatives: countsSchema.extend({
    laws: z.number().describe("Approved bills (projetos and propostas de lei)"),
    byAuthor: z
      .array(
        countsSchema.extend({
          key: z.string().describe("Our party slug, or the parliament's name for the author"),
          name: z.string(),
          partySlug: z.string().nullable().describe("Set when we have a page for the party"),
        }),
      )
      .describe("Co-signed initiatives count for each author. Most submitted first"),
  }),
  events: z.array(eventSchema).describe("Curated: laws, crises, controversies… oldest first"),
  cases: z
    .array(z.object({ id: z.number(), title: z.string(), status: z.string(), statusDate: z.string().nullable(), startedAt: z.string().nullable() }))
    .describe("Published cases from the record (/cases/:id) with something dated in this legislature"),
});

type Counts = z.infer<typeof countsSchema>;
const emptyCounts = (): Counts => ({ submitted: 0, approved: 0, rejected: 0, withdrawn: 0, pending: 0 });
const add = (c: Counts, status: string, n: number) => {
  c.submitted += n;
  if (status === "approved") c.approved += n;
  else if (status === "rejected") c.rejected += n;
  else if (status === "withdrawn") c.withdrawn += n;
  else c.pending += n;
};

const overlaps = (start: string, end: string | null, from: string, to: string | null) =>
  start < (to ?? "9999-12-31") && (end ?? "9999-12-31") > from;

/**
 * Governments that governed during a legislature: in office for at least 30 days of it, or
 * wholly within it (the XX Government lasted 27 days). Leaves out an outgoing government
 * staying on as caretaker, and one formed days before the next legislature first sat.
 */
const governedDuring = (g: { start: string; end: string | null }, from: string, to: string | null) => {
  const overlapStart = g.start > from ? g.start : from;
  const overlapEnd = [g.end, to].filter((d): d is string => d !== null).sort()[0] ?? new Date().toISOString().slice(0, 10);
  const days = (Date.parse(overlapEnd) - Date.parse(overlapStart)) / 86_400_000;
  const within = g.start >= from && g.end !== null && to !== null && g.end <= to;
  return days > 0 && (days >= 30 || within);
};

const inList = (ids: string[]) => (ids.length ? sql`(${sql.join(ids.map((e) => sql`${e}`), sql`, `)})` : sql`(null)`);

/** The whole-country row of an election's results: the global total, or the national one. */
const TOP_PLACE = (electionRef: ReturnType<typeof sql.raw>) => sql`(
  select t.place_key from election_turnout t
  where t.election_id = ${electionRef} and t.organ = 'AR' and t.place_key in ('GLOBAL-990000', 'LOCAL-500000')
  order by t.place_key limit 1
)`;

export const legislatureRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const currentId = LEGISLATURES.at(-1)!.id;

    app.get(
      "/legislatures",
      {
        schema: {
          tags: ["history"],
          summary: "Every legislature since the Constituent Assembly, newest first",
          response: { 200: z.object({ items: z.array(summarySchema) }) },
        },
      },
      async () => {
        const counts = new Map(
          (
            await db.execute<{ legislature: string; n: number }>(sql`
              select legislature, count(*)::int as n from past_initiatives group by legislature
              union all
              select legislature, count(*)::int from initiatives group by legislature`)
          ).rows.map((r) => [r.legislature, r.n]),
        );
        const governments = await historicGovernments(db);
        return {
          items: LEGISLATURES.map(({ id }) => {
            const { start, end } = legislatureDates(id)!;
            return {
              id, name: nameOf(id), start, end, current: id === currentId,
              elections: [...(LEGISLATURE_ELECTIONS[id] ?? [])],
              primeMinisters: [...new Set(governments.filter((g) => governedDuring(g, start, end)).map((g) => g.primeMinister))],
              initiatives: counts.get(id) ?? 0,
              events: LEGISLATURE_EVENTS[id]?.length ?? 0,
            };
          }).reverse(),
        };
      },
    );

    app.get(
      "/legislatures/:id",
      {
        schema: {
          tags: ["history"],
          summary: "One legislature: who was elected, who governed, what parliament passed and what happened",
          params: z.object({ id: z.string().max(20) }),
          response: { 200: detailSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const { id } = request.params;
        const dates = legislatureDates(id);
        if (!dates) throw new ApiError(404, "not_found", "No such legislature");
        const { start, end } = dates;
        const electionIds = [...(LEGISLATURE_ELECTIONS[id] ?? [])];
        const before = end ? sql`${end}::date` : sql`'infinity'::date`;

        const [electionRows, seatRows, initiativeRows, caseRows, partyRows] = await Promise.all([
          db.execute<{ id: string; name: string; date: string; total_mandates: number | null }>(sql`
            select e.id, e.name, e.date::text as date,
              (select t.total_mandates from election_turnout t where t.election_id = e.id and t.organ = 'AR'
                 and t.place_key = ${TOP_PLACE(sql.raw("e.id"))}) as total_mandates
            from elections e
            where e.id in ${inList(electionIds)}
            order by e.date`),
          db.execute<{ election_id: string; list: string; name: string | null; party_slugs: string[] | null; votes: number; mandates: number }>(sql`
            select r.election_id, r.list, l.name, l.party_slugs, r.votes, r.mandates
            from election_results r
            left join election_lists l on l.election_id = r.election_id and l.list = r.list
            where r.organ = 'AR' and r.mandates > 0 and r.election_id in ${inList(electionIds)}
              and r.place_key = ${TOP_PLACE(sql.raw("r.election_id"))}
            order by r.mandates desc, r.votes desc`),
          id === currentId
            ? db.execute<{ type: string; status: string; authors: string[]; n: number }>(sql`
                select i.type, i.status,
                  coalesce(array_agg(p.slug order by p.slug) filter (where p.slug is not null), array[coalesce(i.other_author, 'Outros')]) as authors,
                  1 as n
                from initiatives i
                left join initiative_parties ip on ip.initiative_id = i.id
                left join parties p on p.id = ip.party_id
                where i.legislature = ${id}
                group by i.id`)
            : db.execute<{ type: string; status: string; authors: string[]; n: number }>(sql`
                select type, status,
                  case when cardinality(author_groups) > 0 then author_groups else array[coalesce(other_author, 'Outros')] end as authors,
                  count(*)::int as n
                from past_initiatives where legislature = ${id}
                group by 1, 2, 3`),
          db.execute<{ id: number; title: string; status: string; status_date: string | null; started_at: string | null }>(sql`
            select c.id, c.title, c.status, c.status_date::text as status_date, c.started_at::text as started_at
            from cases c
            where c.published and (
              (c.started_at >= ${start}::date and c.started_at < ${before})
              or exists (select 1 from case_events ev where ev.case_id = c.id and ev.date >= ${start}::date and ev.date < ${before})
            )
            order by coalesce(c.started_at, c.status_date)`),
          db.execute<{ slug: string; acronym: string }>(sql`select slug, acronym from parties`),
        ]);

        const acronymBySlug = new Map(partyRows.rows.map((p) => [p.slug, p.acronym]));
        const totals = emptyCounts();
        let laws = 0;
        const byAuthor = new Map<string, Counts & { key: string; name: string; partySlug: string | null }>();
        for (const row of initiativeRows.rows) {
          add(totals, row.status, row.n);
          if (row.status === "approved" && LAW_TYPES.includes(row.type)) laws += row.n;
          // Current legislature: authors are already party slugs. Past ones: the parliament's group names.
          const keys = [...new Set(row.authors.map((a) => (id === currentId ? a : (pastPartySlug(a) ?? a))))];
          for (const key of keys) {
            const partySlug = acronymBySlug.has(key) ? key : null;
            const entry = byAuthor.get(key) ?? {
              key, name: partySlug ? acronymBySlug.get(key)! : (AUTHOR_NAMES[key] ?? key), partySlug, ...emptyCounts(),
            };
            add(entry, row.status, row.n);
            byAuthor.set(key, entry);
          }
        }

        const governments = (await historicGovernments(db)).filter((g) => governedDuring(g, start, end));
        return {
          id, name: nameOf(id), start, end, current: id === currentId,
          primeMinisters: [...new Set(governments.map((g) => g.primeMinister))],
          elections: electionRows.rows.map((e) => ({
            id: e.id, name: e.name, date: e.date, totalMandates: e.total_mandates,
            seats: seatRows.rows
              .filter((s) => s.election_id === e.id)
              .map((s) => ({ list: s.list, name: s.name, partySlugs: s.party_slugs ?? [], votes: s.votes, mandates: s.mandates })),
          })),
          governments,
          presidents: PRESIDENTS.filter((p) => overlaps(p.termStart, p.termEnd, start, end)).map((p) => ({
            id: p.id, name: p.name, termStart: p.termStart, termEnd: p.termEnd,
          })),
          initiatives: { ...totals, laws, byAuthor: [...byAuthor.values()].sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name)) },
          events: [...(LEGISLATURE_EVENTS[id] ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
          cases: caseRows.rows.map((c) => ({ id: c.id, title: c.title, status: c.status, statusDate: c.status_date, startedAt: c.started_at })),
        };
      },
    );
  };
