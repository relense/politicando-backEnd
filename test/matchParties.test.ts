import { describe, expect, it } from "vitest";
import { buildPartyRegex, matchParties } from "../src/matching/matchParties.js";
import { PARTY_DEFINITIONS } from "../src/matching/parties.js";

const parties = PARTY_DEFINITIONS.map((party, index) => ({
  id: index + 1,
  acronym: party.acronym,
  terms: party.terms,
}));
const idOf = (slug: string) =>
  PARTY_DEFINITIONS.findIndex((party) => party.slug === slug) + 1;
const match = (content: string, title = "Título") =>
  matchParties({ title, content }, parties);
const mentions = (slug: string, content: string) =>
  match(content).find((result) => result.partyId === idOf(slug))?.mentions ?? 0;

describe("thresholds", () => {
  it("rejects an article whose top party has a single mention", () => {
    expect(match("O PS votou contra.")).toEqual([]);
  });

  it("accepts a top party with two mentions and a second party with one", () => {
    expect(match("O PS e o PS falaram com o PSD.")).toEqual([
      { partyId: idOf("ps"), mentions: 2 },
      { partyId: idOf("psd"), mentions: 1 },
    ]);
  });

  it("keeps at most four parties", () => {
    expect(match("PS PS PSD BE PCP IL")).toHaveLength(4);
  });

  it("breaks ties by acronym, whatever the input order", () => {
    const text = { title: "t", content: "PSD PSD PS PS" };
    const expected = [idOf("ps"), idOf("psd")];
    expect(matchParties(text, parties).map((r) => r.partyId)).toEqual(expected);
    expect(matchParties(text, [...parties].reverse()).map((r) => r.partyId)).toEqual(expected);
  });

  it("counts mentions in the title and the body", () => {
    expect(match("O PS reagiu.", "PS em debate")).toEqual([
      { partyId: idOf("ps"), mentions: 2 },
    ]);
  });
});

describe("bugs from the Ruby matcher", () => {
  it("does not count one CDS-PP mention twice", () => {
    expect(match("O CDS-PP reagiu.")).toEqual([]);
  });

  it("counts a long name plus bracketed acronym once", () => {
    expect(match("O Partido Socialista (PS) reagiu.")).toEqual([]);
    expect(match("O PS (Partido Socialista) reagiu.")).toEqual([]);
  });

  it("matches a mention at the very end of the text", () => {
    expect(mentions("psd", "O PSD reagiu e criticou o PSD")).toBe(2);
  });

  it("counts adjacent mentions", () => {
    expect(mentions("ps", "PS PS PS")).toBe(3);
  });

  it("treats a non-breaking space as whitespace in a long name", () => {
    expect(mentions("ps", "O Partido Socialista e o Partido Socialista")).toBe(2);
  });

  it("ignores stray whitespace in a term, like the old PPV tab", () => {
    const regex = buildPartyRegex(["Partido Exemplo\t"]);
    expect("O Partido Exemplo votou".match(regex)).toHaveLength(1);
  });

  it("escapes regex characters in terms", () => {
    expect("B.E.".match(buildPartyRegex(["B.E."]))).toHaveLength(1);
    expect("BxEx".match(buildPartyRegex(["B.E."]))).toBeNull();
    expect("A (A)TUA votou".match(buildPartyRegex(["(A)TUA"]))).toHaveLength(1);
  });
});

describe("boundaries", () => {
  it("does not match an acronym inside a longer word", () => {
    expect(mentions("ps", "PSD PSD PSOE PS1 ÉPS")).toBe(0);
  });

  it("is case-sensitive", () => {
    expect(mentions("psd", "psd psd")).toBe(0);
  });
});

describe("names that are also common words", () => {
  it("ignores MAS as an all-caps conjunction", () => {
    expect(mentions("mas", "GOVERNO RECUA MAS MANTÉM MAS NÃO CEDE")).toBe(0);
  });

  it("counts the MAS party in context or by full name", () => {
    expect(mentions("mas", "O partido MAS e o Movimento Alternativa Socialista")).toBe(2);
  });

  it("ignores Chega as a verb but counts the party", () => {
    expect(mentions("chega", "Chega a Lisboa hoje. Chega de atrasos.")).toBe(0);
    expect(mentions("chega", "Criticou o Chega e o líder do Chega")).toBe(2);
  });

  it("ignores everyday uses of Livre", () => {
    expect(mentions("livre", "Mercado Livre com Entrada Livre")).toBe(0);
    expect(mentions("livre", "O deputado do Livre e o LIVRE")).toBe(2);
  });

  it("does not read ADN meaning DNA as the party", () => {
    expect(mentions("adn", "O ADN do clube e o ADN da região")).toBe(0);
    expect(mentions("adn", "O partido ADN e a Alternativa Democrática Nacional")).toBe(2);
  });
});

describe("party data", () => {
  it("has unique slugs and 230 seats in total", () => {
    expect(new Set(PARTY_DEFINITIONS.map((p) => p.slug)).size).toBe(PARTY_DEFINITIONS.length);
    expect(PARTY_DEFINITIONS.reduce((sum, p) => sum + p.assemblySeats, 0)).toBe(230);
  });

  it("keeps the slugs the frontend redirects old party URLs to", () => {
    const slugs = PARTY_DEFINITIONS.map((p) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(["livre", "pctp-mrpp"]));
  });

  it("gives no two parties the same term", () => {
    const terms = PARTY_DEFINITIONS.flatMap((p) => p.terms);
    expect(new Set(terms).size).toBe(terms.length);
  });
});
