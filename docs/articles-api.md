# Articles API (for the frontend): news search, sources, most commented and votes

Base path: `/api/v2`. Article items look the same everywhere (`id`, `title`, `excerpt`, `url`,
`source`, `imageUrl`, `publishedAt`, `commentCount`, `upvotes`, `downvotes`, `parties`, `deputies`, `government`,
`president`, `people`, `initiatives`, `kind`, `storyId`). That includes the article lists in `/deputies/:id`, `/initiatives/:id`,
`/government/...` and `/president`.

- `kind`: `"news"`, or what the outlet itself marks as something else: `"opinion"` (columns,
  chronicles, editorials), `"podcast"` (also radio and TV programmes, such as Observador's
  "Momentos de Glória" or SIC's "Eixo do Mal"), `"newsletter"`. **Label anything but news**
  ("Opinião", "Podcast"). Only news makes stories, so the others have `storyId: null` and never
  show in `/stories` or `/today`. Read from the article's URL ("/opiniao/", "/programas/") and
  its page's section, so it's as good as the outlet's own marking: an opinion piece filed
  under a news URL stays `"news"`.
- `storyId`: the story the article belongs to, with the other outlets' versions. **The feed
  should use stories** (`docs/stories-api.md`); articles remain for search and for the news
  on deputy, initiative, Government and President pages.
- **One copy per outlet:** when an outlet publishes the same article twice under different URLs
  (RTP under both /politica/ and /economia/, Expresso re-dating a slug or adding "-1"), the later
  copy is hidden at the end of that scan (every 15 minutes). Same outlet and same headline within 3 days count as one article;
  the same headline from two outlets (agency copy) is two versions of one story, as before.
- `people`: **everyone named in it who has a page**, most mentioned first, for linking names
  to people pages (internal links matter for search):
  `[{ "kind": "deputy" | "government" | "president" | "local", "id": "1047", "name": "Nuno Melo" }]`.
  `id` is what that person's endpoint takes: `/deputies/:id`, `/government/members/:id`,
  `/president`, `/local-officials/:id`. A deputy who is also in the Government appears once,
  as a deputy. Matching uses full names (plus a few curated short names, as before). Mayors are
  matched by their full name, or by first and last name ("Carlos Moedas") only when the text
  also names their municipality next to a local-government word ("câmara", "autarca"…), so a
  namesake isn't linked. `name` for mayors is the full name from the ballot.
- Each item in `initiatives` also has `status` and `lastVote` (`{ date, phase, result, unanimous }`
  or `null`), for the "Ver como votou cada partido" chip.

## GET /articles

Returns `{ items, nextCursor, total }`. `total` is how many articles match the filters across all pages (the same on every page), for "Mostrar 52 notícias". Pass `nextCursor` back as `cursor` for the next page; it's
`null` on the last page. Every filter combines with the others and with paging.

| query | what |
| --- | --- |
| `q` | Words in the title or excerpt. **All** words must match, ignoring accents and case: `habitacao` finds "Habitação". Parts of words match too (`habit` finds "habitação"). Up to 10 words |
| `source` | An outlet as in `article.source` (e.g. `observador.pt`), or several separated by commas (`publico.pt,expresso.pt`): articles from **any** of them. Take the values from `/articles/sources`. An outlet with no articles just matches nothing |
| `party` | A party slug, or several separated by commas (`ps,psd,livre`): articles about **any** of them. 404 `not_found` if any slug is unknown, naming it (`"Party not found: xyz"`) |
| `deputy`, `initiative`, `governmentMember`, `president` | One value each, as before |
| `sort` | `newest` (default), `comments`, `top` or `controversial` (see [Votes](#votes)), `views` ("Mais lidas") or `trending` ("Em alta"), see [Reads and trending](#reads-and-trending) |
| `days` | For `sort=views`: 1–90, default 7 |
| `period` | `today`, `yesterday`, `week` or `month`: articles published then, in Lisbon days. `today` is since midnight, `yesterday` the whole previous day, `week` and `month` the last 7 and 30 days, today included. Works with every sort, and together with `since` |
| `since` | Only articles published in the last N hours: `24h` (or `24`). 1 to 8760 |
| `ids` | Only these articles, by id, separated by commas (up to 100). For the reader's **saved** list |
| `exclude` | Leave these article ids out (up to 500). For the ones the reader **hid** |
| `kind` | Only these kinds, separated by commas: `news`, or `opinion,podcast` for an "Opinião" section. All kinds by default |
| `excludeSource` | Leave out these outlets (up to 30). For "Mostrar menos deste jornal" |
| `excludeParty` | Leave out articles about any of these parties (up to 30). For "Mostrar menos sobre este partido". Unknown slugs are ignored, so stale saved preferences never break the feed |
| `limit` | 1–50, default 10 |
| `cursor` | The previous page's `nextCursor`. Keep the other parameters the same |

Note: `source` holds the outlet's **domain** (`observador.pt`, `publico.pt`), not a display
name. Map domains to names on your side if you want "Observador" in the dropdown.

### Most commented

`GET /articles?sort=comments&since=24h&limit=5`: articles published in the last 24 hours that
have at least one visible comment, most comments first (ties: newest first). Counts only
visible comments, the same as `commentCount`. Paging works, but positions can shift if
someone comments while you page; for a sidebar, one request with `limit` is enough.

Filters combine with AND: `?party=ps,psd&source=publico.pt,expresso.pt` gives articles about PS
or PSD **and** from Público or Expresso. Up to 30 values per list; spaces and empty values are
ignored. Everything works together with `q`, `sort`, `period`, `since`, `cursor` and `limit`.

## Votes

Readers vote news up or down, as on Reddit: anonymous, no captcha.

- `POST /articles/:id/vote` with `{ "value": 1 }` (up), `-1` (down) or `0` (remove the vote).
  Answers 200 `{ "up": 12, "down": 3, "mine": 1 }`: the new totals and the vote you just sent.
  - One vote per reader per article. Voting again **replaces** the earlier vote, so a reader
    can switch from up to down or take it back. Sending the same vote twice changes nothing.
  - Readers are told apart by a keyed hash of their IP; the IP itself is never stored. The API
    can't tell a reader their earlier vote: **remember it in the browser** (e.g. localStorage
    by article id) to show the arrow as pressed.
  - 30 a minute per IP, then 429 `rate_limited`. 404 for an unknown article. 400
    `invalid_request` for any other value.
  - Send it from the **browser**, so each reader counts as themselves.
- Every article item carries `upvotes` and `downvotes`. Show the score as `upvotes − downvotes`,
  or both numbers.
- `sort=top`: highest `upvotes − downvotes` first. Articles with no votes come after the
  positives (score 0), newest first. Combine with `period` for "Mais votadas hoje / esta
  semana".
- `sort=controversial`: many votes on both sides first, Reddit's formula
  `(up + down) ^ (min(up, down) / max(up, down))`. Only articles with at least one vote of
  each kind, so the list can be short or empty: hide the box then.
- Ties in every sort: newest first. `top` and `controversial` page by position, like
  `comments`, so positions can shift if people vote while you page.
- Admin: there's nothing to moderate in votes beyond the rate limit. The counts are in
  `GET /articles/:id`.

## Reads and trending

- `POST /articles/:id/view` when a reader opens an article's page on our site: no body
  (anything sent is ignored, so `navigator.sendBeacon` works), 204. One read per reader per
  article per day; nothing about readers is kept. 60 a minute per IP, 404 for unknown or
  hidden articles. Send it **from the browser**, so renders and crawlers don't count.
- Every article has `views`: reads of its page on our site since publication. Clicks to the
  outlet aren't counted.
- `sort=views&days=7`: "Mais lidas", the most read in the last `days` Lisbon days, each with
  `recentViews` (that count; only with this sort). Only articles read then, so the list can be
  short. Keep the order, or sort by `recentViews`, not `views`.
- `sort=trending`: "Em alta", the most activity for their age among the last 7 days' news.
  Points are upvotes − downvotes, 2 per visible comment and 1 per 10 reads in the last 2 days.
  The score is (points + 1) ÷ (hours since publication + 2)^1.5, as Hacker News does, so a
  fresh story with some activity beats an older one with more. It changes by the minute;
  cache it briefly at most.
- Both page by position, like `comments`.

## The article menu (no accounts)

Readers have no accounts, so their choices live in **their browser** (localStorage), and the
API filters by them:

| Menu item | How |
| --- | --- |
| Guardar | Keep the ids in the browser. "Guardadas" page: `GET /articles?ids=…` |
| Esconder | Keep the ids in the browser. Lists: `&exclude=…` |
| Mostrar menos assim | Offer "deste jornal" (`article.source`) and "sobre este partido" (`article.parties`). Keep them in the browser. Lists: `&excludeSource=…&excludeParty=…` |
| Porque vejo isto? | Nothing to call: the feed isn't personalised. Say it's newest first (or the chosen sort), and name what the article is tagged with (`parties`, `deputies`, `government`, `president`, `initiatives`) |
| Denunciar | `POST /reports` with `"kind": "article"` (see `docs/forums-api.md`) |
| Votar | `POST /articles/:id/vote` (see [Votes](#votes)) |

Following an article and awards need accounts, so they aren't offered yet.

Lists filtered by one reader's choices are personal: fetch them **from the browser** (or
uncached), never through Next's shared fetch cache, or each reader's list would become its
own cache entry. The unfiltered feed can stay cached, with the reader's filters applied as a
second, browser-side request when they have any.

## GET /articles/sources

Every outlet we have articles from, most articles first (then by name). This fills the "Todas
as fontes" dropdown.

```json
{ "items": [{ "name": "observador.pt", "count": 71 }, { "name": "tsf.pt", "count": 31 }] }
```

## Errors

400 `invalid_request` for bad parameters (e.g. `since=1d`, `period=year`, a vote of `2`), 400 `invalid_cursor` for a
cursor from another sort, and 404 for an unknown `party`, `deputy` or `initiative`.
