# Politicando API

Collects Portuguese news, links each article to the political parties it mentions, and serves articles and anonymous comments over a JSON API.

Built with Node 22, TypeScript, Fastify, Zod, Drizzle and Postgres.

## Run it locally

```sh
cp .env.example .env
docker compose up -d --wait   # Postgres on port 5433
npm install
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:4000
```

The API docs are at `/docs` and the OpenAPI spec is at `/docs/json`.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run all tests (needs Postgres from `docker compose`) |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm run ingest` | Scan news sources once |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` |
| `npm run db:seed` | Create or update parties. Safe to re-run |

## API

Everything is under `/api/v2`.

| Route | Description |
|---|---|
| `GET /parties` | All parties |
| `GET /articles?party=&cursor=&limit=` | Newest first, returns `{ items, nextCursor }`. `limit` is 1-50, default 10 |
| `GET /articles/:id` | One article: excerpt, parties and source link |
| `GET /articles/:id/comments` | Flat list; use `parentId` to build threads |
| `POST /articles/:id/comments` | `{ username?, body, parentId?, recaptchaToken }` |

Errors look like `{ "error": { "code": "...", "message": "..." } }`.

To hide a comment, set its `hidden_at` in the database. There is no admin endpoint yet: `UPDATE comments SET hidden_at = now() WHERE id = ...`.

Comment `body` and `username`, and headlines and excerpts from news sources, are stored as received. **Clients must escape them when rendering.**

## News scanner

`npm run ingest` scans once and exits. It uses no paid API. The sources are in `src/ingestion/sources.ts`.

1. It reads each outlet's news sitemap or RSS feed.
2. It opens an article page only if the listing looks political, up to `INGEST_MAX_PAGES_PER_SOURCE` per outlet per run. The rest wait for the next run.
3. It matches parties using the headline, summary and article text.
4. It stores the headline, a short excerpt, the image URL and a link. **Full article text is never stored or served.**

The scanner identifies itself as `PoliticandoBot`, obeys `robots.txt` and `Crawl-delay`, and sends one request at a time per host. If a site refuses it, that site is skipped and only its listing is used, if available. Don't disguise the bot or work around a block. Pages marked subscriber-only aren't read.

It prints one JSON line per source and exits non-zero if more than half of the sources can't be read. It's safe to re-run. Articles that match no party are recorded in `seen_source_uris` so they aren't scored again; clear that table to re-score after changing terms.

Schedule it hourly next to the API, using the same Docker image with the command `node dist/jobs/ingest.js`. RSS feeds only cover a few hours, so running it less often misses articles.

## Party matching

- Party data and terms are in `src/matching/parties.ts`.
- Matching is case-sensitive.
- An article is kept if its top party scores at least 2. Up to 3 more parties are linked if they score at least 1. A mention scores 1, or 2 in the headline.
- Names that are also ordinary words (Chega, Livre, MAS, ADN, TU) count only in a party context such as "do Chega" or "Chega quer".
- Coalitions count for each member: CDU for PCP and PEV, AD for PSD and CDS-PP.
- Foreign parties are ignored ("Partido Socialista francês", "CDU alemã"), and so are articles in `/mundo/` or `/internacional/` sections.

Add a test in `test/matchParties.test.ts` when you change terms.

The file header records where the party list and seat counts came from. Update it when they change.

## Deploy

Build the `Dockerfile` and set the variables from `.env.example`, using a real `RECAPTCHA_SECRET`. The test secret in the example accepts every token. Set `TRUST_PROXY=true` behind a reverse proxy so rate limits see real client IPs.

```sh
node dist/db/migrate.js   # on each release
node dist/db/seed.js      # on each release
node dist/server.js       # the default command
```
