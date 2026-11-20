import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articles, comments, notifications, stories, storyMergeChecks, storyMerges, storyVotes, userFollows, userReads, userSaves, users } from "../src/db/schema.js";
import { briefOf, candidates, mergeStories, signatureOf, type MergeJudge, type MergeStory, type StoryBrief } from "../src/stories/merge.js";
import { rarity, termsOf } from "../src/stories/similarity.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret" });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const HOUR = 3_600_000;
let n = 0;
type Version = [title: string, excerpt: string, source: string, hoursAgo: number];

/** A story with these versions, as the hourly grouping would have left it. */
const story = async (versions: Version[], parties: string[] = []) => {
  const [row] = await db.insert(stories).values({}).returning({ id: stories.id });
  for (const [title, excerpt, source, hoursAgo] of versions) {
    await insertArticle(
      db,
      { title, excerpt, source, sourceUri: `m${++n}`, url: `https://${source}/${n}`, publishedAt: new Date(Date.now() - hoursAgo * HOUR), storyId: row!.id },
      parties,
    );
  }
  return row!.id;
};

/** Other news, so word rarity behaves as with real data. */
const background = async () => {
  const topics: [string, string][] = [
    ["Bombeiros combatem incêndio na serra da Estrela", "Dezenas de operacionais estão no terreno desde a madrugada."],
    ["Inflação abranda em outubro", "O Instituto Nacional de Estatística divulgou os dados mensais dos preços."],
    ["Greve dos médicos marcada para dezembro", "Os sindicatos anunciaram três dias de paralisação nos hospitais."],
    ["Benfica vence em Braga", "Os encarnados ganharam por dois golos sem resposta."],
    ["Chuva forte no Norte", "O IPMA emitiu aviso amarelo para cinco distritos."],
    ["Câmara de Lisboa aprova novo plano de mobilidade", "A proposta prevê mais ciclovias e autocarros elétricos."],
    ["Sindicatos convocam manifestação nacional", "A CGTP marcou um protesto para o próximo sábado em Lisboa."],
    ["Preço dos combustíveis desce na segunda-feira", "A gasolina e o gasóleo ficam mais baratos, segundo as gasolineiras."],
    ["Universidade do Porto abre novo centro de investigação", "O laboratório vai estudar o mar e as alterações climáticas."],
    ["Comboios suprimidos na linha de Sintra", "A CP justifica com avarias na catenária."],
    ["Exportações crescem no terceiro trimestre", "Os dados do INE mostram uma subida face ao ano passado."],
    ["Museu reabre após obras de requalificação", "O espaço volta a receber visitantes a partir de terça-feira."],
  ];
  for (const [i, [title, excerpt]] of topics.entries()) await story([[title, excerpt, `fundo${i}.pt`, 30]]);
};

const reaction = async () => {
  const older = await story(
    [["Montenegro acusa PS e Chega de imaturidade e rejeita crise política", "O primeiro-ministro reagiu à aprovação conjunta do IVA zero no Orçamento do Estado pelo PS e pelo Chega.", "publico.pt", 3]],
    ["ps", "chega"],
  );
  const newer = await story(
    [["Montenegro diz que PS e Chega formam geringonça ao contrário mas rejeita crise política", "O primeiro-ministro reagiu à aprovação do IVA zero no Orçamento do Estado com os votos do PS e do Chega.", "rtp.pt", 2]],
    ["ps", "chega"],
  );
  return { older, newer };
};

