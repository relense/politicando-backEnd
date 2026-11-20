import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { articles, stories, storyApart, storyArticleChecks, storyMerges } from "../src/db/schema.js";
import { mergeStories, moveStory, type MergeJudge, type StoryBrief } from "../src/stories/merge.js";
import { detachStrays, splitStory } from "../src/stories/split.js";
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

/** A story with these versions, as the hourly grouping would have left it. Returns its id and article ids. */
const story = async (versions: Version[], parties: string[] = []) => {
  const [row] = await db.insert(stories).values({}).returning({ id: stories.id });
  const ids: number[] = [];
  for (const [title, excerpt, source, hoursAgo] of versions) {
    const article = await insertArticle(
      db,
      { title, excerpt, source, sourceUri: `s${++n}`, url: `https://${source}/${n}`, publishedAt: new Date(Date.now() - hoursAgo * HOUR), storyId: row!.id },
      parties,
    );
    ids.push(article.id);
  }
  return { id: row!.id, articles: ids };
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
    ["Universidade do Porto abre novo centro de investigação", "O laboratório vai estudar o mar e as alterações climáticas."],
    ["Comboios suprimidos na linha de Sintra", "A CP justifica com avarias na catenária."],
    ["Museu reabre após obras de requalificação", "O espaço volta a receber visitantes a partir de terça-feira."],
  ];
  // Three rounds, so the five articles of a test story are a small share of the news.
  for (let round = 0; round < 3; round++) {
    for (const [i, [title, excerpt]] of topics.entries()) await story([[title, excerpt, `fundo${round}-${i}.pt`, 30]]);
  }
};

const IVA = "O cabaz alimentar fica isento de IVA durante três meses com os votos do PS e do Chega no Orçamento.";
/** The IVA zero story, which an article about another vote (the first one) drifted into. */
const drifted = () =>
  story(
    [
      ["Parlamento aprova proposta que alarga benefícios em IRC para rendas moderadas", "Os senhorios com rendas moderadas pagam menos IRC a partir de janeiro.", "cnnportugal.iol.pt", 20],
      ["Isenção de IVA do cabaz alimentar aprovada com apoio do Chega", IVA, "publico.pt", 10],
      ["Isenção de IVA do cabaz alimentar proposta pelo PS aprovada", IVA, "sicnoticias.pt", 9],
      ["IVA zero no cabaz alimentar aprovado pelo PS e pelo Chega", IVA, "observador.pt", 8],
      ["Cabaz alimentar com isenção de IVA aprovada no Parlamento", IVA, "expresso.pt", 7],
    ],
    ["ps", "chega"],
  );

/** A judge that answers per article title and remembers what it was asked. */
const judgeSaying = (answer: (single: StoryBrief) => boolean | null) => {
  const asked: [StoryBrief, StoryBrief][] = [];
  const judge: MergeJudge = async (a, b) => {
    asked.push([a, b]);
    return answer(b);
  };
  return { judge, asked };
};
const notAbout = (word: string) => (b: StoryBrief) => !b.headlines[0]!.title.includes(word);

