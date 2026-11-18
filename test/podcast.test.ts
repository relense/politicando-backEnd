import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseShowEmbed, showEmbedUrl, syncPodcast } from "../src/podcast/spotify.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", commentLimitPerMinute: 1000 });

beforeEach(async () => {
  await resetDb(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Spotify's show player page, trimmed to what we read (real shape, 2026-11-18). */
const page = (entity: Record<string, unknown>) =>
  `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity, embeded_entity_uri: "spotify:show:6qMcWa60jvf3CqsSZtzPtT" } } } },
  })}</script></body></html>`;

const episode = (overrides: Record<string, unknown> = {}) => ({
  type: "episode",
  name: "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
  uri: "spotify:episode:3SdtZYRNI9rFCjBRxnnkFJ",
  id: "3SdtZYRNI9rFCjBRxnnkFJ",
  title: "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
  subtitle: "Politicando · A política portuguesa, em dados",
  releaseDate: { isoString: "2026-11-18T11:28:00Z" },
  duration: 408800,
  relatedEntityCoverArt: [
    { url: "https://image-cdn-ak.spotifycdn.com/image/ab67656300005f1f6eb383b7fa7b539fde8ab893", maxHeight: 300, maxWidth: 300 },
    { url: "https://image-cdn-ak.spotifycdn.com/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893", maxHeight: 640, maxWidth: 640 },
    { url: "https://image-cdn-ak.spotifycdn.com/image/ab6765630000f68d6eb383b7fa7b539fde8ab893", maxHeight: 64, maxWidth: 64 },
  ],
  ...overrides,
});

const fakeFetch =
  (html: string, status = 200): typeof fetch =>
  async (url) => {
    expect(String(url)).toBe(showEmbedUrl);
    return new Response(html, { status });
  };

describe("podcast", () => {
  it("reads the newest episode from Spotify's show page", () => {
    expect(parseShowEmbed(page(episode()))).toEqual({
      id: "3SdtZYRNI9rFCjBRxnnkFJ",
      title: "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
      publishedAt: new Date("2026-11-18T11:28:00Z"),
      durationSeconds: 409,
      imageUrl: "https://i.scdn.co/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893",
    });
  });

  it("gives up on anything it doesn't recognise rather than store junk", () => {
    expect(parseShowEmbed("<html>no data</html>")).toBeNull();
    expect(parseShowEmbed(page(episode({ type: "show" })))).toBeNull();
    expect(parseShowEmbed(page(episode({ id: "../../evil" })))).toBeNull();
    expect(parseShowEmbed(page(episode({ releaseDate: {} })))).toBeNull();
    // Covers only from Spotify's image servers.
    expect(parseShowEmbed(page(episode({ relatedEntityCoverArt: [{ url: "https://evil.example/x.png", maxWidth: 640 }] })))?.imageUrl).toBeNull();
  });

  it("stores each episode once and serves the newest for the play bar", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v2/podcast" })).json()).toMatchObject({ latest: null, episodes: [] });

    const first = await syncPodcast(db, fakeFetch(page(episode({ id: "1111111111111111111111", releaseDate: { isoString: "2026-11-17T11:00:00Z" } }))));
    expect(first).toMatchObject({ changed: true, isNew: true });
    expect(await syncPodcast(db, fakeFetch(page(episode())))).toMatchObject({ episode: "3SdtZYRNI9rFCjBRxnnkFJ", isNew: true });
    // Seen again an hour later: nothing changes.
    expect(await syncPodcast(db, fakeFetch(page(episode())))).toMatchObject({ changed: false, isNew: false });
    // A corrected title is stored.
    expect(await syncPodcast(db, fakeFetch(page(episode({ title: "Título corrigido" }))))).toMatchObject({ changed: true, isNew: false });

    const response = await app.inject({ method: "GET", url: "/api/v2/podcast" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.show).toEqual({ url: "https://open.spotify.com/show/6qMcWa60jvf3CqsSZtzPtT", embedUrl: "https://open.spotify.com/embed/show/6qMcWa60jvf3CqsSZtzPtT" });
    expect(body.latest).toEqual({
      id: "3SdtZYRNI9rFCjBRxnnkFJ",
      title: "Título corrigido",
      publishedAt: "2026-11-18T11:28:00.000Z",
      durationSeconds: 409,
      imageUrl: "https://i.scdn.co/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893",
      url: "https://open.spotify.com/episode/3SdtZYRNI9rFCjBRxnnkFJ",
      embedUrl: "https://open.spotify.com/embed/episode/3SdtZYRNI9rFCjBRxnnkFJ",
    });
    expect(body.episodes.map((e: { id: string }) => e.id)).toEqual(["3SdtZYRNI9rFCjBRxnnkFJ", "1111111111111111111111"]);
    expect((await app.inject({ method: "GET", url: "/api/v2/podcast?limit=1" })).json().episodes).toHaveLength(1);
  });

  it("serves the newest episode in the frontend's shape, 404 before there is one", async () => {
    const none = await app.inject({ method: "GET", url: "/api/v2/podcast/latest" });
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe("not_found");

    await syncPodcast(db, fakeFetch(page(episode())));
    const response = await app.inject({ method: "GET", url: "/api/v2/podcast/latest" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      title: "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
      publishedAt: "2026-11-18T11:28:00.000Z",
      durationSeconds: 409,
      episodeNumber: null,
      imageUrl: "https://i.scdn.co/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893",
      spotifyUrl: "https://open.spotify.com/episode/3SdtZYRNI9rFCjBRxnnkFJ",
    });
  });

  it("keeps the last episode when Spotify can't be read", async () => {
    await syncPodcast(db, fakeFetch(page(episode())));
    await expect(syncPodcast(db, fakeFetch("", 503))).rejects.toThrow("503");
    await expect(syncPodcast(db, fakeFetch("<html>changed</html>"))).rejects.toThrow("did the page change");
    expect((await app.inject({ method: "GET", url: "/api/v2/podcast" })).json().latest.id).toBe("3SdtZYRNI9rFCjBRxnnkFJ");
  });
});
