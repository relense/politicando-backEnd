import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { matchDeputy, nameKey, syncGovernment, type GovernmentSource } from "../src/government/sync.js";
import { nextData, parsePage, parseSitemap, portalDate } from "../src/government/portal.js";
import { GOVERNMENT_ALIASES } from "../src/government/aliases.js";
import { matchNames } from "../src/matching/matchParties.js";
import { linkStoredArticles } from "../src/parliament/linkNews.js";
import { syncParliament } from "../src/parliament/sync.js";
import { createTestDb, insertArticle, resetDb } from "./helpers.js";
import { loaderFor } from "./parliamentFixtures.js";

const NO_DATE = "0001-01-01T00:00:00Z";
const hex = (n: number) => n.toString(16).padStart(32, "0");
const value = (v: unknown) => ({ value: v });
const official = (id: number, name: string, sex = "Male") => ({
  id: `{${hex(id)}}`,
  displayName: name,
  fields: {
    FullName: value(name),
    Sex: { fields: { Value: value(sex) } },
    CardPhoto: value({ src: `https://edge.example/${name.replace(/ /g, "-")}.jpg?w=800` }),
    SocialMediaNetworks: [],
  },
});
const holder = (positionId: number, memberId: number, name: string, role: string, start: string, end = NO_DATE, sex?: string) => ({
  id: hex(positionId),
  fields: {
    Official: official(memberId, name, sex),
    GovernmentRole: value(role),
    StartDate: value(start),
    EndDate: value(end),
    IsOfficialHidden: value(false),
    Bio: value(`<p>${name} nasceu em Lisboa.</p><p>É <b>jurista</b>.</p>`),
  },
});
const page = (context: Record<string, unknown>, route: Record<string, unknown>) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        layoutData: {
          sitecore: {
            context: {
              governmentContext: { governmentName: "XXV Governo Constitucional", startDate: "20250605T000000Z", ...context },
            },
            route,
          },
        },
      },
    },
  })}</script></html>`;

const MINISTRIES = ["negocios-estrangeiros", "financas", "presidencia", "economia", "defesa", "justica", "saude", "educacao", "trabalho", "ambiente"];

/** A small portal: the PM, ten ministries, one secretary of state and a minister who left. */
const portal = (): Record<string, string> => {
  const pages: Record<string, string> = {
    "/pt/gc25/primeiro-ministro/acerca": page(
      { governmentAreaTitle: "Primeiro-Ministro", primeMinisterId: `{${hex(1)}}` },
      {
        placeholders: {
          main: [
            {
              fields: {
                data: {
                  contextItem: {
                    __typename: "PrimeMinisterPage",
                    governmentRole: { jsonValue: value("Primeiro-Ministro") },
                    bio: { jsonValue: value("<p>Nasceu no Porto.</p>") },
                    startDate: { jsonValue: value("2025-06-05T00:00:00Z") },
                    endDate: { jsonValue: value(NO_DATE) },
                  },
                },
              },
            },
            { fields: { data: { datasource: { SearchResultsByOfficials: { values: [{ official: { jsonValue: official(100, "Luís Montenegro") } }] } } } } },
          ],
        },
      },
    ),
  };
  MINISTRIES.forEach((slug, i) => {
    const history = [holder(10 + i, 200 + i, `Ministro ${slug}`, "Ministro", "2025-06-05T00:00:00Z")];
    if (slug === "justica") {
      history.unshift(holder(50, 300, "Maria Antiga", "Ministra", "2025-06-05T00:00:00Z", "2026-02-11T00:00:00Z", "Female"));
    }
    pages[`/pt/gc25/area-de-governo/${slug}`] = page(
      { governmentAreaTitle: slug === "financas" ? "Finanças" : slug, governmentPreposition: slug === "financas" ? "e das" : "da" },
      { fields: { OfficialsHistory: history } },
    );
  });
  pages["/pt/gc25/area-de-governo/financas/secretarios-de-estado/assuntos-fiscais"] = page(
    { governmentAreaTitle: "Finanças" },
    {
      fields: {
        GovernmentPreposition: value("dos"),
        GovernmentTitle: value("Assuntos Fiscais"),
        // Same name as a sitting deputy in the fixtures: must not be linked to them.
        OfficialsHistory: [holder(60, 400, "Francisco César", "Secretário de Estado", "2025-06-06T00:00:00Z")],
      },
    },
  );
  return pages;
};

const sitemapFor = (paths: string[]) =>
  `<?xml version="1.0"?><urlset>${["/gc24/area-de-governo/financas", ...paths.map((p) => p.replace(/^\/pt/, ""))]
    .map((p) => `<url><loc>https://portugal.gov.pt${p}</loc></url>`)
    .join("")}</urlset>`;

const sourceFor = (pages: Record<string, string>): GovernmentSource => ({
  get: async (url) => {
    const path = new URL(url).pathname;
    if (path === "/sitemap.xml") return { status: "ok", body: sitemapFor(Object.keys(pages)) };
    const body = pages[path];
    return body ? { status: "ok", body } : { status: "blocked", reason: "HTTP 404" };
  },
});

describe("portal parsing", () => {
  it("finds the latest government's pages in protocol order", () => {
    const found = parseSitemap(sitemapFor(Object.keys(portal())))!;
    expect(found.code).toBe("gc25");
    expect(found.pages.map((p) => [p.kind, p.area, p.areaRank, p.rank]).slice(0, 3)).toEqual([
      ["prime_minister", "primeiro-ministro", 0, 0],
      ["minister", "negocios-estrangeiros", 1, 0],
      ["minister", "financas", 2, 0],
    ]);
    expect(found.pages.find((p) => p.kind === "secretary_of_state")).toMatchObject({ area: "financas", areaRank: 2, rank: 1 });
  });

  it("builds titles, plain-text bios and dates", () => {
    const pages = portal();
    const found = parseSitemap(sitemapFor(Object.keys(pages)))!;
    const finance = found.pages.find((p) => p.area === "financas" && p.kind === "minister")!;
    const parsed = parsePage(nextData(pages[finance.path]!)!, finance)!;
    expect(parsed.positions[0]).toMatchObject({ title: "Ministro e das Finanças", startDate: "2025-06-05", endDate: null });
    expect(parsed.members[0]).toMatchObject({ id: hex(201), gender: "M", bio: ["Ministro financas nasceu em Lisboa.", "É jurista."] });
    const secretary = found.pages.find((p) => p.kind === "secretary_of_state")!;
    expect(parsePage(nextData(pages[secretary.path]!)!, secretary)!.positions[0]!.title).toBe("Secretário de Estado dos Assuntos Fiscais");
    expect(portalDate("20250605T000000Z")).toBe("2025-06-05");
    expect(portalDate(NO_DATE)).toBeNull();
    expect(nextData("<html>no data</html>")).toBeNull();
  });
});

describe("matchDeputy", () => {
  const deputy = (id: number, name: string, sittingPeriods: { from: string; to: string | null }[], fullName = name) => ({ id, name, fullName, sittingPeriods });
  const post = [{ from: "2025-06-05", to: null }];

  it("tolerates spelling, but never matches someone who sat while in office", () => {
    expect(nameKey("João Valle e Azevedo")).toBe(nameKey("João Vale e Azevedo"));
    expect(nameKey("Álvaro Castelo Branco")).toBe(nameKey("Álvaro Castello-Branco"));
    const suspended = [{ from: "2025-06-03", to: "2025-06-06" }];
    expect(matchDeputy({ name: "João Valle e Azevedo", posts: post }, [deputy(1, "João Vale e Azevedo", suspended)])).toBe(1);
    expect(matchDeputy({ name: "Rui Rocha", posts: post }, [deputy(2, "Rui Rocha", [{ from: "2025-06-03", to: null }])])).toBeNull();
  });

  it("accepts the full civil name only with the same first and last names, and only one match", () => {
    const old = [{ from: "2025-06-03", to: "2025-06-05" }];
    expect(matchDeputy({ name: "Ana Paula Martins", posts: post }, [deputy(3, "Ana Martins", old, "Ana Maria Martins")])).toBeNull();
    expect(matchDeputy({ name: "Ana Paula Martins", posts: post }, [deputy(4, "Ana Martins", old, "Ana Paula Sousa Martins")])).toBe(4);
    expect(matchDeputy({ name: "Ana Martins", posts: post }, [deputy(5, "Ana Martins", old), deputy(6, "Ana Martins", old)])).toBeNull();
  });
});

describe("matching the Prime Minister's short name", () => {
  const alias = GOVERNMENT_ALIASES["Luís Montenegro"]!;
  const pm = { id: "pm", terms: ["Luís Montenegro"], contextTerms: ["Luís Montenegro", ...alias.withContext], context: alias.context, exclude: alias.exclude };
  const mentions = (title: string, content = "") => matchNames({ title, content }, [pm])[0]?.mentions ?? 0;

  it("counts \"Montenegro\" in political context", () => {
    expect(mentions("Montenegro responde ao PS", "O primeiro-ministro falou em São Bento.")).toBe(2);
    expect(mentions("Luís Montenegro e Montenegro")).toBe(4);
    expect(mentions("Críticas a Montenegro", "O Governo reage.")).toBe(2);
  });

  it("ignores the country and stories with no context", () => {
    expect(mentions("Seleção joga no Montenegro", "O Governo do Montenegro recebeu a equipa.")).toBe(0);
    expect(mentions("Montenegro vence a Sérvia")).toBe(0);
  });
});

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true });

beforeEach(async () => {
  await resetDb(db);
  await syncParliament(db, loaderFor());
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const get = async (url: string) => {
  const response = await app.inject({ method: "GET", url: `/api/v2${url}` });
  return { status: response.statusCode, body: response.json() };
};

describe("syncGovernment", () => {
  it("stores members and posts, and is safe to re-run", async () => {
    const stats = await syncGovernment(db, sourceFor(portal()));
    expect(stats).toMatchObject({ government: "gc25", pages: 12, members: 13, positions: 13, inOffice: 12, deputiesMatched: 0, warnings: [] });
    expect((await syncGovernment(db, sourceFor(portal()))).positions).toBe(13);
  });

  it("refuses a portal with too few ministers in office", async () => {
    const pages = portal();
    for (const slug of MINISTRIES.slice(0, 5)) delete pages[`/pt/gc25/area-de-governo/${slug}`];
    await expect(syncGovernment(db, sourceFor(pages))).rejects.toThrow(/refusing/);
  });

  it("keeps posts it couldn't re-read, and drops removed ones only after a full read", async () => {
    await syncGovernment(db, sourceFor(portal()));
    const broken = portal();
    broken["/pt/gc25/area-de-governo/financas/secretarios-de-estado/assuntos-fiscais"] = "<html>oops</html>";
    const partial = await syncGovernment(db, sourceFor(broken));
    expect(partial.warnings).toHaveLength(1);
    expect((await get("/government")).body.ministries.find((m: { area: string }) => m.area === "financas").secretaries).toHaveLength(1);

    const removed = portal();
    delete removed["/pt/gc25/area-de-governo/financas/secretarios-de-estado/assuntos-fiscais"];
    await syncGovernment(db, sourceFor(removed));
    expect((await get("/government")).body.ministries.find((m: { area: string }) => m.area === "financas").secretaries).toHaveLength(0);
  });
});

describe("GET /government", () => {
  it("returns the PM, ministries in protocol order with their secretaries, and who left", async () => {
    await syncGovernment(db, sourceFor(portal()));
    const { status, body } = await get("/government");
    expect(status).toBe(200);
    expect(body.government).toMatchObject({ code: "gc25", name: "XXV Governo Constitucional", startDate: "2025-06-05" });
    expect(body.primeMinister).toMatchObject({ name: "Luís Montenegro", title: "Primeiro-Ministro", party: null });
    expect(body.ministries.map((m: { area: string }) => m.area)).toEqual(["primeiro-ministro", ...MINISTRIES]);
    expect(body.ministries[2]).toMatchObject({
      name: "Finanças",
      minister: { title: "Ministro e das Finanças" },
      secretaries: [{ name: "Francisco César", title: "Secretário de Estado dos Assuntos Fiscais", deputyId: null }],
    });
    expect(body.former).toEqual([expect.objectContaining({ name: "Maria Antiga", endDate: "2026-02-11", areaName: "justica" })]);
  });

  it("returns 404 before the first sync", async () => {
    expect((await get("/government")).status).toBe(404);
  });
});

describe("GET /government/members/:id", () => {
  it("returns the profile, posts and news naming them", async () => {
    await syncGovernment(db, sourceFor(portal()));
    const article = await insertArticle(db, { title: "Luís Montenegro responde ao PS", sourceUri: "uri-pm", url: "https://example.pt/pm" });
    const homonym = await insertArticle(db, { title: "Francisco César critica o Governo", sourceUri: "uri-fc", url: "https://example.pt/fc" });
    const totals = await linkStoredArticles(db);
    expect(totals.governmentLinks).toBe(1);

    const { status, body } = await get(`/government/members/${hex(100)}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "Luís Montenegro", inOffice: true, bio: ["Nasceu no Porto."], deputy: null });
    expect(body.positions).toEqual([expect.objectContaining({ title: "Primeiro-Ministro", endDate: null })]);
    expect(body.articles.map((a: { id: number }) => a.id)).toEqual([article.id]);
    expect(body.articles[0].government).toEqual([{ id: hex(100), name: "Luís Montenegro" }]);

    const filtered = await get(`/articles?governmentMember=${hex(100)}`);
    expect(filtered.body.items.map((a: { id: number }) => a.id)).toEqual([article.id]);
    expect((await get(`/articles/${homonym.id}`)).body.government).toEqual([]);
  });

  it("returns 404 for an unknown member and 400 for a bad id", async () => {
    expect((await get(`/government/members/${hex(999)}`)).status).toBe(404);
    expect((await get("/government/members/nope")).status).toBe(400);
  });
});
