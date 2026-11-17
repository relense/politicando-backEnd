import { TOPICS } from "../parliament/plain.js";

/*
 * Tags on stories, for the "Em debate" row (#OE2027 · 214 comentários) and the context box.
 *
 * Two kinds:
 * - events: specific and curated here, like the State Budget of a year or an election. Add
 *   one when a subject dominates the news for weeks;
 * - topics: the broad subjects initiatives use too (src/parliament/plain.ts), like Habitação.
 */

export interface StoryTag {
  slug: string;
  /** Short, for a hashtag: "OE2027", "Habitação". */
  label: string;
  /** In full: "Orçamento do Estado para 2027", "Habitação e urbanismo". */
  name: string;
  kind: "event" | "topic";
}

const normalise = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Curated events. Each finds itself in a text and returns the tag, or null. */
const EVENTS: ((text: string) => StoryTag | null)[] = [
  // "OE2027", "OE 2027", "Orçamento do Estado para 2027".
  (text) => {
    const year = /\boe ?\/?(20\d\d)\b/.exec(text)?.[1] ?? /\borcamento do estado (?:para |de )?(20\d\d)\b/.exec(text)?.[1];
    return year ? { slug: `oe${year}`, label: `OE${year}`, name: `Orçamento do Estado para ${year}`, kind: "event" } : null;
  },
  (text) => (/\bestado da nacao\b/.test(text) ? { slug: "estado-da-nacao", label: "EstadoDaNação", name: "Debate do Estado da Nação", kind: "event" } : null),
  (text) => (/\bmoc(?:ao|oes) de censura\b/.test(text) ? { slug: "mocao-de-censura", label: "MoçãoDeCensura", name: "Moção de censura", kind: "event" } : null),
  (text) => (/\blegislativas\b/.test(text) ? { slug: "legislativas", label: "Legislativas", name: "Eleições legislativas", kind: "event" } : null),
  (text) => (/\bautarquicas\b/.test(text) ? { slug: "autarquicas", label: "Autárquicas", name: "Eleições autárquicas", kind: "event" } : null),
  (text) => (/\bpresidenciais\b/.test(text) ? { slug: "presidenciais", label: "Presidenciais", name: "Eleições presidenciais", kind: "event" } : null),
  (text) => (/\blei das rendas\b|\blei do arrendamento\b/.test(text) ? { slug: "lei-das-rendas", label: "LeiDasRendas", name: "Lei das rendas", kind: "event" } : null),
];

/**
 * Words that events already cover, left out when looking for topics: the initiatives' taxonomy
 * files "Orçamento do Estado" and elections under "Estado e autarquias", right for laws but
 * not for news, where #OE2027 or #Legislativas say it better.
 */
const EVENT_WORDS = /\borcamento do estado(?: (?:para|de) 20\d\d)?|\boe ?\/?20\d\d\b|\b(?:eleic|eleitora)\w*|\b(?:legislativas|autarquicas|presidenciais)\b/g;

/** At most this many topics per story: the ones most of its versions share. */
const MAX_TOPICS = 2;

/**
 * A story's tags from its versions' titles and excerpts. An event counts when any headline
 * names it, or a third of the versions do; a topic needs half of the versions, since broad
 * words turn up in passing.
 */
export const storyTagsOf = (versions: { title: string; excerpt: string }[]): StoryTag[] => {
  if (versions.length === 0) return [];
  const events = new Map<string, { tag: StoryTag; count: number; inTitle: boolean }>();
  const topics = new Map<string, number>();
  for (const v of versions) {
    const title = normalise(v.title);
    const text = `${title} ${normalise(v.excerpt)}`;
    const seen = new Set<string>();
    for (const find of EVENTS) {
      const tag = find(text);
      if (!tag || seen.has(tag.slug)) continue;
      seen.add(tag.slug);
      const entry = events.get(tag.slug) ?? { tag, count: 0, inTitle: false };
      entry.count++;
      entry.inTitle ||= find(title)?.slug === tag.slug;
      events.set(tag.slug, entry);
    }
    const topicText = text.replace(EVENT_WORDS, " ");
    for (const topic of TOPICS) if (topic.pattern.test(topicText)) topics.set(topic.slug, (topics.get(topic.slug) ?? 0) + 1);
  }
  const third = Math.ceil(versions.length / 3);
  const half = Math.ceil(versions.length / 2);
  const eventTags = [...events.values()].filter((e) => e.inTitle || e.count >= third).map((e) => e.tag);
  const topicTags = [...topics.entries()]
    .filter(([, count]) => count >= half)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOPICS)
    .map(([slug]) => {
      const name = TOPICS.find((t) => t.slug === slug)!.label;
      // "Habitação e urbanismo" → "Habitação".
      return { slug, label: name.split(/ e |, /)[0]!, name, kind: "topic" as const };
    });
  return [...eventTags, ...topicTags];
};

/** Whether a text (an agenda event's title, say) is about a tag. */
export const textHasTag = (text: string, tag: StoryTag) => {
  const normal = normalise(text);
  if (tag.kind === "topic") return TOPICS.find((t) => t.slug === tag.slug)?.pattern.test(normal) ?? false;
  return EVENTS.some((find) => find(normal)?.slug === tag.slug);
};

/** The words an editorial post's tags may use for a story tag ("oe2027", "orçamento", "habitação"). */
export const editorialTagWords = (tag: StoryTag) => {
  const words = new Set([tag.slug, normalise(tag.label), normalise(tag.name)]);
  if (/^oe20\d\d$/.test(tag.slug)) for (const w of ["orcamento", "orcamento do estado", "oe"]) words.add(w);
  if (tag.kind === "topic") for (const w of normalise(tag.name).split(/ e |, /)) words.add(w.trim());
  return [...words];
};
