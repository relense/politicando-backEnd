# Politicando backend: working rules

The API behind www.politicando.pt (api.politicando.pt): Fastify 5, Zod 4
(fastify-type-provider-zod), Drizzle ORM, Postgres 17, Vitest. Schema in `src/db/schema.ts`,
routes in `src/modules/*/routes.ts`, domain logic in `src/<area>/`, jobs in `src/jobs/`.
How each API behaves for the frontend is in `docs/*.md`; setup and the production checklist are
in `README.md`.

## Scope

- **Backend only.** Another agent builds the frontend (`../politicando-frontEnd`): read it to understand what it calls, never edit it. For every feature, deliver the API, its doc in `docs/`, and a short paste-ready note for the frontend agent.
- **Admin screens are only for moderation and feedback.** Content (blog posts, newsletter issues) comes from repo files or from automation through the publish API key, not admin editors.
- **Product principles:**
  - No karma, no public profile pages, no leaderboards, no upvotes on forum replies. The one exception is the ideas board (`ideias`): there, replies take votes, because it's feedback for the team rather than discussion.
  - Discussion is ordered by activity, never by popularity. On the ideas board too, replies default to oldest first; sorting by votes is something the reader picks.
  - Moderation is 4chan-style: rudeness is allowed, illegal content isn't.
  - Inboxes, follows and prediction records are private to the account.
- **Deferred:** the X/Twitter feed (cost). Don't scrape the Entidade para a Transparência without asking.

## Production

- **Deploys:** master is production. It auto-deploys to Render (`politicando-api` plus the crons in `render.yaml`). The pre-deploy step runs `node dist/db/migrate.js`, which migrates and then seeds.
- **Scheduled work:** jobs are Render crons, never GitHub Actions.
- **Settings:** production env vars live in the Render dashboard.
  - `LOGIN_REQUIRED` decides whether readers need an account to take part (empty = anonymous allowed).
  - When a change needs a new variable, say so and add it to `render.yaml` with `sync: false`.
- **Credentials:** never write production credentials into the repo or echo them.

## Privacy and external services

- **Personal details:** never send the owner's personal details (name, personal email) to external services. `info@politicando.pt` is the public contact and is fine.
- **Scraping:** scrapers identify as `PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)`.
- **Secrets on disk:**
  - Never `cat` or print `.env`.
  - To query a database, write a small `node --env-file=.env` / `tsx --env-file=.env` script in the session's scratchpad, not in the repo, and don't print secrets.

## Local development

- **Postgres:** runs in Docker on port 5433 (`docker compose up -d`). The dev API runs on port 4000 (`npm run dev`).
  - The dev server may already be running from this checkout: don't stop it unless asked.
  - It doesn't reload `.env` changes, so restart it after one.
- **Tests:** they create and drop their own `politicando_test` database on every run. Never run two test runs at once.
- **Before calling a change done:** `npm test`, `npm run lint` and `npx tsc --noEmit` must all pass.
- **Migrations:**
  - Change `src/db/schema.ts`, then `npm run db:generate -- --name <what>` (run with `< /dev/null`; it can't prompt).
  - If drizzle-kit wants to ask about a rename, split the change: add in one migration, drop in the next. Hand-edit the generated SQL to move data in between.
  - Apply locally with `npm run db:migrate`.
  - Never edit a migration that has already been merged.

## Git

- **When:** commit, push and open PRs only when the owner asks. They prefer one branch and one PR per piece of work.
- **Branches:** branch from an up-to-date master. Never commit to master directly.
- **Never:** force-push, rewrite history, or run destructive git commands.
- **Commit messages** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **PR descriptions** end with:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- **Reviewing a PR:** use the `pr-reviewer` agent (`.claude/agents/pr-reviewer.md`). It comments a verdict and never merges. The owner merges.

## How to build

- **New behaviour comes with tests:** Vitest against the real test database, in `test/`. Add new tables to the truncate list in `test/helpers.ts`, and new routes to the route list in `test/api.test.ts`.
- **Validation:** validate every input with Zod in the route schema. Return errors as `ApiError(status, code, message)`, with stable snake_case codes the frontend can switch on.
- **Never build SQL from user input with `sql.raw`.**
- **Cache headers:** responses that depend on the reader (cookie) send `Cache-Control: private, no-store`. Public lists can be cached.
- **Interface changes:** flag changes to response shapes that the live frontend reads. Keep deprecated fields until the frontend has moved.
- **Jobs:** keep them safe to run twice. Side effects like notifications are best effort and never fail the main write.
