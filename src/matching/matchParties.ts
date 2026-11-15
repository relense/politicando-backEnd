export const MIN_TOP_PARTY_MENTIONS = 2;
export const MIN_OTHER_PARTY_MENTIONS = 1;
export const MAX_PARTIES_PER_ARTICLE = 4;
/** A party in the headline is what the article is about, so it counts for more. */
export const TITLE_MENTION_WEIGHT = 2;

export interface MatchableParty {
  id: number;
  acronym: string;
  terms: string[];
}

export interface PartyMatch {
  partyId: number;
  mentions: number;
}

/** A sitting deputy, matched by their parliamentary name ("Francisco César"). */
export interface MatchableDeputy {
  id: number;
  partyId: number | null;
  /** Kept as a one-item list so the regex cache can key on it, like party terms. */
  terms: string[];
}

export interface DeputyMatch {
  deputyId: number;
  mentions: number;
}

/**
 * A name followed by one of these is a foreign party: "Partido Socialista
 * francês", "CDU alemã", "PSD romeno", "Partido Socialista Europeu".
 */
const FOREIGN_QUALIFIER = [
  "alem[ãa]o?", "alem[ãa]es", "espanh[oó]l", "espanhola", "franc[eê]s", "francesa",
  "italian[oa]", "brit[âa]nic[oa]", "ingl[eê]s", "inglesa", "sueco", "sueca", "dinamarqu[eê]s",
  "dinamarquesa", "holand[eê]s", "holandesa", "belga", "grego", "grega", "romeno", "romena",
  "b[úu]lgaro", "b[úu]lgara", "h[úu]ngaro", "h[úu]ngara", "polaco", "polaca", "brasileir[oa]",
  "angolan[oa]", "mo[çc]ambican[oa]", "[Ee]uropeu", "[Ee]uropeia", "[Oo]per[áa]rio", "[Oo]brero", "de Merz",
  "d[aeo]s? (?:Alemanha|Espanha|Fran[çc]a|It[áa]lia|Reino Unido|Su[ée]cia|Dinamarca|Holanda|B[ée]lgica|Gr[ée]cia|Rom[ée]nia|Bulg[áa]ria|Hungria|Pol[óo]nia|Brasil|Angola|Mo[çc]ambique|Cabo Verde)",
].join("|");

const toPattern = (term: string) =>
  term
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("\\s+");

/**
 * Builds one regex for a party. Longer terms are tried first so "CDS-PP" isn't
 * seen as "CDS", and a term followed by another in brackets, such as
 * "Partido Socialista (PS)", is consumed as a single mention.
 */
export const buildPartyRegex = (terms: string[]): RegExp => {
  const patterns = [...new Set(terms.map((term) => term.trim()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(toPattern);
  if (patterns.length === 0) throw new Error("A party needs at least one term");
  const any = patterns.join("|");
  return new RegExp(
    // A term starting with a comma (", Chega") naturally follows a letter.
    `(?:(?<![\\p{L}\\p{N}])|(?=,))(?:${any})(?:\\s*\\((?:${any})\\))?(?![\\p{L}\\p{N}])` +
      `(?![-/]CSU)(?!\\s+(?:${FOREIGN_QUALIFIER})(?![\\p{L}\\p{N}]))`,
    "gu",
  );
};

const regexCache = new Map<string[], RegExp>();
const regexFor = (entity: { terms: string[] }) => {
  let regex = regexCache.get(entity.terms);
  if (!regex) {
    regex = buildPartyRegex(entity.terms);
    regexCache.set(entity.terms, regex);
  }
  return regex;
};

const count = (text: string, regex: RegExp) => [...text.matchAll(regex)].length;

/** Total mentions of any party, used to decide whether an article is worth opening. */
export const countMentions = (text: string, entities: { terms: string[] }[]) =>
  entities.reduce((total, entity) => total + count(text, regexFor(entity)), 0);

const weighted = (article: { title: string; content: string }, regex: RegExp) =>
  count(article.title, regex) * TITLE_MENTION_WEIGHT + count(article.content, regex);

/** Deputies named in an article, most mentioned first. */
export const matchDeputies = (
  article: { title: string; content: string },
  deputies: MatchableDeputy[],
): DeputyMatch[] =>
  deputies
    .map((deputy) => ({ deputyId: deputy.id, mentions: weighted(article, regexFor(deputy)) }))
    .filter(({ mentions }) => mentions > 0)
    .sort((a, b) => b.mentions - a.mentions || a.deputyId - b.deputyId);

/**
 * Scores parties and deputies together. A deputy's mentions also count for their party,
 * but an article still needs at least one direct party mention to be kept, so a namesake
 * of a deputy in a football story doesn't make it political.
 */
export const matchArticle = (
  article: { title: string; content: string },
  parties: MatchableParty[],
  deputies: MatchableDeputy[] = [],
): { parties: PartyMatch[]; deputies: DeputyMatch[] } => {
  const direct = new Map(parties.map((party) => [party.id, weighted(article, regexFor(party))]));
  const deputyMatches = matchDeputies(article, deputies);
  const partyOf = new Map(deputies.map((deputy) => [deputy.id, deputy.partyId]));

  const anyDirect = [...direct.values()].some((mentions) => mentions > 0);
  if (!anyDirect) return { parties: [], deputies: [] };

  const total = new Map(direct);
  for (const { deputyId, mentions } of deputyMatches) {
    const partyId = partyOf.get(deputyId);
    if (partyId != null && total.has(partyId)) total.set(partyId, total.get(partyId)! + mentions);
  }

  const ranked = parties
    .map((party) => ({ party, mentions: total.get(party.id) ?? 0 }))
    .filter(({ mentions }) => mentions >= MIN_OTHER_PARTY_MENTIONS)
    .sort(
      (a, b) =>
        b.mentions - a.mentions || a.party.acronym.localeCompare(b.party.acronym),
    );

  const top = ranked[0];
  if (!top || top.mentions < MIN_TOP_PARTY_MENTIONS) return { parties: [], deputies: [] };

  return {
    parties: ranked
      .slice(0, MAX_PARTIES_PER_ARTICLE)
      .map(({ party, mentions }) => ({ partyId: party.id, mentions })),
    deputies: deputyMatches,
  };
};

export const matchParties = (
  article: { title: string; content: string },
  parties: MatchableParty[],
): PartyMatch[] => matchArticle(article, parties).parties;
