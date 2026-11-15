import * as cheerio from "cheerio";

/*
 * Reads the Government's composition from the official portal (portugal.gov.pt). Each
 * member of the Government has a page whose server-rendered data (__NEXT_DATA__) holds
 * who holds the post, since when, until when, their biography and photo. Pages are found
 * through the portal's sitemap; there is no open-data file for this.
 */

export const PORTAL_ORIGIN = "https://portugal.gov.pt";
export const PORTAL_SITEMAP = `${PORTAL_ORIGIN}/sitemap.xml`;

export type PositionKind = "prime_minister" | "minister" | "secretary_of_state";

export interface PortalPage {
  kind: PositionKind;
  /** Path on the portal, in Portuguese: /pt/gc25/area-de-governo/financas */
  path: string;
  /** Ministry it belongs to, as the portal's slug ("financas"), or "primeiro-ministro". */
  area: string;
  /** Ministry order on the portal, which follows protocol order. The Prime Minister is 0. */
  areaRank: number;
  /** Order within the ministry: the minister is 0, secretaries of state follow. */
  rank: number;
}

export interface PortalMember {
  /** The portal's ID for the person, stable across posts and governments. */
  id: string;
  name: string;
  gender: "M" | "F" | null;
  photoUrl: string | null;
  /** Plain-text paragraphs. */
  bio: string[];
  links: { network: string; url: string }[];
}

export interface PortalPosition {
  /** The portal's ID for this person in this post. */
  id: string;
  memberId: string;
  kind: PositionKind;
  /** Full title, e.g. "Secretária de Estado dos Assuntos Fiscais". */
  title: string;
  /** Ministry slug ("financas") or "primeiro-ministro". */
  area: string;
  /** Ministry name ("Finanças"), or "Primeiro-Ministro". */
  areaName: string;
  areaRank: number;
  rank: number;
  startDate: string | null;
  /** Null while in office. */
  endDate: string | null;
  url: string;
}

