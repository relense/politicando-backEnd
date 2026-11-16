/*
 * Links news articles to the initiatives (bills, resolutions) they talk about, by keywords.
 * The press almost never cites an initiative's number, and official titles rarely read like
 * headlines, so this is approximate: it favours a missed link over a wrong one, and every
 * link keeps its score so weak ones can be filtered or reviewed later.
 *
 * How it works: titles and articles are reduced to word stems and pairs of stems. A pair
 * found in both counts most, a rare single word a little; rarity is measured across all
 * initiative titles. A link needs a shared pair, plus either a good score with some of the
 * initiative's distinctive words, or most of a short title's words.
 */

/** Only articles that seem to be about legislation are checked at all. */
export const LEGISLATIVE_TERMS =
  /(?<![\p{L}\p{N}])(lei|leis|diplomas?|propostas?|projetos?|orçamento|OE ?\d{4}|votaç(ão|ões)|vot(ou|aram|a)|aprovad[oa]s?|chumb\w*|veto|vetar|parlamento|iniciativas?|decreto)(?![\p{L}\p{N}])/iu;

/** Grammar words, legal boilerplate and political words too common to identify a topic. */
const STOP_WORDS = new Set(
  `a ao aos as com como da das de do dos e em entre era essa esse esta este estes estas isso
  na nas no nos o os ou para pela pelas pelo pelos por que quem qual quais se sem seu sua seus
  suas sob sobre ate apos uma umas uns mais muito todo toda todos todas ser sao foi tem ter nao
  ja lhe lhes cada outro outra outros outras qualquer quer pode podem deve devem fim
  procede aprova altera alteracao alteracoes regime decreto lei leis artigo artigos numero
  relativo relativa relativos relativas medida medidas recomenda governo projeto proposta
  resolucao republica assembleia nacional portugal portugues portuguesa portugueses pais
  forma ambito termos novo nova novos novas cria criacao estabelece define garantir garante
  promove promover reforca reforco quadro geral publico publica publicos publicas direito
  direitos primeiro primeira ministro ministra ministerio presidente presidencia regiao
  regional regioes autonoma autonomas acores madeira apoio apoios financiamento cargo contra
  melhor melhoria aprovado aprovada valor valores ano anos sistema programa processo plano
  partido partidos deputado deputados parlamento politica politicas social sociais estado`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words that never carry meaning, not even inside a pair. */
const GRAMMAR = new Set(
  "a ao aos as com da das de do dos e em na nas no nos o os ou para pela pelas pelo pelos por que se sem um uma umas uns".split(" "),
);

const STEM_LENGTH = 6;
const MIN_SCORE = 18;
const MIN_COVERAGE = 0.15;
/** Short titles ("Orçamento do Estado para 2027") can't score high, but are well covered. */
const SHORT_TITLE_SCORE = 10;
const SHORT_TITLE_COVERAGE = 0.4;
const PAIR_WEIGHT = 1.5;
/** A single word must be at least this rare (as log inverse frequency) to count. */
const MIN_WORD_RARITY = 3;
const MAX_INITIATIVES_PER_ARTICLE = 3;
/** Initiatives with no activity in this many days before an article aren't considered. */
export const ACTIVITY_WINDOW_DAYS = 120;

const normalise = (text: string) =>
  text
    .replace(/(?<![\p{L}\p{N}])OE ?(\d{4})(?![\p{L}\p{N}])/gu, "Orçamento do Estado $1")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Stems and pairs of neighbouring stems. A pair is kept unless both of its words are stop
 * words, so "Orçamento do Estado" gives "orcame estado" even though "estado" alone is too
 * common to count, while "primeiro-ministro" gives nothing.
 */
export const termsOf = (text: string): Set<string> => {
  const words = (normalise(text).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !GRAMMAR.has(w));
  const stem = (w: string) => (/^\d+$/.test(w) ? w : w.slice(0, STEM_LENGTH));
  const terms = new Set<string>();
  words.forEach((word, i) => {
    if (!STOP_WORDS.has(word)) terms.add(stem(word));
    const next = words[i + 1];
    if (next && !(STOP_WORDS.has(word) && STOP_WORDS.has(next)) && !bothNumbers(word, next)) {
      terms.add(`${stem(word)} ${stem(next)}`);
    }
  });
  return terms;
};

const bothNumbers = (a: string, b: string) => /^\d+$/.test(a) && /^\d+$/.test(b);

export interface IndexedInitiative {
  id: number;
  /** Latest activity, as YYYY-MM-DD. */
  activityDate: string;
  /** When it was submitted: an article can't be about an initiative that didn't exist yet. */
  submittedAt: string | null;
  terms: Set<string>;
  /** Sum of the weights of all its terms, to measure how much of it an article covers. */
  totalWeight: number;
}

export interface InitiativeIndex {
  initiatives: IndexedInitiative[];
  weight: (term: string) => number;
}

export const buildInitiativeIndex = (
  rows: { id: number; title: string; activityDate: string; submittedAt?: string | null }[],
): InitiativeIndex => {
  const withTerms = rows.map((row) => ({ ...row, terms: termsOf(row.title) }));
  const documentFrequency = new Map<string, number>();
  for (const { terms } of withTerms) {
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const rarity = (term: string) => Math.log(Math.max(rows.length, 1) / (documentFrequency.get(term) ?? 1));
  const weight = (term: string) => {
    if (term.includes(" ")) return rarity(term) * PAIR_WEIGHT;
    const value = rarity(term);
    return value >= MIN_WORD_RARITY ? value : 0;
  };
  return {
    weight,
    initiatives: withTerms.map(({ id, activityDate, submittedAt, terms }) => ({
      id,
      activityDate,
      submittedAt: submittedAt ?? null,
      terms,
      totalWeight: [...terms].reduce((sum, term) => sum + weight(term), 0),
    })),
  };
};

export interface InitiativeMatch {
  initiativeId: number;
  score: number;
}

const daysAfter = (date: Date, days: number) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** News sometimes announces an initiative a day or two before it's formally submitted. */
const ANNOUNCEMENT_DAYS = 3;

export const matchInitiatives = (
  index: InitiativeIndex,
  article: { text: string; publishedAt: Date },
): InitiativeMatch[] => {
  if (!LEGISLATIVE_TERMS.test(article.text)) return [];
  const articleTerms = termsOf(article.text);
  const earliest = daysAfter(article.publishedAt, -ACTIVITY_WINDOW_DAYS);
  const latestSubmission = daysAfter(article.publishedAt, ANNOUNCEMENT_DAYS);

  return index.initiatives
    .filter(
      (initiative) =>
        initiative.totalWeight > 0 &&
        initiative.activityDate >= earliest &&
        (initiative.submittedAt === null || initiative.submittedAt <= latestSubmission),
    )
    .map((initiative) => {
      let score = 0;
      let pairs = 0;
      for (const term of initiative.terms) {
        if (!articleTerms.has(term)) continue;
        score += index.weight(term);
        if (term.includes(" ") && index.weight(term) > 0) pairs++;
      }
      return { initiative, score, pairs, coverage: score / initiative.totalWeight };
    })
    .filter(
      ({ score, pairs, coverage }) =>
        pairs > 0 &&
        ((score >= MIN_SCORE && coverage >= MIN_COVERAGE) ||
          (score >= SHORT_TITLE_SCORE && coverage >= SHORT_TITLE_COVERAGE)),
    )
    // Higher score first; on a tie, the more recently active initiative.
    .sort((a, b) => b.score - a.score || b.initiative.activityDate.localeCompare(a.initiative.activityDate))
    .slice(0, MAX_INITIATIVES_PER_ARTICLE)
    .map(({ initiative, score }) => ({ initiativeId: initiative.id, score: Math.round(score * 10) / 10 }));
};
