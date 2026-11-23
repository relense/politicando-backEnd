import { and, desc, eq, exists, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PROPOSAL_RESULTS, VOTE_RESULTS } from "../../budget/parse.js";
import { BUDGET_DATASET_PAGE } from "../../budget/sync.js";
import type { Db } from "../../db/client.js";
import { budgetNewsFor } from "../../budget/news.js";
import { agendaEvents, budgetBills, budgetProposals, budgetSchedule, budgetSources, budgetSummaries, budgetVotes, parties, userFollows, type BudgetVoteEntry } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { PARTY_DEFINITIONS } from "../../matching/parties.js";
import { escapeLike, searchWords } from "../articles/routes.js";
import { voteSchema as billVoteSchema } from "../parliament/routes.js";
import { errorSchema } from "../shared.js";

/*
 * The State Budget's amendment proposals and how each party voted (docs/budget-api.md).
 * Official data only, in the parliament's own terms: no "won" or "lost".
 */

const partySchema = z.object({ slug: z.string(), acronym: z.string(), name: z.string() });
const VOTE_VALUES = ["favor", "against", "abstention", "absent"] as const;
const phaseSchema = z.enum(["committee", "plenary"]).nullable();

const voteSchema = z.object({
  votedOn: z.string(),
  phase: phaseSchema.describe("committee (especialidade, COF) or plenary (a proposal called up, avocada); null if the source doesn't say"),
  result: z.enum(VOTE_RESULTS).nullable().describe("This vote's (or this part's) result; null when the source's is unreadable"),
  unanimous: z.boolean(),
  label: z.string().nullable().describe('The source\'s words for the proposal at this vote: "Aprovado(a) Parcialmente em Comissão"'),
  partLabel: z.string().nullable().describe('The source\'s words for this vote: "Rejeitado(a)"'),
  parts: z.array(z.string()).describe('What this vote was on, when voted in parts: "Alínea a), N.º 1, Artigo 108.º"'),
  subject: z.string().nullable(),
  parties: z.array(
    z.object({
      party: partySchema.nullable().describe("Null when the source's name matched no party"),
      group: z.string().describe("As the source writes it"),
      deputy: z.string().nullable().describe("A deputy who voted apart from their group"),
      vote: z.enum(VOTE_VALUES).nullable(),
    }),
  ),
  ambiguous: z.boolean(),
  ambiguity: z.string().nullable().describe("Why the source can't be read with certainty"),
});

const proposalSchema = z.object({
  id: z.number().describe("The parliament's id"),
  year: z.number(),
  number: z.string().describe('"2777C"'),
  title: z.string(),
  article: z.string().nullable().describe('The article it adds or changes: "Artigo 116.º-A"'),
  topics: z.array(z.string()),
  target: z.enum(["articles", "tables"]).nullable().describe("The law's articles, or the budget's tables (mapas)"),
  kind: z.string().nullable().describe('As the source writes it: "Aditamento (Artigo PPL)", "Substituição", "Eliminação"'),
  status: z.string().describe('The source\'s status, as written: "Aguarda Voto em Comissão"'),
  result: z.enum(PROPOSAL_RESULTS),
  resultPhase: phaseSchema,
  unanimous: z.boolean(),
  authors: z.object({
    parties: z.array(partySchema),
    deputies: z.array(z.string()).describe("Deputies named as authors without a group"),
    label: z.string().nullable().describe('As the source writes it: "PSD, CDS-PP"'),
  }),
  submittedOn: z.string().nullable(),
  lastVotedOn: z.string().nullable(),
  plain: z
    .object({
      summary: z.string().describe('"O que muda": what the proposal changes, in plain words'),
      automatic: z.boolean().describe('Written by a model from the PDF: label it ("Resumo automático") and link the PDF'),
      updatedAt: z.string(),
    })
    .nullable()
    .describe("Null until one is written"),
  documentUrl: z.string().nullable().describe("The proposal's official text (PDF)"),
  sourceUrl: z.string().describe("The parliament's open-data page this comes from"),
  votes: z.array(voteSchema).describe("Oldest first; a proposal voted in parts has one per part"),
  scheduled: z
    .array(
      z.object({
        date: z.string().describe("The voting day its script is for"),
        venue: z.enum(["committee", "plenary"]),
        position: z.number().describe("Its place in that day's scripts for that venue, from 1"),
        scriptUrl: z.string().describe("The parliament's voting script (PDF)"),
      }),
    )
    .describe("The voting days the parliament's scripts put it on, oldest first: planned, not certain (votes get postponed). [] when on none"),
});

