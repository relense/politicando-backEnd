import { type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CASE_CRIMES, CASE_STATUSES, INTEREST_KINDS, PERSON_STATUSES, crimeSchema, caseStatusSchema } from "../../cases/model.js";
import { loadCases, type StoredCase } from "../../cases/store.js";
import type { Db } from "../../db/client.js";
import { parties } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

const termSchema = z.object({ key: z.string(), label: z.string(), plain: z.string() });
const byKey = <T extends { key: string }>(list: readonly T[]) => new Map(list.map((t) => [t.key, t]));
const crimes = byKey(CASE_CRIMES);
const caseStatuses = byKey(CASE_STATUSES);
const personStatuses = byKey(PERSON_STATUSES);
const interestKinds = byKey(INTEREST_KINDS);
const term = (map: Map<string, { key: string; label: string; plain: string }>, key: string) => map.get(key) ?? { key, label: key, plain: "" };

const partySchema = z.object({ slug: z.string(), acronym: z.string() }).nullable();

const personSchema = z.object({
  name: z.string(),
  roleAtTime: z.string().nullable().describe("What they were when it happened"),
  party: partySchema.describe("Party at the time"),
  deputyId: z.number().nullable(),
  governmentMemberId: z.string().nullable(),
  status: termSchema.describe("Their own situation in the case"),
  final: z.boolean().describe("The decision on them can no longer be appealed. If false, they are presumed innocent"),
});

const caseSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  crimes: z.array(termSchema),
  status: termSchema,
  statusDate: z.string().nullable(),
  startedAt: z.string().nullable(),
  reviewedAt: z.string().describe("When an editor last checked it against the sources"),
  people: z.array(personSchema),
});

const caseSchema = caseSummarySchema.extend({
  summary: z.string(),
  people: z.array(personSchema.extend({ outcome: z.string().nullable().describe("The sentence, for convictions") })),
  events: z.array(z.object({ date: z.string(), description: z.string(), sources: z.array(z.number()).describe("Positions in sources, from 1") })),
  sources: z.array(
    z.object({ position: z.number(), url: z.string(), title: z.string(), publisher: z.string(), publishedAt: z.string().nullable(), kind: z.enum(["court", "official", "news"]) }),
  ),
});

const contractTotals = z.object({ count: z.number(), total: z.number() });

