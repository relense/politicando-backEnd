# Stories API (for the frontend): one card per story, "Importa", "Hoje em 5" and the debate

Base path: `/api/v2`. When seven outlets report the same news, the feed shows **one story**
saying "7 jornais contaram isto", and opening it shows each outlet's version. Readers mark
stories "Importa" and comment on the story, not on each outlet's version.

## How stories are made

After each hourly news scan, every new article joins the story it matches or starts a new
one. Two articles tell the same story when, within 36 hours of each other, their titles and
excerpts share enough **rare** words ("Odemira", "reeleito", "98%", not "Governo") and,
where their headlines name parties, the parties overlap. To join a story, an article has to
match at least half of its articles, so stories don't drift from topic to topic.

The grouping favours a missed match over a wrong one: occasionally one story shows as two
cards, but two different stories should not show as one. Every article has `storyId`, which
is `null` for the few minutes between it being found and grouped. An article with no other
version is a story of one.

## GET /stories

The feed as stories. Returns `{ items, nextCursor, total }`, paged like `/articles` (pass
`nextCursor` back as `cursor`; positions can shift if things change while you page).

```json
{
  "id": 29,
  "title": "André Ventura reeleito presidente do Chega com 98% dos votos",
  "excerpt": "A convenção do Chega em Viseu reelegeu…",
  "tags": [{ "slug": "legislativas", "label": "Legislativas", "name": "Eleições legislativas", "kind": "event" }],
  "imageUrl": "https://…",
  "firstPublishedAt": "2026-11-15T09:10:00.000Z",
  "lastPublishedAt": "2026-11-15T19:42:00.000Z",
  "articleCount": 11,
  "sourceCount": 9,
  "sources": [
    { "name": "rtp.pt", "articleId": 101, "title": "Ventura vai a votos como candidato único…", "url": "https://…", "publishedAt": "…" }
  ],
  "parties": [{ "slug": "chega", "acronym": "CH", "name": "Chega" }],
  "deputies": [{ "id": 123, "name": "André Ventura", "party": "chega" }],
  "government": [],
  "president": null,
  "initiatives": [],
  "importa": 14,
  "importance": 0.8,
  "commentCount": 6
}
```

