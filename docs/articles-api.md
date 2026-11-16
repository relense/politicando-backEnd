# Articles API (for the frontend): news search, sources and most commented

Base path: `/api/v2`. Article items look the same everywhere (`id`, `title`, `excerpt`, `url`,
`source`, `imageUrl`, `publishedAt`, `commentCount`, `parties`, `deputies`, `government`,
`president`, `initiatives`).

## GET /articles

Returns `{ items, nextCursor }`. Pass `nextCursor` back as `cursor` for the next page; it's
`null` on the last page. Every filter combines with the others and with paging.

| query | what |
| --- | --- |
| `q` | Words in the title or excerpt. **All** words must match, ignoring accents and case: `habitacao` finds "Habitação". Parts of words match too (`habit` finds "habitação"). Up to 10 words |
| `source` | One outlet, exactly as in `article.source` (e.g. `observador.pt`). Take the values from `/articles/sources` |
| `party`, `deputy`, `initiative`, `governmentMember`, `president` | As before |
| `sort` | `newest` (default) or `comments` |
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

## GET /articles/sources

Every outlet we have articles from, most articles first (then by name). This fills the "Todas
as fontes" dropdown.

```json
{ "items": [{ "name": "observador.pt", "count": 71 }, { "name": "tsf.pt", "count": 31 }] }
```

## Errors

400 `invalid_request` for bad parameters (e.g. `since=1d`), 400 `invalid_cursor` for a
cursor from another sort, and 404 for an unknown `party`, `deputy` or `initiative`.
