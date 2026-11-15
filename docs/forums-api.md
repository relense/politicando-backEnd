# Forums API (for the frontend)

Anonymous forums, like 4chan or Reddit without accounts. There is one board per party and a
general one (`geral`). Nobody signs in. Each poster gets an **ID per thread**, derived from
their IP and a server secret:

- It is the same for all their posts in that thread, so you can follow who says what.
- It differs across threads, so nobody can be tracked from thread to thread.
- The IP is never stored or returned.

Base path: `/api/v2`. Errors use the usual `{ error: { code, message } }`.

Posting works like comments: a reCAPTCHA v2 token on every post (`recaptchaToken`), and a
per-IP limit (5 posts a minute by default; 429 `rate_limited`). If Google can't be reached,
posting fails with 503 `recaptcha_unavailable`. A failed check is 403 `recaptcha_failed`.

**All text is plain text.** Escape it when rendering, keep line breaks, and turn URLs into
links with `rel="nofollow ugc noopener"`. `>>123` can link to post 123 in the same thread
(`replyTo` also says which post is answered).

## GET /forums

Boards: `geral` first, then parties by seats.

```json
{ "items": [
  { "board": "geral", "name": "Geral", "acronym": null, "threads": 12, "posts": 140, "lastActivity": "2026-11-15T12:00:00.000Z" },
  { "board": "psd", "name": "Partido Social Democrata", "acronym": "PPD/PSD", "threads": 3, "posts": 20, "lastActivity": "…" }
] }
```

`posts` counts threads plus replies.

## GET /forums/:board/threads

Query: `sort=active|new|top` (default `active`: last reply first; `new`: newest; `top`: most
replies), `page`, `limit` (1-50, default 25). Pinned threads come first. 404 for an unknown
board.

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
      "link": { "article": { "id": 12, "title": "…" }, "initiative": null }
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

## POST /reports

Lets readers report threads, replies and article comments:

```json
{ "kind": "thread", "id": 7, "reason": "insult", "details": "optional, up to 500 characters" }
```

`reason`: `spam`, `insult`, `hate`, `personal_data`, `illegal`, `other`. Returns 202, also
when the same person reports twice (counted once). There is no captcha; it's limited to 10 a
minute per IP. Show a "Denunciar" link on every post and comment, with these reasons as
options.

## Moderation

In the admin, see `docs/admin-api.md`: the reports queue, hiding, locking and pinning.