const interestSchema = z.object({
  id: z.number(),
  personName: z.string(),
  deputyId: z.number().nullable(),
  governmentMemberId: z.string().nullable(),
  kind: termSchema,
  entityName: z.string(),
  nif: z.string().nullable(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  declaredAt: z.string().nullable(),
  source: z.object({ url: z.string(), title: z.string() }),
  contracts: z
    .object({
      won: contractTotals.describe("Public contracts the entity won (as supplier), in our data"),
      duringInterest: contractTotals.describe("Of those, signed while the declared interest held (when dates are known)"),
    })
    .nullable()
    .describe("Only when the entity's NIF is known"),
});

export const caseRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const partyMap = async () =>
      new Map((await db.select({ slug: parties.slug, acronym: parties.acronym }).from(parties)).map((p) => [p.slug, p]));

    const present = async (list: StoredCase[]) => {
      const known = await partyMap();
      return list.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        crimes: c.crimes.map((k) => term(crimes, k)),
        status: term(caseStatuses, c.status),
        statusDate: c.statusDate,
        startedAt: c.startedAt,
        reviewedAt: c.reviewedAt ?? "",
        people: c.people.map((p) => ({
          name: p.name, roleAtTime: p.roleAtTime, party: p.party ? (known.get(p.party) ?? null) : null, deputyId: p.deputyId,
          governmentMemberId: p.governmentMemberId, status: term(personStatuses, p.status), final: p.final, outcome: p.outcome,
        })),
        events: c.events,
        sources: c.sources.map((s, i) => ({ position: i + 1, ...s })),
      }));
    };

    app.get(
      "/cases/glossary",
      {
        schema: {
          tags: ["cases"],
          summary: "What each crime, case stage and personal situation means, in plain Portuguese",
          response: {
            200: z.object({
              crimes: z.array(termSchema),
              caseStatuses: z.array(termSchema),
              personStatuses: z.array(termSchema),
              interestKinds: z.array(termSchema),
            }),
          },
        },
      },
      async () => ({ crimes: CASE_CRIMES, caseStatuses: CASE_STATUSES, personStatuses: PERSON_STATUSES, interestKinds: INTEREST_KINDS }),
    );

    app.get(
      "/cases",
      {
        schema: {
          tags: ["cases"],
          summary: "Published cases involving political officeholders, latest development first",
          querystring: z.object({
            party: z.string().max(50).optional().describe("Party slug (at the time) of anyone involved"),
            deputy: z.coerce.number().int().positive().optional(),
            member: z.string().max(64).optional().describe("Government member id"),
            status: caseStatusSchema.optional(),
            crime: crimeSchema.optional(),
            page: z.coerce.number().int().min(1).max(1000).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
          response: { 200: z.object({ items: z.array(caseSummarySchema), total: z.number() }), 400: errorSchema },
        },
      },
      async (request) => {
        const { party, deputy, member, status, crime, page, limit } = request.query;
        const where: SQL[] = [sql`c.published`];
        if (status) where.push(sql`c.status = ${status}`);
        if (crime) where.push(sql`c.crimes @> array[${crime}]::text[]`);
        const person = (condition: SQL) => sql`exists (select 1 from case_people p where p.case_id = c.id and ${condition})`;
        if (party) where.push(person(sql`p.party_id = (select id from parties where slug = ${party})`));
        if (deputy) where.push(person(sql`p.deputy_id = ${deputy}`));
        if (member) where.push(person(sql`p.government_member_id = ${member}`));
        const condition = sql.join(where, sql` and `);
        const [rows, total] = await Promise.all([
          db.execute<{ id: number }>(sql`
            select c.id from cases c where ${condition}
            order by c.status_date desc nulls last, c.id desc limit ${limit} offset ${(page - 1) * limit}`),
          db.execute<{ n: number }>(sql`select count(*)::int as n from cases c where ${condition}`),
        ]);
        const items = await present(await loadCases(db, rows.rows.map((r) => r.id)));
        return {
          items: items.map(({ summary: _s, events: _e, sources: _src, ...c }) => ({
            ...c,
            people: c.people.map(({ outcome: _o, ...p }) => p),
          })),
          total: total.rows[0]?.n ?? 0,
        };
      },
    );

    app.get(
      "/cases/:id",
      {
        schema: {
          tags: ["cases"],
          summary: "One published case: who, what stage, what happened when, and the sources",
          params: z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) }),
          response: { 200: caseSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request) => {
        const [found] = await loadCases(db, [request.params.id]);
        if (!found?.published) throw notFound("Case");
        return (await present([found]))[0]!;
      },
    );

    // Declared interests.

    const interestRows = async (condition: SQL) => {
      const rows = await db.execute<{
        id: number; person_name: string; deputy_id: number | null; government_member_id: string | null; kind: string;
        entity_name: string; nif: string | null; description: string | null; start_date: string | null; end_date: string | null;
        declared_at: string | null; source_url: string; source_title: string;
        won_count: number | null; won_total: number | null; during_count: number | null; during_total: number | null;
      }>(sql`
        select i.id, i.person_name, i.deputy_id, i.government_member_id, i.kind, i.entity_name, i.nif, i.description,
          i.start_date::text, i.end_date::text, i.declared_at::text, i.source_url, i.source_title,
          w.won_count, w.won_total, w.during_count, w.during_total
        from interests i
        left join lateral (
          select count(*)::int as won_count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as won_total,
            (count(*) filter (where ${during}))::int as during_count,
            round(coalesce(sum(c.price) filter (where ${during}), 0)::numeric, 2)::float8 as during_total
          from contract_parties cp join contracts c on c.id = cp.contract_id
          where i.nif is not null and cp.nif = i.nif and cp.role = 'supplier'
        ) w on true
        where i.published and ${condition}
        order by w.won_total desc nulls last, i.person_name, i.entity_name`);
      return rows.rows.map((r) => ({
        id: r.id, personName: r.person_name, deputyId: r.deputy_id, governmentMemberId: r.government_member_id,
        kind: term(interestKinds, r.kind), entityName: r.entity_name, nif: r.nif, description: r.description,
        startDate: r.start_date, endDate: r.end_date, declaredAt: r.declared_at,
        source: { url: r.source_url, title: r.source_title },
        contracts: r.nif
          ? { won: { count: r.won_count ?? 0, total: r.won_total ?? 0 }, duringInterest: { count: r.during_count ?? 0, total: r.during_total ?? 0 } }
          : null,
      }));
    };
    // A contract counts as during the interest when its signing (or publication) date falls within the declared period.
    const during = sql`(i.start_date is not null and coalesce(c.signed_at, c.published_at) >= i.start_date
      and (i.end_date is null or coalesce(c.signed_at, c.published_at) <= i.end_date))`;

    app.get(
      "/interests",
      {
        schema: {
          tags: ["cases"],
          summary: "Officeholders' declared interests, curated from their declarations, with public contracts the entities won",
          querystring: z.object({
            deputy: z.coerce.number().int().positive().optional(),
            member: z.string().max(64).optional().describe("Government member id"),
            nif: z.string().regex(/^\d{9}$/).optional().describe("Entity NIF"),
          }),
          response: { 200: z.object({ items: z.array(interestSchema) }), 400: errorSchema },
        },
      },
      async (request) => {
        const { deputy, member, nif } = request.query;
        // Raw conditions: the query aliases the table as "i".
        const conditions: SQL[] = [sql`true`];
        if (deputy) conditions.push(sql`i.deputy_id = ${deputy}`);
        if (member) conditions.push(sql`i.government_member_id = ${member}`);
        if (nif) conditions.push(sql`i.nif = ${nif}`);
        return { items: await interestRows(sql.join(conditions, sql` and `)) };
      },
    );

    app.get(
      "/interests/contracts",
      {
        schema: {
          tags: ["cases"],
          summary: "Declared interests whose entity won public contracts, biggest totals first",
          response: { 200: z.object({ items: z.array(interestSchema) }) },
        },
      },
      async () => ({
        items: (await interestRows(sql`exists (select 1 from contract_parties cp where cp.nif = i.nif and cp.role = 'supplier')`)),
      }),
    );
  };
