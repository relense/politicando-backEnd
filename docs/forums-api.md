# Forums API (for the frontend)

Anonymous forums, like 4chan or Reddit without accounts. There is one board per party, a
general one (`geral`), and an ideas board (`ideias`) for suggestions about the site, which
the team answers with a status. Nobody signs in. Each poster gets an **ID per thread**, derived from
their IP and a server secret:

- It is the same for all their posts in that thread, so you can follow who says what.
- It differs across threads, so nobody can be tracked from thread to thread.
- The IP is never stored or returned.

Base path: `/api/v2`. Errors use the usual `{ error: { code, message } }`.

Posting works like comments: a reCAPTCHA v2 token on every post (`recaptchaToken`), and a
per-IP limit (5 posts a minute by default; 429 `rate_limited`). If Google can't be reached,
posting fails with 503 `recaptcha_unavailable`. A failed check is 403 `recaptcha_failed`.

**Refused text (400).** Posts, threads and comments (news, stories and editorial posts) are
screened before they're saved. Rudeness and swearing pass; these don't, and the error's
`message` is in Portuguese, written to show as is next to the form (keep what they typed so
they can fix it):

| code | when |
| --- | --- |
| `personal_data` | An email or a Portuguese phone number, theirs or someone else's |
| `hate` | A slur, or an insult aimed at a group ("… de merda") |
| `threat` | A threat of violence ("vou-te matar", "sei onde moras") |
| `too_many_links` | More than 2 links |

The nickname or username is screened too.

**All text is plain text.** Escape it when rendering, keep line breaks, and turn URLs into
links with `rel="nofollow ugc noopener"`. `>>123` can link to post 123 in the same thread
(`replyTo` also says which post is answered).

## GET /forums

Boards: `geral` first, then `ideias`, then parties by seats.

```json
{ "items": [
  { "board": "geral", "name": "Geral", "acronym": null, "threads": 12, "posts": 140, "lastActivity": "2026-11-15T12:00:00.000Z" },
  { "board": "ideias", "name": "Ideias", "acronym": null, "threads": 30, "posts": 95, "lastActivity": "…" },
  { "board": "psd", "name": "Partido Social Democrata", "acronym": "PPD/PSD", "threads": 3, "posts": 20, "lastActivity": "…" }
] }
```

`posts` counts threads plus replies.

## GET /forums/:board/threads

Query: `sort=active|new|top` (default `active`: last reply first; `new`: newest; `top`: most
upvoted, then most replies), `status` (only threads the team gave that status; see the
ideas board), `page`, `limit` (1-50, default 25). Pinned threads come first. 404 for an
unknown board.

```json
{
  "items": [
    {
      "id": 7,
      "board": "ps",
      "title": "Orçamento",
      "excerpt": "O que acham?",
      "nickname": null,
      "posterId": "Xk3_a9Qz",
      "replyCount": 2,
      "createdAt": "…",
      "bumpedAt": "…",
      "pinned": false,
      "locked": false,
      "link": { "article": { "id": 12, "title": "…" }, "initiative": null },
      "score": 42,
      "status": null,
      "answer": null,
      "answeredAt": null
    }
  ],
  "total": 1
}
```

- `nickname` is optional and not unique: anyone can type any name. Show it with the
  `posterId`, e.g. "Zé (ID: Xk3_a9Qz)", or "Anónimo (ID: …)" when null.
- `link` is what the thread is about, when the poster linked it: an article
  (`/articles/:id`) or an initiative (`/initiatives/:id`).

## GET /forums/threads/:id

Query: `after` (a post id; only newer replies, for polling) and `limit` (1-500, default 200).

```json
{
  "thread": { "id": 7, "title": "Orçamento", "body": "O que acham?", "posterId": "Xk3_a9Qz", "locked": false, "…": "…" },
  "posts": [
    { "id": 31, "body": "Concordo", "nickname": null, "posterId": "pQ8-m2Lr", "isOp": false, "replyTo": null, "createdAt": "…", "hidden": false },
    { "id": 32, "body": null, "nickname": null, "posterId": null, "isOp": false, "replyTo": 31, "createdAt": "…", "hidden": true }
  ],
  "hasMore": false
}
```

