# Publishing blog posts by API key

For our own tools (e.g. a local project that writes and publishes articles): one HTTP call puts
a post live on politicando.pt. No login; an API key instead.

## Setup (once)

1. Make a key: `openssl rand -hex 32`.
2. In Render → `politicando-api` → Environment, set `PUBLISH_API_KEYS` to it. Separate several
   keys with commas (one per tool or person, so one can be revoked alone). Without any key, the
   routes don't exist (404).
3. Put the same key in the other project's secrets. Never in a repository or a browser.

## `POST https://api.politicando.pt/api/v2/publish`

Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`.

```json
{
  "markdown": "---\nslug: partidos-nas-noticias\nkind: article\ntitle: \"…\"\nsubtitle: \"…\"\ntags: [partidos, dados]\ncover: https://…/capa.jpg\nfeatured: true\n---\n\nTodos os dias, …",
  "draft": false,
  "author": "Redação Politicando"
}
```

- `markdown`: the whole `article.md`, the front matter included. Required keys are `slug` and
  `title`; also `subtitle`, `kind` (`article`, `opinion`, `podcast`, `interview`, `video`),
  `tags`, `cover` (an https image URL), `media_url` (Spotify, YouTube…) and `featured`.
- `draft` (default `false`): store without publishing. A draft never touches a post that's
  live: for a published slug it answers **409 `already_published`** (unpublish first, or
  publish the change).
- `author` (default "Redação Politicando"): the byline.

The answer:

```json
{ "slug": "partidos-nas-noticias", "status": "published", "created": true, "changed": true,
  "url": "https://www.politicando.pt/editorial/partidos-nas-noticias" }
```

- **Matched by `slug`.** A new slug creates the post. An existing one gets the new text and
  keeps its first publication date. Sending the same file twice changes nothing
  (`changed: false`), so retries are safe.
- **`featured: true`** makes it the blog's highlighted post (the newest featured one is the
  highlight); `featured: false` takes it off; leaving it out keeps what it was.
- **Errors:** 401 `invalid_key`; 400 `invalid_article` (no slug or title, a bad cover URL…); 429
  past 30 calls a minute.
- New posts reach search engines at the next hourly ingest (IndexNow).

```sh
curl -X POST https://api.politicando.pt/api/v2/publish \
  -H "Authorization: Bearer $PUBLISH_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -Rs '{markdown: .}' article.md)"
```

From this repo there's also `npm run editorial:publish -- article.md [--draft]` (it reads
`PUBLISH_API_KEY` from `.env`).

## `POST /api/v2/publish/image`: a cover image

Same header. Send a PNG or JPG up to 2 MB, either as the request body (`Content-Type:
image/png` or `image/jpeg`) or as one multipart file:

```sh
curl -X POST https://api.politicando.pt/api/v2/publish/image \
  -H "Authorization: Bearer $PUBLISH_API_KEY" -H "Content-Type: image/png" --data-binary @capa.png
```

- 200 `{ "url": "https://api.politicando.pt/media/<sha256>.png", "created": true }`. Put the
  `url` in the article's `cover:` field.
- **The same file always gets the same URL** (it's named by its content), so uploading it again
  just answers `created: false`.
- The URL is permanent and public, served with a year-long cache.
- Errors: 401 `invalid_key`; 400 `invalid_image` (not a PNG or JPG, judged by its bytes); 413
  `too_large`; 429 past 30 a minute.

## State Budget summaries ("O que muda")

Same header. Plain summaries of the Budget's amendment proposals (`docs/budget-api.md`), written
from each proposal's official PDF.

- `GET /api/v2/publish/budget/missing?year=2027&voted=true&limit=50`: proposals without a
  summary, latest votes first: `{ items: [{ id, year, number, title, article, topics, result,
  lastVotedOn, documentUrl }], total }`. `voted=false` gives those still waiting.
- `PUT /api/v2/publish/budget/:id/summary` with `{ "summary": "…", "automatic": true }`: one or
  two neutral sentences (10–600 characters) saying what the proposal changes. No judgement, no
  "wins" or "losses"; when the PDF is unclear, say less. `automatic: false` when a person wrote it.
  Answers `{ id, summary, automatic, changed }`; 404 for an unknown proposal; 120 a minute.
- `DELETE /api/v2/publish/budget/:id/summary`: removes it (204).

Summaries survive the hourly sync. The site is told to refresh (tag `budget`) on each change.

## `POST /api/v2/publish/:slug/unpublish`

Same header. Takes the post off the site (back to draft, no longer featured). 204, or 404 for
an unknown slug.

Every publish, update and unpublish is in the admin's audit log.
