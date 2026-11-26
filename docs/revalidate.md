# Fresh pages after each update (for the frontend)

The site keeps a cached copy of what it fetches from the API. Without a signal, readers can see
that copy after the news has moved on. So the backend **tells the site** each time something
changes, and the site drops its copy of just that part at once.

## What the backend sends

```
POST <FRONTEND_REVALIDATE_URL>            e.g. https://www.politicando.pt/api/revalidate
Authorization: Bearer <REVALIDATE_SECRET>
Content-Type: application/json

{ "tags": ["news", "podcast"] }
```

- Answer any 2xx. Anything else is logged on our side and ignored: a failed ping never fails a
  job, and the next run pings again.
- Check the secret in constant time and answer 401 when it's wrong. The secret is server-only
  on the site (not `NEXT_PUBLIC_`).
- Each tag is sent at most once per ping. Unknown tags should be ignored, so we can add more.
- **Make the next visit fresh.** Expire the tagged data so the very next request refetches it
  (e.g. `revalidateTag(tag, { expire: 0 })` or `updateTag`), rather than marking it stale and
  serving the old copy once more while a new one builds. The latter is the problem this fixes.

## The tags, and when they're sent

| Tag | Covers | Sent by |
| --- | --- | --- |
| `news` | articles, stories, `/today`, tags, party and people news | the news scan (every 15 minutes: `:05`, `:20`, `:35`, `:50`), and the parliament and government syncs (they relink news) |
| `podcast` | `/podcast`, `/podcast/latest` | the news scan, only when a new or edited episode came in |
| `agenda` | `/agenda` | the agenda sync (every 3 hours) |
| `predictions` | "Passa ou chumba?" open rounds and results | the agenda and parliament syncs |
| `parliament` | initiatives, votes, deputies, parties' parliament data | the parliament sync |
| `government` | government, President, people's links | the government sync |
| `budget` | `/budget` and everything under it | the Budget sync (hourly, `:35`), only when the parliament's file changed |
| `blog` | `/editorial` lists and posts | a post going live, changing or coming off through the publish API or the admin (publish, unpublish, feature, unfeature, editing a live post), the import script, and a deploy that changed a post in `content/editorial` |

Tag the site's `fetch` calls with these names (`next: { tags: ["news"] }`). The site's own
timer can stay as a fallback.

## Setup

One secret, the same on both sides: `openssl rand -hex 32`.

- **Backend** (Render: `politicando-api` and the crons `politicando-ingest`,
  `politicando-parliament-sync`, `politicando-government-sync`, `politicando-agenda`,
  `politicando-budget`):
  `FRONTEND_REVALIDATE_URL` and `REVALIDATE_SECRET`. Either empty turns the pings off.
- **Frontend:** `REVALIDATE_SECRET`.
