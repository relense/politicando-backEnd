import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Reader } from "../../accounts/sessions.js";
import type { Db } from "../../db/client.js";
import { type VoteRecord, initiatives, parties, predictions } from "../../db/schema.js";
import { follow } from "../../notifications/index.js";
import { ApiError, notFound } from "../../errors.js";
import { OPEN_FOR_PREDICTION, PREDICTABLE_NOW, nextVoteLabel, record, settle } from "../../predictions/index.js";
import { DECIDING_VOTES } from "../../parliament/parse.js";
import { AGENDA_NAMES_INITIATIVE, OPEN_DAYS, ensureThread } from "../../predictions/rounds.js";
import { plainType } from "../../parliament/plain.js";
import { TOPIC_LABELS, simplerTitle } from "../parliament/routes.js";
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

const topicsSchema = z.array(z.object({ slug: z.string(), label: z.string() })).describe("Topics from the title (as on GET /initiatives)");
/** Plain-language reading of an initiative, by fixed rules (no AI): the same as on GET /initiatives. */
const plainSchema = z.object({
  title: z.string().nullable().describe("The title without legal boilerplate; null when the official one is already plain"),
  typeLabel: z.string().describe('e.g. "Recomendação" for a Projeto de Resolução'),
  typeExplainer: z.string().describe("One or two sentences on what this kind of initiative is"),
});
const plainOf = (type: string, title: string) => {
  const kind = plainType(type);
  return { title: simplerTitle(title), typeLabel: kind.label, typeExplainer: kind.explainer };
};
/** Who proposed it: "Governo", a regional assembly…, or the parties that signed it. */
const AUTHOR_SQL = sql`coalesce(initiatives.other_author, (select string_agg(p.acronym, ', ' order by p.acronym)
  from initiative_parties ip join parties p on p.id = ip.party_id where ip.initiative_id = initiatives.id))`;
const voteLabelSchema = z.string().describe('What gets voted, by rule: "votação na generalidade", "votação final global" or "votação" (our best reading; parliament doesn\'t say in advance)');
const authorSchema = z.string().nullable().describe('Who proposed it: "Governo", "Assembleia Legislativa da Região Autónoma da Madeira"…, or the parties that signed it ("PS, Livre")');
const groupVotes = z.array(z.object({ party: z.string().describe("The party's acronym, or the parliament's name for the group"), count: z.number().nullable().describe("Set when only part of the group voted this way") }));
const tallySchema = z
  .object({ unanimous: z.boolean(), favor: groupVotes, against: groupVotes, abstention: groupVotes })
  .nullable()
  .describe("How the groups voted, once decided by a vote. Parliament records votes by group, not deputy totals");
const topicsOf = (slugs: string[]) => slugs.map((slug) => ({ slug, label: TOPIC_LABELS.get(slug) ?? slug }));

const openItemSchema = z.object({
  id: z.number().describe("The initiative (GET /initiatives/:id)"),
  type: z.string(),
  number: z.string(),
  title: z.string(),
  plain: plainSchema,
  topics: topicsSchema,
  phase: z.string().describe("Its latest stage"),
  phaseDate: z.string(),
  voteLabel: voteLabelSchema,
  author: authorSchema,
  replyCount: z.number().describe("Replies in the megathread (0 while upcoming)"),
  state: z.enum(["open", "upcoming"]).describe("upcoming only with ?upcoming=true: on the agenda, picks not open yet"),
  opensAt: z.string().describe("When picks open(ed): a week before the session"),
  closesAt: z.string().describe("When the plenary session starts: picks lock then (show a countdown)"),
  count: z.number().describe("How many readers picked so far (the number only, no split: it doesn't steer anyone). 0 while upcoming"),
  threadId: z.number().nullable().describe('The vote\'s megathread (board "votacoes"), where readers defend their pick'),
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
  topics: topicsSchema.describe('For "acertas mais em habitação do que em economia"'),
  tally: tallySchema,
});

