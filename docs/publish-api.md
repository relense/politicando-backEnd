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
- `draft` (default `false`): store without publishing.
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

## `POST /api/v2/publish/:slug/unpublish`

Same header. Takes the post off the site (back to draft, no longer featured). 204, or 404 for
an unknown slug.

Every publish, update and unpublish is in the admin's audit log.
