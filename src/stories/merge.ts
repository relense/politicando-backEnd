import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rarity, sameStory, similarity, termsOf, titlePartiesOf, type Rarity, type Terms } from "./similarity.js";

/*
 * Joins stories that turned out to be the same news. Articles join a story one at a time, by
 * their words (similarity.ts), so the same event told in different words ("bloco fatal",
 * "imaturidade", "geringonça ao contrário") can start several stories. After each run:
 *
 * 1. Cheap rules pick pairs of stories close in time that name the same people or parties and
 *    share enough rare words (fewer when they share an event tag such as #OE2027), or that the
 *    usual article test matches across.
 * 2. A small model (Claude Haiku) says whether each pair is the same happening, not just the
 *    same broad subject. Its answer is kept until either story grows. Without ANTHROPIC_API_KEY
 *    nothing is joined: word scores alone can't tell a roundup ("tudo o que foi votado") from
 *    each vote it lists.
 * 3. A merge moves everything into the older story: articles, Importa marks, comments,
 *    follows, saves, reads and notifications. The newer id keeps answering as the older one
 *    (story_merges), since the Studio keeps ids in its alerts.
 *
 * As in similarity.ts, a missed merge beats a wrong one.
 */

/** Stories with an article this recent are looked at. */
export const LOOKBACK_HOURS = 36;
/** Two stories are compared when some of their articles are this close in time. */
export const MERGE_WINDOW_HOURS = 12;
/** Shared-word score (similarity of the stories' words together) a pair needs for the model to be asked. */
export const MIN_SCORE_WITH_EVENT = 0.18;
export const MIN_SCORE = 0.25;
/** The model is asked at most this often per run, strongest pairs first (about $0.0001 each). */
export const MAX_CHECKS = 200;
/** Questions to the model at once. */
const CONCURRENCY = 4;
/** Word rarity is measured over this many days of news, as when articles join stories. */
const RARITY_DAYS = 7;

export interface MergeArticle {
  id: number;
  title: string;
  excerpt: string;
  source: string;
  publishedAt: Date;
  /** "d:12", "g:ab…", "p:x", as in similarity.ts. */
  people: string[];
  /** Party slugs linked to the article. */
  parties: string[];
}

export interface MergeStory {
  id: number;
  createdAt: Date;
  /** Event tag slugs (#OE2027 → "oe2027"). */
  events: string[];
  articles: MergeArticle[];
}

export interface Candidate {
  a: MergeStory;
  b: MergeStory;
  score: number;
  /** The usual article test matched across them (asked first). */
  byRules: boolean;
}

/** What the model reads about a story. */
export interface StoryBrief {
  headlines: { title: string; source: string; at: string }[];
  excerpt: string;
}

/** Whether two stories are the same news; null when it couldn't tell (the pair is skipped, not cached). */
export type MergeJudge = (a: StoryBrief, b: StoryBrief) => Promise<boolean | null>;

const HOUR = 3_600_000;

/** A story's words together, as one text, plus everyone and every party it names. */
const profile = (story: MergeStory) => {
  const terms = story.articles.map((a) => ({ terms: termsOf(a), source: a.source, article: a }));
  const union: Terms = { title: new Set(), body: new Set(), people: new Set(), titleParties: new Set() };
  const parties = new Set<string>();
  for (const { terms: t, article } of terms) {
    for (const s of t.title) union.title.add(s);
    for (const s of t.body) union.body.add(s);
    for (const p of t.people) union.people.add(p);
    for (const p of t.titleParties) union.titleParties.add(p);
    for (const p of article.parties) parties.add(p);
    for (const p of titlePartiesOf(article.title)) parties.add(p);
  }
  return { terms, union, parties };
};
type Profile = ReturnType<typeof profile>;

const closeInTime = (a: MergeStory, b: MergeStory) =>
  a.articles.some((x) => b.articles.some((y) => Math.abs(+x.publishedAt - +y.publishedAt) <= MERGE_WINDOW_HOURS * HOUR));

/** The usual test across two stories: half of the smaller one's articles match half of the larger one's. */
const matchByRules = (small: Profile, large: Profile, rare: Rarity) => {
  const need = Math.ceil(large.terms.length / 2);
  const hits = small.terms.filter((x) => large.terms.filter((y) => sameStory(x, y, rare).ok).length >= need).length;
  return hits >= Math.ceil(small.terms.length / 2);
};