export const predictionRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireReader = (request: FastifyRequest): Reader => {
      if (!request.reader) throw new ApiError(401, "login_required", "Log in to predict");
      return request.reader;
    };
    const acronyms = async () => new Map((await db.select({ slug: parties.slug, acronym: parties.acronym }).from(parties)).map((p) => [p.slug, p.acronym]));
    const tallyOf = (vote: VoteRecord | null, names: Map<string, string>) => {
      if (!vote) return null;
      const side = (list: VoteRecord["favor"]) => list.map((v) => ({ party: names.get(v.party) ?? v.party, count: v.count }));
      return { unanimous: vote.unanimous, favor: side(vote.favor), against: side(vote.against), abstention: side(vote.abstention) };
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
          summary: '"Passa ou chumba?": votes open for picks, soonest session first; with ?upcoming=true also those opening within the week',
          description: "A vote opens a week before its plenary session and closes when the session starts. Empty when nothing is coming up.",
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(50).default(10),
            upcoming: z.enum(["true", "false"]).default("false").describe('true: also votes on the agenda whose picks open within the week ("Abre terça 12:00")'),
          }),
          response: { 200: z.object({ items: z.array(openItemSchema) }) },
        },
      },
      async (request, reply) => {
        const userId = request.reader?.id ?? null;
        if (userId) reply.header("Cache-Control", "private, no-store");
        const withUpcoming = request.query.upcoming === "true";
        const rows = (
          await db.execute<{
            id: number; type: string; number: string; title: string; topics: string[]; phase: string; phase_date: string; votes: VoteRecord[];
            author: string | null; reply_count: number | null;
            opens_at: Date | string; closes_at: Date | string; open: boolean; thread_id: number | null; my_pick: "pass" | "fail" | null;
            count: number; pass: number; fail: number;
          }>(sql`
            select initiatives.id, initiatives.type, initiatives.number, initiatives.title, initiatives.topics, initiatives.phase, initiatives.phase_date,
              initiatives.votes, ${AUTHOR_SQL} as author, t.reply_count,
              r.opens_at, r.closes_at, r.opens_at <= now() as open, r.thread_id, mine.pick as my_pick,
              (select count(*) from predictions p where p.initiative_id = initiatives.id)::int as count,
              (select count(*) filter (where p.pick = 'pass') from predictions p where p.initiative_id = initiatives.id)::int as pass,
              (select count(*) filter (where p.pick = 'fail') from predictions p where p.initiative_id = initiatives.id)::int as fail
            from initiatives
            join vote_rounds r on r.initiative_id = initiatives.id
            left join forum_threads t on t.id = r.thread_id
            left join predictions mine on mine.initiative_id = initiatives.id and mine.user_id = ${userId}
            where initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION} and r.closes_at > now()
              and (r.opens_at <= now() ${withUpcoming ? sql`or r.opens_at <= now() + make_interval(days => ${OPEN_DAYS})` : sql``})
            order by r.opens_at <= now() desc, r.closes_at, initiatives.id
            limit ${request.query.limit}`)
        ).rows;
        return {
          items: rows.map((r) => ({
            id: r.id,
            type: r.type,
            number: r.number,
            title: r.title,
            plain: plainOf(r.type, r.title),
            topics: topicsOf(r.topics),
            voteLabel: nextVoteLabel(r.type, r.votes),
            author: r.author,
            replyCount: r.open ? (r.reply_count ?? 0) : 0,
            phase: r.phase,
            phaseDate: typeof r.phase_date === "string" ? r.phase_date : new Date(r.phase_date).toISOString().slice(0, 10),
            state: r.open ? ("open" as const) : ("upcoming" as const),
            opensAt: new Date(r.opens_at).toISOString(),
            closesAt: new Date(r.closes_at).toISOString(),
            count: r.open ? r.count : 0,
            threadId: r.open ? r.thread_id : null,
            myPick: r.my_pick,
            split: r.open && r.my_pick ? { pass: r.pass, fail: r.fail } : null,
          })),
        };
      },
    );

    const boxSchema = z.object({
      id: z.number().describe("The initiative"),
      title: z.string(),
      plain: plainSchema,
      topics: topicsSchema,
      count: z.number().describe("How many readers picked (0 while upcoming)"),
      voteLabel: voteLabelSchema.describe("What gets (or got) voted, by rule"),
      author: authorSchema,
      replyCount: z.number().describe("Replies in the megathread"),
      tally: tallySchema,
      state: z.enum(["upcoming", "open", "closed", "decided"]).describe(
        "upcoming: on an agenda more than 7 days out (opens at opensAt); open: picks allowed until closesAt; closed: the session started, waiting for the result (settled by the 04:00 sync); decided: settled, void included",
      ),
      opensAt: z.string().describe("When picks open(ed): a week before the session (the agenda bar: entrou na agenda → fecha quando a sessão começa)"),
      closesAt: z.string().nullable().describe("When the session starts and picks lock (for upcoming: the planned session)"),
      threadId: z.number().nullable().describe("The vote's megathread (board votacoes); null while upcoming"),
      myPick: pickSchema.nullable(),
      split: splitSchema.describe("How everyone picked: while open only once this reader has picked; once closed, for everyone"),
      voteDate: z.string().nullable(),
      voteResult: z.string().nullable().describe('decided: "Aprovado", "Rejeitado" or "Prejudicado"; null when it was decided without a vote (withdrawn…)'),
      outcome: z.enum(["hit", "miss", "void"]).nullable().describe("This reader's, once decided; null when anonymous or no pick"),
    });

    app.get(
      "/predictions/:initiativeId",
      {
        schema: {
          tags: ["predictions"],
          summary: 'The initiative page\'s "Passa ou chumba?" box: its vote, in any state, kept forever as history',
          description: "404 when the initiative never had a vote open for predictions and none is on the agenda. A postponed vote goes back to open with the new closesAt.",
          params: idParams,
          response: { 200: boxSchema, 400: errorSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const { initiativeId } = request.params;
        const userId = request.reader?.id ?? null;
        reply.header("Cache-Control", userId ? "private, no-store" : "public, max-age=60");
        const [row] = (
          await db.execute<{
            id: number; type: string; title: string; topics: string[]; votes: VoteRecord[]; open_now: boolean; waiting: boolean;
            author: string | null; reply_count: number | null;
            opens_at: Date | string | null; closes_at: Date | string | null; opened_at: Date | string | null; thread_id: number | null;
            next_session: Date | string | null;
          }>(sql`
            select initiatives.id, initiatives.type, initiatives.title, initiatives.topics, initiatives.votes,
              ${AUTHOR_SQL} as author, (select t.reply_count from forum_threads t where t.id = r.thread_id) as reply_count,
              ${PREDICTABLE_NOW} as open_now,
              (initiatives.status = 'in_progress' and ${OPEN_FOR_PREDICTION}) as waiting,
              r.opens_at, r.closes_at, r.opened_at, r.thread_id,
              (select min(e.starts_at) from agenda_events e where ${AGENDA_NAMES_INITIATIVE} and e.starts_at > now()) as next_session
            from initiatives left join vote_rounds r on r.initiative_id = initiatives.id
            where initiatives.id = ${initiativeId}`)
        ).rows;
        if (!row) throw notFound("Prediction");
        const about = {
          id: row.id, title: row.title, plain: plainOf(row.type, row.title), topics: topicsOf(row.topics), author: row.author,
          replyCount: row.reply_count ?? 0,
        };
        const upcoming = (opensAt: Date, closesAt: Date) => ({
          ...about, state: "upcoming" as const, count: 0, threadId: null, replyCount: 0, tally: null, voteLabel: nextVoteLabel(row.type, row.votes), myPick: null, split: null, voteDate: null, voteResult: null, outcome: null,
          opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(),
        });

        if (row.closes_at === null || row.opened_at === null || row.opens_at === null) {
          // Not scheduled yet: only worth a box when a session is planned (and it's still waiting for a vote).
          if (!row.waiting || row.next_session === null) throw notFound("Prediction");
          const session = new Date(row.next_session);
          return upcoming(new Date(session.getTime() - OPEN_DAYS * 24 * 3_600_000), session);
        }
        if (new Date(row.opens_at) > new Date() && new Date(row.closes_at) > new Date()) return upcoming(new Date(row.opens_at), new Date(row.closes_at));

        const settled = settle({ pick: "pass", updatedAt: new Date(row.opened_at) }, { votes: row.votes, open: row.waiting });
        // The label of the vote that decided it; before that, of the vote expected (by rule, from the votes before this round).
        const voteLabel = settled?.vote ? settled.vote.phase.replace(/^Votação/, "votação") : nextVoteLabel(row.type, row.votes.filter((v) => v.date < new Date(row.opened_at!).toISOString().slice(0, 10)));
        const state = row.open_now ? ("open" as const) : settled ? ("decided" as const) : ("closed" as const);
        const [mine] = userId
          ? await db
              .select({ pick: predictions.pick, outcome: predictions.outcome })
              .from(predictions)
              .where(and(eq(predictions.userId, userId), eq(predictions.initiativeId, initiativeId)))
          : [];
        const counts = await split(initiativeId);
        return {
          ...about,
          state,
          voteLabel,
          tally: state === "decided" ? tallyOf(settled?.vote ?? null, await acronyms()) : null,
          count: counts.pass + counts.fail,
          opensAt: new Date(row.opens_at).toISOString(),
          closesAt: new Date(row.closes_at).toISOString(),
          threadId: row.thread_id,
          myPick: mine?.pick ?? null,
          split: state !== "open" || mine ? counts : null,
          voteDate: state === "decided" ? (settled?.voteDate ?? null) : null,
          voteResult: state === "decided" ? (settled?.voteResult ?? null) : null,
          outcome: state === "decided" ? (mine?.outcome ?? null) : null,
        };
      },
    );

    app.put(
      "/predictions/:initiativeId",
      {
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          tags: ["predictions"],
          summary: "Predict (or change) whether it passes its vote. Needs an account; only while the vote is open",
          description: "Changeable until the session starts (closesAt). Picking follows the vote's megathread.",
          params: idParams,
          body: z.strictObject({ pick: pickSchema }),
          response: { 200: z.object({ pick: pickSchema, split: splitSchema }), 401: errorSchema, 404: errorSchema, 409: errorSchema },
        },
      },
      async (request) => {
        const reader = requireReader(request);
        const { initiativeId } = request.params;
        const [initiative] = await db
          .select({ id: initiatives.id, open: sql<boolean>`${PREDICTABLE_NOW}` })
          .from(initiatives)
          .where(eq(initiatives.id, initiativeId));
        if (!initiative) throw notFound("Initiative");
        const [existing] = await db
          .select({ outcome: predictions.outcome })
          .from(predictions)
          .where(and(eq(predictions.userId, reader.id), eq(predictions.initiativeId, initiativeId)));
        if (!initiative.open || (existing && existing.outcome !== null)) throw new ApiError(409, "closed", "Not open for predictions: it opens a week before the vote and closes when the session starts");
        await db
          .insert(predictions)
          .values({ userId: reader.id, initiativeId, pick: request.body.pick })
          .onConflictDoUpdate({
            target: [predictions.userId, predictions.initiativeId],
            set: { pick: request.body.pick, updatedAt: sql`now()` },
            setWhere: sql`${predictions.outcome} is null and ${predictions.pick} is distinct from excluded.pick`,
          });
        // Picking a side follows the vote's megathread, where that side gets argued.
        const threadId = await ensureThread(db, initiativeId);
        if (threadId) await follow(db, reader.id, "thread", threadId);
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
            topics: initiatives.topics,
            votes: initiatives.votes,
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
        const names = await acronyms();
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
            topics: topicsOf(r.topics),
            // The vote that settled it: the deciding vote on its date.
            tally: r.voteDate ? tallyOf(r.votes.find((v) => v.date === r.voteDate && DECIDING_VOTES.has(v.phase)) ?? null, names) : null,
          })),
        };
      },
    );
  };

