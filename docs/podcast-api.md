# Podcast API

Our podcast's newest episode, for the home page's play bar, with no deploy per episode. The
hourly ingest reads Spotify's public player page for the show and stores the newest episode;
a new one shows here within the hour after it goes live on Spotify (episodes come out around
11:30 UTC, so expect them by about 12:05).

## `GET /api/v2/podcast/latest` (what the home page uses)

```json
{
  "title": "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
  "publishedAt": "2026-11-18T11:28:00.000Z",
  "durationSeconds": 409,
  "episodeNumber": null,
  "imageUrl": "https://i.scdn.co/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893",
  "spotifyUrl": "https://open.spotify.com/episode/3SdtZYRNI9rFCjBRxnnkFJ"
}
```

- 404 (`not_found`) until the first episode is read.
- The source is Spotify's show page, not an RSS feed (we don't have the show's feed), so
  `spotifyUrl` is always the exact episode, and `episodeNumber` is `null`: Spotify doesn't
  number episodes.
- `imageUrl` is always on **`i.scdn.co`** (Spotify's image server): that's the host to allow.
- Public, with the normal rate limit.

## `GET /api/v2/podcast`

The same episodes as a list, with the player addresses. Query: `limit` (1–50, default 10), how many episodes to list.

```json
{
  "show": {
    "url": "https://open.spotify.com/show/6qMcWa60jvf3CqsSZtzPtT",
    "embedUrl": "https://open.spotify.com/embed/show/6qMcWa60jvf3CqsSZtzPtT"
  },
  "latest": {
    "id": "3SdtZYRNI9rFCjBRxnnkFJ",
    "title": "18 nov. · Orçamento chega às votações, Chega afasta-se do PS e Seguro pede pacto para a Saúde",
    "publishedAt": "2026-11-18T11:28:00.000Z",
    "durationSeconds": 409,
    "imageUrl": "https://i.scdn.co/image/ab6765630000ba8a6eb383b7fa7b539fde8ab893",
    "url": "https://open.spotify.com/episode/3SdtZYRNI9rFCjBRxnnkFJ",
    "embedUrl": "https://open.spotify.com/embed/episode/3SdtZYRNI9rFCjBRxnnkFJ"
  },
  "episodes": [ /* newest first, latest included, same shape */ ]
}
```

- `latest` is `null` until the first episode is read (right after a fresh deploy, until the
  next hourly run). Fall back to today's box: the show's "Abrir no Spotify" link.
- `title` is as on Spotify, date prefix included ("18 nov. · …").
- `durationSeconds` can be `null`; show "7 min" (rounded) when present.
- `imageUrl` is the 640px cover on Spotify's image server. Loading it sends the reader's IP to
  Spotify but sets no cookies; to avoid even that, serve it through our own domain (as with
  the deputies' photos in `app/fotos`).
- `episodes` holds only those seen since we started reading (2026-11-18); older ones aren't
  backfilled.

## The play bar

1. On load, show the bar from this response: cover, title, date, duration and a ▶ button.
   Nothing from Spotify loads yet, so no consent is needed.
2. On ▶, swap in the iframe with `latest.embedUrl` (Spotify's compact player on that episode,
   height 152). It sets Spotify's cookies, so it loads only after the reader's click, or right
   away if they chose "Carregar sempre", as today.
3. Keep "Abrir no Spotify" pointing at `latest.url` (or `show.url`).

The page is cached by the frontend; an hourly revalidation matches how often this changes.
