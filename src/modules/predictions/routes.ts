import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Reader } from "../../accounts/sessions.js";
import type { Db } from "../../db/client.js";
import { initiatives, predictions } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { STAGE_GROUP_SQL } from "../../parliament/plain.js";
import { OPEN_FOR_PREDICTION, record } from "../../predictions/index.js";
import { errorSchema } from "../shared.js";

/*
 * "Passa ou chumba?" (src/predictions). Anyone can see what's open; predicting needs an
 * account. The crowd's split is shown only to readers who already picked, so it can't steer
 * them. Each reader's record is theirs alone: there's no leaderboard.
 */

const MAX_INT = 2_147_483_647;
const idParams = z.object({ initiativeId: z.coerce.number().int().positive().max(MAX_INT) });
const pickSchema = z.enum(["pass", "fail"]);
const splitSchema = z.object({ pass: z.number(), fail: z.number() }).nullable().describe("How everyone picked; only once this reader has picked");

const openItemSchema = z.object({
  id: z.number().describe("The initiative (GET /initiatives/:id)"),
  type: z.string(),
  number: z.string(),
  title: z.string(),
  phase: z.string().describe("Its latest stage"),
  phaseDate: z.string(),
  onAgenda: z.boolean().describe("Named in an upcoming plenary agenda: likely voted soon"),
  myPick: pickSchema.nullable(),
  split: splitSchema,
});

const myItemSchema = z.object({
  initiativeId: z.number(),
  title: z.string(),
  pick: pickSchema,
  outcome: z.enum(["hit", "miss", "void"]).nullable().describe("Null while waiting for the vote"),
  voteDate: z.string().nullable(),
  voteResult: z.string().nullable().describe('"Aprovado", "Rejeitado" or "Prejudicado"'),
  updatedAt: z.string(),
  split: splitSchema,
});

