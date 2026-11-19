import { and, asc, count, eq, gt, inArray, like, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { adminGuard, audit } from "../../admin/sessions.js";
import { AGENDA_KINDS, type AgendaInput, toRow } from "../../agenda/store.js";
import { loadDistricts } from "../../agenda/sync.js";
import { fromLisbon, lisbonDay, toLisbonIso } from "../../agenda/time.js";
import type { Db } from "../../db/client.js";
import { agendaEvents, parties } from "../../db/schema.js";
import { slugify } from "../../editorial/media.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

export const DISTRICTS = [
  "Aveiro", "Beja", "Braga", "Bragança", "Castelo Branco", "Coimbra", "Évora", "Faro", "Guarda", "Leiria", "Lisboa",
  "Portalegre", "Porto", "Santarém", "Setúbal", "Viana do Castelo", "Vila Real", "Viseu", "Açores", "Madeira",
] as const;

const kindSchema = z.enum(AGENDA_KINDS);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/;
/** A day that exists ("2026-02-31" doesn't: Date.UTC would quietly make it 3 March). */
const realDay = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
const daySchema = z.string().regex(DAY).refine(realDay, "Not a real day");

const placeSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  municipality: z.string().nullable(),
  district: z.string().nullable().describe("One of the 18 districts, Açores or Madeira; null abroad"),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});
const itemSchema = z.object({
  id: z.string().describe("Stable across imports"),
  kind: kindSchema,
  title: z.string(),
  summary: z.string().nullable().describe("Plain text, with line breaks"),
  start: z.string().describe('"2026-11-17T15:00:00+00:00" (Lisbon time with its offset), or a bare day when allDay'),
  end: z.string().nullable().describe("Same format as start; for allDay, the last day (inclusive) of a multi-day event"),
  allDay: z.boolean(),
  status: z.enum(["scheduled", "cancelled", "postponed"]),
  place: placeSchema.nullable(),
  online: z.object({ url: z.string(), label: z.string().nullable() }).nullable(),
  attend: z.object({ open: z.boolean(), how: z.string().nullable(), url: z.string().nullable() }),
  organizer: z.string().nullable(),
  parties: z.array(z.object({ slug: z.string(), acronym: z.string() })),
  sourceUrl: z.string().nullable(),
  featured: z.boolean(),
});
const adminItemSchema = itemSchema.extend({
  source: z.enum(["parliament", "president", "europarl", "editorial"]),
  hidden: z.boolean(),
  partySlugs: z.array(z.string()),
  updatedAt: z.string(),
});

type Row = typeof agendaEvents.$inferSelect;

const commaList = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .max(500)
    .transform((value) => [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(values)).min(1));

const encodeCursor = (row: { startsAt: Date; id: string }) =>
  Buffer.from(JSON.stringify([row.startsAt.toISOString(), row.id])).toString("base64url");
const decodeCursor = (cursor: string) => {
  try {
    const [startsAt, id] = z.tuple([z.iso.datetime(), z.string()]).parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
    return { startsAt, id };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Invalid cursor");
  }
};

const httpsUrl = z.url({ protocol: /^https?$/ }).max(1000);
const inputSchema = z
  .object({
    kind: kindSchema,
    title: z.string().trim().min(3).max(200),
    summary: z.string().trim().max(2000).nullable(),
    allDay: z.boolean(),
    start: z.string().describe('Lisbon time: "2026-11-17T15:00", or "2026-11-21" when allDay'),
    end: z.string().nullable().describe('Same format; for allDay, the last day (inclusive). Null when unknown or one day'),
    status: z.enum(["scheduled", "cancelled", "postponed"]),
    place: z
      .object({
        name: z.string().trim().min(1).max(200),
        address: z.string().trim().max(300).nullable(),
        municipality: z.string().trim().max(100).nullable(),
        district: z.enum(DISTRICTS).nullable().describe("Filled in from the municipality when left null"),
        lat: z.number().min(-90).max(90).nullable(),
        lng: z.number().min(-180).max(180).nullable(),
      })
      .nullable(),
    online: z.object({ url: httpsUrl, label: z.string().trim().max(100).nullable() }).nullable(),
    attend: z.object({ open: z.boolean(), how: z.string().trim().max(500).nullable(), url: httpsUrl.nullable() }),
    organizer: z.string().trim().max(200).nullable(),
    partySlugs: z.array(z.string()).max(12),
    sourceUrl: httpsUrl.nullable(),
  })
  .superRefine((input, ctx) => {
    const shape = input.allDay ? DAY : DAY_TIME;
    const want = input.allDay ? '"2026-11-21"' : '"2026-11-17T15:00"';
    if (!shape.test(input.start) || !realDay(input.start.slice(0, 10))) ctx.addIssue({ code: "custom", path: ["start"], message: `Use ${want}` });
    if (input.end !== null && (!shape.test(input.end) || !realDay(input.end.slice(0, 10)))) ctx.addIssue({ code: "custom", path: ["end"], message: `Use ${want}` });
    if (input.end !== null && input.end < input.start) ctx.addIssue({ code: "custom", path: ["end"], message: "Ends before it starts" });
  });

