# Articles API (for the frontend): news search, sources, most commented and votes

Base path: `/api/v2`. Article items look the same everywhere (`id`, `title`, `excerpt`, `url`,
`source`, `imageUrl`, `publishedAt`, `commentCount`, `upvotes`, `downvotes`, `parties`, `deputies`, `government`,
`president`, `initiatives`). That includes the article lists in `/deputies/:id`, `/initiatives/:id`,
`/government/...` and `/president`.

## GET /articles

Returns `{ items, nextCursor, total }`. `total` is how many articles match the filters across all pages (the same on every page), for "Mostrar 52 notícias". Pass `nextCursor` back as `cursor` for the next page; it's
`null` on the last page. Every filter combines with the others and with paging.

| query | what |
| --- | --- |
| `q` | Words in the title or excerpt. **All** words must match, ignoring accents and case: `habitacao` finds "Habitação". Parts of words match too (`habit` finds "habitação"). Up to 10 words |
| `source` | An outlet as in `article.source` (e.g. `observador.pt`), or several separated by commas (`publico.pt,expresso.pt`): articles from **any** of them. Take the values from `/articles/sources`. An outlet with no articles just matches nothing |
| `party` | A party slug, or several separated by commas (`ps,psd,livre`): articles about **any** of them. 404 `not_found` if any slug is unknown, naming it (`"Party not found: xyz"`) |
| `deputy`, `initiative`, `governmentMember`, `president` | One value each, as before |
| `sort` | `newest` (default), `comments`, `top` or `controversial` (see [Votes](#votes)) |
| `period` | `today`, `yesterday`, `week` or `month`: articles published then, in Lisbon days. `today` is since midnight, `yesterday` the whole previous day, `week` and `month` the last 7 and 30 days, today included. Works with every sort, and together with `since` |
| `since` | Only articles published in the last N hours: `24h` (or `24`). 1 to 8760 |
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

## GET /articles/sources

Every outlet we have articles from, most articles first (then by name). This fills the "Todas
as fontes" dropdown.

```json
{ "items": [{ "name": "observador.pt", "count": 71 }, { "name": "tsf.pt", "count": 31 }] }
```

## Errors

400 `invalid_request` for bad parameters (e.g. `since=1d`, `period=year`, a vote of `2`), 400 `invalid_cursor` for a
cursor from another sort, and 404 for an unknown `party`, `deputy` or `initiative`.