/** Pairs of stories worth joining or asking about, strongest first. */
export const candidates = (stories: MergeStory[], rare: Rarity): Candidate[] => {
  const profiles = new Map(stories.map((s) => [s.id, profile(s)]));
  const found: Candidate[] = [];
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const [a, b] = [stories[i]!, stories[j]!];
      if (!closeInTime(a, b)) continue;
      const [pa, pb] = [profiles.get(a.id)!, profiles.get(b.id)!];
      const [small, large] = pa.terms.length <= pb.terms.length ? [pa, pb] : [pb, pa];
      const score = similarity(pa.union, pb.union, rare).score;
      if (matchByRules(small, large, rare)) {
        found.push({ a, b, score, byRules: true });
        continue;
      }
      const sharedPeople = [...pa.union.people].some((p) => pb.union.people.has(p));
      const sharedParties = [...pa.parties].some((p) => pb.parties.has(p));
      if (!sharedPeople && !sharedParties) continue;
      const sharedEvent = a.events.some((e) => b.events.includes(e));
      if (score >= (sharedEvent ? MIN_SCORE_WITH_EVENT : MIN_SCORE)) found.push({ a, b, score, byRules: false });
    }
  }
  return found.sort((x, y) => Number(y.byRules) - Number(x.byRules) || y.score - x.score);
};

const lisbonTime = new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const briefOf = (story: MergeStory): StoryBrief => {
  const articles = [...story.articles].sort((x, y) => +x.publishedAt - +y.publishedAt);
  return {
    // The first and the latest versions: a story that grew shows where it has gone since.
    headlines: (articles.length > 8 ? [...articles.slice(0, 4), ...articles.slice(-4)] : articles).map((a) => ({ title: a.title, source: a.source, at: lisbonTime.format(a.publishedAt) })),
    excerpt: articles[0]?.excerpt.slice(0, 400) ?? "",
  };
};

const PROMPT = `Recebes dois grupos de notícias portuguesas (A e B), cada um com títulos, jornal e hora, e o resumo da primeira.
Diz se A e B contam o MESMO acontecimento, mesmo com palavras diferentes:
- o mesmo facto concreto (uma votação, uma decisão, um anúncio, um incidente) contado por jornais diferentes; ou
- reações do mesmo lado (por exemplo o primeiro-ministro, os ministros, o Governo e o seu partido) ao mesmo facto, no mesmo dia.
Um facto e as reações a ele são acontecimentos DIFERENTES: a votação do IVA zero e o Governo a criticar quem a aprovou são false.
Reações de lados diferentes (o Governo a acusar e a oposição a responder) também são false.
Responde false quando só partilham o tema largo: duas medidas diferentes do Orçamento, votações diferentes, declarações de pessoas diferentes sobre assuntos diferentes, ou o mesmo assunto em dias diferentes sem facto novo comum.
Na dúvida, false.`;

const format = (label: string, brief: StoryBrief) =>
  `${label}:\n${brief.headlines.map((h) => `- [${h.at}, ${h.source}] ${h.title}`).join("\n")}\nResumo: ${brief.excerpt}`;

/** The judge backed by Claude Haiku. Fails soft: an error means "can't tell", never a merge. */
export const claudeJudge = (apiKey: string, model = "claude-haiku-5-5"): MergeJudge => {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 });
  return async (a, b) => {
    const response = await client.messages.create({
      model,
      max_tokens: 64,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { same: { type: "boolean" } }, required: ["same"], additionalProperties: false },
        },
      },
      system: PROMPT,
      messages: [{ role: "user", content: `${format("A", a)}\n\n${format("B", b)}` }],
    });
    if (response.stop_reason !== "end_turn") return null;
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return null;
    try {
      const parsed = JSON.parse(text.text) as { same?: unknown };
      return typeof parsed.same === "boolean" ? parsed.same : null;
    } catch {
      return null;
    }
  };
};

/** The judge for this environment: Claude when ANTHROPIC_API_KEY is set, otherwise none (rules only). */
export const judgeFromEnv = (env: NodeJS.ProcessEnv = process.env): MergeJudge | null =>
  env.ANTHROPIC_API_KEY ? claudeJudge(env.ANTHROPIC_API_KEY) : null;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Runner = Db | Tx;

/** The story a (possibly merged) id now is. */
export const resolveStoryId = async (db: Runner, id: number) => {
  const rows = await db.execute<{ into_id: number }>(sql`select into_id from story_merges where from_id = ${id}`);
  return rows.rows[0]?.into_id ?? id;
};