describe("taking out articles that don't belong in their story", () => {
  it("asks only about the odd one out, moves it into a story of its own kept apart, and doesn't ask again", async () => {
    await background();
    const s = await drifted();
    const { judge, asked } = judgeSaying(notAbout("IRC"));

    expect(await detachStrays(db, { judge })).toEqual({ suspects: 1, checked: 1, detached: 1 });
    // The model saw the rest of the story against the one article.
    expect(asked[0]![0].headlines.map((h) => h.title).every((t) => t.includes("IVA"))).toBe(true);
    expect(asked[0]![1].headlines.map((h) => h.title)).toEqual(["Parlamento aprova proposta que alarga benefícios em IRC para rendas moderadas"]);

    const [irc] = await db.select({ storyId: articles.storyId }).from(articles).where(eq(articles.id, s.articles[0]!));
    expect(irc!.storyId).not.toBe(s.id);
    const rest = await db.select({ storyId: articles.storyId }).from(articles).where(sql`${articles.id} = any(${`{${s.articles.slice(1).join(",")}}`}::integer[])`);
    expect(rest.every((r) => r.storyId === s.id)).toBe(true);
    expect(await db.select({ low: storyApart.lowId, high: storyApart.highId, reason: storyApart.reason }).from(storyApart)).toEqual([
      { low: s.id, high: irc!.storyId, reason: "model" },
    ]);
    const [created] = await db.select({ createdAt: stories.createdAt, tags: stories.tags }).from(stories).where(eq(stories.id, irc!.storyId!));
    expect(Date.now() - +created!.createdAt).toBeGreaterThan(19 * HOUR);
    expect(created!.tags).not.toBeNull();

    // The story left is smaller now, but the IVA articles all match each other: nothing to ask.
    expect(await detachStrays(db, { judge })).toMatchObject({ checked: 0, detached: 0 });
  });

  it("keeps the article when the model says it belongs, and remembers the answer until the story doubles", async () => {
    await background();
    const s = await drifted();
    const { judge, asked } = judgeSaying(() => true);
    expect(await detachStrays(db, { judge })).toEqual({ suspects: 1, checked: 1, detached: 0 });
    expect(await detachStrays(db, { judge })).toMatchObject({ checked: 0 });
    expect(asked).toHaveLength(1);
    expect(await db.select({ belongs: storyArticleChecks.belongs, size: storyArticleChecks.storySize }).from(storyArticleChecks)).toEqual([
      { belongs: true, size: 5 },
    ]);
    // Twice the size: asked again.
    await db.update(storyArticleChecks).set({ storySize: 2 }).where(eq(storyArticleChecks.storyId, s.id));
    expect(await detachStrays(db, { judge })).toMatchObject({ checked: 1 });
  });

  it("moves nothing without the model, or when the model can't tell, or when it says most of a story doesn't belong", async () => {
    await background();
    await drifted();
    expect(await detachStrays(db, { judge: null })).toEqual({ suspects: 0, checked: 0, detached: 0 });
    expect(await detachStrays(db, { judge: judgeSaying(() => null).judge })).toMatchObject({ checked: 1, detached: 0 });
    expect(await db.select().from(storyArticleChecks)).toEqual([]);

    // A story whose articles match nothing in it: every one is odd, and the model saying no to all is a doubt, not a fix.
    await resetDb(db);
    await background();
    await story(
      [
        ["Parlamento aprova benefícios em IRC para rendas moderadas", "Os senhorios pagam menos IRC.", "a.pt", 6],
        ["Isenção de IVA do cabaz alimentar aprovada", IVA, "c.pt", 4],
        ["Tribunal Constitucional chumba lei da eutanásia", "Os juízes consideraram a norma inconstitucional.", "d.pt", 3],
        ["Autarquia de Faro inaugura nova biblioteca municipal", "O edifício abre ao público na segunda-feira.", "e.pt", 2],
      ],
      ["ps"],
    );
    expect(await detachStrays(db, { judge: judgeSaying(() => false).judge })).toMatchObject({ suspects: 4, detached: 0 });
  });

  it("acts on a story only once all its odd ones are answered", async () => {
    await background();
    await drifted();
    // No budget for this story's question: nothing is asked or moved, rather than half a story.
    const { judge, asked } = judgeSaying(() => false);
    expect(await detachStrays(db, { judge, maxChecks: 0 })).toEqual({ suspects: 1, checked: 0, detached: 0 });
    expect(asked).toEqual([]);
    // The model failing leaves it for the next run too.
    const failing: MergeJudge = async () => {
      throw new Error("overloaded");
    };
    expect(await detachStrays(db, { judge: failing, log: { error: () => undefined } })).toMatchObject({ detached: 0 });
  });

  it("leaves alone the articles that came in through a merge", async () => {
    await background();
    const s = await drifted();
    await db.insert(storyMerges).values({ fromId: 999_999, intoId: s.id, reason: "model", articleIds: [s.articles[0]!] });
    const { judge, asked } = judgeSaying(() => false);
    expect(await detachStrays(db, { judge })).toMatchObject({ suspects: 0, detached: 0 });
    expect(asked).toEqual([]);

    // A join from before merges kept their articles: the whole story is left alone.
    await db.update(storyMerges).set({ articleIds: null });
    expect(await detachStrays(db, { judge })).toMatchObject({ suspects: 0 });
  });
});

