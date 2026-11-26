import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { deputies, governmentMembers } from "../db/schema.js";

/*
 * Official site, Wikipedia, Wikidata and social accounts of deputies and members of the
 * Government, from Wikidata (open data, CC0). Deputies are found by the parliament's own ID
 * (property P6199), so there's no guessing. Members of the Government who aren't deputies
 * are found by their exact name among Portuguese people, and only when that name is unique.
 */

export type Link = { network: string; url: string };

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

const LINK_FIELDS = `
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P2002 ?x }
  OPTIONAL { ?item wdt:P2003 ?instagram }
  OPTIONAL { ?item wdt:P2013 ?facebook }
  OPTIONAL { ?wikipedia schema:about ?item; schema:isPartOf <https://pt.wikipedia.org/> }`;
const LINK_SELECT = "(SAMPLE(?website) AS ?website) (SAMPLE(?x) AS ?x) (SAMPLE(?instagram) AS ?instagram) (SAMPLE(?facebook) AS ?facebook) (SAMPLE(?wikipedia) AS ?wikipedia)";

type Binding = Record<string, { value: string } | undefined>;

const safe = (handle: string | undefined) => (handle && /^[\w.\-]{1,100}$/.test(handle) ? handle : null);

/** Links in a fixed order: official site first, then Wikipedia, social accounts and Wikidata. */
export const linksOf = (b: Binding): Link[] => {
  const links: Link[] = [];
  const website = b.website?.value;
  if (website && /^https?:\/\//.test(website)) links.push({ network: "Website", url: website });
  if (b.wikipedia?.value) links.push({ network: "Wikipedia", url: b.wikipedia.value });
  const x = safe(b.x?.value);
  if (x) links.push({ network: "X", url: `https://x.com/${x}` });
  const instagram = safe(b.instagram?.value);
  if (instagram) links.push({ network: "Instagram", url: `https://www.instagram.com/${instagram}/` });
  const facebook = safe(b.facebook?.value);
  if (facebook) links.push({ network: "Facebook", url: `https://www.facebook.com/${facebook}` });
  if (b.item?.value) links.push({ network: "Wikidata", url: b.item.value.replace(/^http:/, "https:").replace("/entity/", "/wiki/") });
  return links;
};

/** Puts `extra` after `own`, skipping networks `own` already has. */
export const mergeLinks = (own: Link[], extra: Link[]) => {
  const seen = new Set(own.map((l) => l.network.toLowerCase()));
  return [...own, ...extra.filter((l) => !seen.has(l.network.toLowerCase()))];
};

/** Deputies asked about per query: one query for all of them outgrew Wikidata's 60-second limit. */
const DEPUTY_BATCH = 200;
/** Waits before asking again after a timeout, a 429 or a 5xx (Wikidata's query service is often busy). */
const RETRY_DELAYS_MS = [5_000, 20_000];

type Options = { fetchFn?: typeof fetch; retryDelaysMs?: number[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const query = async ({ fetchFn = fetch, retryDelaysMs = RETRY_DELAYS_MS }: Options, sparql: string): Promise<Binding[]> => {
  for (let attempt = 0; ; attempt++) {
    let retryable: unknown;
    try {
      const response = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: new URLSearchParams({ query: sparql }).toString(),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return ((await response.json()) as { results: { bindings: Binding[] } }).results.bindings;
      const error = new Error(`Wikidata answered ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw error;
      retryable = error;
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
      retryable = error;
    }
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) throw retryable;
    await sleep(delay);
  }
};

const literal = (text: string) => `"${text.replace(/["\\]/g, "")}"@pt`;

/**
 * Everything is read before anything is written: when Wikidata fails, the links stored last time stay.
 */
export const syncWikidataLinks = async (db: Db, options: Options = {}) => {
  // Deputies, by the parliament's ID: only the ones we store, a batch at a time.
  const storedDeputies = await db.select({ id: deputies.id }).from(deputies);
  const byDeputy = new Map<number, Link[]>();
  for (let i = 0; i < storedDeputies.length; i += DEPUTY_BATCH) {
    const ids = storedDeputies.slice(i, i + DEPUTY_BATCH).map((d) => `"${d.id}"`).join(" ");
    for (const b of await query(options, `SELECT ?id ?item ${LINK_SELECT} WHERE { VALUES ?id { ${ids} } ?item wdt:P6199 ?id . ${LINK_FIELDS} } GROUP BY ?id ?item`)) {
      const id = Number(b.id?.value);
      if (Number.isInteger(id) && !byDeputy.has(id)) byDeputy.set(id, linksOf(b));
    }
  }

  // Members of the Government: their deputy record's links, or a unique exact name.
  const members = await db
    .select({ id: governmentMembers.id, name: governmentMembers.name, deputyId: governmentMembers.deputyId })
    .from(governmentMembers);
  const byName = new Map<string, Link[] | null>();
  const unlinked = members.filter((m) => !(m.deputyId && byDeputy.has(m.deputyId)));
  for (let i = 0; i < unlinked.length; i += 50) {
    const names = unlinked.slice(i, i + 50).map((m) => literal(m.name)).join(" ");
    const rows = await query(
      options,
      `SELECT ?name ?item ${LINK_SELECT} WHERE { VALUES ?name { ${names} } ?item rdfs:label ?name; wdt:P31 wd:Q5; wdt:P27 wd:Q45 . ${LINK_FIELDS} } GROUP BY ?name ?item`,
    );
    for (const b of rows) {
      const name = b.name?.value;
      if (!name) continue;
      // The same name on two people: skip it rather than guess.
      byName.set(name, byName.has(name) ? null : linksOf(b));
    }
  }
  let deputyLinks = 0;
  for (const { id } of storedDeputies) {
    const links = byDeputy.get(id) ?? [];
    if (links.length) deputyLinks++;
    await db.update(deputies).set({ wikidataLinks: links }).where(eq(deputies.id, id));
  }
  let memberLinks = 0;
  for (const m of members) {
    const links = (m.deputyId ? byDeputy.get(m.deputyId) : undefined) ?? byName.get(m.name) ?? [];
    if (links.length) memberLinks++;
    await db.update(governmentMembers).set({ wikidataLinks: links }).where(eq(governmentMembers.id, m.id));
  }
  return { deputies: deputyLinks, governmentMembers: memberLinks };
};