const idParams = z.object({ id: z.string().regex(/^[a-z0-9-]{3,120}$/) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

export const agendaRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    const partyAcronyms = async () =>
      new Map((await db.select({ slug: parties.slug, acronym: parties.acronym }).from(parties)).map((p) => [p.slug, p.acronym]));

    const present = (row: Row, acronyms: Map<string, string>) => ({
      id: row.id,
      kind: row.kind as z.infer<typeof kindSchema>,
      title: row.title,
      summary: row.summary,
      start: row.allDay ? row.startDay : toLisbonIso(row.startsAt),
      end: row.allDay ? row.endDay : row.endsAt ? toLisbonIso(row.endsAt) : null,
      allDay: row.allDay,
      status: row.status,
      place: row.place,
      online: row.online,
      attend: row.attend,
      organizer: row.organizer,
      parties: row.partySlugs.filter((slug) => acronyms.has(slug)).map((slug) => ({ slug, acronym: acronyms.get(slug)! })),
      sourceUrl: row.sourceUrl,
      featured: row.featured,
    });
    const presentAdmin = (row: Row, acronyms: Map<string, string>) => ({
      ...present(row, acronyms),
      source: row.source,
      hidden: row.hidden,
      partySlugs: row.partySlugs,
      updatedAt: row.updatedAt.toISOString(),
    });

    app.get(
      "/agenda",
      {
        schema: {
          tags: ["agenda"],
          summary: "The political calendar: what hasn't ended yet, soonest first",
          querystring: z.object({
            from: daySchema.optional().describe("A day; default today in Lisbon"),
            kind: commaList(AGENDA_KINDS).optional().describe(`One or more, comma-separated: ${AGENDA_KINDS.join(", ")}`),
            district: z.enum(DISTRICTS).optional(),
            open: z.enum(["true", "false"]).optional().describe("true: only events the public can attend"),
            cursor: z.string().max(200).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable(), total: z.number() }), 400: errorSchema },
        },
      },
      async (request) => {
        const { from, kind, district, open, cursor, limit } = request.query;
        const now = new Date();
        const fromStart = from ? fromLisbon(from) : now;
        const conditions: SQL[] = [eq(agendaEvents.hidden, false), gt(agendaEvents.until, fromStart > now ? fromStart : now)];
        if (kind) conditions.push(inArray(agendaEvents.kind, kind));
        if (district) conditions.push(eq(agendaEvents.district, district));
        if (open === "true") conditions.push(sql`(${agendaEvents.attend}->>'open')::boolean`);
        const after = cursor ? decodeCursor(cursor) : null;
        const page = after
          ? and(...conditions, sql`(${agendaEvents.startsAt}, ${agendaEvents.id}) > (${after.startsAt}::timestamptz, ${after.id})`)
          : and(...conditions);

        const [rows, [counted], acronyms] = await Promise.all([
          db.select().from(agendaEvents).where(page).orderBy(asc(agendaEvents.startsAt), asc(agendaEvents.id)).limit(limit + 1),
          db.select({ total: count() }).from(agendaEvents).where(and(...conditions)),
          partyAcronyms(),
        ]);
        const items = rows.slice(0, limit);
        return {
          items: items.map((row) => present(row, acronyms)),
          nextCursor: rows.length > limit ? encodeCursor(items.at(-1)!) : null,
          total: counted?.total ?? 0,
        };
      },
    );

    // Admin: editors add their own events (congresses, rallies, interviews, Government
    // meetings, elections…) and feature or hide any, imported ones included.

    const load = async (id: string) => {
      const [row] = await db.select().from(agendaEvents).where(eq(agendaEvents.id, id));
      if (!row) throw notFound("Event");
      return row;
    };
    const editorialOnly = (row: Row) => {
      if (row.source !== "editorial") {
        throw new ApiError(400, "imported", "Imported events are replaced on every sync: feature or hide it instead");
      }
    };

    const toInput = async (body: z.infer<typeof inputSchema>, id: string): Promise<AgendaInput> => {
      if (body.partySlugs.length > 0) {
        const acronyms = await partyAcronyms();
        const unknown = body.partySlugs.filter((slug) => !acronyms.has(slug));
        if (unknown.length > 0) throw new ApiError(400, "unknown_party", `Unknown party: ${unknown.join(", ")}`);
      }
      const [startDay, startTime] = body.allDay ? [body.start, null] : [DAY_TIME.exec(body.start)![1]!, DAY_TIME.exec(body.start)![2]!];
      const end = body.end && !body.allDay ? DAY_TIME.exec(body.end) : null;
      let place = body.place ? { ...body.place, district: body.place.district as string | null } : null;
      if (place && !place.district && place.municipality) place = { ...place, district: (await loadDistricts(db))(place.municipality) };
      return {
        id,
        kind: body.kind,
        title: body.title,
        summary: body.summary || null,
        allDay: body.allDay,
        startDay,
        startTime,
        endDay: body.allDay ? body.end : (end?.[1] ?? null),
        endTime: end?.[2] ?? null,
        status: body.status,
        place,
        online: body.online,
        attend: body.attend,
        organizer: body.organizer || null,
        partySlugs: [...new Set(body.partySlugs)],
        sourceUrl: body.sourceUrl,
      };
    };
    const newId = async (startDay: string, title: string) => {
      const base = `ed-${startDay}-${slugify(title).slice(0, 60).replace(/-+$/, "")}`;
      const taken = new Set(
        (await db.select({ id: agendaEvents.id }).from(agendaEvents).where(like(agendaEvents.id, `${base}%`))).map((r) => r.id),
      );
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      return id;
    };

    app.get(
      "/admin/agenda",
      {
        schema: {
          tags: ["admin"],
          summary: "Events from a day on (default today), hidden ones included, soonest first",
          querystring: z.object({
            from: daySchema.optional(),
            source: z.enum(["parliament", "president", "europarl", "editorial"]).optional(),
          }),
          response: { 200: z.object({ items: z.array(adminItemSchema) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request);
        const { from, source } = request.query;
        const rows = await db
          .select()
          .from(agendaEvents)
          .where(and(gt(agendaEvents.until, fromLisbon(from ?? lisbonDay(new Date()))), source ? eq(agendaEvents.source, source) : undefined))
          .orderBy(asc(agendaEvents.startsAt), asc(agendaEvents.id))
          .limit(500);
        const acronyms = await partyAcronyms();
        return { items: rows.map((row) => presentAdmin(row, acronyms)) };
      },
    );

    app.post(
      "/admin/agenda",
      { schema: { tags: ["admin"], summary: "Add an event", body: inputSchema, response: { 201: adminItemSchema, ...errors } } },
      async (request, reply) => {
        const me = await requireAdmin(request);
        const id = await newId(request.body.allDay ? request.body.start : request.body.start.slice(0, 10), request.body.title);
        const [created] = await db
          .insert(agendaEvents)
          .values({ ...toRow(await toInput(request.body, id), "editorial"), createdBy: me.id })
          .returning();
        const acronyms = await partyAcronyms();
        await audit(db, me.id, "agenda.create", "agenda", created!.id, null, presentAdmin(created!, acronyms));
        return reply.status(201).send(presentAdmin(created!, acronyms));
      },
    );

    app.put(
      "/admin/agenda/:id",
      {
        schema: { tags: ["admin"], summary: "Replace an editors' event (imported ones can't be edited)", params: idParams, body: inputSchema, response: { 200: adminItemSchema, ...errors } },
      },
      async (request) => {
        const me = await requireAdmin(request);
        const before = await load(request.params.id);
        editorialOnly(before);
        const { id: _id, source: _source, ...fields } = toRow(await toInput(request.body, before.id), "editorial");
        const [after] = await db.update(agendaEvents).set({ ...fields, updatedAt: new Date() }).where(eq(agendaEvents.id, before.id)).returning();
        const acronyms = await partyAcronyms();
        await audit(db, me.id, "agenda.update", "agenda", before.id, presentAdmin(before, acronyms), presentAdmin(after!, acronyms));
        return presentAdmin(after!, acronyms);
      },
    );

    const toggles = [
      { name: "feature", set: { featured: true }, summary: "Show it in the front page box (moderators)" },
      { name: "unfeature", set: { featured: false }, summary: "Take it out of the front page box" },
      { name: "hide", set: { hidden: true, featured: false }, summary: "Leave it out of the public calendar, even after imports (moderators)" },
      { name: "unhide", set: { hidden: false }, summary: "Show it again" },
    ] as const;
    for (const t of toggles) {
      app.post(
        `/admin/agenda/:id/${t.name}`,
        { schema: { tags: ["admin"], summary: t.summary, params: idParams, response: { 200: adminItemSchema, ...errors } } },
        async (request) => {
          const me = await requireAdmin(request, "moderator");
          const before = await load(request.params.id);
          const [after] = await db.update(agendaEvents).set({ ...t.set, updatedAt: new Date() }).where(eq(agendaEvents.id, before.id)).returning();
          await audit(db, me.id, `agenda.${t.name}`, "agenda", before.id);
          return presentAdmin(after!, await partyAcronyms());
        },
      );
    }

    app.delete(
      "/admin/agenda/:id",
      { schema: { tags: ["admin"], summary: "Delete an editors' event (hide imported ones instead)", params: idParams, response: { 204: z.null(), ...errors } } },
      async (request, reply) => {
        const me = await requireAdmin(request);
        const before = await load(request.params.id);
        editorialOnly(before);
        await db.delete(agendaEvents).where(eq(agendaEvents.id, before.id));
        await audit(db, me.id, "agenda.delete", "agenda", before.id, presentAdmin(before, await partyAcronyms()), null);
        return reply.status(204).send(null);
      },
    );
  };
