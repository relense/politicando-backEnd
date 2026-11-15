import { describe, expect, it } from "vitest";
import { buildInitiativeIndex, matchInitiatives, termsOf } from "../src/matching/matchInitiatives.js";
import { matchArticle, matchDeputies } from "../src/matching/matchParties.js";
import { Readable } from "node:stream";
import { deputyVote, wasSitting } from "../src/parliament/deputyVotes.js";
import { findFolderLink, findJsonLink, streamJsonArray } from "../src/parliament/openData.js";
import { parseDeputies, parseInitiatives, parseVoteDetail, presidencyOf } from "../src/parliament/parse.js";
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

describe("matchInitiatives", () => {
  const filler = Array.from({ length: 300 }, (_, i) => ({
    id: 1000 + i,
    title: `Recomenda ao Governo medidas para o setor ${i} e apoio às famílias`,
    activityDate: "2026-10-01",
  }));
  const index = buildInitiativeIndex([
    { id: 1, title: "Orçamento do Estado para 2027", activityDate: "2026-10-29", submittedAt: "2026-10-09" },
    { id: 2, title: "Orçamento do Estado para 2026", activityDate: "2025-11-28", submittedAt: "2025-10-09" },
    { id: 3, title: "Pelo fim das nomeações partidárias de altos quadros da Administração Pública", activityDate: "2026-10-01" },
    { id: 4, title: "Deslocação do Presidente da República a Cabo Verde", activityDate: "2026-10-20" },
    ...filler,
  ]);
  const match = (text: string, date = "2026-11-14") =>
    matchInitiatives(index, { text, publishedAt: new Date(`${date}T12:00:00Z`) }).map((m) => m.initiativeId);

  it("expands OE2027 and picks the budget active at the time", () => {
    expect(match("OE2027: Chega apresenta propostas")).toEqual([1]);
    expect(match("PS ameaça chumbar o Orçamento do Estado")).toEqual([1]);
    expect(match("PS ameaça chumbar o Orçamento do Estado", "2025-12-01")).toEqual([2]);
  });

  it("matches distinctive phrases from long titles", () => {
    expect(match("PS quer terminar com nomeações partidárias na saúde, numa proposta")).toEqual([3]);
  });

  it("ignores articles that aren't about legislation, and generic political words", () => {
    expect(match("Nomeações partidárias voltam a gerar polémica")).toEqual([]);
    expect(match("O Presidente da República falou ao país sobre a lei")).toEqual([]);
  });

  it("skips initiatives inactive for months", () => {
    expect(match("Proposta sobre nomeações partidárias", "2027-06-01")).toEqual([]);
  });

  it("builds pairs across stop words but not from two generic words", () => {
    const terms = termsOf("Orçamento do Estado e o primeiro-ministro");
    expect(terms.has("orcame estado")).toBe(true);
    expect(terms.has("primei minist")).toBe(false);
  });
});

describe("presidencyOf", () => {
  const ev = (Fase: string, DataFase: string) => ({ Fase, DataFase });
  it("follows the decree through Belém, the latest event winning", () => {
    expect(presidencyOf([ev("Entrada", "2026-01-01")])).toBeNull();
    expect(presidencyOf([ev("Envio para promulgação", "2026-04-01")])).toEqual({
      status: "pending", sentAt: "2026-04-01", promulgatedAt: null, promulgationRecorded: true, vetoedAt: null, vetoKind: null, constitutionalCourt: [], vetoes: [],
    });
    expect(presidencyOf([ev("Envio para promulgação", "2026-04-01"), ev("Promulgação", "2026-04-10")])?.status).toBe("promulgated");
    expect(presidencyOf([ev("Envio para promulgação", "2026-04-01"), ev("Veto (Receção)", "2026-04-20")])?.status).toBe("vetoed");
    // Vetoed, passed again and sent back: pending, then promulgated.
    const second = [
      ev("Envio para promulgação", "2026-04-01"), ev("Veto (Receção)", "2026-04-20"),
      ev("Envio para promulgação (2ª versão)", "2026-06-01"),
    ];
    expect(presidencyOf(second)).toMatchObject({ status: "pending", vetoedAt: "2026-04-20", sentAt: "2026-06-01" });
    expect(presidencyOf([...second, ev("Promulgação (2ª versão)", "2026-06-10")])).toMatchObject({
      status: "promulgated", vetoedAt: "2026-04-20", promulgatedAt: "2026-06-10",
    });
  });

  it("infers a promulgation the record skips from the law's publication", () => {
    const sent = [ev("Envio para promulgação", "2026-07-31"), ev("Lei (Publicação DR)", "2026-08-19")];
    expect(presidencyOf(sent)).toMatchObject({ status: "promulgated", promulgatedAt: null, promulgationRecorded: false });
  });

  it("tells a veto after a Constitutional Court ruling from a political one", () => {
    const veto = (ObsFase: string) => [
      ev("Envio para promulgação", "2025-11-01"),
      { Fase: "Veto (Receção)", DataFase: "2025-12-19", ObsFase },
    ];
    expect(presidencyOf(veto("Decreto n.º 17/XVII - Acórdão do Tribunal Constitucional n.º 1133/2025"))).toMatchObject({
      status: "vetoed",
      vetoKind: "unconstitutionality",
      constitutionalCourt: [{ ruling: "1133/2025", url: "https://www.tribunalconstitucional.pt/tc/acordaos/20251133.html" }],
    });
    expect(presidencyOf(veto("Decreto 70/XVII"))).toMatchObject({ vetoKind: "political", constitutionalCourt: [] });
    // Vetoed after a ruling, passed again, vetoed again on its merits.
    const twice = [
      ...veto("Acórdão do Tribunal Constitucional n.º 785/2025"),
      { Fase: "Veto (Leitura)", DataFase: "2025-12-20", ObsFase: "" },
      ev("Envio para promulgação (2ª versão)", "2026-05-01"),
      { Fase: "Veto (Receção)", DataFase: "2026-05-13", ObsFase: "Decreto n.º 49/XVII" },
    ];
    expect(presidencyOf(twice)).toMatchObject({
      status: "vetoed",
      vetoKind: "political",
      vetoes: [
        { date: "2025-12-19", kind: "unconstitutionality", constitutionalCourt: [{ ruling: "785/2025" }] },
        { date: "2026-05-13", kind: "political", constitutionalCourt: [] },
      ],
    });
  });
});
