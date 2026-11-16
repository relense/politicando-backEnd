import * as cheerio from "cheerio";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { presidents } from "../db/schema.js";
import type { GovernmentSource } from "../government/sync.js";
import { BIOGRAPHY_URL, PRESIDENCY_SITE, PRESIDENTS, currentPresident } from "./presidents.js";

const MIN_PARAGRAPHS = 3;

/** The biography paragraphs and first official photo from presidencia.pt's biography page. */
export const parseBiography = (html: string) => {
  const $ = cheerio.load(html);
  const pane = $(".tab-pane").filter((_, el) => /biografia/.test($(el).attr("data-url") ?? "")).first();
  // Paragraphs are <p>s, some holding several separated by <br>.
  const bio = (pane.length > 0 ? pane : $("main"))
    .find("p")
    .toArray()
    .flatMap((el) => ($(el).html() ?? "").split(/<br\s*\/?>/i))
    .map((part) => cheerio.load(part).root().text().replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 40 && !/^Atualizado em/i.test(text));
  const photos = $(".tab-pane")
    .filter((_, el) => !/biografia/.test($(el).attr("data-url") ?? "") && $(el).find("img").length > 0)
    .first()
    .find("img")
    .toArray()
    .map((el) => $(el).attr("src") ?? $(el).attr("data-src") ?? "")
    .filter((src) => /\.(jpe?g|png)/i.test(src));
  let photoUrl: string | null = null;
  if (photos[0]) {
    const url = new URL(photos[0], PRESIDENCY_SITE);
    url.searchParams.set("width", "800");
    url.searchParams.set("height", "533");
    photoUrl = url.href;
  }
  return { bio, photoUrl };
};

const surname = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/**
 * Stores the Presidents from presidents.ts, with the current one's biography and photo.
 * If the site's biography no longer names the current President, the list is out of date:
 * the old biography is kept and a warning asks to update it.
 */
export const syncPresidency = async (db: Db, source: GovernmentSource) => {
  const warnings: string[] = [];
  const current = currentPresident();
  const [stored] = await db.select().from(presidents).where(eq(presidents.id, current.id));
  let bio = stored?.bio ?? [];
  let photoUrl = stored?.photoUrl ?? null;

  const page = await source.get(BIOGRAPHY_URL);
  if (page.status !== "ok") {
    warnings.push(`Could not read the President's biography: ${page.reason}`);
  } else {
    const parsed = parseBiography(page.body);
    if (parsed.bio.length < MIN_PARAGRAPHS) {
      warnings.push("The President's biography page has changed shape; keeping the stored biography");
    } else if (!parsed.bio.join(" ").includes(surname(current.name))) {
      warnings.push(
        `The biography on presidencia.pt doesn't name ${current.name}: add the new President to src/presidency/presidents.ts`,
      );
    } else {
      bio = parsed.bio;
      photoUrl = parsed.photoUrl ?? photoUrl;
    }
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const president of PRESIDENTS) {
      const own = president.id === current.id;
      const row = { ...president, bio: own ? bio : [], photoUrl: own ? photoUrl : null, updatedAt: now };
      await tx
        .insert(presidents)
        .values(row)
        .onConflictDoUpdate({
          target: presidents.id,
          // Former Presidents keep whatever biography they had.
          set: own ? row : { name: row.name, fullName: row.fullName, termStart: row.termStart, termEnd: row.termEnd, updatedAt: now },
        });
    }
  });
  return { president: current.name, bioParagraphs: bio.length, photo: photoUrl !== null, warnings };
};