export const predictionRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireReader = (request: FastifyRequest): Reader => {
      if (!request.reader) throw new ApiError(401, "login_required", "Log in to predict");
      return request.reader;
    };
    const split = async (initiativeId: number) => {
      const [row] = await db
        .select({
          pass: sql<number>`count(*) filter (where ${predictions.pick} = 'pass')::int`,
          fail: sql<number>`count(*) filter (where ${predictions.pick} = 'fail')::int`,
        })
        .from(predictions)
        .where(eq(predictions.initiativeId, initiativeId));
      return { pass: row?.pass ?? 0, fail: row?.fail ?? 0 };
    };

    app.get(
      "/predictions/open",
      {
        schema: {
          tags: ["predictions"],
          summary: '"Passa ou chumba?": initiatives waiting for a deciding vote, likeliest to be voted soon first',
          description: "Those named in an upcoming plenary agenda come first, then those in debate, then the newest.",
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
          response: { 200: z.object({ items: z.array(openItemSchema) }) },
        },
      },
      async (request, reply) => {
        const userId = request.reader?.id ?? null;
        if (userId) reply.header("Cache-Control", "private, no-store");
        // An agenda names them as "Proposta de Lei n.º 110/XVII/2.ª".
        const rows = (
          await db.execute<{
            id: number; type: string; number: string; title: string; phase: string; phase_date: string;
            on_agenda: boolean; my_pick: "pass" | "fail" | null; pass: number | null; fail: number | null;
          }>(sql`
            select initiatives.id, initiatives.type, initiatives.number, initiatives.title, initiatives.phase, initiatives.phase_date,
              exists (select 1 from agenda_events e where e.source = 'parliament' and not e.hidden and e.until > now()
                and strpos(coalesce(e.summary, '') || ' ' || e.title, initiatives.type || ' n.º ' || initiatives.number || '/' || initiatives.legislature) > 0) as on_agenda,
              mine.pick as my_pick,
              case when mine.pick is not null then (select count(*) filter (where p.pick = 'pass') from predictions p where p.initiative_id = initiatives.id)::int end as pass,
              case when mine.pick is not null then (select count(*) filter (where p.pick = 'fail') from predictions p where p.initiative_id = initiatives.id)::int end as fail
            from initiatives
            left join predictions mine on mine.initiative_id = initiatives.id and mine.user_id = ${userId}
            where initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}
            order by on_agenda desc, (${sql.raw(STAGE_GROUP_SQL)} = 'debate') desc, initiatives.phase_date desc, initiatives.id desc
            limit ${request.query.limit}`)
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            type: r.type,
            number: r.number,
            title: r.title,
            phase: r.phase,
            phaseDate: typeof r.phase_date === "string" ? r.phase_date : new Date(r.phase_date).toISOString().slice(0, 10),
            onAgenda: r.on_agenda,
            myPick: r.my_pick,
            split: r.my_pick ? { pass: r.pass ?? 0, fail: r.fail ?? 0 } : null,
          })),
        };
      },
    );

    app.put(
      "/predictions/:initiativeId",
      {
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          tags: ["predictions"],
          summary: "Predict (or change) whether it passes its next deciding vote. Needs an account",
          description: "Changeable until it's decided. Only votes from the day after the last change count (a change on the vote day waits for the next vote).",
          params: idParams,
          body: z.strictObject({ pick: pickSchema }),
          response: { 200: z.object({ pick: pickSchema, split: splitSchema }), 401: errorSchema, 404: errorSchema, 409: errorSchema },
        },
      },
      async (request) => {
        const reader = requireReader(request);
        const { initiativeId } = request.params;
        const [initiative] = await db
          .select({ id: initiatives.id, open: sql<boolean>`initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}` })
          .from(initiatives)
          .where(eq(initiatives.id, initiativeId));
        if (!initiative) throw notFound("Initiative");
        const [existing] = await db
          .select({ outcome: predictions.outcome })
          .from(predictions)
          .where(and(eq(predictions.userId, reader.id), eq(predictions.initiativeId, initiativeId)));
        if (!initiative.open || (existing && existing.outcome !== null)) throw new ApiError(409, "closed", "This one is already decided");
        await db
          .insert(predictions)
          .values({ userId: reader.id, initiativeId, pick: request.body.pick })
          .onConflictDoUpdate({
            target: [predictions.userId, predictions.initiativeId],
            set: { pick: request.body.pick, updatedAt: sql`now()` },
            setWhere: sql`${predictions.outcome} is null and ${predictions.pick} is distinct from excluded.pick`,
          });
        return { pick: request.body.pick, split: await split(initiativeId) };
      },
    );

    app.delete(
      "/predictions/:initiativeId",
      {
        schema: {
          tags: ["predictions"],
          summary: "Take a pending prediction back",
          params: idParams,
          response: { 204: z.null(), 401: errorSchema },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        await db
          .delete(predictions)
          .where(and(eq(predictions.userId, reader.id), eq(predictions.initiativeId, request.params.initiativeId), isNull(predictions.outcome)));
        return reply.status(204).send(null);
      },
    );

    app.get(
      "/me/predictions",
      {
        schema: {
          tags: ["predictions"],
          summary: "The reader's own predictions, newest first, and their private record",
          response: {
            200: z.object({
              record: z.object({ hits: z.number(), misses: z.number(), pending: z.number(), streak: z.number().describe("Hits in a row, latest first") }),
              items: z.array(myItemSchema),
            }),
            401: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const reader = requireReader(request);
        reply.header("Cache-Control", "private, no-store");
        const rows = await db
          .select({
            initiativeId: predictions.initiativeId,
            title: initiatives.title,
            pick: predictions.pick,
            outcome: predictions.outcome,
            voteDate: predictions.voteDate,
            voteResult: predictions.voteResult,
            updatedAt: predictions.updatedAt,
            resolvedAt: predictions.resolvedAt,
            pass: sql<number>`(select count(*) filter (where p.pick = 'pass') from predictions p where p.initiative_id = ${predictions.initiativeId})::int`,
            fail: sql<number>`(select count(*) filter (where p.pick = 'fail') from predictions p where p.initiative_id = ${predictions.initiativeId})::int`,
          })
          .from(predictions)
          .innerJoin(initiatives, eq(initiatives.id, predictions.initiativeId))
          .where(eq(predictions.userId, reader.id))
          .orderBy(desc(predictions.updatedAt))
          .limit(500);
        return {
          record: record(rows),
          items: rows.map((r) => ({
            initiativeId: r.initiativeId,
            title: r.title,
            pick: r.pick,
            outcome: r.outcome,
            voteDate: r.voteDate,
            voteResult: r.voteResult,
            updatedAt: r.updatedAt.toISOString(),
            split: { pass: r.pass, fail: r.fail },
          })),
        };
      },
    );
  };

