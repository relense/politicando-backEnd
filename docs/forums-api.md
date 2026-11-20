# Forums API (for the frontend)

Anonymous forums, like 4chan or Reddit without accounts. There is one board per party, a
general one (`geral`), and an ideas board (`ideias`) for suggestions about the site, which
the team answers with a status. No account is needed, except to open or vote on an idea.
Each poster gets an **ID per thread**, derived from their IP and a server secret:

- It is the same for all their posts in that thread, so you can follow who says what.
- It differs across threads, so nobody can be tracked from thread to thread.
- The IP is never stored or returned.

Base path: `/api/v2`. Errors use the usual `{ error: { code, message } }`.

**Accounts:** with `LOGIN_REQUIRED` covering `forum`, posting needs a logged-in reader, whose username becomes `nickname` (with `account: true`), and needs no reCAPTCHA; see `docs/accounts-api.md`.

Anonymous posting works like comments: a reCAPTCHA v2 token on every post (`recaptchaToken`), and a
per-IP limit (5 posts a minute by default; 429 `rate_limited`). If Google can't be reached,
posting fails with 503 `recaptcha_unavailable`. A failed check is 403 `recaptcha_failed`.

**Refused text (400). The rules are 4chan's: anything goes except what's illegal.**
Swearing, insults, rudeness towards politicians or each other all pass. Posts, threads and
comments (news, stories and editorial posts) are refused only for these. The error's
`message` is in Portuguese, written to show as is next to the form (keep what they typed so
they can fix it):

