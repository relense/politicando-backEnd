# Politicando API

Collects Portuguese news, links each article to the political parties it mentions, and serves articles and anonymous comments over a JSON API.

Built with Node 22, TypeScript, Fastify, Zod, Drizzle and Postgres.

Live at https://www.politicando.pt (API: https://api.politicando.pt). Contact: info@politicando.pt.

## Run it locally

```sh
cp .env.example .env
docker compose up -d --wait   # Postgres on port 5433
npm install
npm run db:migrate           # also seeds parties and local officials
npm run dev                   # http://localhost:4000
```

The API docs are at `/docs` and the OpenAPI spec is at `/docs/json`.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Run all tests (needs Postgres from `docker compose`) |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm run ingest` | Scan news sources once |
| `npm run parliament:sync` | Load deputies and initiatives from the parliament's open data |
| `npm run elections:import` | Import election results since 2011, plus the curated legislativas 1975–2009 (one-off; add ids to import only some, `--historic` for just the curated ones) |
| `npm run agenda:sync` | Import the political calendar: the parliament's agenda, the President's and the European Parliament's plenaries (Render runs it every 3 hours) |
| `npm run parliament:history` | Import earlier legislatures' initiatives (I to XVI) from the parliament's open data, for the legislature pages (one-off; add ids for only some) |
| `npm run editorial:import -- <folder or .md files>` | Publish editorial posts written as Markdown with front matter (e.g. `../politicando-research/articles`); only files with a `slug` are published (`featured: true` makes a front-page pick); re-running updates them by slug. `--draft` to keep them as drafts, `--author="Nome"` for the byline |
| `npm run admin:create -- <email> "<name>" admin` | Create the first admin (prints a one-time password) |
| `npm run contracts:import` | Import public contracts from BASE for this year and last (weekly; `-- --from=2012` for history) |
| `npm run parliament:link-news` | Link stored articles to deputies and initiatives. Add `-- --replace` after changing matching rules |
| `npm run places:shapes -- <folder>` | Rebuild `data/municipalities.json` (for `/places/locate`) from the CAOP GeoPackages, only when CAOP changes |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` |
| `npm run db:seed` | Create or update parties and local officials (mayors). Safe to re-run; `db:migrate` runs it too |

## API

Everything is under `/api/v2`.

| Route | Description |
|---|---|
| `GET /parties?sort=name\|seats\|votes` | All parties, with seats, latest legislativas result, Government members and leader. See `docs/parties-api.md` |
| `GET /parties/:slug/votes` | How a party voted in parliament, with totals and how often it votes with each other party |
| `GET /articles?party=&deputy=&q=&source=&sort=&since=&cursor=&limit=` | Newest first (or `sort=comments`), returns `{ items, nextCursor }`. See `docs/articles-api.md` |
| `GET /articles/sources` | News outlets with their article counts |
| `GET /articles/:id` | One article: excerpt, parties and source link |
| `GET /articles/:id/comments` | Flat list; use `parentId` to build threads |
| `POST /articles/:id/comments` | `{ username?, body, parentId?, recaptchaToken }` |
| `POST /newsletter/subscribe` | Double opt-in sign-up. See `docs/newsletter-api.md` |

Errors look like `{ "error": { "code": "...", "message": "..." } }`.

To hide a comment, set its `hidden_at` in the database. There is no admin endpoint yet: `UPDATE comments SET hidden_at = now() WHERE id = ...`.

Comment `body` and `username`, and headlines and excerpts from news sources, are stored as received. **Clients must escape them when rendering.**

## Government

`npm run government:sync` reads the Government's composition from portugal.gov.pt: the Prime
Minister, ministers and secretaries of state, with biographies, photos and past holders.
There's no open-data file, so it finds each member's page through the portal's sitemap and
reads the data embedded in it, politely (robots.txt, one request every 2 seconds, about
3 minutes in total). Run it daily with `node dist/jobs/syncGovernment.js`. It refuses to sync
if the portal lists no Prime Minister or fewer than 10 ministers in office. It only deletes
posts the portal dropped when every page was read.

- Endpoints: `GET /government`, `GET /government/members/:id`. See `docs/government-api.md`.
- Code: `src/government/portal.ts` (parsing), `src/government/sync.ts`.
- Members are linked to their deputy record by name, but never to a deputy who sat in parliament
  while they were in office (a namesake).