- `isOp`: the reply is by whoever opened the thread. Show an "OP" badge.
- Hidden replies keep their place with `body: null`, so quotes still make sense. Show
  "Removido pela moderação".
- 404 if the thread doesn't exist or was hidden.

## POST /forums/:board/threads

```json
{ "title": "Orçamento", "body": "O que acham?", "nickname": "Zé", "articleId": 12, "initiativeId": null, "recaptchaToken": "…" }
```

- `title`: 3-150 characters. `body`: 1-5000. `nickname`: up to 40, optional.
- `articleId` and `initiativeId` are optional. Offer "Discutir no fórum" buttons on articles
  and initiatives that open this form prefilled.
- Returns 201 `{ id, posterId }`, the poster's own ID in the new thread. Keep it in the page
  so you can show "(tu)" next to their posts.

## POST /forums/threads/:id/posts

```json
{ "body": "Concordo", "nickname": null, "replyTo": 31, "recaptchaToken": "…" }
```

Returns 201 `{ id, posterId }`. Replying bumps the thread. Errors:

- 409 `thread_locked`: closed by a moderator. Hide the form when `locked`.
- 400 `invalid_reply`: `replyTo` isn't in this thread.

## POST /forums/threads/:id/vote

Upvotes a thread, on any board. No body, no captcha. Returns 200 `{ "score": 42 }`.

- One vote per reader per thread, counted by a keyed hash of the IP (never stored as is).
  Voting again returns the same score, without an error. There's no downvote or undo.
- 30 votes a minute per IP; past that, 429 `rate_limited`.
- 404 for a missing or hidden thread. Locked threads can still be voted on.
- `score` is on every thread in the list and in `GET /forums/threads/:id`. Remember the vote
  on the device to show the arrow as pressed.

## The ideas board (`ideias`)

A board like the others (same posting, replies, captcha, limits and reports) where readers
suggest things for the site. The page at `/feedback/ideias` lists it with `sort=top`.

The team gives each idea a `status` and, optionally, a public `answer`:

| `status` | Meaning |
|---|---|
| `null` | Nobody from the team has looked yet |
| `reviewing` | We're looking at it |
| `planned` | We'll do it |
| `in_progress` | We're doing it |
| `done` | Done |
| `declined` | We won't do it (the answer usually says why) |

`answer` is plain text, e.g. "Feito em novembro: já podes filtrar por distrito", and
`answeredAt` is when it was written (it only changes when the text changes). Both are on the
thread in the list and in `GET /forums/threads/:id`. Filter with
`GET /forums/ideias/threads?status=planned`.

For the feedback page's "most voted ideas" box, use
`GET /forums/ideias/threads?sort=top&limit=5`.

## POST /reports

Lets readers report threads, replies, comments and news articles:

```json
{ "kind": "thread", "id": 7, "reason": "insult", "details": "optional, up to 500 characters" }
```

`reason`: `spam`, `insult`, `hate`, `personal_data`, `illegal`, `other`. Returns 202, also
when the same person reports twice (counted once). There is no captcha; it's limited to 10 a
minute per IP. Show a "Denunciar" link on every post and comment, with these reasons as
options. 404 for unknown or already hidden items.

**Reported items hide themselves.** When 3 different readers report the same thread, reply
or comment, it's hidden at once (2 when they say `hate`, `personal_data` or `illegal`). A
moderator can bring it back, and then it takes twice as many new reports. So after a reader
reports something, saying "Obrigado, vamos rever" is accurate; don't promise it'll be
removed.

News articles (`"kind": "article"`) take their own reasons, about our tagging or the item
rather than what the outlet wrote: `wrong_tags` ("Partido ou pessoa errados"),
`broken_link` ("Link não funciona"), `duplicate` ("Notícia repetida"), `not_politics`
("Não é sobre política"), `other`. Mixing the two lists is 400.
News is hidden on its own after 3 reports of `duplicate`, `broken_link` or `not_politics`,
never for `wrong_tags` (that's ours to fix).

## Moderation

In the admin, see `docs/admin-api.md`: the reports queue, hiding, locking and pinning. For
ideas (moderators):

`PUT /admin/forum/threads/:id/status` with `{ "status": "planned", "answer": "Está nos planos para dezembro" }`.
Both can be `null`. Returns `{ status, answer, answeredAt }`. Threads on other boards get
400 `not_an_idea`.