- `title`: the headline **most like the others**, i.e. what most outlets said. The first
  headline can be written before the news happened ("Ventura vai a votos" before "Ventura
  reeleito"), so it isn't used.
- `excerpt`: the excerpt of the version whose headline is the `title`.
- `tags`: see [Tags and "Em debate"](#tags-and-em-debate).
- `sourceCount`: "N jornais contaram isto". `sources`: one per outlet, first to publish
  first, each with **its own headline**. Use them for the stack of logos, and for "how each
  one headlined it" when opened.
- `parties`, `deputies`, `government`, `president`, `initiatives`: named across the
  versions, most often first. Use them for the context strip (below).
- `importa` and `importance`: see [Importa](#importa).
- `commentCount`: visible comments on the story, including older ones made on its articles.

| query | what |
| --- | --- |
| `sort` | `newest` (default: latest version first), `top` (most Importa), `coverage` (most outlets: "Mais noticiadas"), `comments` (most comments: "Mais debatidas", only stories with some). Ties: newest |
| `tag` | A tag slug (`oe2027`, `habitacao`): stories with that tag |
| `period` | `today`, `yesterday`, `week`, `month`: stories with a version published then, in Lisbon days (as on `/articles`) |
| `since` | Stories with a version in the last N hours: `24h` |
| `q` | Words in any version's title or excerpt (all must match, ignoring accents) |
| `party`, `deputy`, `initiative`, `governmentMember`, `president`, `source` | As on `/articles`: stories where a version matches |
| `ids` | Only these stories (up to 100): the reader's **saved** ones |
| `exclude` | Leave these stories out (up to 500): the ones the reader **hid** |
| `excludeSource` | Leave out stories told **only** by these outlets (a story others told too stays) |
| `excludeParty` | Leave out stories about any of these parties. Unknown slugs are ignored |
| `limit` | 1–50, default 10 |

The article menu ("Guardar", "Esconder", "Mostrar menos assim", "Denunciar") works on stories
the same way it does on articles (`docs/articles-api.md` › The article menu). Keep the
reader's choices by **story id** in the browser. Report a story by reporting the version the
reader was looking at (`kind: "article"`). Lists filtered by one reader's choices must be
fetched from the browser, not through Next's shared cache.

## Tags and "Em debate"

Every story has `tags`, events first and then at most 2 topics, each
`{ slug, label, name, kind }`:

- **events** (`kind: "event"`): specific subjects, curated in the backend: `OE2027` (any
  year's budget), `Legislativas`, `Autárquicas`, `Presidenciais`, `EstadoDaNação`,
  `MoçãoDeCensura`, `LeiDasRendas`. Ask the backend to add one when a subject dominates the
  news. An event tags a story when any version's headline names it, or a third of the versions
  mention it.
- **topics** (`kind: "topic"`): the broad subjects initiatives use (Habitação, Saúde,
  Impostos…). A topic needs half of the versions to mention it.

`label` is short, for the hashtag ("#OE2027", "#Habitação"); `name` is in full ("Orçamento
do Estado para 2027") for a tooltip or a page title.

`GET /stories/tags?days=7&limit=8` is the **"Em debate"** row: the tags of stories with a
version in the last `days` Lisbon days (1–30), most commented first (then most stories):

```json
{ "items": [{ "slug": "oe2027", "label": "OE2027", "name": "Orçamento do Estado para 2027", "kind": "event", "stories": 10, "comments": 214, "importa": 57 }] }
```

Show "#OE2027 · 214 comentários", linking to `/stories?tag=oe2027`. `kind=event` keeps only
events, if you'd rather the row skip broad topics. `comments` counts every visible comment on
those stories.

## GET /stories/:id

The card plus:

- `context`, for the **"Contexto"** box:
  - `explainers` (**Explica**): up to 3 of our published blog posts whose tags match the
    story's (e.g. a post tagged "orçamento" or "oe2027" for #OE2027; "habitação" for
    #Habitação), newest first: `{ slug, title, kind, publishedAt }`. Tag our posts with the
    subjects they explain and they show up here.
  - `agenda` (**Agenda**): up to 3 coming events (next 14 days) about the story's tags first,
    then of its two main parties, soonest first within each: `{ id, title, kind, startsAt, allDay }`.
    Link to the agenda.
  - **Partido**: use the story's `parties`.
  Hide the box when all three are empty.

- `articles`: every outlet's version, first published first, each a full article item (as
  on `/articles`). This is "how each one told it".
- `debate`: `{ agree, disagree }`, the most liked comment that agrees and the one that
  disagrees, each `{ id, username, body, likes, createdAt }` or `null`. Each needs at least
  one like. **Show the pair only when both exist**: one side alone isn't a debate.

404 for unknown stories, or ones whose articles are all hidden.

## Importa

One button, "Importa": how much a story matters, not whether you liked it. There's no
down-vote, so nobody can bury the news about the party they dislike.

- `POST /stories/:id/vote` with `{ "value": 1 }` to mark it, `{ "value": 0 }` to take it back.
  Answers `{ "importa": 15, "importance": 0.85, "mine": 1 }`. One mark per reader (a keyed
  hash of the IP; the IP is never stored), 30 a minute per IP, no captcha. Remember the
  reader's own mark in the browser to draw the button filled. Send it from the browser.
- `importance` is **0 to 1, for the semicircle of dots**. It is the share of the stories with
  news in the last 24 hours that this story ties or beats on Importa marks, so the fill means
  the same on a quiet day and a busy one. 0 with no marks. 1 means as marked as any story of
  the day. E.g. 10 dots: fill `Math.round(importance * 10)`.

The old up and down votes on articles (`POST /articles/:id/vote`) still work, but use
Importa on stories instead.

## GET /today ("Hoje em 5")

`{ "items": [5 stories], "since": "…" }`: the stories with news in the last 24 hours that
matter most. A story scores one point per outlet that told it, plus half a point per Importa
mark (up to 5 points from marks). Ties go to the newest. `limit` 1–10, default 5.

It's a rolling 24 hours, so the morning isn't empty. "Estás em dia" is yours to keep in the
browser: once the reader has opened (or scrolled past) the 5 ids, show the marker. The set
changes as the day goes on, so compare ids, not just a count. Streaks also live in the
browser.

## The context strip

Chips under a story's title link it to our own pages, from fields every story already has:

| Chip | When | Link |
| --- | --- | --- |
| "Ver como votou cada partido" | an item in `initiatives` has a `lastVote` | `/iniciativas/:id`. `lastVote` is `{ date, phase, result, unanimous }`, e.g. "Rejeitado a 2 de outubro" |
| "Percurso de …" | someone in `deputies`, `government` or `president` | the career path, `GET /people/:kind/:id/path` (`docs/people-api.md`) |
| The party | `parties` | the party's page |

Each initiative also has `status` (`approved`, `rejected`, `in_progress`, `withdrawn`). We
don't link news to contracts: we don't keep articles' text, and matching an amount in a story
to a contract would too often be wrong.

## Comments on stories

As everywhere (anonymous, reCAPTCHA, 5 a minute, one level of replies, reports by comment
id), plus likes and a side:

- `GET /stories/:id/comments`: the story's comments, oldest first, including older ones made
  on its articles. Each is `{ id, storyId, parentId, username, parentUsername, body, stance, likes, createdAt }`.
- `POST /stories/:id/comments` with `{ "body": "…", "username": null, "parentId": null, "stance": "agree", "recaptchaToken": "…" }`.
  `stance` is optional: `"agree"` ("Concordo") or `"disagree"` ("Discordo"), the
  commenter's own choice. We never guess it. Offer the picker when the story is about a
  proposal (it has `initiatives`); leave it out otherwise.
- `POST /comments/:id/like` with `{ "value": 1 }` (like) or `0` (take it back) returns
  `{ likes, mine }`. One like per reader per comment, 30 a minute per IP. It works on every
  comment: news, stories, editorial. Remember the reader's likes in the browser.

Every comment, wherever it is, now has `stance` and `likes`.
