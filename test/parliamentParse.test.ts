import { describe, expect, it } from "vitest";
import { matchArticle, matchDeputies } from "../src/matching/matchParties.js";
import { Readable } from "node:stream";
import { deputyVote, wasSitting } from "../src/parliament/deputyVotes.js";
import { findFolderLink, findJsonLink, streamJsonArray } from "../src/parliament/openData.js";
import { parseDeputies, parseInitiatives, parseVoteDetail } from "../src/parliament/parse.js";
import { SEATS } from "../src/parliament/seatMap.js";
import { resolveSeats } from "../src/parliament/sync.js";
import { biographies, chamber, deputyEntry, initiativesFile } from "./parliamentFixtures.js";

describe("seat map", () => {
  it("has 230 numbered seats with the official count per group", () => {
    expect(SEATS).toHaveLength(230);
    expect(new Set(SEATS.map(([n]) => n))).toEqual(new Set(Array.from({ length: 230 }, (_, i) => i + 1)));
    const perGroup: Record<string, number> = {};
    for (const [, group] of SEATS) perGroup[group] = (perGroup[group] ?? 0) + 1;
    expect(perGroup).toEqual({
      PSD: 89, CH: 60, PS: 58, IL: 9, L: 6, PCP: 3, "CDS-PP": 2, BE: 1, PAN: 1, JPP: 1,
    });
  });

  it("keeps positions inside the drawing", () => {
    for (const [, , x, y] of SEATS) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("parseDeputies", () => {
  const parsed = parseDeputies(chamber(), biographies());
  const byId = (id: number) => parsed.find((d) => d.id === id);

  it("keeps everyone who sat, and leaves out substitutes who never did", () => {
    expect(parsed.filter((d) => d.active)).toHaveLength(230);
    expect(byId(9001)).toMatchObject({ active: false, situation: "Renunciou" });
    expect(byId(9002)).toBeUndefined();
  });

  it("maps groups to party slugs and reads the biography", () => {
    expect(byId(7341)).toMatchObject({
      name: "Francisco César",
      parliamentaryGroup: "PS",
      partySlug: "ps",
      birthDate: "1978-11-11",
      profession: "Economista",
      education: [{ course: "Economia", completed: true }],
      roles: [
        { title: "Presidente do PS-Açores", current: true },
        { title: "Deputado regional", current: false },
      ],
      committees: [
        { name: "Comissão de Agricultura", acronym: "CAPes", membership: "Efetivo", role: "Coordenador do grupo parlamentar" },
      ],
      pastLegislatures: ["XVI", "XV"],
    });
  });

  it("uses the current group after a change, and the sitting record over an old one", () => {
    const moved = deputyEntry(5, "Rita Muda", "PS", "Efetivo", {
      DepGP: [
        { gpSigla: "PS", gpDtInicio: "2025-06-03", gpDtFim: "2026-01-01" },
        { gpSigla: "L", gpDtInicio: "2026-01-01", gpDtFim: null },
      ],
    });
    const old = deputyEntry(5, "Rita Muda", "PS", "Suspenso(Eleito)", {
      DepSituacao: [
        { sioDes: "Efetivo", sioDtInicio: "2025-06-03", sioDtFim: "2025-07-01" },
        { sioDes: "Suspenso(Eleito)", sioDtInicio: "2025-07-01", sioDtFim: null },
      ],
    });
    const [rita] = parseDeputies({ Deputados: [moved, old] }, []);
    expect(rita).toMatchObject({ parliamentaryGroup: "L", partySlug: "livre", active: true });
  });

  it("survives empty or foreign files", () => {
    expect(parseDeputies(null, null)).toEqual([]);
    expect(parseDeputies({ Deputados: [{ DepCadId: "x" }] }, "nope")).toEqual([]);
  });
});

describe("parseInitiatives", () => {
  const parsed = parseInitiatives(initiativesFile());
  const status = (id: number) => parsed.find((i) => i.id === id)?.status;

  it("works out the status from the stages", () => {
    expect(status(1)).toBe("approved");
    expect(status(2)).toBe("rejected");
    expect(status(3)).toBe("in_progress");
    expect(status(4)).toBe("withdrawn");
    expect(status(5)).toBe("in_progress");
  });

  it("keeps dates, authors, the latest stage and an https text link", () => {
    expect(parsed.find((i) => i.id === 1)).toMatchObject({
      phase: "Lei (Publicação DR)",
      phaseDate: "2025-10-20",
      submittedAt: "2025-07-01",
      publishedAt: "2025-10-20",
      authorGroups: ["PS"],
      authorDeputyIds: [7341],
      otherAuthor: null,
      textUrl: "https://app.parlamento.pt/webutils/docs/doc.pdf?path=1",
    });
    expect(parsed.find((i) => i.id === 5)?.otherAuthor).toBe("Governo");
  });

  it("skips initiatives without an id, title or any dated stage", () => {
    expect(parseInitiatives([{ IniId: "9", IniTitulo: "T", IniDescTipo: "X", IniEventos: [] }, {}, null])).toEqual([]);
  });
});

describe("parseVoteDetail", () => {
  it("reads whole groups, partial groups and named deputies", () => {
    expect(
      parseVoteDetail("A Favor: <I>PSD</I>, <I> 3-PS</I>, <I> Pedro Vaz (PS)</I><BR>Contra:<I>CH</I>, <I> BE</I><BR>Abstenção:<I>PS</I>, <I> Ninsc</I>"),
    ).toEqual({
      favor: [{ party: "psd", count: null }, { party: "ps", count: 3 }],
      against: [{ party: "chega", count: null }, { party: "be", count: null }],
      abstention: [{ party: "ps", count: null }, { party: "Ninsc", count: null }],
      named: [{ name: "Pedro Vaz", group: "PS", position: "favor" }],
    });
  });

  it("ignores unknown labels and empty text", () => {
    expect(parseVoteDetail("Ausência: <I>PS</I>")).toEqual({ favor: [], against: [], abstention: [], named: [] });
    expect(parseVoteDetail("")).toEqual({ favor: [], against: [], abstention: [], named: [] });
  });
});

describe("open data links", () => {
  it("finds the legislature folder and the JSON file", () => {
    const page = `<a id="a" title="Pasta XVII Legislatura" class="x" href="/Cidadania/Paginas/DAIniciativas.aspx?t=1&amp;Path=abc">XVII</a>`;
    expect(findFolderLink(page, "XVII")).toBe("https://www.parlamento.pt/Cidadania/Paginas/DAIniciativas.aspx?t=1&Path=abc");
    expect(findFolderLink(page, "XVI")).toBeNull();
    const folder = `<a href="https://app.parlamento.pt/doc.xml?path=1">IniciativasXVII.xml</a><a href="https://app.parlamento.pt/doc.txt?path=2&amp;x=1">IniciativasXVII_json.txt</a>`;
    expect(findJsonLink(folder)).toBe("https://app.parlamento.pt/doc.txt?path=2&x=1");
  });
});

describe("resolveSeats", () => {
  const parsed = parseDeputies(chamber(), biographies());
  const psSeat = SEATS.find(([, group]) => group === "PS")![0];
  const otherPsSeat = SEATS.filter(([, group]) => group === "PS")[1]![0];
  const chSeat = SEATS.find(([, group]) => group === "CH")![0];

  it("accepts a seat in the deputy's own block", () => {
    const warnings: string[] = [];
    expect(resolveSeats(parsed, { 7341: psSeat }, warnings).get(7341)).toBe(psSeat);
    expect(warnings).toEqual([]);
  });

  it("rejects another group's seat, a shared seat and deputies who left", () => {
    const warnings: string[] = [];
    const ps = parsed.find((d) => d.parliamentaryGroup === "PS" && d.id !== 7341)!;
    const seats = resolveSeats(parsed, { 7341: chSeat, [ps.id]: otherPsSeat, 9001: psSeat, 100_000: otherPsSeat }, warnings);
    expect(seats.has(7341)).toBe(false);
    expect(seats.has(9001)).toBe(false);
    expect(warnings).toHaveLength(3);
  });
});

describe("deputy matching", () => {
  const parties = [
    { id: 1, acronym: "PS", terms: ["PS"] },
    { id: 2, acronym: "PSD", terms: ["PSD"] },
  ];
  const deputies = [{ id: 7341, partyId: 1, terms: ["Francisco César"] }];

  it("counts a deputy for their party and links them", () => {
    const result = matchArticle({ title: "Francisco César quer mudança", content: "Disse o líder do PS." }, parties, deputies);
    expect(result.parties).toEqual([{ partyId: 1, mentions: 3 }]);
    expect(result.deputies).toEqual([{ deputyId: 7341, mentions: 2 }]);
  });

  it("needs a direct party mention, so a namesake alone isn't political", () => {
    expect(matchArticle({ title: "Francisco César marca dois golos", content: "" }, parties, deputies)).toEqual({
      parties: [],
      deputies: [],
    });
  });

  it("matches whole names only", () => {
    expect(matchDeputies({ title: "", content: "Francisco Césares e Francisco César." }, deputies)).toEqual([
      { deputyId: 7341, mentions: 1 },
    ]);
  });
});

describe("short names", () => {
  const parties = [
    { id: 1, acronym: "CH", terms: ["Chega"] },
    { id: 2, acronym: "PS", terms: ["PS"] },
  ];
  const ventura = { id: 6535, partyId: 1, terms: ["André Ventura"], contextTerms: ["André Ventura", "Ventura"] };
  const branco = { id: 2061, partyId: 3, terms: ["José Pedro Aguiar-Branco", "Aguiar-Branco"] };

  it("counts a common surname when the article names the party", () => {
    const result = matchArticle({ title: "Ventura pede maturidade", content: "O líder do Chega falou." }, parties, [ventura]);
    expect(result.deputies).toEqual([{ deputyId: 6535, mentions: 2 }]);
  });

  it("ignores a common surname without that context", () => {
    expect(matchArticle({ title: "Ventura marca golo", content: "O PS reagiu ao PS." }, parties, [ventura]).deputies).toEqual([]);
  });

  it("counts the full name once, not also as the surname", () => {
    expect(matchDeputies({ title: "", content: "André Ventura e o Chega." }, [ventura], () => true)).toEqual([
      { deputyId: 6535, mentions: 1 },
    ]);
  });

  it("counts a distinctive short name on its own", () => {
    expect(matchDeputies({ title: "Aguiar-Branco avisa deputados", content: "" }, [branco])).toEqual([
      { deputyId: 2061, mentions: 2 },
    ]);
  });
});

describe("deputyVote", () => {
  const base = { favor: [], against: [], abstention: [], named: [], absent: [], unanimous: false, result: "Aprovado" };
  const pedro = { name: "Pedro Vaz", group: "PS", party: "ps" };
  const ana = { name: "Ana Lima", group: "PS", party: "ps" };

  it("uses the named entry first", () => {
    const vote = { ...base, favor: [{ party: "ps", count: 1 }], abstention: [{ party: "ps", count: null }],
      named: [{ name: "Pedro Vaz", group: "PS", position: "favor" as const }] };
    expect(deputyVote(vote, pedro)).toEqual({ position: "favor", basis: "named" });
    // Everyone in the partial count is named, so the rest of PS abstained.
    expect(deputyVote(vote, ana)).toEqual({ position: "abstention", basis: "group" });
  });

  it("doesn't guess when a group split without names", () => {
    const vote = { ...base, favor: [{ party: "ps", count: 3 }], against: [{ party: "ps", count: null }] };
    expect(deputyVote(vote, ana)).toEqual({ position: null, basis: "unknown" });
  });

  it("handles absent groups, unanimous votes and missing groups", () => {
    expect(deputyVote({ ...base, absent: ["ps"] }, ana)).toEqual({ position: null, basis: "absent" });
    expect(deputyVote({ ...base, unanimous: true }, ana)).toEqual({ position: "favor", basis: "unanimous" });
    expect(deputyVote({ ...base, favor: [{ party: "psd", count: null }] }, ana)).toEqual({ position: null, basis: "unknown" });
  });

  it("checks sitting periods, end date exclusive", () => {
    const periods = [{ from: "2025-06-03", to: "2025-09-01" }, { from: "2026-01-01", to: null }];
    expect(wasSitting(periods, "2025-06-03")).toBe(true);
    expect(wasSitting(periods, "2025-09-01")).toBe(false);
    expect(wasSitting(periods, "2026-05-05")).toBe(true);
  });
});

describe("streamJsonArray", () => {
  it("yields array elements one by one and drops a byte order mark", async () => {
    const body = Readable.from([Buffer.from("\uFEFF[{\"a\":1},"), Buffer.from("{\"a\":2}]")]);
    const items: unknown[] = [];
    for await (const item of streamJsonArray(body)) items.push(item);
    expect(items).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
