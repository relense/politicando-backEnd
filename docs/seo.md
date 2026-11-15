# Search (SEO): a brief for the frontend

What will rank for Politicando is **our own content and our data pages**: deputies,
municipalities, elections and our editorial. Aggregated news (other outlets' headlines and
excerpts) is thin content and can drag the site down. This brief lists what the backend
provides and what the frontend should do.

## 1. Ship the editorial pages

The backend already serves our posts (`docs/editorial-api.md`); the frontend has no page for
them yet. Without it, nothing we write can rank.

- `/editorial` (list) from `GET /editorial`, and `/editorial/[slug]` from `GET /editorial/:slug`.
- Each post page needs:
  - `<title>`: the title. Meta description: the `subtitle`, or the first ~155 characters of
    the body.
  - Open Graph and Twitter tags with `coverImageUrl`.
  - A canonical URL.
  - JSON-LD `NewsArticle` (or `Article`; `PodcastEpisode` for `kind: "podcast"`), with
    `author.name` from `authorName`, `datePublished` from `publishedAt` and `dateModified`.
- Render the Markdown body on the server, so it's in the HTML.

## 2. Sitemap with every data page

`app/sitemap.ts` currently lists only top-level pages, parties and up to 500 news articles.
The backend now says exactly what to include:

- `GET /sitemap` returns `{ pageSize: 10000, kinds: [{ kind, count, pages }] }`.
- `GET /sitemap/:kind?page=N` returns `{ items: [{ id, lastmod, level? }] }`.

| kind | id is | suggested page |
| --- | --- | --- |
| `party` | slug | `/partidos/:slug` |
| `deputy` | id | `/deputados/:id` |
| `government-member` | id | `/governo/:id` |
| `president` | id | `/presidente/:id` |
| `election` | id | `/eleicoes/:id` |
| `place` | key (+ `level`) | `/sitios/:key`: municipalities and districts first; parishes too |
| `initiative` | id | `/iniciativas/:id` |
| `editorial` | slug | `/editorial/:slug` |
| `case` | id | `/registo/:id` |

- Use your actual routes. The table only suggests names.
- Use Next's `generateSitemaps` to split by kind: one sitemap per kind and page, all under the
  sitemap index.
- Set `<lastmod>` from `lastmod`, and omit it when null. Don't fake it with the build date.
- Leave out the aggregated news pages (see 3).
- Revalidate it daily (`export const revalidate = 86400`).

## 3. Keep aggregated news out of the index

News article pages only repeat another outlet's headline and excerpt.

- Add `<meta name="robots" content="noindex, follow">` to them, so links still pass but the
  pages aren't indexed. Drop them from the sitemap.
- Keep the canonical link pointing to the original article (`url`), or omit it. Don't claim
  the content as ours.
- Where a news page has something of ours (the initiatives and deputies it's about, comments),
  surface links to our data pages, which is what we want indexed.

## 4. Data pages: make each one unique

Per-deputy and per-municipality pages are the biggest search asset because nobody else
has them in one place. For each:

- A specific `<title>` and description from the data. For example: "Ana Abrunhosa,
  presidente da Câmara de Coimbra: vereadores, deputados e contratos | Politicando".
- Server-rendered content (not client-only fetches), with headings that match real searches:
  "Quem é o presidente da câmara de X", "deputados eleitos por X", "contratos públicos de X".
- JSON-LD:
  - `Person` for deputies and Government members (`name`, `jobTitle`, `memberOf` the party,
    `image`).
  - `Place` / `AdministrativeArea` for municipalities.
  - `BreadcrumbList` everywhere (district → municipality → parish).
- Internal links between them:
  - municipality → its deputies, mayor's party, elections;
  - deputy → their district's municipalities, party, initiatives.

## Backend endpoints for these pages

- Municipalities and districts: `GET /places/:key` (`docs/places-api.md`).
- Deputies and Government: `GET /people/:kind/:id/path` and the parliament and Government APIs.
- Elections: `GET /elections/:id` and `/elections/:id/places/:key`.
