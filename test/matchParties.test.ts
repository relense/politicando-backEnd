import { describe, expect, it } from "vitest";
import { buildPartyRegex, matchParties } from "../src/matching/matchParties.js";
import { AD_TERMS, CDU_TERMS, PARTY_DEFINITIONS } from "../src/matching/parties.js";

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

  it("gives a headline mention double weight, so it alone qualifies", () => {
    expect(match("", "PS em debate")).toEqual([{ partyId: idOf("ps"), mentions: 2 }]);
    expect(match("O PS reagiu.", "PS em debate")).toEqual([{ partyId: idOf("ps"), mentions: 3 }]);
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

describe("headlines", () => {
  const titleMatch = (title: string) => matchParties({ title, content: "" }, parties);

  it.each(["Chega quer novo debate", "Chega: a resposta do partido", "PSD e Chega negoceiam", "PS, Chega e IL", "Moção diz que Chega está pronto"])(
    "finds the party in %s",
    (title) => {
      expect(titleMatch(title).map((r) => r.partyId)).toContain(idOf("chega"));
    },
  );

  it.each(["Chega a Lisboa o novo ministro", "Chega de atrasos"])("ignores the verb in %s", (title) => {
    expect(titleMatch(title).map((r) => r.partyId)).not.toContain(idOf("chega"));
  });

  it("finds Livre in a headline but not a free market", () => {
    expect(titleMatch("Livre propõe nova lei").map((r) => r.partyId)).toEqual([idOf("livre")]);
    expect(titleMatch("Mercado Livre cresce")).toEqual([]);
  });
});

describe("coalitions", () => {
  it("credits CDU to both PCP and PEV", () => {
    expect(match("A CDU e a CDU reagiram.").map((r) => r.partyId).sort()).toEqual(
      [idOf("pcp"), idOf("pev")].sort(),
    );
  });

  it("credits AD to both PSD and CDS-PP", () => {
    expect(match("A AD venceu e a Aliança Democrática celebrou.").map((r) => r.partyId).sort()).toEqual(
      [idOf("psd"), idOf("cds-pp")].sort(),
    );
  });

  it("ignores AD without coalition context", () => {
    expect(match("AD Fundum e AD Astra AD")).toEqual([]);
  });
});

describe("foreign parties", () => {
  it.each([
    "O Partido Socialista francês e o Partido Socialista espanhol",
    "O Partido Socialista Europeu e o Partido Socialista Operário Espanhol",
    "O Partido Social Democrata alemão e o PSD romeno",
    "A CDU alemã, a CDU de Merz e a CDU/CSU",
    "O Partido Socialista de Espanha e o Partido Socialista do Brasil",
  ])("ignores %s", (text) => {
    expect(match(text)).toEqual([]);
  });

  it("still counts the Portuguese party in the same article", () => {
    expect(mentions("ps", "O PS falou. O Partido Socialista francês não. O PS insistiu.")).toBe(2);
  });

  it("is not confused by a qualifier that only starts the next word", () => {
    expect(mentions("ps", "O PS belgaço e o PS")).toBe(2);
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
    const shared = new Set([...CDU_TERMS, ...AD_TERMS]);
    const terms = PARTY_DEFINITIONS.flatMap((p) => p.terms).filter((term) => !shared.has(term));
    expect(new Set(terms).size).toBe(terms.length);
  });
});