export interface PortalGovernment {
  /** "XXV Governo Constitucional" */
  name: string;
  /** "gc25" */
  code: string;
  startDate: string | null;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
/** Sitecore wraps values as { value } or { jsonValue: { value } }. */
const val = (field: unknown): unknown => {
  const node = obj(field);
  return "jsonValue" in node ? obj(node.jsonValue).value : node.value;
};

/** "2025-06-05T00:00:00Z" or "20250605T000000Z" → "2025-06-05". Sitecore's "no date" is year 1. */
export const portalDate = (value: unknown) => {
  const text = str(value);
  const match = text && /^(\d{4})-?(\d{2})-?(\d{2})/.exec(text);
  if (!match || match[1] === "0001") return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
};

const toPlainParagraphs = (html: unknown) => {
  const text = str(html);
  if (!text) return [];
  const $ = cheerio.load(text);
  const paragraphs = $("p, li").toArray().map((el) => $(el).text().replace(/\s+/g, " ").trim());
  const found = paragraphs.length > 0 ? paragraphs : [$.root().text().replace(/\s+/g, " ").trim()];
  return found.filter((p) => p !== "");
};

const imageSrc = (field: unknown) => {
  const src = str(obj(val(field)).src);
  if (!src || !/^https:\/\//.test(src)) return null;
  try {
    return new URL(src).href; // Escapes accented file names.
  } catch {
    return null;
  }
};

const genderOf = (sex: unknown) => {
  const value = str(val(obj(obj(sex).fields).Value));
  return value === "Male" ? "M" : value === "Female" ? "F" : null;
};

const linksOf = (networks: unknown) =>
  arr(networks).flatMap((network) => {
    const node = obj(network);
    const url = str(obj(val(obj(node.fields).SocialMediaUrl)).url);
    const name = str(node.displayName) ?? str(node.name);
    return url && name && /^https:\/\//.test(url) ? [{ network: name, url }] : [];
  });

const normaliseId = (id: unknown) => str(id)?.replace(/[{}-]/g, "").toLowerCase() ?? null;

/** Joins a role and its area: "Ministro de Estado" + "e das" + "Finanças". */
const titleOf = (role: string, preposition: string | null, area: string | null) =>
  [role, preposition, area].filter((part): part is string => !!part).join(" ");

/** Pages of the current government, found in the sitemap. */
export const parseSitemap = (xml: string): { code: string; pages: PortalPage[] } | null => {
  const paths = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => {
    try {
      return new URL(m[1]!).pathname.replace(/^\/(pt|en)(?=\/)/, "");
    } catch {
      return "";
    }
  });
  const codes = paths.map((p) => /^\/gc(\d+)\//.exec(p)?.[1]).filter((c): c is string => !!c).map(Number);
  if (codes.length === 0) return null;
  const code = `gc${Math.max(...codes)}`;
  const pages: PortalPage[] = [];
  const seen = new Set<string>();
  const areaRank = new Map<string, number>([["primeiro-ministro", 0]]);
  const add = (page: Omit<PortalPage, "rank" | "areaRank">) => {
    if (seen.has(page.path)) return;
    seen.add(page.path);
    if (!areaRank.has(page.area)) areaRank.set(page.area, areaRank.size);
    const rank = page.kind === "secretary_of_state" ? 1 + pages.filter((p) => p.area === page.area && p.kind === "secretary_of_state").length : 0;
    pages.push({ ...page, areaRank: areaRank.get(page.area)!, rank });
  };
  for (const path of paths) {
    let match: RegExpExecArray | null;
    if (path === `/${code}/primeiro-ministro/acerca`) {
      add({ kind: "prime_minister", path: `/pt${path}`, area: "primeiro-ministro" });
    } else if ((match = new RegExp(`^/${code}/area-de-governo/([a-z0-9-]+)$`).exec(path))) {
      add({ kind: "minister", path: `/pt${path}`, area: match[1]! });
    } else if ((match = new RegExp(`^/${code}/(?:area-de-governo/([a-z0-9-]+)|primeiro-ministro)/secretarios-de-estado/[a-z0-9-]+$`).exec(path))) {
      add({ kind: "secretary_of_state", path: `/pt${path}`, area: match[1] ?? "primeiro-ministro" });
    }
  }
  return { code, pages };
};

export const nextData = (html: string): Json | null => {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try {
    return obj(JSON.parse(match[1]!));
  } catch {
    return null;
  }
};

function* walk(node: unknown): Generator<Json> {
  if (Array.isArray(node)) for (const item of node) yield* walk(item);
  else if (typeof node === "object" && node !== null) {
    yield node as Json;
    for (const value of Object.values(node)) yield* walk(value);
  }
}

export interface ParsedPage {
  government: PortalGovernment;
  members: PortalMember[];
  positions: PortalPosition[];
}

/** Everyone who held the post a page describes, current and past. */
export const parsePage = (data: Json, page: PortalPage): ParsedPage | null => {
  const sitecore = obj(obj(obj(obj(data.props).pageProps).layoutData).sitecore);
  const context = obj(obj(sitecore.context).governmentContext);
  const route = obj(sitecore.route);
  const fields = obj(route.fields);
  const name = str(context.governmentName);
  if (!name) return null;
  const government = { name, code: page.path.split("/")[2]!, startDate: portalDate(context.startDate) };
  const url = `${PORTAL_ORIGIN}${page.path}`;
  const areaName = str(context.governmentAreaTitle) ?? page.area;
  const members: PortalMember[] = [];
  const positions: PortalPosition[] = [];

  if (page.kind === "prime_minister") {
    const holder = [...walk(route)].find((node) => node.__typename === "PrimeMinisterPage");
    const card = [...walk(route)]
      .flatMap((node) => arr(obj(node.SearchResultsByOfficials).values))
      .map((value) => obj(obj(obj(value).official).jsonValue))
      .find((value) => str(value.id));
    const memberId = normaliseId(card?.id);
    const positionId = normaliseId(context.primeMinisterId);
    if (!holder || !card || !memberId || !positionId) return { government, members, positions };
    const cardFields = obj(card.fields);
    members.push({
      id: memberId,
      name: str(val(cardFields.FullName)) ?? str(card.displayName) ?? "",
      gender: genderOf(cardFields.Sex),
      photoUrl: imageSrc(cardFields.CardPhoto) ?? imageSrc(holder.bioPhoto),
      bio: toPlainParagraphs(val(holder.bio)),
      links: linksOf(cardFields.SocialMediaNetworks),
    });
    positions.push({
      id: positionId,
      memberId,
      kind: "prime_minister",
      title: str(val(holder.governmentRole)) ?? "Primeiro-Ministro",
      area: page.area,
      areaName: "Primeiro-Ministro",
      areaRank: 0,
      rank: 0,
      startDate: portalDate(val(holder.startDate)),
      endDate: portalDate(val(holder.endDate)),
      url,
    });
    return { government, members, positions };
  }

  for (const entry of arr(fields.OfficialsHistory)) {
    const item = obj(entry);
    const f = obj(item.fields);
    if (val(f.IsOfficialHidden) === true) continue;
    const official = obj(f.Official);
    const officialFields = obj(official.fields);
    const memberId = normaliseId(official.id);
    const positionId = normaliseId(item.id);
    const role = str(val(f.GovernmentRole));
    if (!memberId || !positionId || !role) continue;
    members.push({
      id: memberId,
      name: str(val(officialFields.FullName)) ?? str(official.displayName) ?? str(item.displayName) ?? "",
      gender: genderOf(officialFields.Sex),
      photoUrl: imageSrc(f.CardPhoto) ?? imageSrc(officialFields.CardPhoto),
      bio: toPlainParagraphs(val(f.Bio)),
      links: linksOf(officialFields.SocialMediaNetworks),
    });
    const title =
      page.kind === "minister"
        ? titleOf(role, str(context.governmentPreposition), areaName)
        : titleOf(role, str(val(fields.GovernmentPreposition)), str(val(fields.GovernmentTitle)));
    positions.push({
      id: positionId,
      memberId,
      kind: page.kind,
      title,
      area: page.area,
      areaName,
      areaRank: page.areaRank,
      rank: page.rank,
      startDate: portalDate(val(f.StartDate)),
      endDate: portalDate(val(f.EndDate)),
      url,
    });
  }
  return { government, members, positions };
};
