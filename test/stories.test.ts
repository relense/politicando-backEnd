import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { agendaEvents, articleInitiatives, articles, comments, editorialPosts, initiatives, notifications, stories, userFollows, users } from "../src/db/schema.js";
import { assignStories } from "../src/stories/assign.js";
import { rarity, sameStory, termsOf, titlePartiesOf } from "../src/stories/similarity.js";
import { storyTagsOf } from "../src/stories/tags.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000,
});

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const HOUR = 3_600_000;
let n = 0;
/** An article `hoursAgo` hours old. */
const article = (title: string, excerpt: string, source: string, hoursAgo = 1, partySlugs: string[] = []) =>
  insertArticle(db, { title, excerpt, source, sourceUri: `s${++n}`, url: `https://${source}/${n}`, publishedAt: new Date(Date.now() - hoursAgo * HOUR) }, partySlugs);

const call = async (method: "GET" | "POST", url: string, payload?: object, ip = "10.0.0.1") => {
  const response = await app.inject({ method, url: `/api/v2${url}`, ...(payload && { payload }), remoteAddress: ip });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const storyOf = async (id: number) => (await db.select({ storyId: articles.storyId }).from(articles).where(eq(articles.id, id)))[0]!.storyId;

/** Background news, so word rarity behaves as with real data. */
const background = async () => {
  const topics = [
    ["Governo aprova novo regime para a função pública", "O Conselho de Ministros aprovou hoje alterações para os trabalhadores do Estado."],
    ["Bombeiros combatem incêndio na serra", "Dezenas de operacionais estão no terreno desde a madrugada."],
    ["Inflação abranda em outubro", "O Instituto Nacional de Estatística divulgou os dados mensais dos preços."],
    ["Sindicatos marcam greve nos transportes", "Os trabalhadores exigem aumentos salariais e melhores condições."],
    ["Câmara de Lisboa apresenta orçamento municipal", "O executivo municipal quer mais investimento em habitação e mobilidade."],
    ["Ministra da Saúde reúne com médicos", "Em cima da mesa estão as urgências e a falta de profissionais nos hospitais."],
  ];
  for (const [i, [title, excerpt]] of topics.entries()) await article(title!, excerpt!, `bg${i}.pt`, 60 + i);
  // Word rarity needs a few dozen articles to mean anything, as in production.
  for (let i = 0; i < 40; i++) await article(`Assunto${i} em destaque${i}`, `Texto${i} sobre o tema${i}.`, `bg.pt`, 40 + i);
};

describe("telling stories apart", () => {
  it("reads the parties a headline names", () => {
    expect([...titlePartiesOf("PSD/M apresenta 20 propostas")]).toEqual(["psd"]);
    expect([...titlePartiesOf("Livre, PCP e Bloco criticam Governo")].sort()).toEqual(["be", "livre", "pcp"]);
    expect(titlePartiesOf("Governo aprova orçamento").size).toBe(0);
  });

  it("keeps headlines about different parties apart, however alike", () => {
    const make = (title: string, source: string) => ({ terms: termsOf({ title, excerpt: "Propostas de alteração ao Orçamento do Estado para 2027 na Madeira", people: [] }), source });
    const a = make("PSD/Madeira apresenta propostas ao Orçamento do Estado", "dnoticias.pt");
    const b = make("PS/Madeira apresenta propostas ao Orçamento do Estado", "noticiasaominuto.com");
    const c = make("PSD/Madeira leva propostas ao Orçamento do Estado", "observador.pt");
    const filler = Array.from({ length: 40 }, (_, i) => termsOf({ title: `Assunto${i} em destaque${i}`, excerpt: `Texto${i}`, people: [] }));
    const rare = rarity([a.terms, b.terms, c.terms, ...filler]);
    expect(sameStory(a, b, rare).ok).toBe(false);
    expect(sameStory(a, c, rare).ok).toBe(true);
  });
});

describe("assignStories", () => {
  it("groups the same news from several outlets, and nothing else", async () => {
    await background();
    const a = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "Convenção do Chega em Viseu confirmou a liderança de André Ventura.", "rtp.pt", 5);
    const b = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "O líder do Chega foi reeleito na convenção de Viseu.", "dn.pt", 4);
    const c = await article("Chega: André Ventura reeleito presidente com 98% dos votos", "Ventura obteve 98% na convenção em Viseu.", "expresso.pt", 3);
    const other = await article("Bombeiros combatem incêndio em Odemira", "As chamas lavram desde a madrugada em zona de mato.", "tsf.pt", 3);
    expect(await assignStories(db)).toMatchObject({ assigned: 50, created: 48 });
    const story = await storyOf(a.id);
    expect(await storyOf(b.id)).toBe(story);
    expect(await storyOf(c.id)).toBe(story);
    expect(await storyOf(other.id)).not.toBe(story);

    // A later version joins the story and tells its followers; running again with nothing new does nothing.
    const [reader] = await db.insert(users).values({ username: "seguidor", passwordHash: "x" }).returning();
    await db.insert(userFollows).values({ userId: reader!.id, kind: "story", targetId: story! });
    const d = await article("André Ventura reeleito presidente do Chega", "A convenção de Viseu deu 98% dos votos a Ventura.", "jn.pt", 1);
    expect(await assignStories(db)).toMatchObject({ assigned: 1, created: 0, tagged: 1, notified: 1 });
    expect(await storyOf(d.id)).toBe(story);
    expect(await db.select().from(notifications)).toMatchObject([{ userId: reader!.id, kind: "story_update", targetId: story, count: 1 }]);
    expect(await assignStories(db)).toEqual({ assigned: 0, created: 0, tagged: 0, notified: 0, strays: { suspects: 0, checked: 0, detached: 0 }, merges: { candidates: expect.any(Number), checked: 0, merged: 0 } });
  });

  it("doesn't join news days apart", async () => {
    await background();
    const a = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "Convenção do Chega em Viseu.", "rtp.pt", 100);
    const b = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "Convenção do Chega em Viseu.", "dn.pt", 1);
    await assignStories(db);
    expect(await storyOf(a.id)).not.toBe(await storyOf(b.id));
  });
});