describe("splitting a story by hand", () => {
  it("moves the articles into a new story, takes along the joins they came from, and the old ids answer as the new story", async () => {
    await background();
    const s = await drifted();
    const [irc, ...iva] = s.articles;
    await db.insert(storyMerges).values([
      { fromId: 999_998, intoId: s.id, reason: "model", articleIds: [irc!] },
      { fromId: 999_997, intoId: s.id, reason: "model", articleIds: [iva[0]!] },
      { fromId: 999_996, intoId: s.id, reason: "model", articleIds: null },
    ]);

    const result = await db.transaction((tx) => splitStory(tx, s.id, [irc!], "manual"));
    expect(result).toMatchObject({ moved: 1, left: 4, redirected: [999_998] });

    const viaOld = (await app.inject({ method: "GET", url: "/api/v2/stories/999998" })).json();
    expect(viaOld).toMatchObject({ id: result.id, articleCount: 1, mergedFrom: [999_998] });
    // Lists show which ids each story took in, too.
    const list = (await app.inject({ method: "GET", url: `/api/v2/stories?ids=${s.id},${result.id}` })).json();
    const byId = new Map(list.items.map((c: { id: number; mergedFrom: number[] }) => [c.id, c.mergedFrom]));
    expect(byId.get(s.id)).toEqual([999_996, 999_997]);
    expect(byId.get(result.id)).toEqual([999_998]);

    await expect(db.transaction((tx) => splitStory(tx, s.id, [irc!], "manual"))).rejects.toThrow(/Not every article/);
    await expect(db.transaction((tx) => splitStory(tx, s.id, iva, "manual"))).rejects.toThrow(/no visible articles left/);
    // A hidden article alone would make a story nobody sees.
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, iva[0]!));
    await expect(db.transaction((tx) => splitStory(tx, s.id, [iva[0]!], "manual"))).rejects.toThrow(/hidden/);
  });
});

describe("stories kept apart", () => {
  const reactions = async () => {
    const older = await story(
      [["Montenegro acusa PS e Chega de imaturidade e rejeita crise política", "O primeiro-ministro reagiu à aprovação conjunta do IVA zero no Orçamento do Estado pelo PS e pelo Chega.", "publico.pt", 3]],
      ["ps", "chega"],
    );
    const newer = await story(
      [["Montenegro diz que PS e Chega formam geringonça ao contrário mas rejeita crise política", "O primeiro-ministro reagiu à aprovação do IVA zero no Orçamento do Estado com os votos do PS e do Chega.", "rtp.pt", 2]],
      ["ps", "chega"],
    );
    return { older: older.id, newer: newer.id };
  };

  it("are never joined, and the model isn't even asked", async () => {
    await background();
    const { older, newer } = await reactions();
    await db.insert(storyApart).values({ lowId: older, highId: newer, reason: "manual" });
    const asked: string[] = [];
    await mergeStories(db, { judge: async (a, b) => (asked.push(`${a.headlines[0]!.title} ${b.headlines[0]!.title}`), false) });
    expect(asked.some((q) => q.includes("Montenegro"))).toBe(false);
    expect(await db.select({ id: stories.id }).from(stories).where(sql`${stories.id} in (${older}, ${newer})`)).toHaveLength(2);
  });

  it("stay apart from whatever the other story is joined into", async () => {
    const x = (await story([["Uma notícia", "Texto.", "a.pt", 1]])).id;
    const y = (await story([["Outra notícia", "Texto.", "b.pt", 1]])).id;
    const z = (await story([["Mais uma notícia", "Texto.", "c.pt", 1]])).id;
    await db.insert(storyApart).values({ lowId: x, highId: y, reason: "model" });
    await db.transaction((tx) => moveStory(tx, x, z));
    expect(await db.select({ low: storyApart.lowId, high: storyApart.highId }).from(storyApart)).toEqual([{ low: y, high: z }]);
  });
});