- When a new government takes office, the sync picks up the new portal code (gc26…) by itself.
- The same job stores the President of the Republic: name and term are kept by hand in
  `src/presidency/presidents.ts`, and the biography and photo come from presidencia.pt. If the
  site's biography stops naming the President listed there, the job warns you to update it.
- What the President did with each law (promulgated, vetoed, pending) comes from the
  parliament's own data, in the parliament sync. See `docs/presidency-api.md`.

## Elections

`npm run elections:import` downloads official results since 2011 from the MAI results site
(www.eleicoes.mai.gov.pt): every body, from the whole country down to municipalities
(parishes for juntas de freguesia). It's a one-off, not a daily job: run it once, and again
for a new election once the count is final, after adding it to `src/elections/catalog.ts`.
It takes a few hours at one request per second. If it stops, run it again: places already
stored are skipped (`-- --refresh` re-downloads them, `-- --parishes` goes to parishes for
every body).

- Endpoints: `GET /elections`, `GET /elections/:id`, `GET /elections/:id/places/:key`,
  `GET /places/:key`. See `docs/elections-api.md`.
- Code: `src/elections/catalog.ts` (which elections), `src/elections/mai.ts` (file formats),
  `src/elections/import.ts`.
- Autárquicas 2025 uses the site's newest format (`src/elections/maiV3.ts`). It has no
  official place codes, so it is matched by name to the places earlier elections stored, and
  it must run after autárquicas 2021 (the job's order already does this). Parishes restored
  in 2025 get keys like `AUTARQUICAS2025-1234` with no DICOFRE code.
- The same job imports candidate lists where the site has them (legislativas 2022-2025,
  europeias 2024), and links candidates to deputy records by name.
- Not yet: presidenciais 2026 (not on the MAI site).

## History

`GET /governments/history` and `GET /timeline` serve every government since 1974 and the
Presidents since 1976, kept by hand in `src/government/history.ts` and
`src/presidency/presidents.ts`. When a government takes office, add it to the history: the
daily government sync warns until you do. See `docs/history-api.md`.

`GET /legislatures` and `GET /legislatures/:id` give each legislature's page: elections,
governments, Presidents, initiatives by author, curated events (laws, crises, controversies,
each with sources, in `src/parliament/legislatureEvents.ts`) and cases from the record. Earlier
legislatures' initiatives come from `npm run parliament:history` (one-off). See
`docs/legislatures-api.md`.

## Explainers

`GET /explainers/become-deputy` serves the rules for becoming a deputy, with their legal
basis, from `src/explainers/becomeDeputy.ts`. Review that text when the electoral law
changes. See `docs/become-deputy-api.md`.

## People

`GET /people/featured` and `GET /people/:kind/:id/path` build career timelines from the
records above (parliament, Government, Presidency), so they need no job of their own. See
`docs/people-api.md`. Legislature dates are in `src/parliament/legislatures.ts`: add the next
one after each general election.

## Places and search

`GET /places` and `GET /places/:key` (`docs/places-api.md`) put together each district,
municipality and parish: the mayor (from the 2025 autárquicas candidates, imported with the
election), council seats, the district's deputies, recent results and contracts.
`GET /sitemap` lists every indexable page for the frontend's sitemap; `docs/seo.md` is the
search brief for the frontend.

## Public contracts

`npm run contracts:import` downloads public contracts from BASE (IMPIC's open data on
dados.gov.pt: one zip per year, regenerated weekly, public domain) and serves them under
`/contracts`. See `docs/contracts-api.md`.

- Run it weekly from the host's cron, e.g. `0 6 * * 1 npm run contracts:import`. It
  re-imports this year and last year, since contracts are often published months late, and
  skips files that haven't changed. The host needs the `unzip` command.
- History: `npm run contracts:import -- --from=2012` (about 2 million contracts; each year
  takes a minute or two).
- Places of execution are matched to our municipalities and districts, so import the
  autárquicas first (`npm run elections:import`).

## Corruption record and declared interests

Curated by hand in the admin (`docs/admin-api.md`), never scraped: judicial cases involving
officeholders (`/cases`) and their declared interests (`/interests`), each entry sourced and
audited. Interests with a NIF link to public contracts. Drafts stay private; publishing
checks the sources (`src/cases/model.ts`). See `docs/cases-api.md`, including the wording
rules for the frontend.

## Rate limits

Per reader IP: 300 requests a minute overall, with tighter limits on posting. The frontend
renders pages on its own server, so it sends the reader's IP with a shared `FRONTEND_API_KEY`
to keep limits per reader. See `docs/rate-limits.md`.

## Forums and editorial

Anonymous party forums (`/forums`, `docs/forums-api.md`): no accounts, reCAPTCHA and rate
limits on posting, a per-thread poster ID keyed by `FORUM_SECRET` (set it once and never
change it), upvotes (one per reader per thread, keyed the same way), and reports that feed
the moderation queue. The `ideias` board holds readers' ideas for the site, which the team
answers with a status. The feedback form, the public corrections log and their admin are in
`docs/feedback-api.md`; screenshots are kept in the database for 90 days and the hourly
ingest deletes older ones. Our own posts and podcasts live under `/editorial`
(`docs/editorial-api.md`), written in the admin.

## News scanner

`npm run ingest` scans once and exits. It uses no paid API. The sources are in `src/ingestion/sources.ts`.

1. It reads each outlet's news sitemap or RSS feed.
2. It opens an article page only if the listing looks political, up to `INGEST_MAX_PAGES_PER_SOURCE` per outlet per run. The rest wait for the next run.
3. It matches parties using the headline, summary and article text.
4. It stores the headline, a short excerpt, the image URL and a link. **Full article text is never stored or served.**

The scanner identifies itself as `PoliticandoBot`, obeys `robots.txt` and `Crawl-delay`, and sends one request at a time per host. If a site refuses it, that site is skipped and only its listing is used, if available. Don't disguise the bot or work around a block. Pages marked subscriber-only aren't read.

It prints one JSON line per source and exits non-zero if more than half of the sources can't be read. It's safe to re-run. Articles that match no party are recorded in `seen_source_uris` so they aren't scored again; clear that table to re-score after changing terms.

Schedule it hourly next to the API, using the same Docker image with the command `node dist/jobs/ingest.js`. RSS feeds only cover a few hours, so running it less often misses articles.

## Parliament

`npm run parliament:sync` downloads the current legislature's deputies, biographies and
initiatives from parlamento.pt › Dados Abertos and replaces what's stored. Run it daily,
using the same Docker image with the command `node dist/jobs/syncParliament.js`. It reads the
100 MB initiatives file as a stream, so it peaks at about 300 MB of memory. It refuses to sync if
the file lists fewer than 200 sitting deputies, and prints warnings when the chamber no
longer fits the seat map.

- Endpoints: `GET /parliament`, `GET /deputies/:id`, `GET /initiatives`,
  `GET /initiatives/:id`. Shapes and meaning are in `docs/parliament-api.md`.
- Seat map: `src/parliament/seatMap.ts`, measured from the map annexed to Deliberação
  n.º 5-PL/2025. It says which group owns each seat, not who sits where. Regenerate it
  when a deliberation changes the map.
- Who sits where isn't published. Sync estimates it from the "Composição dos Órgãos" file:
  within each party's block, the most important deputies take the front rows
  (`src/parliament/leadership.ts`, `src/parliament/seating.ts`), flagged `seatEstimated`.
  Party leaders are kept by hand in `PARTY_LEADERS`. Real assignments go in
  `src/parliament/seatAssignments.ts` and always win.
- New legislature: set `PARLIAMENT_LEGISLATURE` and replace the seat map.
- New party in parliament: add its acronym to `src/parliament/groups.ts`.
- After syncing, it links the last 30 days of news to any new initiatives or deputies.
- News ↔ initiatives is by keywords (`src/matching/matchInitiatives.ts`) and approximate.
  Each link keeps its score; tune the thresholds there and re-run
  `npm run parliament:link-news -- --replace`.
- The news scanner links articles to sitting deputies by their parliamentary name, plus
  the short names in `src/parliament/aliases.ts` ("Ventura" counts only next to Chega). A
  deputy's mentions also count for their party, but an article still needs one direct
  party mention to be kept.

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

### On Render

`render.yaml` is a Render Blueprint for everything, in Frankfurt: the API (web service, Docker,
health check on `/health`, migrations and party seed before each deploy), the database
(Postgres 17) and the scheduled jobs (`ingest` hourly, the parliament and government syncs daily,
contracts weekly). In Render: New › Blueprint, pick this repo, and fill in the values it asks for
(`CORS_ORIGINS`, `RECAPTCHA_SECRET`, `RECAPTCHA_HOSTNAMES`, `SMTP_URL`, `SITE_URL`,
`PUBLIC_API_URL`). `FORUM_SECRET` and `NEWSLETTER_SECRET` are generated once; never regenerate them.

1. **Custom domain.** Give the API a subdomain of the site (`api.politicando.pt`) under
   Settings › Custom Domains. The admin session cookie is `SameSite=strict`, so admin login only
   works when the API and the frontend share a site; on `*.onrender.com` the public API works
   but the admin doesn't.
2. **Data.** Copy the imports from a local database rather than re-running them all (contracts
   history, elections since 1975, past legislatures, blog posts). With the external connection
   string from the database's page in Render (both sides on Postgres 17):

   ```sh
   pg_dump "$LOCAL_URL" -Fc --no-owner --no-privileges \
     --exclude-table-data='admin*' --exclude-table-data=audit_log --exclude-table-data=comments \
     --exclude-table-data='forum_*' --exclude-table-data=reports --exclude-table-data=newsletter_subscribers \
     -f politicando.dump
   pg_restore --no-owner --no-privileges --clean --if-exists -d "$RENDER_EXTERNAL_URL" politicando.dump
   ```

   Or start empty and run the imports from the API's Shell in Render:
   `node dist/jobs/importElections.js`, `node dist/jobs/importPastLegislatures.js`,
   `node dist/jobs/importContracts.js --from=2012`, `node dist/jobs/syncParliament.js`,
   `node dist/jobs/syncGovernment.js`, `node dist/jobs/ingest.js`. Blog posts from Markdown:
   `DATABASE_URL="$RENDER_EXTERNAL_URL" npm run editorial:import -- ../politicando-research/articles` from a laptop.
3. **First admin.** In the API's Shell: `node dist/jobs/createAdmin.js <email> "<name>" admin`,
   then invite the rest from the admin (`docs/admin-api.md`).

Client IPs (rate limits, reCAPTCHA, forum poster IDs) come from `CLIENT_IP_HEADER=true-client-ip`:
Render passes on whatever `X-Forwarded-For` a client sends, so that header can't be trusted there.
The API and the jobs use Render's database user; `deploy/db-roles.sql` (separate owner and app
roles) is for a Postgres where we have a superuser.