/** Three outlets on one story, one on another; returns their ids after grouping. */
const twoStories = async () => {
  await background();
  const v1 = await article("Ventura vai a votos como candidato único à presidência do Chega", "A convenção do Chega decorre em Viseu este sábado.", "rtp.pt", 6, ["chega"]);
  const v2 = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "A convenção do Chega em Viseu reelegeu Ventura com 98% dos votos.", "dn.pt", 4, ["chega"]);
  const v3 = await article("André Ventura reeleito presidente do Chega com 98% dos votos", "Na convenção de Viseu, Ventura teve 98% dos votos.", "expresso.pt", 3, ["chega"]);
  const o = await article("Bombeiros combatem incêndio em Odemira", "As chamas lavram desde a madrugada em zona de mato.", "tsf.pt", 2);
  await assignStories(db);
  return { v1, v2, v3, o, ventura: (await storyOf(v2.id))!, fire: (await storyOf(o.id))! };
};

describe("GET /stories", () => {
  it("shows one card per story, with every outlet and the headline most like the others", async () => {
    const { ventura, v1, fire } = await twoStories();
    const { body } = await call("GET", "/stories?sort=coverage&limit=2");
    expect(body.items[0]).toMatchObject({
      id: ventura,
      title: "André Ventura reeleito presidente do Chega com 98% dos votos",
      articleCount: 3,
      sourceCount: 3,
      parties: [{ slug: "chega" }],
      importa: 0,
      importance: 0,
      commentCount: 0,
    });
    expect(body.items[0].sources.map((s: { name: string }) => s.name)).toEqual(["rtp.pt", "dn.pt", "expresso.pt"]);
    expect(body.items[0].sources[0]).toMatchObject({ articleId: v1.id, title: v1.title, imageUrl: v1.imageUrl ?? null });
    expect(body.items[1].sourceCount).toBe(1);

    const newest = await call("GET", "/stories?limit=1");
    expect(newest.body.items[0].id).toBe(fire);
    expect(newest.body.nextCursor).not.toBeNull();
    expect((await call("GET", `/stories?limit=1&cursor=${newest.body.nextCursor}`)).body.items[0].id).toBe(ventura);
  });

  it("filters like /articles, at story level", async () => {
    const { ventura, fire } = await twoStories();
    const ids = async (query: string) => (await call("GET", `/stories?${query}`)).body.items.map((s: { id: number }) => s.id);
    expect(await ids("party=chega")).toEqual([ventura]);
    expect(await ids("q=odemira")).toEqual([fire]);
    expect(await ids("source=expresso.pt")).toEqual([ventura]);
    expect(await ids(`ids=${fire}`)).toEqual([fire]);
    expect(await ids(`exclude=${fire}&since=24h`)).toEqual([ventura]);
    expect(await ids("excludeParty=chega&since=24h")).toEqual([fire]);
    // Only stories told by nothing but the muted outlet go.
    expect(await ids("excludeSource=tsf.pt,expresso.pt&since=24h")).toEqual([ventura]);
    expect((await call("GET", "/stories?period=decade")).status).toBe(400);
    expect((await call("GET", "/stories?party=nope")).status).toBe(404);
  });

  it("leaves hidden articles out of the cards, and stories with none left", async () => {
    const { ventura, fire, v3, o } = await twoStories();
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, v3.id));
    await db.update(articles).set({ hiddenAt: new Date() }).where(eq(articles.id, o.id));
    const { body } = await call("GET", `/stories?ids=${ventura},${fire}`);
    expect(body.items.map((s: { id: number; sourceCount: number }) => [s.id, s.sourceCount])).toEqual([[ventura, 2]]);
    expect((await call("GET", `/stories/${fire}`)).status).toBe(404);
    expect((await call("POST", `/stories/${fire}/vote`, { value: 1 })).status).toBe(404);
    expect((await call("GET", `/stories/${fire}/comments`)).status).toBe(404);
  });
});