const proposalDetailSchema = proposalSchema.extend({
  news: z
    .array(z.object({ id: z.number(), title: z.string(), source: z.string(), url: z.string(), publishedAt: z.string() }))
    .describe("News articles about this proposal (found and checked automatically), newest first; link to /article/:id"),
  statements: z
    .array(
      z.object({
        party: partySchema.nullable().describe("The party it's attributed to, when known"),
        speaker: z.string().nullable().describe("The person, as the article names them; null when it's the party's"),
        text: z.string().describe("What they said about it, as the article reports it (a short quote or a faithful paraphrase)"),
        articleId: z.number(),
        articleTitle: z.string(),
        source: z.string(),
        publishedAt: z.string(),
      }),
    )
    .describe("What parties and politicians said about it, according to the news (never the parliament's record); newest first"),
});

const billSchema = z.object({
  initiativeId: z.number().describe("The parliament's id; current-legislature bills have a page at /iniciativas/:id"),
  legislature: z.string(),
  number: z.string().describe('"110": Proposta de Lei 110/XVII'),
  title: z.string(),
  status: z.string().describe("approved, rejected, in_progress, withdrawn, or lapsed (its legislature ended first)"),
  votes: z.array(billVoteSchema).describe('Oldest first: "Votação na generalidade", "Votação final global"…, as on /initiatives'),
});

const day = z.iso.date();
const yearParams = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const voteCountsSchema = z.object({ favor: z.number(), against: z.number(), abstention: z.number(), absent: z.number() });
const resultCountsSchema = z.object(Object.fromEntries(PROPOSAL_RESULTS.map((r) => [r, z.number()])) as Record<(typeof PROPOSAL_RESULTS)[number], z.ZodNumber>);

const PUBLIC = "public, max-age=300";
const FOLLOWED_PAGE = 20;

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
const decodeCursor = (value: string) => {
  try {
    const { o } = z.object({ o: z.number().int().min(0).max(1_000_000) }).parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return o;
  } catch {
    throw new ApiError(400, "invalid_cursor", "The cursor is not valid");
  }
};

export const SESSION_STAGES = ["committee", "plenary", "general_vote", "final_vote"] as const;

/**
 * What a Budget session is for, from its title and agenda. The parliament's agenda rarely says
 * "votação final global" in words: the final vote closes the session headed "Encerramento do
 * debate na especialidade", so that counts too.
 */
export function sessionStage(kind: string, text: string): (typeof SESSION_STAGES)[number] | null {
  const t = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/votacao final global|encerramento do debate na especialidade/.test(t)) return "final_vote";
  if (/debate na generalidade|votacao na generalidade/.test(t) && /orcamento do estado/.test(t)) return "general_vote";
  if (kind === "committee" || /comissao de orcamento/.test(t)) return "committee";
  if (/normas avocadas|remetidos a plenario|debate na especialidade/.test(t)) return "plenary";
  return null;
}