### Anywhere else

Build the `Dockerfile` and set the variables from `.env.example`, using a real `RECAPTCHA_SECRET`. The test secret in the example accepts every token. Behind a reverse proxy that replaces `X-Forwarded-For`, set `TRUST_PROXY=true` so rate limits see real client IPs; if the proxy only appends to it, set `CLIENT_IP_HEADER` to the header it sets instead.

Production checklist:

- `RECAPTCHA_HOSTNAMES=politicando.pt,www.politicando.pt` (our real hostnames), so tokens solved on other sites are rejected.
- `FORUM_SECRET`: `openssl rand -hex 32`, set once. Changing it changes every poster ID.
- `COOKIE_SECURE=true` (the default): the admin and reader session cookies only travel over HTTPS.
- `LOGIN_REQUIRED`: what needs a reader account (`comments,forum,votes,reports`). Empty by default, so taking part stays anonymous; set it once the website has its login screens (`docs/accounts-api.md`).
- `CORS_ORIGINS` lists only our frontends: the API allows credentials for them, for the admin.
- Database roles: run `deploy/db-roles.sql` once. Migrations run as `politicando_owner`; the API and jobs connect as `politicando_app`, which can't change the schema or rewrite the audit log.
- Newsletter: `SMTP_URL=smtps://user:password@host:465` from a mail provider, `MAIL_FROM` (default `Politicando <info@politicando.pt>`) on a domain whose SPF/DKIM that provider covers, `NEWSLETTER_SECRET` (`openssl rand -hex 32`, set once: changing it breaks every link already sent), `SITE_URL` (the website) and `PUBLIC_API_URL` (this API's public address). Without `SMTP_URL` and `NEWSLETTER_SECRET`, sign-ups answer 503.
- `PUBLISH_API_KEYS`: keys that may publish blog posts with `POST /api/v2/publish` (`docs/publish-api.md`), e.g. from an automation. Empty: off.
- Blog posts can live in `content/editorial/*.md` (front matter as in `src/editorial/markdownFiles.ts`): every deploy publishes new or edited ones and leaves the rest untouched.
- Create the first admin with `node dist/jobs/createAdmin.js <email> "<name>" admin`, then invite the rest from the admin (`docs/admin-api.md`).
- Schedule the jobs from the host's cron, with the same image: `node dist/jobs/ingest.js` hourly, `syncParliament.js` and `syncGovernment.js` daily, `importContracts.js` weekly.

```sh
node dist/db/migrate.js   # on each release: migrates, then seeds
node dist/server.js       # the default command
```