describe("Importa", () => {
  it("counts one mark per reader, removable, and ranks top and importance by it", async () => {
    const { ventura, fire } = await twoStories();
    expect((await call("POST", `/stories/${fire}/vote`, { value: 1 })).body).toEqual({ importa: 1, importance: 1, mine: 1 });
    expect((await call("POST", `/stories/${fire}/vote`, { value: 1 })).body).toMatchObject({ importa: 1 });
    expect((await call("POST", `/stories/${fire}/vote`, { value: 1 }, "10.0.0.2")).body).toMatchObject({ importa: 2 });
    expect((await call("POST", `/stories/${ventura}/vote`, { value: 1 })).body).toMatchObject({ importa: 1 });
    expect((await call("POST", `/stories/${fire}/vote`, { value: 0 }, "10.0.0.2")).body).toEqual({ importa: 1, importance: 1, mine: 0 });
    expect((await call("POST", `/stories/${fire}/vote`, { value: -1 })).status).toBe(400);
    expect((await call("POST", "/stories/999999/vote", { value: 1 })).status).toBe(404);

    await call("POST", `/stories/${fire}/vote`, { value: 1 }, "10.0.0.3");
    const top = (await call("GET", "/stories?sort=top&limit=2")).body.items;
    expect(top.map((s: { id: number; importa: number }) => [s.id, s.importa])).toEqual([[fire, 2], [ventura, 1]]);
    // Among the 2 stories of the last day: the fire ties or beats both, Ventura 1 of 2.
    expect(top[0].importance).toBe(1);
    expect(top[1].importance).toBe(1 / 2);
  });
});

