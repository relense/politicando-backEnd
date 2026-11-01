export const MIN_TOP_PARTY_MENTIONS = 2;
export const MIN_OTHER_PARTY_MENTIONS = 1;
export const MAX_PARTIES_PER_ARTICLE = 4;

export interface MatchableParty {
  id: number;
  acronym: string;
  terms: string[];
}

export interface PartyMatch {
  partyId: number;
  mentions: number;
}

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
    `(?<![\\p{L}\\p{N}])(?:${any})(?:\\s*\\((?:${any})\\))?(?![\\p{L}\\p{N}])`,
    "gu",
  );
};

const countMentions = (text: string, regex: RegExp) =>
  [...text.matchAll(regex)].length;

export const matchParties = (
  article: { title: string; content: string },
  parties: MatchableParty[],
): PartyMatch[] => {
  const text = `${article.title}\n${article.content}`;

  const ranked = parties
    .map((party) => ({
      party,
      mentions: countMentions(text, buildPartyRegex(party.terms)),
    }))
    .filter(({ mentions }) => mentions >= MIN_OTHER_PARTY_MENTIONS)
    .sort(
      (a, b) =>
        b.mentions - a.mentions || a.party.acronym.localeCompare(b.party.acronym),
    );

  const top = ranked[0];
  if (!top || top.mentions < MIN_TOP_PARTY_MENTIONS) return [];

  return ranked
    .slice(0, MAX_PARTIES_PER_ARTICLE)
    .map(({ party, mentions }) => ({ partyId: party.id, mentions }));
};