/** A judge that says `answer` and remembers what it was asked. */
const judgeSaying = (answer: boolean | null | Error) => {
  const asked: [StoryBrief, StoryBrief][] = [];
  const judge: MergeJudge = async (a, b) => {
    asked.push([a, b]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { judge, asked };
};

describe("joining stories that are the same news", () => {
  it("joins two stories the model says are the same into the older one, moving everything, and the old id keeps answering", async () => {
    await background();
    const { older, newer } = await reaction();
    const [user] = await db.insert(users).values({ username: "ana", passwordHash: "x" }).returning({ id: users.id });
    const userId = user!.id;
    await db.insert(storyVotes).values([{ storyId: newer, voter: "v1" }, { storyId: older, voter: "v2" }]);
    await db.update(stories).set({ importa: 1 }).where(eq(stories.id, newer));
    await db.insert(comments).values({ storyId: newer, body: "Que confusão", posterKey: "k" } as never);
    await db.insert(userFollows).values({ userId, kind: "story", targetId: newer });
    await db.insert(userSaves).values({ userId, kind: "story", targetId: newer });
    await db.insert(userReads).values({ userId, storyId: newer });
    await db.insert(notifications).values({ userId, kind: "story_update", targetId: newer });

    const { judge, asked } = judgeSaying(true);
    const result = await mergeStories(db, { judge });
    expect(result).toMatchObject({ merged: 1, checked: 1 });
    expect(asked[0]![0].headlines[0]!.title).toContain("imaturidade");

    expect(await db.select().from(stories).where(eq(stories.id, newer))).toEqual([]);
    expect(await db.select({ storyId: articles.storyId }).from(articles).where(sql`${articles.title} like 'Montenegro%'`)).toEqual([
      { storyId: older }, { storyId: older },
    ]);
    expect(await db.select({ intoId: storyMerges.intoId }).from(storyMerges).where(eq(storyMerges.fromId, newer))).toEqual([{ intoId: older }]);
    const [after] = await db.select({ importa: stories.importa }).from(stories).where(eq(stories.id, older));
    expect(after!.importa).toBe(2);
    for (const table of [userFollows, userSaves]) {
      expect((await db.select({ id: table.targetId }).from(table)).map((r) => r.id)).toEqual([older]);
    }
    expect((await db.select({ id: userReads.storyId }).from(userReads)).map((r) => r.id)).toEqual([older]);
    expect((await db.select({ id: notifications.targetId }).from(notifications)).map((r) => r.id)).toEqual([older]);

    // The old id answers as the story it went into, which lists where it came from.
    const detail = (await app.inject({ method: "GET", url: `/api/v2/stories/${newer}` })).json();
    expect(detail).toMatchObject({ id: older, sourceCount: 2, mergedFrom: [newer], commentCount: 1 });
    const viaOld = (await app.inject({ method: "GET", url: `/api/v2/stories/${newer}/comments` })).json();
    expect(viaOld).toEqual([expect.objectContaining({ body: "Que confusão", storyId: older })]);
    const saved = (await app.inject({ method: "GET", url: `/api/v2/stories?ids=${newer}` })).json();
    expect(saved.items.map((s: { id: number }) => s.id)).toEqual([older]);

    // Nothing left to ask.
    expect((await mergeStories(db, { judge })).checked).toBe(0);
  });

  it("joins each story at most once per run, so a chain doesn't pull in stories the model never compared", async () => {
    await background();
    const { older, newer } = await reaction();
    const third = await story(
      [["Montenegro garante que Governo vai até ao fim apesar de PS e Chega e rejeita crise política", "O primeiro-ministro reagiu à aprovação do IVA zero no Orçamento do Estado pelo PS e pelo Chega.", "sicnoticias.pt", 1]],
      ["ps", "chega"],
    );
    const { judge } = judgeSaying(true);
    expect((await mergeStories(db, { judge })).merged).toBe(1);
    expect((await db.select({ id: stories.id }).from(stories).where(sql`${stories.id} in (${older}, ${newer}, ${third})`))).toHaveLength(2);
    // The grown story is asked about again with its new headlines, and the last one joins then.
    expect((await mergeStories(db, { judge })).merged).toBe(1);
    const left = await db.select({ id: stories.id }).from(stories).where(sql`${stories.id} in (${older}, ${newer}, ${third})`);
    expect(left).toEqual([{ id: older }]);
    // Each join keeps which articles moved, so it can be undone.
    const merges = await db.select({ fromId: storyMerges.fromId, articleIds: storyMerges.articleIds }).from(storyMerges);
    expect(merges).toHaveLength(2);
    for (const m of merges) expect(m.articleIds).toHaveLength(1);
  });

  it("asks about a pair again only once a story grows, and never joins on a no", async () => {
    await background();
    const { older, newer } = await reaction();
    const { judge, asked } = judgeSaying(false);
    expect((await mergeStories(db, { judge })).merged).toBe(0);
    await mergeStories(db, { judge });
    expect(asked).toHaveLength(1);
    // The answer is tied to the articles both stories had.
    const ids = async (story: number) => (await db.select({ id: articles.id }).from(articles).where(eq(articles.storyId, story))).map((r) => r.id);
    expect(await db.select({ same: storyMergeChecks.same, signature: storyMergeChecks.signature }).from(storyMergeChecks)).toEqual([
      { same: false, signature: signatureOf(await ids(older), await ids(newer)) },
    ]);

    await insertArticle(
      db,
      {
        title: "Montenegro rejeita crise política depois de PS e Chega aprovarem IVA zero", excerpt: "O primeiro-ministro reagiu à aprovação no Orçamento do Estado.",
        source: "expresso.pt", sourceUri: "m-new", url: "https://expresso.pt/x", publishedAt: new Date(Date.now() - HOUR), storyId: newer,
      },
      ["ps", "chega"],
    );
    await mergeStories(db, { judge });
    expect(asked).toHaveLength(2);
    expect((await db.select().from(stories)).map((s) => s.id)).toEqual(expect.arrayContaining([older, newer]));
  });

  it("joins nothing without a model, or when the model fails, and leaves no answer behind", async () => {
    await background();
    await reaction();
    const none = await mergeStories(db, { judge: null });
    expect(none.candidates).toBeGreaterThan(0);
    expect(none.merged).toBe(0);

    const failing = judgeSaying(new Error("overloaded"));
    const errors: unknown[] = [];
    expect((await mergeStories(db, { judge: failing.judge, log: { error: (...args: unknown[]) => errors.push(args) } })).merged).toBe(0);
    expect(errors).toHaveLength(1);
    expect(await db.select().from(storyMergeChecks)).toEqual([]);
    expect((await mergeStories(db, { judge: judgeSaying(null).judge })).merged).toBe(0);
    expect(await db.select().from(storyMergeChecks)).toEqual([]);
  });
});

describe("which pairs are worth asking about", () => {
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
  const mk = (
    id: number, title: string, hoursAgo: number, parties: string[], events: string[] = [],
    excerpt = "O primeiro-ministro reagiu à aprovação do IVA zero no Orçamento do Estado.",
  ): MergeStory => ({
    id, createdAt: at(hoursAgo), events,
    articles: [{ id, title, excerpt, source: `s${id}.pt`, publishedAt: at(hoursAgo), people: [], parties }],
  });
  const corpus = [
    "Bombeiros combatem incêndio", "Inflação abranda em outubro", "Greve dos médicos em dezembro", "Benfica vence em Braga",
    "Chuva forte no Norte", "Câmara aprova plano de mobilidade", "Sindicatos convocam manifestação",
  ].map((title) => termsOf({ title, excerpt: "", people: [] }));
  const montenegro = "Montenegro acusa PS e Chega de imaturidade e rejeita crise política";
  const geringonca = "Montenegro diz que PS e Chega formam geringonça ao contrário e rejeita crise política";

  it("takes stories close in time that name the same parties", () => {
    const a = mk(1, montenegro, 3, ["ps", "chega"]);
    const b = mk(2, geringonca, 2, ["ps", "chega"]);
    const rare = rarity([...corpus, ...[a, b].map((s) => termsOf(s.articles[0]!))]);
    expect(candidates([a, b], rare)).toEqual([expect.objectContaining({ a, b })]);
  });

  it("leaves out stories more than 12 hours apart, or with nobody in common", () => {
    const a = mk(1, montenegro, 20, ["ps", "chega"]);
    const late = mk(2, geringonca, 2, ["ps", "chega"]);
    const rare = rarity([...corpus, ...[a, late].map((s) => termsOf(s.articles[0]!))]);
    expect(candidates([a, late], rare)).toEqual([]);
    // Alike, but not enough for the usual article test: then they need someone in common.
    const pair = (pa: string[], pb: string[]) => [
      mk(3, "Montenegro rejeita crise política e acusa a oposição de imaturidade", 3, pa, [], "O primeiro-ministro falou aos jornalistas em São Bento depois do Conselho de Ministros."),
      mk(4, "Governo fala em geringonça ao contrário mas rejeita crise política", 2, pb, [], "A ministra da Presidência respondeu no briefing semanal sobre a aprovação do IVA zero."),
    ];
    const rare2 = rarity([...corpus, ...pair([], []).map((s) => termsOf(s.articles[0]!))]);
    expect(candidates(pair(["ps"], ["ps"]), rare2)).toHaveLength(1);
    expect(candidates(pair(["il"], ["livre"]), rare2)).toEqual([]);
  });

  it("gives the model the headlines in order, with outlet and Lisbon time", () => {
    const brief = briefOf(mk(1, montenegro, 3, []));
    expect(brief.headlines).toEqual([{ title: montenegro, source: "s1.pt", at: expect.stringMatching(/^\d\d\/\d\d, \d\d:\d\d$/) }]);
    expect(brief.excerpt).toContain("IVA zero");
  });
});

describe("joining stories safely", () => {
  it("doesn't join stories that changed after the model was asked", async () => {
    await background();
    const { older, newer } = await reaction();
    // While the model answers, another run moves an article into one of the stories.
    let moved = false;
    const judge: MergeJudge = async () => {
      if (moved) return true;
      moved = true;
      await insertArticle(
        db,
        { title: "Outra coisa", excerpt: "Nada a ver.", source: "dn.pt", sourceUri: "late", url: "https://dn.pt/late", publishedAt: new Date(Date.now() - HOUR), storyId: newer },
        [],
      );
      return true;
    };
    expect((await mergeStories(db, { judge })).merged).toBe(0);
    expect(await db.select({ id: stories.id }).from(stories).where(sql`${stories.id} in (${older}, ${newer})`)).toHaveLength(2);
  });

  it("a logged-in reader who marked both stories counts once after they're joined", async () => {
    await background();
    const { older, newer } = await reaction();
    const [user] = await db.insert(users).values({ username: "rui", passwordHash: "x" }).returning({ id: users.id });
    await db.insert(storyVotes).values([
      { storyId: older, voter: "k-older", userId: user!.id },
      { storyId: newer, voter: "k-newer", userId: user!.id },
      { storyId: newer, voter: "k-anon" },
    ]);
    await mergeStories(db, { judge: async () => true });
    expect((await db.select({ voter: storyVotes.voter }).from(storyVotes).where(eq(storyVotes.storyId, older))).map((r) => r.voter).sort()).toEqual(["k-anon", "k-older"]);
    expect((await db.select({ importa: stories.importa }).from(stories).where(eq(stories.id, older)))[0]!.importa).toBe(2);
  });

  it("taking back an Importa on the story a mark was joined into removes the mark, and marking again counts once", async () => {
    await background();
    const { older, newer } = await reaction();
    const mark = (id: number, value: 0 | 1) =>
      app.inject({ method: "POST", url: `/api/v2/stories/${id}/vote`, payload: { value }, remoteAddress: "203.0.113.9" });
    expect((await mark(newer, 1)).json()).toMatchObject({ importa: 1 });
    await mergeStories(db, { judge: async () => true });

    // Marking the joined story again doesn't count the reader twice.
    expect((await mark(older, 1)).json()).toMatchObject({ importa: 1 });
    // Taking it back on the new id removes the mark that came from the old one.
    expect((await mark(older, 0)).json()).toMatchObject({ importa: 0 });
    expect(await db.select().from(storyVotes)).toEqual([]);
    // And the old id still works, acting on the story it went into.
    expect((await mark(newer, 1)).json()).toMatchObject({ importa: 1 });
    expect((await db.select({ storyId: storyVotes.storyId }).from(storyVotes)).map((r) => r.storyId)).toEqual([older]);
  });
});