describe("GET /today", () => {
  it("picks the stories of the last 24 hours that most outlets told, plus Importa marks", async () => {
    const { ventura, fire } = await twoStories();
    const ids = async () => (await call("GET", "/today?limit=2")).body.items.map((s: { id: number }) => s.id);
    expect(await ids()).toEqual([ventura, fire]);
    // Ventura scores 3 (outlets); the fire 1 + 6 marks / 2 = 4.
    for (let i = 0; i < 6; i++) await call("POST", `/stories/${fire}/vote`, { value: 1 }, `10.0.1.${i}`);
    expect(await ids()).toEqual([fire, ventura]);
    const { body } = await call("GET", "/today");
    expect(body.items).toHaveLength(2);
    expect(Date.parse(body.since)).toBeLessThan(Date.now() - 23 * HOUR);
  });
});

describe("each outlet's photo", () => {
  it("comes with its source on /stories, /stories/:id and /today, null when it has none", async () => {
    const { ventura, v2, v3 } = await twoStories();
    await db.update(articles).set({ imageUrl: "https://dn.pt/foto.jpg" }).where(eq(articles.id, v2.id));
    await db.update(articles).set({ imageUrl: null }).where(eq(articles.id, v3.id));
    const photos = (sources: { name: string; imageUrl: string | null }[]) => Object.fromEntries(sources.map((s) => [s.name, s.imageUrl]));
    const card = (await call("GET", `/stories?ids=${ventura}`)).body.items[0];
    expect(photos(card.sources)).toMatchObject({ "dn.pt": "https://dn.pt/foto.jpg", "expresso.pt": null });
    expect(photos((await call("GET", `/stories/${ventura}`)).body.sources)).toMatchObject({ "dn.pt": "https://dn.pt/foto.jpg" });
    const today = (await call("GET", "/today")).body.items.find((s: { id: number }) => s.id === ventura);
    expect(photos(today.sources)).toMatchObject({ "dn.pt": "https://dn.pt/foto.jpg", "expresso.pt": null });
  });
});

describe("GET /today: fresh news over old big stories", () => {
  /** A story with one article per [outlet, hoursAgo]. */
  const storyWith = async (coverage: [string, number][], importa = 0) => {
    const [story] = await db.insert(stories).values({ importa }).returning();
    for (const [source, hoursAgo] of coverage) {
      const a = await article(`Notícia ${n} de ${source}`, "Texto.", source, hoursAgo);
      await db.update(articles).set({ storyId: story!.id }).where(eq(articles.id, a.id));
    }
    return story!.id;
  };
  const outlets = (count: number, hoursAgo: number) => Array.from({ length: count }, (_, i): [string, number] => [`o${hoursAgo}-${i}.pt`, hoursAgo + i * 0.1]);
  const today = async () => (await call("GET", "/today")).body.items as { id: number; recentSourceCount: number; sourceCount: number }[];

  it("at 08:00, 4 outlets since 06:00 beat yesterday afternoon's 13 outlets plus one at 01:30", async () => {
    // Yesterday 13:00–19:00 (13 to 19 hours ago), then a follow-up at 01:30 (6.5 hours ago).
    const big = await storyWith([...outlets(13, 13), ["noite.pt", 6.5]]);
    const fresh = await storyWith(outlets(4, 0.5));
    const items = await today();
    expect(items.map((i) => i.id)).toEqual([fresh, big]);
    expect(items[1]).toMatchObject({ recentSourceCount: 14, sourceCount: 14 });
    expect(items[0]!.recentSourceCount).toBe(4);
  });

  it("counts only the window's outlets, and old coverage sinks below fresh", async () => {
    const old = await storyWith([...outlets(8, 30), ...outlets(2, 20)]);
    const fresh = await storyWith(outlets(3, 1));
    const items = await today();
    expect(items.map((i) => i.id)).toEqual([fresh, old]);
    expect(items[1]).toMatchObject({ recentSourceCount: 2, sourceCount: 10 });
  });

  it("still fills the box with yesterday evening's stories on a quiet night, and Importa counts", async () => {
    const a = await storyWith(outlets(6, 10));
    const b = await storyWith(outlets(3, 9));
    const c = await storyWith(outlets(2, 11), 10);
    expect((await today()).map((i) => i.id)).toEqual([c, a, b]);
  });

  it("keeps the same order from one request to the next", async () => {
    await storyWith(outlets(5, 12));
    await storyWith(outlets(2, 2));
    await storyWith(outlets(3, 6));
    const first = (await today()).map((i) => i.id);
    expect((await today()).map((i) => i.id)).toEqual(first);
  });
});