| code | when |
| --- | --- |
| `personal_data` | An email or a Portuguese phone number, theirs or someone else's |
| `hate` | Insulting a whole group for its origin, colour, religion, sexuality or disability, or calling for violence against it ("… de merda", "morte aos …"). Criticising immigration, a religion's ideas or a person is fine |
| `threat` | A threat of violence ("vou-te matar", "sei onde moras") |

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
ideas board), `q` (search, below), `page`, `limit` (1-50, default 25). Pinned threads come
first. 404 for an unknown board.
Keep `active` as the default view: discussion goes by activity, not popularity, so upvotes
never bury anyone (`top` is something the reader picks). Logged-in readers follow the threads
they open or reply in, and get told about new replies (see `engagement-api.md`).

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
      "answeredAt": null,
      "expectedOn": null,
      "duplicateOf": null,
      "area": null,
      "followers": 3
    }
  ],
  "total": 1
}
```

- `followers`: logged-in readers following the thread (they opened it, replied, voted on an
  idea, or pressed "Seguir"). A count only: who follows is private.
- `expectedOn`, `duplicateOf`, `area`: ideas board, see below. `null` elsewhere.

- `nickname` is optional and not unique: anyone can type any name, except ones that pass for
  the team ("Politicando", "Redação", "moderador", "admin"…, accents and case ignored): those
  get a 400 validation error. Show it with the `posterId`, e.g. "Zé (ID: Xk3_a9Qz)", or
  "Anónimo (ID: …)" when null. The same applies to `username` on anonymous comments.
- `link` is what the thread is about, when the poster linked it: an article
  (`/articles/:id`) or an initiative (`/initiatives/:id`).

## GET /forums/threads/:id

Query: `after` (a post id; only newer replies, for polling), `limit` (1-500, default 200) and
`sort`: `old` (default, oldest first), `new` (newest first) or `top` (most voted, then
oldest). `top` only means something on the ideas board, the only place replies take votes;
elsewhere it's the same as `old`. Poll with `after` in the default order.

```json
{
  "thread": { "id": 7, "title": "Orçamento", "body": "O que acham?", "posterId": "Xk3_a9Qz", "locked": false, "…": "…" },
  "posts": [
    { "id": 31, "body": "Concordo", "nickname": null, "posterId": "pQ8-m2Lr", "isOp": false, "replyTo": null, "createdAt": "…", "hidden": false, "team": false, "score": 0 },
    { "id": 32, "body": null, "nickname": null, "posterId": null, "isOp": false, "replyTo": 31, "createdAt": "…", "hidden": true, "team": false, "score": 0 },
    { "id": 33, "body": "Está nos planos", "nickname": "Politicando", "posterId": "equipa", "isOp": false, "replyTo": 31, "createdAt": "…", "hidden": false, "team": true, "score": 4 }
  ],
  "hasMore": false
}
```

- `isOp`: the reply is by whoever opened the thread. Show an "OP" badge.
- Hidden replies keep their place with `body: null`, so quotes still make sense. Show
  "Removido pela moderação".
- `team`: written by the team (signed "Politicando"). Show a team badge; no reader can take
  that name.
- `score`: votes for the reply, ideas board only (0 elsewhere).
- `thread.statusHistory`: the idea's timeline, see the ideas board.
- 404 if the thread doesn't exist or was hidden.

## POST /forums/:board/threads

```json
{ "title": "Orçamento", "body": "O que acham?", "nickname": "Zé", "articleId": 12, "initiativeId": null, "recaptchaToken": "…" }
```

- `title`: 3-150 characters. `body`: 1-5000. `nickname`: up to 40, optional.
- `area`: optional, up to 100 characters, for ideas: which part of the site it's about. Use the
  same values as the feedback form's `page`.
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
- On the ideas board it needs an account (401 `login_required`), and voting follows the idea.
- `score` is on every thread in the list and in `GET /forums/threads/:id`. Remember the vote
  on the device to show the arrow as pressed.

## The ideas board (`ideias`)

A board where readers suggest things for the site and the team answers. The page at
`/feedback/ideias` lists it with `sort=top`. It differs from the other boards in these ways.

**Accounts.** Opening an idea and voting on one need a logged-in reader, whatever
`LOGIN_REQUIRED` says: 401 `login_required`. Replies follow the usual forum rules, and so does
voting on other boards. `POST /feedback` stays anonymous.

**Search before posting.** `GET /forums/ideias/threads?q=modo%20escuro&limit=3` matches the
title and body, ignoring accents and case, and ranks by relevance (a word in the title counts
twice as much as one in the body), then by votes. `q` needs at least 3 characters (400
otherwise). Very common words ("que", "para", "mais"…) are ignored unless that's all there is.
Same item shape and `total` as the list. Pinned ideas get no special place in a search. Good for
"Já alguém sugeriu isto?" while typing the title.

**Similar ideas.** `GET /forums/threads/:id/similar?limit=3` (1-10): ideas on the same board
that share words with this one's title, most alike first, then most voted. Never the idea
itself. Same item shape: `{ items }`. Empty when nothing is alike enough.

**Followers.** `followers` on each idea. Voting on an idea follows it, as do opening and
replying.

**Status.** The team gives each idea a `status` and, optionally, a public `answer`:

| `status` | Meaning |
|---|---|
| `null` | Nobody from the team has looked yet |
| `reviewing` | We're looking at it |
| `planned` | We'll do it |
| `in_progress` | We're doing it |
| `done` | Done |
| `declined` | We won't do it (the answer usually says why) |
| `duplicate` | Someone suggested it before: see `duplicateOf` |

`answer` is plain text, e.g. "Feito em novembro: já podes filtrar por distrito", and
`answeredAt` is when it was written (it only changes when the text changes). `expectedOn`
(`"2026-12-15"` or null) is when the team expects it done, if they said. All are on the idea in
the list and in `GET /forums/threads/:id`. Filter with `GET /forums/ideias/threads?status=planned`.

**Timeline.** `GET /forums/threads/:id` has `thread.statusHistory`, oldest first, starting
with the idea being opened:

```json
[{ "status": null, "at": "2026-11-02T10:00:00.000Z" }, { "status": "planned", "at": "…" }, { "status": "in_progress", "at": "…" }]
```

A new step only when the status changes, not when the answer does. Followers get an
`idea_status` notification (`docs/engagement-api.md`) each time, except when it's cleared to null.

**Team replies.** The team replies as the team: posts with `team: true`, signed "Politicando"
(see `GET /forums/threads/:id`).

**Votes on replies.** Only here: discussion elsewhere goes by activity, never popularity.
`POST /forums/posts/:id/vote`, no body. Needs an account (401 `login_required`); one vote per
reader, voting again returns the same score, no undo. Returns `{ "score": 4 }`. 400
`not_an_idea` for replies on other boards, 404 for a missing or hidden one. 30 a minute.
Order replies by votes with `GET /forums/threads/:id?sort=top`, but keep oldest first as the
default. The reader's voted reply ids are in `GET /me/state` › `votes.forumPosts`.

**Duplicates.** A `duplicate` idea has `duplicateOf: { id, title }`: link to the original
("Já foi sugerida: *title*"). The original's `score` includes the duplicate's votes, each
reader counted once, and a vote on the duplicate counts on the original too. If the team
unmarks it, those votes go back.

For the feedback page's "most voted ideas" box, use
`GET /forums/ideias/threads?sort=top&limit=5`.

## POST /reports

Lets readers report threads, replies, comments and news articles:

```json
{ "kind": "thread", "id": 7, "reason": "insult", "details": "optional, up to 500 characters" }
```

`reason`: `spam`, `insult`, `hate`, `personal_data`, `illegal`, `other`. Returns 202, also
when the same person reports twice (counted once: per connection, so reporting logged in and
again logged out still counts once). There is no captcha; it's limited to 10 a
minute per IP. Show a "Denunciar" link on every post and comment, with these reasons as
options. 404 for unknown or already hidden items.

**Reported items hide themselves, but only for what's illegal or spam.** When 2 different
readers report the same thread, reply or comment as `hate`, `personal_data` or `illegal`,
it's hidden at once; 3 readers for `spam`. `insult` and `other` never hide anything (rudeness
stays up); they only reach the moderators. A moderator can bring an item back, and then it
takes twice as many new reports. After a reader reports something, "Obrigado, vamos rever" is
accurate; don't promise it'll be removed. Suggested labels: `illegal` "Ilegal (difamação,
crime…)", `hate` "Ataque a um grupo", `personal_data` "Dados pessoais", `spam` "Spam",
`insult` "Insulto", `other` "Outro".

News articles (`"kind": "article"`) take their own reasons, about our tagging or the item
rather than what the outlet wrote: `wrong_tags` ("Partido ou pessoa errados"),
`broken_link` ("Link não funciona"), `duplicate` ("Notícia repetida"), `not_politics`
("Não é sobre política"), `other`. Mixing the two lists is 400.
News is hidden on its own after 3 reports of `duplicate`, `broken_link` or `not_politics`,
never for `wrong_tags` (that's ours to fix).

## Moderation

In the admin, see `docs/admin-api.md`: the reports queue, hiding, locking and pinning. For
ideas (moderators):

`PUT /admin/forum/threads/:id/status` with
`{ "status": "planned", "answer": "Está nos planos para dezembro", "expectedOn": "2026-12-15" }`.
`status` and `answer` can be `null`. `expectedOn` can be null (clears it) or left out (keeps
it). `{ "status": "duplicate", "duplicateOf": 12 }` marks a duplicate of idea 12. Returns
`{ status, answer, answeredAt, expectedOn, duplicateOf }`. Errors, all 400:

- `not_an_idea`: a thread on another board.
- `duplicate_of_required`: `duplicate` without `duplicateOf`.
- `invalid_duplicate`: `duplicateOf` isn't another visible idea, or is a duplicate itself.

Reply as the team with `POST /admin/forum/threads/:id/posts` (`docs/admin-api.md`).

## Votes board (`votacoes`)

One thread per parliament vote open for "Passa ou chumba?". Each is created automatically and
pinned, and readers can't open threads there themselves (403 `board_closed`). Posts carry `pick`,
the poster's prediction, to show as their side. See `engagement-api.md`.
