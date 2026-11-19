import { type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CONTRACTS_DATASET_URL, PROCEDURES, type ProcedureKind, baseContractUrl } from "../../contracts/base.js";
import type { Db } from "../../db/client.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";
import { cacheKey, createVersionedCache } from "./cache.js";

const procedureKinds = PROCEDURES.map((p) => p.kind) as [ProcedureKind, ...ProcedureKind[]];
const procedureByKind = new Map(PROCEDURES.map((p) => [p.kind, p]));
const procedureLabel = (kind: string) => procedureByKind.get(kind as ProcedureKind)?.label ?? kind;

const nifSchema = z.string().regex(/^[A-Za-z0-9-]{1,20}$/);

const filtersSchema = z.object({
  procedure: z.enum(procedureKinds).optional().describe("Procedure kind; see GET /contracts/procedures"),
  entity: nifSchema.optional().describe("NIF of the public body that awarded it"),
  supplier: nifSchema.optional().describe("NIF of the company (or person) it went to"),
  place: z
    .string()
    .regex(/^LOCAL-\d{6}$/)
    .optional()
    .describe("Municipality or district key (places.key, e.g. LOCAL-060300) where it is carried out"),
  q: z.string().trim().min(2).max(200).optional().describe("Words in the contract's object"),
  from: z.iso.date().optional().describe("Published on or after"),
  to: z.iso.date().optional().describe("Published on or before"),
  minPrice: z.coerce.number().min(0).optional().describe("Price in euros, without VAT"),
});
type Filters = z.infer<typeof filtersSchema>;

const conditionsOf = (f: Filters): SQL => {
  const parts: SQL[] = [sql`true`];
  if (f.procedure) parts.push(sql`c.procedure_kind = ${f.procedure}`);
  if (f.entity) parts.push(sql`exists (select 1 from contract_parties p where p.contract_id = c.id and p.role = 'entity' and p.nif = ${f.entity})`);
  if (f.supplier) parts.push(sql`exists (select 1 from contract_parties p where p.contract_id = c.id and p.role = 'supplier' and p.nif = ${f.supplier})`);
  if (f.place) parts.push(sql`c.place_keys @> array[${f.place}]::text[]`);
  if (f.q) parts.push(sql`to_tsvector('portuguese', c.object) @@ websearch_to_tsquery('portuguese', ${f.q})`);
  if (f.from) parts.push(sql`c.published_at >= ${f.from}::date`);
  if (f.to) parts.push(sql`c.published_at <= ${f.to}::date`);
  if (f.minPrice !== undefined) parts.push(sql`c.price >= ${f.minPrice}`);
  return sql.join(parts, sql` and `);
};

const partySchema = z.object({ nif: z.string(), name: z.string() });
const procedureSchema = z.object({
  kind: z.enum(procedureKinds),
  label: z.string(),
  published: z.string().describe("The procedure exactly as published"),
});

const summarySchema = z.object({
  id: z.string(),
  object: z.string().describe("What was contracted, as published"),
  procedure: procedureSchema,
  contractTypes: z.array(z.string()).describe('e.g. "Aquisição de serviços", "Empreitadas de obras públicas"'),
  price: z.number().describe("Euros, without VAT"),
  publishedAt: z.string(),
  signedAt: z.string().nullable(),
  entities: z.array(partySchema).describe("Public bodies that awarded it (usually one)"),
  suppliers: z.array(partySchema).describe("Who it went to"),
  places: z.array(z.string()).describe('Where it is carried out, as published: "Portugal, Coimbra, Coimbra"'),
  baseUrl: z.string().describe("The contract on base.gov.pt"),
});

type Row = {
  id: string; object: string; procedure_kind: ProcedureKind; procedure: string; contract_types: string[]; price: number;
  published_at: string; signed_at: string | null; places: string[];
};

const cursorSchema = z.object({ v: z.union([z.string(), z.number()]), id: z.string() });
/** A real calendar day, as Postgres will read it ("2026-02-31" isn't). */
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const encodeCursor = (cursor: z.infer<typeof cursorSchema>) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (value: string) => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

const groupSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number(),
  total: z.number().describe("Sum of prices, euros without VAT"),
});

const statsBy = z.enum(["year", "month", "procedure", "entity", "supplier", "municipality", "district"]);
const proceduresQuery = filtersSchema.omit({ procedure: true });
const statsQuery = filtersSchema.extend({
  by: statsBy,
  order: z.enum(["total", "count"]).default("total").describe("For entity, supplier and places: biggest first by this"),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("For entity, supplier and places"),
});

/** What the contracts page asks for with no filters: kept ready, so nobody waits for it. */
const WARM = {
  procedures: [{}],
  stats: [{ by: "year" }, { by: "entity", limit: "8" }, { by: "supplier", limit: "8" }, { by: "municipality", limit: "8" }],
};

export interface ContractRoutesOptions {
  /** Compute the contracts page's default totals at start and after every import (the server; not tests). */
  warm?: boolean;
  /** How often to look for a new import, in ms (default every request: tests change data often). */
  recheckMs?: number;
}

export const contractRoutes =
  (db: Db, { warm = false, recheckMs = 0 }: ContractRoutesOptions = {}): FastifyPluginAsyncZod =>
  async (app) => {
    // Totals and charts scan every contract, and the data only changes when the weekly import
    // runs: keep the answers until contract_imports says there's new data.
    const cache = createVersionedCache<unknown>({
      version: async () =>
        (await db.execute<{ v: string | null }>(sql`select max(imported_at)::text as v from contract_imports`)).rows[0]?.v ?? "none",
      checkEveryMs: recheckMs,
    });
    const cached = <T>(name: string, query: Record<string, unknown>, compute: () => Promise<T>) =>
      cache.get(cacheKey(name, query), compute) as Promise<T>;

    if (warm) {
      const fill = async () => {
        try {
          await Promise.all([
            ...WARM.procedures.map((q) => procedureTotals(proceduresQuery.parse(q))),
            ...WARM.stats.map((q) => stats(statsQuery.parse(q))),
          ]);
        } catch (error) {
          app.log.warn({ err: error }, "Couldn't precompute the contracts totals");
        }
      };
      // After a deploy, and whenever the weekly import lands (checked every 10 minutes).
      app.addHook("onReady", async () => void fill());
      const timer = setInterval(() => {
        cache.refresh(true).then(
          async (changed) => {
            if (changed) await fill();
          },
          () => {},
        );
      }, 10 * 60_000);
      timer.unref();
      app.addHook("onClose", async () => clearInterval(timer));
    }

    const partiesOf = async (ids: string[]) => {
      const map = new Map<string, { entities: z.infer<typeof partySchema>[]; suppliers: z.infer<typeof partySchema>[] }>();
      if (ids.length === 0) return map;
      const rows = await db.execute<{ contract_id: string; role: string; nif: string; name: string }>(sql`
        select contract_id, role, nif, name from contract_parties
        where contract_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        order by contract_id, role, position`);
      for (const r of rows.rows) {
        const entry = map.get(r.contract_id) ?? { entities: [], suppliers: [] };
        (r.role === "entity" ? entry.entities : entry.suppliers).push({ nif: r.nif, name: r.name });
        map.set(r.contract_id, entry);
      }
      return map;
    };

    const summaries = async (rows: Row[]) => {
      const parties = await partiesOf(rows.map((r) => r.id));
      return rows.map((r) => ({
        id: r.id,
        object: r.object,
        procedure: { kind: r.procedure_kind, label: procedureLabel(r.procedure_kind), published: r.procedure },
        contractTypes: r.contract_types,
        price: r.price,
        publishedAt: r.published_at,
        signedAt: r.signed_at,
        entities: parties.get(r.id)?.entities ?? [],
        suppliers: parties.get(r.id)?.suppliers ?? [],
        places: r.places,
        baseUrl: baseContractUrl(r.id),
      }));
    };

    const summaryColumns = sql`c.id, c.object, c.procedure_kind, c.procedure, c.contract_types, c.price,
      c.published_at::text as published_at, c.signed_at::text as signed_at, c.places`;

    app.get(
      "/contracts",
      {
        schema: {
          tags: ["contracts"],
          summary: "Public contracts from BASE, newest or most expensive first",
          querystring: filtersSchema.extend({
            sort: z.enum(["date", "price"]).default("date"),
            cursor: z.string().optional().describe("The nextCursor of the previous page"),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
          response: {
            200: z.object({ items: z.array(summarySchema), nextCursor: z.string().nullable() }),
            400: errorSchema,
          },
        },
      },
      async (request) => {
        const { sort, cursor, limit, ...filters } = request.query;
        const column = sort === "price" ? sql`c.price` : sql`c.published_at`;
        let after = sql`true`;
        if (cursor) {
          const c = decodeCursor(cursor);
          if (typeof c.v !== (sort === "price" ? "number" : "string") || (typeof c.v === "string" && !isDay(c.v))) throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
          after = sort === "price" ? sql`(c.price, c.id) < (${c.v}::float8, ${c.id})` : sql`(c.published_at, c.id) < (${c.v}::date, ${c.id})`;
        }
        const rows = await db.execute<Row>(sql`
          select ${summaryColumns} from contracts c
          where ${conditionsOf(filters)} and ${after}
          order by ${column} desc nulls last, c.id desc nulls last
          limit ${limit + 1}`);
        const page = rows.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: await summaries(page),
          nextCursor:
            rows.rows.length > limit && last ? encodeCursor({ v: sort === "price" ? last.price : last.published_at, id: last.id }) : null,
        };
      },
    );

    app.get(
      "/contracts/procedures",
      {
        schema: {
          tags: ["contracts"],
          summary: "Procedure kinds explained, with how many contracts and euros each accounts for",
          querystring: proceduresQuery,
          response: {
            200: z.object({
              items: z.array(z.object({ kind: z.enum(procedureKinds), label: z.string(), plain: z.string(), count: z.number(), total: z.number() })),
            }),
            400: errorSchema,
          },
        },
      },
      async (request) => procedureTotals(request.query),
    );

    app.get(
      "/contracts/stats",
      {
        schema: {
          tags: ["contracts"],
          summary: "Contract counts and totals grouped by year, month, procedure, entity, supplier or place",
          querystring: statsQuery,
          response: {
            200: z.object({
              by: statsBy,
              items: z.array(groupSchema),
              totals: z.object({ count: z.number(), total: z.number() }),
              updatedAt: z.string().nullable().describe("When the newest data was imported"),
              years: z.array(z.number()).describe("The years we have, complete (the current one so far)"),
              source: z.string(),
            }),
            400: errorSchema,
          },
        },
      },
      async (request) => stats(request.query),
    );

    async function procedureTotals(query: z.infer<typeof proceduresQuery>) {
      return cached("procedures", query, async () => {
        const rows = await db.execute<{ kind: string; count: number; total: number }>(sql`
          select c.procedure_kind as kind, count(*)::int as count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as total
          from contracts c where ${conditionsOf(query)} group by 1`);
        const byKind = new Map(rows.rows.map((r) => [r.kind, r]));
        return {
          items: PROCEDURES.map((p) => ({ ...p, count: byKind.get(p.kind)?.count ?? 0, total: byKind.get(p.kind)?.total ?? 0 })),
        };
      });
    }

    async function stats(query: z.infer<typeof statsQuery>) {
      return cached("stats", query, async () => {
        const { by, order, limit, ...filters } = query;
        const where = conditionsOf(filters);
        const top = sql`order by ${order === "count" ? sql`count` : sql`total`} desc, key limit ${limit}`;
        const aggregates = sql`count(*)::int as count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as total`;
        let statement: SQL;
        if (by === "year" || by === "month") {
          // By signing date (publication date when there is none): BASE splits its yearly files that way,
          // so each year we imported is complete. Years we didn't import are left out: the few contracts
          // dated in them (late or misdated records) would show as a tiny, misleading year.
          // A literal, not a parameter: Postgres must see key and label as the same expression.
          const period = sql.raw(
            by === "year" ? "to_char(coalesce(c.signed_at, c.published_at), 'YYYY')" : "to_char(coalesce(c.signed_at, c.published_at), 'YYYY-MM')",
          );
          statement = sql`select ${period} as key, ${period} as label, ${aggregates}
            from contracts c where ${where}
              and extract(year from coalesce(c.signed_at, c.published_at))::int in (select year from contract_imports)
            group by 1 order by 1`;
        } else if (by === "procedure") {
          statement = sql`select c.procedure_kind as key, c.procedure_kind as label, ${aggregates}
            from contracts c where ${where} group by 1 order by total desc`;
        } else if (by === "entity" || by === "supplier") {
          const role = by;
          statement = sql`select p.nif as key, max(p.name) as label, ${aggregates}
            from contracts c join contract_parties p on p.contract_id = c.id and p.role = ${role}
            where ${where} and p.nif <> '' group by p.nif ${top}`;
        } else {
          statement = sql`select pl.key, max(pl.name) as label, ${aggregates}
            from contracts c cross join unnest(c.place_keys) as k(key) join places pl on pl.key = k.key and pl.level = ${by}
            where ${where} group by pl.key ${top}`;
        }
        const [rows, totals, updated, years] = await Promise.all([
          db.execute<z.infer<typeof groupSchema>>(statement),
          db.execute<{ count: number; total: number }>(sql`select ${aggregates} from contracts c where ${where}`),
          db.execute<{ at: string | null }>(sql`select max(imported_at)::text as at from contract_imports`),
          db.execute<{ year: number }>(sql`select year::int from contract_imports order by year`),
        ]);
        return {
          by,
          items: rows.rows.map((r) => (by === "procedure" ? { ...r, label: procedureLabel(r.key) } : r)),
          totals: totals.rows[0] ?? { count: 0, total: 0 },
          updatedAt: updated.rows[0]?.at ?? null,
          years: years.rows.map((r) => r.year),
          source: CONTRACTS_DATASET_URL,
        };
      });
    }

    app.get(
      "/contracts/parties/:nif",
      {
        schema: {
          tags: ["contracts"],
          summary: "One public body or company: what it awarded, what it won, and with whom",
          params: z.object({ nif: nifSchema }),
          response: {
            200: z.object({
              nif: z.string(),
              name: z.string().describe("The name it most often appears under"),
              asEntity: z.object({ count: z.number(), total: z.number(), directAwards: z.number(), counterparts: z.array(groupSchema) }),
              asSupplier: z.object({ count: z.number(), total: z.number(), directAwards: z.number(), counterparts: z.array(groupSchema) }),
              latest: z.array(summarySchema).describe("Its newest contracts, either side"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        // A big public body has tens of thousands of contracts: cached like the totals.
        const party = await cached("party", { nif: request.params.nif }, () => partyOf(request.params.nif));
        if (!party) throw notFound("Contract party");
        return party;
      },
    );

    async function partyOf(nif: string) {
      const names = await db.execute<{ name: string }>(sql`
        select name from contract_parties where nif = ${nif} group by name order by count(*) desc limit 1`);
      const name = names.rows[0]?.name;
      if (!name) return null;

      const side = async (role: "entity" | "supplier") => {
        const other = role === "entity" ? "supplier" : "entity";
        const [totals, counterparts] = await Promise.all([
          db.execute<{ count: number; total: number; direct: number }>(sql`
            select count(*)::int as count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as total,
              count(*) filter (where c.procedure_kind in ('direct_award', 'direct_award_simplified'))::int as direct
            from contract_parties p join contracts c on c.id = p.contract_id
            where p.nif = ${nif} and p.role = ${role}`),
          db.execute<z.infer<typeof groupSchema>>(sql`
            select o.nif as key, max(o.name) as label, count(*)::int as count, round(coalesce(sum(c.price), 0)::numeric, 2)::float8 as total
            from contract_parties p
            join contracts c on c.id = p.contract_id
            join contract_parties o on o.contract_id = p.contract_id and o.role = ${other} and o.nif <> ''
            where p.nif = ${nif} and p.role = ${role}
            group by o.nif order by total desc, key limit 10`),
        ]);
        const t = totals.rows[0]!;
        return { count: t.count, total: t.total, directAwards: t.direct, counterparts: counterparts.rows };
      };

      const [asEntity, asSupplier, latest] = await Promise.all([
        side("entity"),
        side("supplier"),
        db.execute<Row>(sql`
          select ${summaryColumns} from contracts c
          where c.id in (select contract_id from contract_parties where nif = ${nif})
          order by c.published_at desc nulls last, c.id desc nulls last limit 10`),
      ]);
      return { nif, name, asEntity, asSupplier, latest: await summaries(latest.rows) };
    }

    app.get(
      "/contracts/:id",
      {
        schema: {
          tags: ["contracts"],
          summary: "One contract, with everything BASE publishes about it that we keep",
          params: z.object({ id: z.string().regex(/^\d{1,12}$/) }),
          response: {
            200: summarySchema.extend({
              description: z.string().nullable().describe("Longer description, when different from the object"),
              procedureExplained: z.string().describe("What this kind of procedure means, in plain Portuguese"),
              basePrice: z.number().nullable().describe("The procedure's base price"),
              effectivePrice: z.number().nullable().describe("What was actually paid, once the contract closed"),
              cpv: z.object({ code: z.string(), description: z.string().nullable() }).nullable().describe("EU procurement category"),
              deadlineDays: z.number().nullable(),
              municipalities: z.array(z.object({ key: z.string(), name: z.string() })),
              legalBasis: z.string().nullable(),
              directAwardReason: z.string().nullable().describe("For direct awards: why it wasn't opened to competition"),
              frameworkAgreement: z.string().nullable(),
              centralized: z.boolean().nullable(),
              invited: z.number().nullable().describe("Companies invited to bid, when listed"),
              documentsUrl: z.string().nullable().describe("Procedure documents, on the e-procurement platform"),
              status: z.string().nullable(),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => {
        const rows = await db.execute<
          Row & {
            description: string | null; base_price: number | null; effective_price: number | null; cpv: string | null;
            cpv_description: string | null; deadline_days: number | null; place_keys: string[]; legal_basis: string | null;
            direct_award_reason: string | null; framework_agreement: string | null; centralized: boolean | null;
            invited: number | null; documents_url: string | null; status: string | null;
          }
        >(sql`select ${summaryColumns}, c.description, c.base_price, c.effective_price, c.cpv, c.cpv_description,
            c.deadline_days, c.place_keys, c.legal_basis, c.direct_award_reason, c.framework_agreement, c.centralized,
            c.invited, c.documents_url, c.status
          from contracts c where c.id = ${request.params.id}`);
        const row = rows.rows[0];
        if (!row) throw notFound("Contract");
        const [summary] = await summaries([row]);
        const municipalities = row.place_keys.length
          ? (
              await db.execute<{ key: string; name: string }>(sql`
                select key, name from places where level = 'municipality'
                and key in (${sql.join(row.place_keys.map((k) => sql`${k}`), sql`, `)}) order by name`)
            ).rows
          : [];
        return {
          ...summary!,
          description: row.description,
          procedureExplained: procedureByKind.get(row.procedure_kind)?.plain ?? "",
          basePrice: row.base_price,
          effectivePrice: row.effective_price,
          cpv: row.cpv ? { code: row.cpv, description: row.cpv_description } : null,
          deadlineDays: row.deadline_days,
          municipalities,
          legalBasis: row.legal_basis,
          directAwardReason: row.direct_award_reason,
          frameworkAgreement: row.framework_agreement,
          centralized: row.centralized,
          invited: row.invited,
          documentsUrl: row.documents_url,
          status: row.status,
        };
      },
    );
  };