describe("story comments, likes and the debate", () => {
  it("shows comments on the story and old ones on its articles, and takes new ones with a stance", async () => {
    const { ventura, v2 } = await twoStories();
    await db.insert(comments).values({ articleId: v2.id, body: "Comentário antigo na notícia" });
    const created = await call("POST", `/stories/${ventura}/comments`, { body: "Concordo com isto", stance: "agree", recaptchaToken: "t" });
    expect(created.status).toBe(201);
    // It starts with its author's own like.
    expect(created.body).toMatchObject({ storyId: ventura, stance: "agree", likes: 1 });
    const reply = await call("POST", `/stories/${ventura}/comments`, { body: "Resposta", parentId: created.body.id, recaptchaToken: "t" });
    expect(reply.body).toMatchObject({ parentId: created.body.id, stance: null });

    const list = (await call("GET", `/stories/${ventura}/comments`)).body;
    expect(list.map((c: { body: string }) => c.body)).toEqual(["Comentário antigo na notícia", "Concordo com isto", "Resposta"]);
    expect((await call("GET", `/stories?ids=${ventura}`)).body.items[0].commentCount).toBe(3);
    expect((await call("POST", `/stories/${ventura}/comments`, { body: "x", stance: "maybe", recaptchaToken: "t" })).status).toBe(400);
  });

  it("counts one like per reader and shows the most liked comment of each side", async () => {
    const { ventura } = await twoStories();
    const post = async (body: string, stance?: "agree" | "disagree") =>
      (await call("POST", `/stories/${ventura}/comments`, { body, recaptchaToken: "t", ...(stance && { stance }) })).body.id as number;
    const agree1 = await post("A favor, um", "agree");
    const agree2 = await post("A favor, dois", "agree");
    const against = await post("Contra", "disagree");
    const neutral = await post("Sem lado");

    // Each comment starts with its author's own like: liking it again from there changes nothing.
    expect((await call("POST", `/comments/${agree2}/like`, { value: 1 })).body).toEqual({ likes: 1, mine: 1 });
    expect((await call("POST", `/comments/${agree2}/like`, { value: 1 }, "10.0.0.2")).body).toEqual({ likes: 2, mine: 1 });
    expect((await call("POST", `/comments/${agree2}/like`, { value: 1 }, "10.0.0.2")).body).toEqual({ likes: 2, mine: 1 });
    expect((await call("POST", `/comments/${agree2}/like`, { value: 1 }, "10.0.0.3")).body).toEqual({ likes: 3, mine: 1 });
    await call("POST", `/comments/${agree1}/like`, { value: 1 }, "10.0.0.2");
    await call("POST", `/comments/${neutral}/like`, { value: 1 }, "10.0.0.2");

    // "Contra" has only its author's like: not a pick yet.
    let detail = (await call("GET", `/stories/${ventura}`)).body;
    expect(detail.articles).toHaveLength(3);
    expect(detail.debate).toEqual({ agree: expect.objectContaining({ id: agree2, likes: 3 }), disagree: null });

    await call("POST", `/comments/${against}/like`, { value: 1 }, "10.0.0.2");
    detail = (await call("GET", `/stories/${ventura}`)).body;
    expect(detail.debate.disagree).toMatchObject({ id: against, body: "Contra", likes: 2 });
    const cards = (await call("GET", "/stories")).body.items as { id: number; debate: unknown }[];
    expect(cards.find((c) => c.id === ventura)!.debate).toEqual(detail.debate);
    expect(cards.filter((c) => c.id !== ventura).every((c) => JSON.stringify(c.debate) === '{"agree":null,"disagree":null}')).toBe(true);

    // The author can take their own like back too.
    expect((await call("POST", `/comments/${against}/like`, { value: 0 })).body).toEqual({ likes: 1, mine: 0 });
    expect((await call("GET", `/stories/${ventura}`)).body.debate.disagree).toBeNull();
    expect((await call("POST", "/comments/999999/like", { value: 1 })).status).toBe(404);
    expect((await call("GET", `/stories/${ventura}/comments`)).body.find((c: { id: number }) => c.id === agree2)).toMatchObject({ likes: 3 });
  });
});