export const budgetRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const partyMap = async () => {
      const rows = await db.select({ slug: parties.slug, acronym: parties.acronym, name: parties.name, seats: parties.assemblySeats }).from(parties);
      const map = new Map(rows.map((r) => [r.slug, r]));
      for (const d of PARTY_DEFINITIONS) if (!map.has(d.slug)) map.set(d.slug, { slug: d.slug, acronym: d.acronym, name: d.name, seats: 0 });
      return map;
    };
    type PartyMap = Awaited<ReturnType<typeof partyMap>>;
    const party = (map: PartyMap, slug: string | null) => {
      const p = slug ? map.get(slug) : undefined;
      return p ? { slug: p.slug, acronym: p.acronym, name: p.name } : null;
    };
    const requireYear = async (year: number) => {
      const [source] = await db.select().from(budgetSources).where(eq(budgetSources.year, year));
      if (!source) throw notFound(`The ${year} Budget`);
      return source;
    };

    const hydrate = async (rows: (typeof budgetProposals.$inferSelect)[]) => {
      if (rows.length === 0) return [];
      const map = await partyMap();
      const votes = await db
        .select()
        .from(budgetVotes)
        .where(sql`${budgetVotes.proposalId} in ${rows.map((r) => r.id)}`)
        .orderBy(budgetVotes.proposalId, budgetVotes.seq);
      const summaries = new Map(
        (await db.select().from(budgetSummaries).where(sql`${budgetSummaries.proposalId} in ${rows.map((r) => r.id)}`)).map((s) => [s.proposalId, s]),
      );
      const planned = new Map<string, { date: string; venue: "committee" | "plenary"; position: number; scriptUrl: string }[]>();
      for (const s of await db
        .select()
        .from(budgetSchedule)
        .where(sql`(${budgetSchedule.year}, ${budgetSchedule.number}) in ${sql`(${sql.join(rows.map((r) => sql`(${r.year}, ${r.number})`), sql`, `)})`}`)
        .orderBy(budgetSchedule.votingDay, budgetSchedule.venue)) {
        const key = `${s.year}|${s.number}`;
        planned.set(key, [...(planned.get(key) ?? []), { date: s.votingDay, venue: s.venue, position: s.position, scriptUrl: s.documentUrl }]);
      }
      const byProposal = new Map<number, typeof votes>();
      for (const v of votes) byProposal.set(v.proposalId, [...(byProposal.get(v.proposalId) ?? []), v]);
      return rows.map((r) => ({
        id: r.id, year: r.year, number: r.number, title: r.title, article: r.article, topics: r.topics,
        target: r.target as "articles" | "tables" | null, kind: r.kind, status: r.status,
        result: r.result as (typeof PROPOSAL_RESULTS)[number], resultPhase: r.resultPhase as "committee" | "plenary" | null, unanimous: r.unanimous,
        authors: { parties: r.authorParties.map((s) => party(map, s)).filter((p) => p !== null), deputies: r.authorDeputies, label: r.authorLabel },
        submittedOn: r.submittedOn, lastVotedOn: r.lastVotedOn,
        plain: ((s) => (s ? { summary: s.summary, automatic: s.automatic, updatedAt: s.updatedAt.toISOString() } : null))(summaries.get(r.id)),
        documentUrl: r.documentUrl, sourceUrl: BUDGET_DATASET_PAGE,
        scheduled: planned.get(`${r.year}|${r.number}`) ?? [],
        votes: (byProposal.get(r.id) ?? []).map((v) => ({
          votedOn: v.votedOn, phase: v.phase as "committee" | "plenary" | null, result: v.result as (typeof VOTE_RESULTS)[number] | null,
          unanimous: v.unanimous, label: v.label, partLabel: v.partLabel, parts: v.parts, subject: v.subject,
          parties: v.votes.map((e: BudgetVoteEntry) => ({ party: party(map, e.party), group: e.group, deputy: e.deputy, vote: e.vote })),
          ambiguous: v.ambiguity !== null, ambiguity: v.ambiguity,
        })),
      }));
    };

    const billsByYear = async (year?: number) => {
      const rows = await db
        .select()
        .from(budgetBills)
        .where(year === undefined ? undefined : eq(budgetBills.year, year))
        .orderBy(budgetBills.year, budgetBills.initiativeId);
      const map = new Map<number, z.infer<typeof billSchema>[]>();
      for (const r of rows) {
        map.set(r.year, [...(map.get(r.year) ?? []), {
          initiativeId: r.initiativeId, legislature: r.legislature, number: r.number, title: r.title, status: r.status,
          votes: [...r.votes].sort((a, b) => a.date.localeCompare(b.date)),
        }]);
      }
      return map;
    };

    /** Per voting day and venue, how many proposals the parliament's scripts put on it, and how many still wait. */
    const votingDays = async (year: number) => {
      const rows = await db.execute<{ date: string; venue: "committee" | "plenary"; proposals: number; pending: number }>(sql`
        select s.voting_day::text as date, s.venue, count(*)::int as proposals,
          count(*) filter (where p.result in ('pending', 'sent_to_plenary'))::int as pending
        from ${budgetSchedule} s left join ${budgetProposals} p on p.year = s.year and p.number = s.number
        where s.year = ${year}
        group by 1, 2 order by 1, 2`);
      return rows.rows;
    };

    // The parliament gives no date per proposal in its data; the agenda has the sessions where
    // they're voted, and the voting scripts (votingDays, scheduled) which proposals.
    const schedule = async (year: number) => {
      const rows = await db
        .select({
          id: agendaEvents.id, title: agendaEvents.title, summary: agendaEvents.summary, kind: agendaEvents.kind,
          startsAt: agendaEvents.startsAt, endsAt: agendaEvents.endsAt, allDay: agendaEvents.allDay,
        })
        .from(agendaEvents)
        .where(
          and(
            eq(agendaEvents.source, "parliament"),
            eq(agendaEvents.status, "scheduled"),
            sql`${agendaEvents.until} >= now() and ${agendaEvents.startsAt} < now() + interval '14 days'`,
            sql`(${agendaEvents.title} ~* 'comiss.o de or.amento' or ${agendaEvents.title} ~* 'normas avocadas'
              or ${agendaEvents.title} ~* 'vota..o final global' or ${agendaEvents.title} ilike ${`%Estado para ${year}%`})`,
          ),
        )
        .orderBy(agendaEvents.startsAt)
        .limit(20);
      const now = Date.now();
      return rows.map(({ summary, ...r }) => ({
        ...r,
        stage: sessionStage(r.kind, `${r.title}\n${summary ?? ""}`),
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt?.toISOString() ?? null,
        started: r.startsAt.getTime() <= now,
      }));
    };

    const votedBetween = (from?: string, to?: string) =>
      from || to
        ? exists(
            db.select({ one: sql`1` }).from(budgetVotes).where(
              and(
                eq(budgetVotes.proposalId, budgetProposals.id),
                from ? gte(budgetVotes.votedOn, from) : undefined,
                to ? lte(budgetVotes.votedOn, to) : undefined,
              ),
            ),
          )
        : undefined;

    app.get(
      "/budget",
      {
        schema: {
          tags: ["budget"],
          summary: "The State Budgets we have amendment proposals and votes for, newest first",
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  year: z.number(), proposals: z.number(), voted: z.number(), pending: z.number(), lastVotedOn: z.string().nullable(),
                  syncedAt: z.string().nullable().describe("Null for a year with a bill but no amendment proposals"),
                  bills: z.array(billSchema).describe("The Budget's own bill and its votes; 2022 had two (one rejected)"),
                }),
              ),
              sourceUrl: z.string(),
            }),
          },
        },
      },
      async (_request, reply) => {
        const rows = await db
          .select({
            year: budgetSources.year,
            syncedAt: budgetSources.syncedAt,
            proposals: sql<number>`count(${budgetProposals.id})::int`,
            // A result the source gives without the vote itself (e.g. 111C-2 in 2027) still counts as voted.
            voted: sql<number>`count(*) filter (where ${budgetProposals.lastVotedOn} is not null or ${budgetProposals.result} in ('approved', 'partially_approved', 'rejected'))::int`,
            pending: sql<number>`count(*) filter (where ${budgetProposals.result} in ('pending', 'sent_to_plenary'))::int`,
            lastVotedOn: sql<string | null>`max(${budgetProposals.lastVotedOn})::text`,
          })
          .from(budgetSources)
          .leftJoin(budgetProposals, eq(budgetProposals.year, budgetSources.year))
          .groupBy(budgetSources.year, budgetSources.syncedAt)
          .orderBy(desc(budgetSources.year));
        const bills = await billsByYear();
        const years = new Map(rows.map((r) => [r.year, { ...r, syncedAt: r.syncedAt.toISOString() as string | null, bills: bills.get(r.year) ?? [] }]));
        for (const [year, list] of bills) {
          if (!years.has(year)) years.set(year, { year, proposals: 0, voted: 0, pending: 0, lastVotedOn: null, syncedAt: null, bills: list });
        }
        reply.header("Cache-Control", PUBLIC);
        return { items: [...years.values()].sort((a, b) => b.year - a.year), sourceUrl: BUDGET_DATASET_PAGE };
      },
    );

    app.get(
      "/budget/:year/proposals",
      {
        schema: {
          tags: ["budget"],
          summary: "A Budget's amendment proposals, each with how every party voted",
          params: yearParams,
          querystring: z.object({
            party: z.string().max(40).optional().describe("Proposals by this party (slug)"),
            result: z
              .string()
              .max(200)
              .optional()
              .transform((value, ctx) => {
                if (value === undefined) return undefined;
                const values = [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
                const unknown = values.filter((v) => !(PROPOSAL_RESULTS as readonly string[]).includes(v));
                if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown result: ${unknown.join(", ")}` });
                return values as (typeof PROPOSAL_RESULTS)[number][];
              })
              .describe("One or more, comma-separated: pending,sent_to_plenary is everything still to be voted"),
            topic: z.string().max(200).optional().describe("Exactly as in topics"),
            q: z.string().trim().max(200).optional().describe("Words in the number, title, article or topics"),
            votedFrom: day.optional().describe("Proposals with a vote on or after this day"),
            votedTo: day.optional().describe("Proposals with a vote on or before this day"),
            scheduledOn: day.optional().describe("Proposals the parliament's voting scripts put on this day (planned, not certain)"),
            sort: z
              .enum(["voted", "number", "scheduled"])
              .default("voted")
              .describe("voted: latest vote first, unvoted last; number: in the parliament's numbering; scheduled: in the order of scheduledOn's scripts, committee first (needs scheduledOn)"),
            cursor: z.string().max(200).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          }),
          response: { 200: z.object({ items: z.array(proposalSchema), nextCursor: z.string().nullable(), total: z.number() }), 400: errorSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const { year } = request.params;
        const { party: partySlug, result, topic, q, votedFrom, votedTo, scheduledOn, sort, cursor, limit } = request.query;
        if (sort === "scheduled" && !scheduledOn) throw new ApiError(400, "scheduled_on_required", "sort=scheduled needs scheduledOn");
        await requireYear(year);
        const offset = cursor ? decodeCursor(cursor) : 0;
        const filters: (SQL | undefined)[] = [
          eq(budgetProposals.year, year),
          partySlug ? sql`${partySlug} = any(${budgetProposals.authorParties})` : undefined,
          result?.length ? inArray(budgetProposals.result, result) : undefined,
          topic ? sql`${topic} = any(${budgetProposals.topics})` : undefined,
          votedBetween(votedFrom, votedTo),
          scheduledOn
            ? sql`exists (select 1 from ${budgetSchedule} s where s.year = ${budgetProposals.year} and s.number = ${budgetProposals.number} and s.voting_day = ${scheduledOn})`
            : undefined,
          ...(q ? searchWords(q).map((w) => sql`${budgetProposals.searchText} like ${`%${escapeLike(w)}%`}`) : []),
        ];
        const where = and(...filters);
        const numberOrder = [sql`nullif(regexp_replace(${budgetProposals.number}, '\\D.*$', ''), '')::int nulls last`, budgetProposals.number, budgetProposals.id];
        const scriptOrder = sql`(select min(case s.venue when 'committee' then 0 else 1000000 end + s.position) from ${budgetSchedule} s
          where s.year = ${budgetProposals.year} and s.number = ${budgetProposals.number} and s.voting_day = ${scheduledOn ?? null})`;
        const order =
          sort === "number" ? numberOrder : sort === "scheduled" ? [scriptOrder, ...numberOrder] : [sql`${budgetProposals.lastVotedOn} desc nulls last`, ...numberOrder];
        const [rows, [{ total } = { total: 0 }]] = await Promise.all([
          db.select().from(budgetProposals).where(where).orderBy(...order).limit(limit + 1).offset(offset),
          db.select({ total: sql<number>`count(*)::int` }).from(budgetProposals).where(where),
        ]);
        reply.header("Cache-Control", PUBLIC);
        return { items: await hydrate(rows.slice(0, limit)), nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null, total };
      },
    );

    app.get(
      "/me/follows/budget_proposals",
      {
        schema: {
          tags: ["accounts"],
          summary: 'The Budget proposals the reader follows ("A seguir"), newest followed first, 20 a page',
          description: "Private to the account. Same items as GET /budget/:year/proposals.",
          querystring: z.object({ cursor: z.string().max(200).optional() }),
          response: { 200: z.object({ items: z.array(proposalSchema), nextCursor: z.string().nullable() }), 400: errorSchema, 401: errorSchema },
        },
      },
      async (request, reply) => {
        if (!request.reader) throw new ApiError(401, "unauthenticated", "Log in first");
        reply.header("Cache-Control", "private, no-store");
        const offset = request.query.cursor ? decodeCursor(request.query.cursor) : 0;
        const rows = await db
          .select({ proposal: budgetProposals })
          .from(userFollows)
          .innerJoin(budgetProposals, eq(budgetProposals.id, userFollows.targetId))
          .where(and(eq(userFollows.userId, request.reader.id), eq(userFollows.kind, "budget_proposal")))
          .orderBy(desc(userFollows.createdAt), desc(userFollows.targetId))
          .limit(FOLLOWED_PAGE + 1)
          .offset(offset);
        const page = rows.slice(0, FOLLOWED_PAGE).map((r) => r.proposal);
        return { items: await hydrate(page), nextCursor: rows.length > FOLLOWED_PAGE ? encodeCursor(offset + FOLLOWED_PAGE) : null };
      },
    );

    app.get(
      "/budget/:year/proposals/:id",
      {
        schema: {
          tags: ["budget"],
          summary: "One amendment proposal, with every vote on it",
          params: yearParams.extend({ id: z.coerce.number().int().min(1).max(2_147_483_647) }),
          response: { 200: proposalDetailSchema, 404: errorSchema },
        },
      },
      async (request, reply) => {
        const rows = await db
          .select()
          .from(budgetProposals)
          .where(and(eq(budgetProposals.year, request.params.year), eq(budgetProposals.id, request.params.id)));
        const [item] = await hydrate(rows);
        if (!item) throw notFound("Proposal");
        const map = await partyMap();
        const found = await budgetNewsFor(db, [item.id]);
        reply.header("Cache-Control", PUBLIC);
        return {
          ...item,
          news: (found.news.get(item.id) ?? []).map((n) => ({ ...n, publishedAt: n.publishedAt.toISOString() })),
          statements: (found.statements.get(item.id) ?? []).map((st) => ({
            party: st.party ? party(map, st.party) : null, speaker: st.speaker, text: st.text,
            articleId: st.articleId, articleTitle: st.articleTitle, source: st.source, publishedAt: st.publishedAt.toISOString(),
          })),
        };
      },
    );

    app.get(
      "/budget/:year/summary",
      {
        schema: {
          tags: ["budget"],
          summary: "Totals per party: proposals made and their results, and how each voted on the others' proposals",
          description: "With votedFrom/votedTo, only proposals voted in those days and only those votes count: a day's summary.",
          params: yearParams,
          querystring: z.object({ votedFrom: day.optional(), votedTo: day.optional() }),
          response: {
            200: z.object({
              year: z.number(),
              votedFrom: z.string().nullable(),
              votedTo: z.string().nullable(),
              proposals: z.number(),
              votes: z.number().describe("Votes held (a proposal voted in parts counts each part)"),
              ambiguousVotes: z.number(),
              results: resultCountsSchema,
              parties: z.array(
                z.object({
                  party: partySchema,
                  proposals: z.number().describe("Proposals it authored (alone or with others)"),
                  results: resultCountsSchema.describe("Its proposals, by result"),
                  votesOnOthers: voteCountsSchema.describe("Its group's votes on proposals it didn't author"),
                }),
              ),
              topics: z.array(z.object({ topic: z.string(), proposals: z.number() })),
              lastVotedOn: z.string().nullable(),
              syncedAt: z.string(),
              bills: z.array(billSchema).describe("The Budget's own bill and its votes"),
              schedule: z
                .array(
                  z.object({
                    id: z.string(), title: z.string(), kind: z.string(),
                    stage: z.enum(SESSION_STAGES).nullable().describe("final_vote: the session that ends with the final overall vote"),
                    startsAt: z.string(), endsAt: z.string().nullable().describe("When the parliament gives one; usually null"),
                    allDay: z.boolean(), started: z.boolean().describe("Already started (it's listed until it ends, or until the end of its day)"),
                  }),
                )
                .describe("While proposals are still waiting: the coming sessions where Budget votes happen (next 14 days, from /agenda). Sessions, not a date per proposal"),
              votingDays: z
                .array(
                  z.object({
                    date: z.string(),
                    venue: z.enum(["committee", "plenary"]),
                    proposals: z.number().describe("Proposals on that day's scripts"),
                    pending: z.number().describe("Of those, still waiting for a vote (pending or sent_to_plenary)"),
                  }),
                )
                .describe("From the parliament's voting scripts, oldest first: which days take how many proposals. List them with ?scheduledOn=&sort=scheduled"),
              sourceUrl: z.string(),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const { year } = request.params;
        const { votedFrom, votedTo } = request.query;
        const source = await requireYear(year);
        const [proposals, votes, map] = await Promise.all([
          db
            .select({ id: budgetProposals.id, authors: budgetProposals.authorParties, result: budgetProposals.result, topics: budgetProposals.topics })
            .from(budgetProposals)
            .where(and(eq(budgetProposals.year, year), votedBetween(votedFrom, votedTo))),
          db
            .select({ proposalId: budgetVotes.proposalId, votedOn: budgetVotes.votedOn, votes: budgetVotes.votes, ambiguity: budgetVotes.ambiguity })
            .from(budgetVotes)
            .innerJoin(budgetProposals, eq(budgetProposals.id, budgetVotes.proposalId))
            .where(and(eq(budgetProposals.year, year), votedFrom ? gte(budgetVotes.votedOn, votedFrom) : undefined, votedTo ? lte(budgetVotes.votedOn, votedTo) : undefined)),
          partyMap(),
        ]);
        const emptyResults = () => Object.fromEntries(PROPOSAL_RESULTS.map((r) => [r, 0])) as Record<(typeof PROPOSAL_RESULTS)[number], number>;
        const results = emptyResults();
        const perParty = new Map<string, { proposals: number; results: ReturnType<typeof emptyResults>; votesOnOthers: Record<(typeof VOTE_VALUES)[number], number> }>();
        const entry = (slug: string) => {
          let e = perParty.get(slug);
          if (!e) perParty.set(slug, (e = { proposals: 0, results: emptyResults(), votesOnOthers: { favor: 0, against: 0, abstention: 0, absent: 0 } }));
          return e;
        };
        const topics = new Map<string, number>();
        const authorsOf = new Map<number, string[]>();
        for (const p of proposals) {
          const r = p.result as (typeof PROPOSAL_RESULTS)[number];
          results[r]++;
          authorsOf.set(p.id, p.authors);
          for (const slug of p.authors) {
            const e = entry(slug);
            e.proposals++;
            e.results[r]++;
          }
          for (const t of p.topics) topics.set(t, (topics.get(t) ?? 0) + 1);
        }
        for (const v of votes) {
          const authors = authorsOf.get(v.proposalId) ?? [];
          // A group's own line only: a deputy voting apart doesn't change how the group voted.
          for (const e of v.votes) if (e.party && !e.deputy && e.vote && !authors.includes(e.party)) entry(e.party).votesOnOthers[e.vote]++;
        }
        const partyRows = [...perParty.entries()]
          .map(([slug, e]) => ({ p: map.get(slug), e }))
          .filter((x): x is { p: NonNullable<typeof x.p>; e: typeof x.e } => x.p !== undefined)
          // Neutral order: by seats, then acronym (as the parliament lists groups).
          .sort((a, b) => b.p.seats - a.p.seats || a.p.acronym.localeCompare(b.p.acronym))
          .map(({ p, e }) => ({ party: { slug: p.slug, acronym: p.acronym, name: p.name }, ...e }));
        reply.header("Cache-Control", PUBLIC);
        return {
          year, votedFrom: votedFrom ?? null, votedTo: votedTo ?? null,
          proposals: proposals.length, votes: votes.length, ambiguousVotes: votes.filter((v) => v.ambiguity).length, results,
          parties: partyRows,
          topics: [...topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([topic, n]) => ({ topic, proposals: n })),
          lastVotedOn: votes.reduce<string | null>((m, v) => (!m || v.votedOn > m ? v.votedOn : m), null),
          syncedAt: source.syncedAt.toISOString(), bills: (await billsByYear(year)).get(year) ?? [],
          schedule: results.pending + results.sent_to_plenary > 0 && !votedFrom && !votedTo ? await schedule(year) : [],
          votingDays: votedFrom || votedTo ? [] : await votingDays(year),
          sourceUrl: BUDGET_DATASET_PAGE,
        };
      },
    );
  };
