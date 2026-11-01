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
| `npm run ingest` | Fetch and store news once (needs `EVENT_REGISTRY_API_KEY`) |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` |
| `npm run db:seed` | Create or update parties. Safe to re-run |

## API

Everything is under `/api/v2`.

| Route | Description |
|---|---|
| `GET /parties` | All parties |
| `GET /articles?party=&cursor=&limit=` | Newest first, returns `{ items, nextCursor }`. `limit` is 1-50, default 10 |
| `GET /articles/:id` | Full article |
| `GET /articles/:id/comments` | Flat list; use `parentId` to build threads |
| `POST /articles/:id/comments` | `{ username?, body, parentId?, recaptchaToken }` |

Errors look like `{ "error": { "code": "...", "message": "..." } }`.

To hide a comment, set its `hidden_at` in the database. There is no admin endpoint yet: `UPDATE comments SET hidden_at = now() WHERE id = ...`.

Comment `body` and `username`, and article text from news sources, are stored as received. **Clients must escape them when rendering.**

## Ingestion

`npm run ingest` runs once and exits, so run it from any scheduler. It exits non-zero if a fetch fails, and it is safe to re-run. In a container, use `node dist/jobs/ingest.js`.

Articles that match no party are not stored. Their URIs go in `seen_source_uris` so they aren't scored again. If you change the matching terms and want recent articles re-scored, clear that table first.

## Party matching

- Party data and terms are in `src/matching/parties.ts`.
- Matching is case-sensitive.
- An article is kept if its top party has at least 2 mentions. Up to 3 more parties are linked if they have at least 1.
- Names that are also ordinary words (Chega, Livre, MAS, ADN, TU) count only in a party context such as "do Chega". Add a test in `test/matchParties.test.ts` when you change terms.

The file header records where the party list and seat counts came from. Update it when they change.

## Deploy

Build the `Dockerfile` and set the variables from `.env.example`, using a real `RECAPTCHA_SECRET`. The test secret in the example accepts every token. Set `TRUST_PROXY=true` behind a reverse proxy so rate limits see real client IPs.

```sh
node dist/db/migrate.js   # on each release
node dist/db/seed.js      # on each release
node dist/server.js       # the default command
```