describe("articles link to their story and their initiatives' votes", () => {
  it("carries storyId, and each initiative's status and latest vote", async () => {
    const { v2, ventura } = await twoStories();
    await db.insert(initiatives).values({
      id: 1, legislature: "XVII", type: "Projeto de Lei", number: "1", title: "Lei das rendas", status: "rejected",
      phase: "Votação na generalidade", phaseDate: "2026-10-02",
      votes: [
        { id: "a", date: "2026-09-01", phase: "Requerimento", result: "Aprovado", unanimous: true, favor: [], against: [], abstention: [], absent: [], named: [] },
        { id: "b", date: "2026-10-02", phase: "Votação na generalidade", result: "Rejeitado", unanimous: false, favor: [], against: [], abstention: [], absent: [], named: [] },
      ],
    });
    await db.insert(articleInitiatives).values({ articleId: v2.id, initiativeId: 1, score: 30 });
    const article = (await call("GET", `/articles/${v2.id}`)).body;
    expect(article.storyId).toBe(ventura);
    expect(article.initiatives[0]).toMatchObject({
      status: "rejected",
      lastVote: { date: "2026-10-02", phase: "Votação na generalidade", result: "Rejeitado", unanimous: false },
    });
    expect((await call("GET", `/stories/${ventura}`)).body.initiatives).toHaveLength(1);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(stories)).toEqual([{ n: 48 }]);
  });
});

