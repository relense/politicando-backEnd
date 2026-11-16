# Editorial API (for the frontend)

Our own content: articles, opinion, podcasts, interviews and videos, written by the team and
invited authors in the admin. The front page's 4-up block is `GET /editorial?featured=true`.

Base path: `/api/v2`.

## GET /editorial

Query: `featured=true|false`, `kind` (`article`, `opinion`, `podcast`, `interview`,
`video`), `tag`, `page`, `limit` (1-50, default 10). Published posts only, newest first.

```json
{
  "items": [
    {
      "id": 1,
      "slug": "orcamento-do-estado-o-que-muda",
      "kind": "podcast",
      "title": "Orçamento do Estado: o que muda?",
      "subtitle": null,
      "authorName": "Ana",
      "coverImageUrl": "https://…",
      "media": {
        "provider": "spotify",
        "url": "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk",
        "embedUrl": "https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk"
      },
      "tags": ["orçamento"],
      "featured": true,
      "readingMinutes": 4,
      "publishedAt": "2026-11-15T12:00:00.000Z"
    }
  ],
  "total": 1
}
```

- Front page: `?featured=true&limit=4`. Moderators choose what's featured. If fewer than 4
  are featured, fill with the latest (`?limit=4`).
- `media.embedUrl` is safe to use as an iframe `src`. It's always from an allowed provider:
  YouTube (privacy-enhanced domain), Vimeo, Spotify, SoundCloud or Apple Podcasts. Never
  build iframes from `media.url`.
- `readingMinutes`: words in the body ÷ 200, rounded up, at least 1. Show "N min de leitura".
  For podcasts and videos it reflects the text only; prefer the media's own length there.
- `opinion`: label it clearly as opinion ("Opinião"), with the author.

## GET /editorial/:slug

The same fields plus `body`, in **Markdown**. Render it with a Markdown renderer that
escapes raw HTML (e.g. markdown-it with `html: false`). Pages live at `/editorial/:slug`.
404 for unknown or unpublished slugs.

## Writing (admin)

Sign-in and roles are in `docs/admin-api.md`. Authors write and publish their own posts.
Moderators and admins can edit any post and choose the featured ones.

- `GET /admin/editorial`: posts you can edit (authors see only their own), last edited first.
  Each includes `status` (`draft` or `published`), `authorId`, `mediaUrl` and `updatedAt`.
- `GET /admin/editorial/:id`: one post, with `body`.
- `POST /admin/editorial`: creates a draft. Returns 201.
- `PUT /admin/editorial/:id`: replaces the content; the status stays.
- `POST /admin/editorial/:id/publish` and `/unpublish`. Publishing needs a non-empty body;
  unpublishing also unfeatures. `publishedAt` is kept from the first publication.
- `POST /admin/editorial/:id/feature` and `/unfeature`: moderators only. The post must be
  published.
- `DELETE /admin/editorial/:id`: drafts only (400 `published` otherwise).

Body for `POST` and `PUT`:

```json
{
  "title": "Orçamento do Estado: o que muda?",
  "subtitle": null,
  "slug": null,
  "kind": "podcast",
  "body": "# Episódio 1\n\n…",
  "authorName": null,
  "coverImageUrl": "https://…",
  "mediaUrl": "https://open.spotify.com/episode/…",
  "tags": ["orçamento"]
}
```

- `slug`: leave null to make one from the title (numbered if taken: `…-2`). An edit keeps
  the post's slug. Setting one that's taken is 409 `slug_taken`.
- `authorName`: the byline, e.g. a guest's name. It defaults to yours.
- `mediaUrl`: any other provider is 400 `unsupported_media`. Image and media URLs must be
  https.
- `tags` are lower-cased; up to 10.

There's no image upload yet: use an https link to an image hosted elsewhere.

## Posts imported from Markdown

Some posts are written as Markdown files and published with `npm run editorial:import`
instead of the admin. They come out of the API exactly like posts written in the admin, with
these differences:

- `authorName` is `"Redação Politicando"` and there's no author account behind it.
- `featured` comes from the file (`featured: true`); `GET /editorial?featured=true&limit=1`
  gives the newest pick. A moderator can also change it in the admin, and re-importing keeps
  that unless the file says otherwise.
- No `coverImageUrl` yet, so the cards need a fallback without an image.
- Bodies use GitHub-flavoured Markdown **tables** (party results, vote counts), plus
  footnote-style lines in italics and a `---` rule before the "Como fizemos" note at the end.
  Render tables (e.g. `remark-gfm`) and let them scroll sideways on phones.
- Links inside bodies are absolute `https://politicando.pt/...` links to our own pages
  (`/partido/:slug`, `/parlamento`, `/eleicoes`, `/editorial/:slug`). Treat them as internal links.
