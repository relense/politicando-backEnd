/*
 * Groups articles from different outlets that tell the same story. Two articles are the same
 * story when, published close together, their titles and excerpts share enough rare words
 * and they name the same people. Rarity is measured across recent articles, so "Governo" or
 * "Chega" count little and "Odemira" or "greve dos médicos" count a lot.
 *
 * It favours a missed match over a wrong one: two stories shown apart are a small loss, two
 * different stories shown as one would be misleading.
 */

/** What the grouping looks at in an article. */
export interface StoryArticle {
  id: number;
  title: string;
  excerpt: string;
  publishedAt: Date;
  /** People named in it: deputies, Government members, the President, as "d:12", "g:ab…", "p:x". */
  people: string[];
  source: string;
}

const GRAMMAR = new Set(
  `a ao aos as com como da das de do dos e em entre era essa esse esta este isso na nas no nos o os
  ou para pela pelas pelo pelos por que quem qual se sem seu sua seus suas sob sobre ate apos um uma
  umas uns mais muito ser sao foi tem ter nao ja lhe lhes cada diz disse afirma garante quer pode
  vai vao esta estao sera seja ha hoje ontem amanha agora depois antes ainda tambem so apenas ano
  anos dia dias semana mes contra novo nova novos novas sobre ser segundo onde quando porque`
    .split(/\s+/)
    .filter(Boolean),
);

const STEM = 6;

const normalise = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Word stems of a text, without grammar words. */
export const stemsOf = (text: string) =>
  new Set((normalise(text).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !GRAMMAR.has(w)).map((w) => (/^\d+$/.test(w) ? w : w.slice(0, STEM))));

/** The terms that identify an article: title stems count double, as "t:" terms too. */
/** Party names as headlines write them, to their party. */
const TITLE_PARTIES: Record<string, string> = {
  ps: "ps", psd: "psd", chega: "chega", il: "il", livre: "livre", pcp: "pcp", be: "be", bloco: "be",
  pan: "pan", cds: "cds", jpp: "jpp", ad: "ad",
};

/** The parties a headline names: "PSD/M apresenta…" → psd. */
export const titlePartiesOf = (title: string) =>
  new Set((title.toLowerCase().match(/[\p{L}]+/gu) ?? []).map((w) => TITLE_PARTIES[w]).filter((p): p is string => p !== undefined));

export const termsOf = (article: Pick<StoryArticle, "title" | "excerpt" | "people">) => {
  const title = stemsOf(article.title);
  const body = stemsOf(`${article.title} ${article.excerpt}`);
  return { title, body, people: new Set(article.people), titleParties: titlePartiesOf(article.title) };
};
export type Terms = ReturnType<typeof termsOf>;

/** How rare each stem is across a set of articles, as log inverse document frequency. */
export const rarity = (all: Terms[]) => {
  const df = new Map<string, number>();
  for (const t of all) for (const stem of t.body) df.set(stem, (df.get(stem) ?? 0) + 1);
  const n = Math.max(all.length, 1);
  return (stem: string) => Math.log((n + 1) / ((df.get(stem) ?? 0) + 1));
};
export type Rarity = ReturnType<typeof rarity>;

export interface Similarity {
  score: number;
  shared: string[];
  people: number;
}

/**
 * How alike two articles are, 0 to 1: the rare words they share, weighed against the smaller
 * of the two (so a short excerpt can still match a long one), with shared title words counting
 * double. People named in both add to it.
 */
export const similarity = (a: Terms, b: Terms, rare: Rarity): Similarity => {
  const weight = (t: Terms) => {
    let w = 0;
    for (const s of t.body) w += rare(s) * (t.title.has(s) ? 2 : 1);
    return w;
  };
  let shared = 0;
  const words: string[] = [];
  for (const s of a.body) {
    if (!b.body.has(s)) continue;
    const r = rare(s);
    if (r < MIN_RARITY) continue;
    words.push(s);
    shared += r * (a.title.has(s) && b.title.has(s) ? 2 : 1);
  }
  const people = [...a.people].filter((p) => b.people.has(p)).length;
  const base = shared / Math.max(Math.min(weight(a), weight(b)), 1);
  return { score: Math.min(1, base + Math.min(people * PERSON_BONUS, MAX_PEOPLE_BONUS)), shared: words, people };
};

/** Words in nearly every other article ("governo") don't count as shared at all. */
const MIN_RARITY = 1.2;
const PERSON_BONUS = 0.03;
const MAX_PEOPLE_BONUS = 0.06;
/** Together these make two articles the same story. */
export const MIN_SCORE = 0.4;
export const MIN_SHARED_WORDS = 3;
/** Articles further apart than this aren't compared. */
export const WINDOW_HOURS = 36;

/** Two articles from the same outlet need more: live blogs repeat the same boilerplate. */
export const MIN_SCORE_SAME_SOURCE = 0.6;

/**
 * Whether two articles tell the same story. Headlines naming different parties never do,
 * however alike their words ("PSD/Madeira apresenta propostas" and "PS/Madeira apresenta
 * propostas").
 */
export const sameStory = (a: { terms: Terms; source: string }, b: { terms: Terms; source: string }, rare: Rarity) => {
  const s = similarity(a.terms, b.terms, rare);
  const [pa, pb] = [a.terms.titleParties, b.terms.titleParties];
  const otherParty = pa.size > 0 && pb.size > 0 && ![...pa].some((p) => pb.has(p));
  const ok =
    !otherParty && s.shared.length >= MIN_SHARED_WORDS && s.score >= (a.source === b.source ? MIN_SCORE_SAME_SOURCE : MIN_SCORE);
  return { ok, score: s.score };
};

/** A story so far, while grouping: its articles with their terms. */
export interface Grouping<A extends { publishedAt: Date }> {
  articles: { article: A; terms: Terms; source: string }[];
}

/**
 * The story an article belongs to among `stories`, or null for a new one. It must be the same
 * story as at least half of a story's articles (not just one, so stories don't drift from
 * topic to topic), and one of them must be within the window. The best average wins.
 */
export const pickStory = <A extends { publishedAt: Date }, G extends Grouping<A>>(
  candidate: { article: A; terms: Terms; source: string },
  stories: G[],
  rare: Rarity,
): G | null => {
  let best: G | null = null;
  let bestAverage = 0;
  const window = WINDOW_HOURS * 3_600_000;
  for (const story of stories) {
    if (!story.articles.some((m) => Math.abs(+m.article.publishedAt - +candidate.article.publishedAt) <= window)) continue;
    const results = story.articles.map((m) => sameStory(candidate, m, rare));
    const hits = results.filter((r) => r.ok).length;
    if (hits === 0 || hits < Math.ceil(story.articles.length / 2)) continue;
    const average = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    if (average > bestAverage) {
      bestAverage = average;
      best = story;
    }
  }
  return best;
};