describe("tags, Em debate and context", () => {
  it("tags events named in a headline, and topics most versions share", () => {
    const tags = storyTagsOf([
      { title: "OE2027: PS garante fim da taxa no crédito à habitação", excerpt: "Proposta de alteração ao orçamento." },
      { title: "PS quer acabar com comissão no crédito à habitação", excerpt: "Para o Orçamento do Estado para 2027." },
      { title: "Socialistas e a comissão de amortização", excerpt: "Habitação no centro da discussão." },
    ]);
    expect(tags).toEqual([
      { slug: "oe2027", label: "OE2027", name: "Orçamento do Estado para 2027", kind: "event" },
      { slug: "habitacao", label: "Habitação", name: "Habitação e urbanismo", kind: "topic" },
    ]);
    // A topic one version in three mentions isn't enough.
    expect(storyTagsOf([
      { title: "Ventura reeleito", excerpt: "Fala de habitação." },
      { title: "Ventura reeleito no Chega", excerpt: "Convenção." },
      { title: "Chega reelege Ventura", excerpt: "Viseu." },
    ])).toEqual([]);
  });

  /** A story about the budget and housing, with 3 versions, and the fire story. */
  const budgetStory = async () => {
    await background();
    const a = await article("OE2027: PS garante fim da comissão no crédito à habitação", "Proposta de alteração ao Orçamento do Estado para 2027 elimina comissão de reembolso antecipado.", "publico.pt", 5, ["ps"]);
    await article("OE2027: PS garante fim da comissão no crédito à habitação", "Os socialistas vão eliminar a comissão de reembolso antecipado no crédito à habitação.", "eco.sapo.pt", 4, ["ps"]);
    await article("PS garante fim da comissão de reembolso antecipado no crédito à habitação", "No Orçamento do Estado para 2027, a comissão de reembolso antecipado acaba.", "dn.pt", 3, ["ps"]);
    const o = await article("Bombeiros combatem incêndio em Odemira", "As chamas lavram desde a madrugada em zona de mato.", "tsf.pt", 2);
    await assignStories(db);
    return { budget: (await storyOf(a.id))!, fire: (await storyOf(o.id))! };
  };

  it("gives cards an excerpt and tags, filters by tag and sorts by comments", async () => {
    const { budget, fire } = await budgetStory();
    const card = (await call("GET", `/stories?ids=${budget}`)).body.items[0];
    expect(card.excerpt.length).toBeGreaterThan(10);
    expect(card.tags.map((t: { slug: string }) => t.slug)).toEqual(["oe2027", "habitacao"]);
    expect((await call("GET", "/stories?tag=oe2027")).body).toMatchObject({ total: 1, items: [{ id: budget }] });
    expect((await call("GET", "/stories?tag=OE 2027")).status).toBe(400);

    expect((await call("GET", "/stories?sort=comments")).body.total).toBe(0);
    await db.insert(comments).values([{ storyId: fire, body: "um" }, { storyId: budget, body: "dois" }, { storyId: budget, body: "três" }]);
    expect((await call("GET", "/stories?sort=comments")).body.items.map((s: { id: number }) => s.id)).toEqual([budget, fire]);
  });

  it("adds up comments per tag for Em debate", async () => {
    const { budget, fire } = await budgetStory();
    await db.insert(comments).values([{ storyId: budget, body: "um" }, { storyId: budget, body: "dois" }, { storyId: fire, body: "três" }]);
    const { body } = await call("GET", "/stories/tags?days=7");
    expect(body.items.slice(0, 2)).toEqual([
      // The background has another housing story (Lisbon's budget), without comments.
      { slug: "habitacao", label: "Habitação", name: "Habitação e urbanismo", kind: "topic", stories: 2, comments: 2, importa: 0 },
      { slug: "oe2027", label: "OE2027", name: "Orçamento do Estado para 2027", kind: "event", stories: 1, comments: 2, importa: 0 },
    ]);
    expect((await call("GET", "/stories/tags?kind=event")).body.items.map((t: { slug: string }) => t.slug)).toEqual(["oe2027"]);
  });

  it("finds our posts and coming agenda events for the context box", async () => {
    const { budget } = await budgetStory();
    await db.insert(editorialPosts).values([
      { slug: "como-passa-um-orcamento", title: "Como passa um Orçamento", kind: "article", body: "x", authorName: "Ana", tags: ["Orçamento"], status: "published", publishedAt: new Date() },
      { slug: "sobre-outra-coisa", title: "Outra coisa", kind: "article", body: "x", authorName: "Ana", tags: ["defesa"], status: "published", publishedAt: new Date() },
      { slug: "rascunho-oe", title: "Rascunho", kind: "article", body: "x", authorName: "Ana", tags: ["oe2027"], status: "draft" },
    ]);
    const soon = (days: number) => new Date(Date.now() + days * 24 * HOUR);
    const event = (id: string, title: string, startsAt: Date, partySlugs: string[] = []) => ({
      id, source: "editorial" as const, kind: "parliament", title, allDay: false, startsAt, startDay: startsAt.toISOString().slice(0, 10),
      until: new Date(startsAt.getTime() + HOUR), attend: { open: false, how: null, url: null }, partySlugs,
    });
    await db.insert(agendaEvents).values([
      event("a", "Jornadas do PS", soon(1), ["ps"]),
      event("b", "Votação final global do Orçamento do Estado para 2027", soon(3)),
      event("c", "Debate sobre defesa", soon(2)),
      event("d", "Votação do OE2027 na generalidade", soon(-2)),
      event("e", "Debate do OE2027 daqui a um mês", soon(30)),
    ]);
    const { context } = (await call("GET", `/stories/${budget}`)).body;
    expect(context.explainers.map((p: { slug: string }) => p.slug)).toEqual(["como-passa-um-orcamento"]);
    expect(context.agenda.map((e: { id: string }) => e.id)).toEqual(["b", "a"]);
  });
});
