import { desc } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { podcastEpisodes } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";
import { episodeEmbedUrl, episodeUrl, showEmbedUrl, showUrl } from "../../podcast/spotify.js";

/*
 * Our podcast: the newest episode for the home page's bar, and the ones before it. Episodes are
 * read from Spotify every hour by the ingest job, so a new one appears with no deploy.
 */

const episodeSchema = z.object({
  id: z.string().describe("Spotify's episode id"),
  title: z.string().describe('As on Spotify: "18 nov. · Orçamento chega às votações, …"'),
  publishedAt: z.string(),
  durationSeconds: z.number().nullable(),
  imageUrl: z.string().nullable().describe("The cover, 640px, on Spotify's image CDN"),
  url: z.string().describe("The episode on Spotify (opens the app on a phone that has it)"),
  embedUrl: z.string().describe("Spotify's player on this episode: load it only when the reader presses play (it sets cookies)"),
});

export const podcastRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/podcast",
      {
        schema: {
          tags: ["editorial"],
          summary: "Our podcast: the newest episode (for the play bar) and the ones before it",
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
          response: {
            200: z.object({
              show: z.object({ url: z.string(), embedUrl: z.string() }),
              latest: episodeSchema.nullable().describe("Null until the first episode is read"),
              episodes: z.array(episodeSchema).describe("Newest first, latest included; only those seen since we started reading"),
            }),
          },
        },
      },
      async (request) => {
        const rows = await db.select().from(podcastEpisodes).orderBy(desc(podcastEpisodes.publishedAt)).limit(request.query.limit);
        const episodes = rows.map((r) => ({
          id: r.id,
          title: r.title,
          publishedAt: r.publishedAt.toISOString(),
          durationSeconds: r.durationSeconds,
          imageUrl: r.imageUrl,
          url: episodeUrl(r.id),
          embedUrl: episodeEmbedUrl(r.id),
        }));
        return { show: { url: showUrl, embedUrl: showEmbedUrl }, latest: episodes[0] ?? null, episodes };
      },
    );

    app.get(
      "/podcast/latest",
      {
        schema: {
          tags: ["editorial"],
          summary: "The newest episode, for the home page's play bar. 404 until the first one is read",
          response: {
            200: z.object({
              title: z.string(),
              publishedAt: z.string().nullable(),
              durationSeconds: z.number().nullable(),
              episodeNumber: z.number().nullable().describe("Spotify doesn't number episodes: null for now"),
              imageUrl: z.string().nullable().describe("The 640px cover, always on i.scdn.co"),
              spotifyUrl: z.string().nullable().describe("The episode on open.spotify.com"),
            }),
            404: errorSchema,
          },
        },
      },
      async () => {
        const [r] = await db.select().from(podcastEpisodes).orderBy(desc(podcastEpisodes.publishedAt)).limit(1);
        if (!r) throw notFound("Podcast episode");
        return {
          title: r.title,
          publishedAt: r.publishedAt.toISOString(),
          durationSeconds: r.durationSeconds,
          episodeNumber: null,
          imageUrl: r.imageUrl,
          spotifyUrl: episodeUrl(r.id),
        };
      },
    );
  };
