import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { podcastEpisodes } from "../db/schema.js";
import { USER_AGENT } from "../ingestion/politeClient.js";

/*
 * Our podcast's newest episode, from Spotify's public player page for the show (the same page
 * the embed loads). Read on the server once an hour, so readers see the episode's title, date
 * and cover without their browser touching Spotify until they press play. No API key: the
 * page carries its data as JSON for its own player.
 */

export const SHOW_ID = "6qMcWa60jvf3CqsSZtzPtT";
export const showUrl = `https://open.spotify.com/show/${SHOW_ID}`;
export const episodeUrl = (id: string) => `https://open.spotify.com/episode/${id}`;
/** Spotify's player on one episode; the frontend loads it only when the reader presses play. */
export const episodeEmbedUrl = (id: string) => `https://open.spotify.com/embed/episode/${id}`;
export const showEmbedUrl = `https://open.spotify.com/embed/show/${SHOW_ID}`;

export interface SpotifyEpisode {
  id: string;
  title: string;
  publishedAt: Date;
  durationSeconds: number | null;
  imageUrl: string | null;
}

const isSpotifyImage = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname.endsWith(".spotifycdn.com") || url.hostname === "i.scdn.co");
  } catch {
    return false;
  }
};

/** The episode in the show player's page, or null if Spotify changed the page. */
export const parseShowEmbed = (html: string): SpotifyEpisode | null => {
  const json = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!json) return null;
  let entity: Record<string, unknown> | undefined;
  try {
    entity = JSON.parse(json)?.props?.pageProps?.state?.data?.entity;
  } catch {
    return null;
  }
  if (!entity || entity.type !== "episode") return null;
  const id = entity.id;
  const title = typeof entity.title === "string" ? entity.title : entity.name;
  const published = new Date(String((entity.releaseDate as { isoString?: string } | undefined)?.isoString ?? ""));
  if (typeof id !== "string" || !/^[A-Za-z0-9]{22}$/.test(id) || typeof title !== "string" || !title.trim()) return null;
  if (Number.isNaN(published.getTime())) return null;
  const duration = typeof entity.duration === "number" && entity.duration > 0 ? Math.round(entity.duration / 1000) : null;
  // The largest cover (640px), for the bar and for sharing.
  const covers = Array.isArray(entity.relatedEntityCoverArt) ? (entity.relatedEntityCoverArt as { url?: unknown; maxWidth?: number }[]) : [];
  const cover = covers.filter((c) => isSpotifyImage(c.url)).sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0];
  // Spotify answers from a different image server each time; i.scdn.co is the stable address of the same file.
  const imageId = cover ? /\/image\/([a-f0-9]{40})$/.exec(new URL(cover.url as string).pathname)?.[1] : undefined;
  const imageUrl = imageId ? `https://i.scdn.co/image/${imageId}` : null;
  return { id, title: title.trim(), publishedAt: published, durationSeconds: duration, imageUrl };
};

/** Stores the newest episode. Throws when Spotify can't be read, so the job logs it; the last one stays. */
export const syncPodcast = async (db: Db, fetchFn: typeof fetch = fetch) => {
  const response = await fetchFn(showEmbedUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Spotify answered ${response.status}`);
  const episode = parseShowEmbed(await response.text());
  if (!episode) throw new Error("No episode in Spotify's show page: did the page change?");
  const [row] = await db
    .insert(podcastEpisodes)
    .values({ ...episode, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: podcastEpisodes.id,
      set: {
        title: sql`excluded.title`,
        publishedAt: sql`excluded.published_at`,
        durationSeconds: sql`excluded.duration_seconds`,
        imageUrl: sql`excluded.image_url`,
        updatedAt: sql`excluded.updated_at`,
      },
      // An edited title or cover is a change; the same episode seen again is not.
      setWhere: sql`(${podcastEpisodes.title}, ${podcastEpisodes.publishedAt}, ${podcastEpisodes.durationSeconds}, ${podcastEpisodes.imageUrl})
        is distinct from (excluded.title, excluded.published_at, excluded.duration_seconds, excluded.image_url)`,
    })
    .returning({ isNew: sql<boolean>`xmax = 0` });
  return { episode: episode.id, title: episode.title, changed: Boolean(row), isNew: row?.isNew ?? false };
};