/** Ids as they are now (merged ones replaced), without repeats, in the order given. */
export const resolveStoryIds = async (db: Runner, ids: number[]) => {
  if (ids.length === 0) return ids;
  const rows = await db.execute<{ from_id: number; into_id: number }>(
    sql`select from_id, into_id from story_merges where from_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
  );
  const map = new Map(rows.rows.map((r) => [r.from_id, r.into_id]));
  return [...new Set(ids.map((id) => map.get(id) ?? id))];
};

/** Moves everything from one story into another, then deletes it, leaving a redirect. */
export const moveStory = async (tx: Tx, fromId: number, intoId: number, reason: "model" = "model") => {
  const moved = await tx.execute<{ id: number }>(sql`update articles set story_id = ${intoId} where story_id = ${fromId} returning id`);
  const articleIds = moved.rows.map((r) => r.id);
  await tx.execute(sql`update comments set story_id = ${intoId} where story_id = ${fromId}`);
  // Marks keep their voter key; one reader who marked both stories counts once.
  await tx.execute(sql`insert into story_votes (story_id, voter, user_id, created_at)
    select ${intoId}, voter, user_id, created_at from story_votes where story_id = ${fromId} on conflict do nothing`);
  await tx.execute(sql`insert into user_follows (user_id, kind, target_id, created_at)
    select user_id, kind, ${intoId}, created_at from user_follows where kind = 'story' and target_id = ${fromId} on conflict do nothing`);
  await tx.execute(sql`delete from user_follows where kind = 'story' and target_id = ${fromId}`);
  await tx.execute(sql`insert into user_saves (user_id, kind, target_id, created_at)
    select user_id, kind, ${intoId}, created_at from user_saves where kind = 'story' and target_id = ${fromId} on conflict do nothing`);
  await tx.execute(sql`delete from user_saves where kind = 'story' and target_id = ${fromId}`);
  await tx.execute(sql`insert into user_reads (user_id, story_id, created_at)
    select user_id, ${intoId}, created_at from user_reads where story_id = ${fromId} on conflict do nothing`);
  await tx.execute(sql`delete from user_reads where story_id = ${fromId}`);
  // One unread update per reader and story: drop the old story's where the other already has one.
  await tx.execute(sql`delete from notifications n where n.kind = 'story_update' and n.target_id = ${fromId} and n.read_at is null
    and exists (select 1 from notifications o where o.user_id = n.user_id and o.kind = 'story_update' and o.target_id = ${intoId} and o.read_at is null)`);
  await tx.execute(sql`update notifications set target_id = ${intoId} where kind = 'story_update' and target_id = ${fromId}`);
  await tx.execute(sql`update story_merges set into_id = ${intoId} where into_id = ${fromId}`);
  await tx.execute(sql`delete from stories where id = ${fromId}`);
  await tx.execute(sql`insert into story_merges (from_id, into_id, reason, article_ids)
    values (${fromId}, ${intoId}, ${reason}, ${`{${articleIds.join(",")}}`}::integer[])
    on conflict (from_id) do update set into_id = excluded.into_id, reason = excluded.reason, article_ids = excluded.article_ids, merged_at = now()`);
  await tx.execute(sql`update stories set importa = (select count(*)::int from story_votes v where v.story_id = ${intoId}) where id = ${intoId}`);
};

interface Row extends Record<string, unknown> {
  id: number;
  title: string;
  excerpt: string;
  source: string;
  published_at: Date;
  story_id: number;
  story_created_at: Date;
  events: string[] | null;
  people: string[];
  parties: string[];
}

/** The stories with recent news, as the merge sees them. */
export const recentStories = async (db: Runner, now = new Date()) => {
  const rows = (
    await db.execute<Row>(sql`
      select a.id, a.title, a.excerpt, a.source, a.published_at, a.story_id, s.created_at as story_created_at,
        (select array_agg(t->>'slug') from jsonb_array_elements(coalesce(s.tags, '[]'::jsonb)) t where t->>'kind' = 'event') as events,
        array(select 'd:' || ad.deputy_id from article_deputies ad where ad.article_id = a.id)
          || array(select 'g:' || agm.member_id from article_government_members agm where agm.article_id = a.id)
          || array(select 'p:' || ap.president_id from article_presidents ap where ap.article_id = a.id) as people,
        array(select p.slug from article_parties ap join parties p on p.id = ap.party_id where ap.article_id = a.id) as parties
      from articles a join stories s on s.id = a.story_id
      where a.hidden_at is null and a.story_id in (
        select story_id from articles where hidden_at is null and story_id is not null
          and published_at >= ${now.toISOString()}::timestamptz - make_interval(hours => ${LOOKBACK_HOURS}))
      order by a.published_at, a.id`)
  ).rows;
  const stories = new Map<number, MergeStory>();
  for (const r of rows) {
    const story = stories.get(r.story_id) ?? { id: r.story_id, createdAt: new Date(r.story_created_at), events: r.events ?? [], articles: [] };
    story.articles.push({
      id: r.id, title: r.title, excerpt: r.excerpt, source: r.source, publishedAt: new Date(r.published_at), people: r.people, parties: r.parties,
    });
    stories.set(r.story_id, story);
  }
  return [...stories.values()];
};

/**
 * Finds and joins stories that are the same news (see the top of this file). Returns the
 * stories that received others, for their tags to be refreshed.
 */
export const mergeStories = async (
  db: Db,
  { judge = null, maxChecks = MAX_CHECKS, now = new Date(), log = console }: { judge?: MergeJudge | null; maxChecks?: number; now?: Date; log?: Pick<Console, "error"> } = {},
) => {
  const stories = await recentStories(db, now);
  const context = await db.execute<{ title: string; excerpt: string }>(sql`
    select title, excerpt from articles where hidden_at is null
      and published_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${RARITY_DAYS})`);
  const rare = rarity(context.rows.map((a) => termsOf({ ...a, people: [] })));
  const found = candidates(stories, rare);

  const confirmed: Candidate[] = [];
  let checked = 0;
  let failures = 0;
  if (judge) {
    // Answers already given, while neither story has grown since.
    const toAsk: { candidate: Candidate; low: MergeStory; high: MergeStory; signature: string }[] = [];
    for (const candidate of found) {
      const [low, high] = candidate.a.id < candidate.b.id ? [candidate.a, candidate.b] : [candidate.b, candidate.a];
      const signature = `${low.articles.length}:${high.articles.length}`;
      const cached = await db.execute<{ same: boolean; signature: string }>(
        sql`select same, signature from story_merge_checks where low_id = ${low.id} and high_id = ${high.id}`,
      );
      if (cached.rows[0]?.signature === signature) {
        if (cached.rows[0].same) confirmed.push(candidate);
      } else if (toAsk.length < maxChecks) {
        toAsk.push({ candidate, low, high, signature });
      }
    }
    // A few at a time; after 3 errors (key, credit, outage) the rest wait for the next run.
    for (let i = 0; i < toAsk.length && failures < 3; i += CONCURRENCY) {
      await Promise.all(
        toAsk.slice(i, i + CONCURRENCY).map(async ({ candidate, low, high, signature }) => {
          let same: boolean | null;
          try {
            checked++;
            same = await judge(briefOf(low), briefOf(high));
          } catch (error) {
            failures++;
            log.error("Story merge check failed:", error instanceof Error ? error.message : error);
            return;
          }
          if (same === null) return;
          await db.execute(sql`insert into story_merge_checks (low_id, high_id, signature, same) values (${low.id}, ${high.id}, ${signature}, ${same})
            on conflict (low_id, high_id) do update set signature = excluded.signature, same = excluded.same, checked_at = now()`);
          if (same) confirmed.push(candidate);
        }),
      );
    }
  }

  // Each story joins at most once per run, strongest pairs first, newer into older. No chains:
  // A like B and B like C doesn't join A and C. The grown story is asked about again next run,
  // with its new headlines, so every join is one the model saw.
  const byId = new Map(stories.map((s) => [s.id, s]));
  const older = (x: number, y: number) => {
    const [a, b] = [byId.get(x)!, byId.get(y)!];
    return +a.createdAt < +b.createdAt || (+a.createdAt === +b.createdAt && a.id < b.id) ? x : y;
  };
  const used = new Set<number>();
  const moves: { from: number; into: number }[] = [];
  for (const pair of [...confirmed].sort((x, y) => y.score - x.score)) {
    if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
    used.add(pair.a.id).add(pair.b.id);
    const into = older(pair.a.id, pair.b.id);
    moves.push({ from: into === pair.a.id ? pair.b.id : pair.a.id, into });
  }

  const into = new Set<number>();
  if (moves.length) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assign_stories'))`);
      for (const move of moves) {
        const present = await tx.execute<{ n: number }>(sql`select count(*)::int as n from stories where id in (${move.from}, ${move.into})`);
        if (present.rows[0]?.n !== 2) continue;
        await moveStory(tx, move.from, move.into);
        into.add(move.into);
      }
    });
  }
  return { candidates: found.length, checked, merged: moves.filter((m) => into.has(m.into)).length, into };
};