describe("story numbers kept on the story", () => {
  it("follow every article joining, leaving, hiding or showing, and a story with nothing visible leaves the lists", async () => {
    const s = await story([
      ["Primeira versão", "Texto.", "a.pt", 5],
      ["Segunda versão", "Texto.", "b.pt", 3],
      ["Terceira versão", "Texto.", "a.pt", 1],
    ]);
    const numbers = async () =>
      (await db.select({ n: stories.articleCount, sources: stories.sourceCount, last: stories.lastAt }).from(stories).where(eq(stories.id, s.id)))[0]!;
    expect(await numbers()).toMatchObject({ n: 3, sources: 2 });
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, s.articles[2]!));
    const afterHide = await numbers();
    expect(afterHide).toMatchObject({ n: 2, sources: 2 });
    expect(Date.now() - +afterHide.last!).toBeGreaterThan(2 * HOUR);
    const other = await story([["Outra", "Texto.", "c.pt", 2]]);
    await db.update(articles).set({ storyId: other.id }).where(eq(articles.id, s.articles[1]!));
    expect(await numbers()).toMatchObject({ n: 1, sources: 1 });
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, s.articles[0]!));
    expect(await numbers()).toMatchObject({ n: 0, last: null });
    const list = (await app.inject({ method: "GET", url: "/api/v2/stories?limit=50" })).json();
    expect(list.items.map((c: { id: number }) => c.id)).not.toContain(s.id);
    expect(list.items.find((c: { id: number }) => c.id === other.id)).toMatchObject({ articleCount: 2, sourceCount: 2 });
  });
});

describe("story numbers with two writers at once", () => {
  it("a hide waiting on an open ingest counts the article that ingest added", async () => {
    const s = await story([["Primeira versão", "Texto.", "a.pt", 5]]);
    const ingest = await pool.connect();
    const moderator = await pool.connect();
    try {
      await ingest.query("begin");
      await ingest.query(
        `insert into articles (title, excerpt, source, source_uri, url, published_at, story_id) values ('Segunda', 'Texto.', 'b.pt', 'race-1', 'https://b.pt/race', now(), $1)`,
        [s.id],
      );
      // The moderator hides the first article while the ingest is still open: it waits for the story.
      const hide = moderator.query("update articles set hidden_at = now() where id = $1", [s.articles[0]]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await ingest.query("commit");
      await hide;
    } finally {
      ingest.release();
      moderator.release();
    }
    const [row] = await db.select({ n: stories.articleCount, last: stories.lastAt }).from(stories).where(eq(stories.id, s.id));
    expect(row).toMatchObject({ n: 1 });
    expect(row!.last).not.toBeNull();
  });
});

describe("Importa after a split", () => {
  it("a mark carried in from a join stays removable on the story it was left on", async () => {
    await background();
    const s = await drifted();
    const mark = (id: number, value: 0 | 1) =>
      app.inject({ method: "POST", url: `/api/v2/stories/${id}/vote`, payload: { value }, remoteAddress: "198.51.100.7" });
    // The reader marked story 999995, later joined into s (its mark kept its own key).
    const [joined] = await db.insert(stories).values({}).returning({ id: stories.id });
    await insertArticle(db, { title: "Isenção de IVA do cabaz", excerpt: IVA, source: "rtp.pt", sourceUri: "j1", url: "https://rtp.pt/j1", publishedAt: new Date(Date.now() - 6 * HOUR), storyId: joined!.id }, ["ps"]);
    expect((await mark(joined!.id, 1)).json()).toMatchObject({ importa: 1 });
    const joinedArticles = (await db.select({ id: articles.id }).from(articles).where(eq(articles.storyId, joined!.id))).map((r) => r.id);
    await db.transaction((tx) => moveStory(tx, joined!.id, s.id));
    // Then the join's article was split off again: the old id now answers as the new story, the mark stayed.
    await db.transaction((tx) => splitStory(tx, s.id, joinedArticles, "manual"));
    expect((await mark(s.id, 1)).json()).toMatchObject({ importa: 1 });
    expect((await mark(s.id, 0)).json()).toMatchObject({ importa: 0 });
  });
});
