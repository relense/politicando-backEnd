# Admin API (for the frontend)

A small sign-in for **our team and invited authors only**. Readers never sign in: comments
and forums stay anonymous. The admin is where people moderate comments, and later write
editorial posts and curate the corruption and interests records. Every change is written to
an audit log.

Base path: `/api/v2/admin`. Errors use the usual `{ error: { code, message } }`.

## Sessions

- `POST /admin/login` with `{ "email", "password" }` sets an **httpOnly** cookie,
  `politicando_admin`. It is `SameSite=Strict`, `Secure` in production, scoped to
  `/api/v2/admin`, and lasts 14 days. The frontend never sees the token. Send requests with
  credentials, e.g. `fetch(url, { credentials: "include" })`.
- The admin frontend must be on an origin listed in the API's `CORS_ORIGINS` and on the same
  site as the API (e.g. `admin.politicando.pt` and `api.politicando.pt`). Otherwise the strict
  cookie isn't sent.
- `GET /admin/me` returns `{ admin: { id, email, name, role } }` or 401. Call it on load to
  know whether to show the sign-in page.
- `POST /admin/logout` returns 204.
- `POST /admin/password` with `{ "current", "next" }` (at least 12 characters) returns 204. It
  signs out every other session.
- Login and password changes are limited to 5 tries a minute per IP (429 `rate_limited`).
  Failed logins always say `invalid_credentials`, never which part was wrong.

| status | code | meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | Not signed in, or the session expired: show the sign-in page |
| 401 | `invalid_credentials` | Wrong email or password |
| 403 | `forbidden` | Signed in, but the role can't do this: hide the action |

Every `/admin/*` response is `Cache-Control: private, no-store` (as are `/me/*`, `/publish/*`
and any response that sets a cookie). Editorial posts' bodies can be up to 100,000 characters
(`POST`/`PUT /admin/editorial` take bodies up to about 450 KB); past that, 413 `payload_too_large`.
Publishing, unpublishing, featuring or editing a live post tells the site to refresh the blog
(`docs/revalidate.md`).

## Roles

| role | can |
| --- | --- |
| `author` | sign in, change their password, write and publish their own editorial posts (`docs/editorial-api.md`) |
| `moderator` | everything an author can, plus edit and feature any editorial post, moderate comments and forums, handle reports, curate the corruption record and declared interests (`docs/cases-api.md`), and read the audit log |
| `admin` | everything, plus invite, edit and disable admins, and manage reader accounts (`/admin/readers`) |

## Admins (role admin)

- `GET /admin/admins` returns
  `{ items: [{ id, email, name, role, disabled, createdAt, lastLoginAt }] }`.
- `POST /admin/admins` takes `{ email, name, role, password }` and returns 201 with the
  admin, or 409 `email_taken`. You set a first password; hand it over safely and ask them to
  change it.
- `PATCH /admin/admins/:id` takes `{ name?, role?, disabled? }`. Disabling signs them out
  everywhere. You can't disable yourself or drop your own admin role (400 `self_lockout`).

The very first admin is created on the server: `npm run admin:create -- <email> "<name>" admin`.

## Reader accounts (role admin)

Moderators and authors get 403 `forbidden`. Opening a reader and every action below go into the
audit log as entity `reader` (see the end). Never sent: password hashes or session tokens (and we
keep no IPs).

### `GET /admin/readers`

Query, all optional: `q` (part of the username or email, any case), `email=confirmed|unconfirmed|none`,
`status=active|suspended|banned|deleted`, `active=7|30` (seen in the last N days),
`sort=newest|oldest|last_seen|most_active` (default `newest`), `cursor`, `limit` (default 50, max 100).

```json
{
  "items": [
    {
      "id": 812, "username": "rita_m", "email": "rita@example.com", "emailConfirmed": true, "newsletter": false,
      "createdAt": "2026-11-02T10:14:00.000Z", "lastSeenAt": "2026-11-23T21:40:00.000Z",
      "status": "active", "suspendedUntil": null, "signupFrom": "/orcamento/2027/proposta/25391",
      "counts": { "comments": 14, "forumPosts": 3, "importa": 22, "follows": 5, "saved": 9, "predictions": 4, "reportsMade": 1, "reportsAgainst": 0 }
    }
  ],
  "nextCursor": "50",
  "total": 1342
}
```

- `lastSeenAt`: their last request while logged in, written at most once an hour. Accounts from
  before 24 Nov start from their last login.
- `newsletter`: subscribed with their confirmed email.
- `status`: deleted accounts are removed, not kept, so `deleted` never appears and
  `status=deleted` lists nothing. `suspendedUntil` is set only while suspended.
- `signupFrom`: null for accounts from before 24 Nov.
- `counts.forumPosts` is threads opened plus replies; `importa` covers stories and blog posts;
  `reportsAgainst` counts every report ever made on their comments and forum posts.
- `most_active` sorts by the sum of the counts (reports against them left out).
- `nextCursor` is an offset: pass it back as it is. Anything else is a 400.

### `GET /admin/readers/stats`

```json
{ "total": 1342, "newToday": 12, "newThisWeek": 87, "active7d": 410, "active30d": 760, "withEmail": 690, "emailConfirmed": 540,
  "suspended": 3, "banned": 2, "signupsByDay": [{ "date": "2026-10-26", "count": 0 }, "…", { "date": "2026-11-24", "count": 12 }] }
```

Lisbon days. `newThisWeek` is the last 7 days, today included. `signupsByDay` is the last 30
days, oldest first, zero days included.

### `GET /admin/readers/:id`

A list item plus `moderation`: what was done to them, newest first (up to 200). That covers the
actions below, moderator bans (`/admin/users/:id/disable`), and moderators hiding their comments,
threads or replies (directly or by resolving a report).

```json
{ "...": "every field of a list item",
  "moderation": [{ "at": "2026-11-20T09:00:00.000Z", "action": "comment_removed", "by": { "id": 2, "name": "Equipa" }, "reason": "insulto", "until": null }] }
```

`action`: `comment_removed | post_removed | suspended | unsuspended | banned | unbanned | content_removed`.
`by` is null if that admin was deleted; `reason` is null where none was given. 404 `not_found`.

### `GET /admin/readers/:id/activity?kind=&cursor=`

Everything they did, newest first, 50 a page. `kind` is a comma list (unknown kinds are a 400).

```json
{
  "items": [
    { "at": "2026-11-23T21:40:00.000Z", "kind": "comment", "text": "Concordo com a proposta…", "removed": false,
      "target": { "type": "article", "id": 51234, "title": "Parlamento aprova…" } },
    { "at": "2026-11-23T20:10:00.000Z", "kind": "follow", "text": null, "removed": false,
      "target": { "type": "budget_proposal", "id": 25391, "title": "Artigo 91.º", "year": 2027 } }
  ],
  "nextCursor": null
}
```

- `kind`: `comment`, `forum_thread`, `forum_post`, `importa` (story or blog post), `vote` (an
  article's, `text` `"up"`/`"down"`, at its last change), `follow`, `save`, `prediction` (`text`
  `"pass"`/`"fail"`), `report` (`text` is the reason), `feedback`, and `read` (a story ticked as
  read in «Hoje em 5»). Unfollows aren't kept, so `unfollow` never appears. Something unfollowed,
  unsaved or un-voted simply isn't there any more.
- `text`: the body, at most 300 characters (a thread: title — body), or null.
- `removed`: a comment, thread or reply that's hidden.
- `target`: `type` `article | story | thread | initiative | budget_proposal | editorial`, with
  `id` and `title` (null when unknown), plus `year` for proposals, `board` for threads and `slug`
  for blog posts. A comment points at the article, story or post it's on; a forum reply at its
  thread. Null for feedback.

### Actions

Each takes a required `reason` (3–500 characters, 400 `invalid_request` otherwise), is audited,
and returns the reader as `GET /admin/readers/:id` does (404 if unknown).

- `POST /admin/readers/:id/suspend` `{ "until": "2026-12-01T00:00:00.000Z", "reason": "…" }`:
  `until` must be in the future.
- `POST /admin/readers/:id/unsuspend` `{ "reason": "…" }`
- `POST /admin/readers/:id/ban` / `unban` `{ "reason": "…" }`
- `POST /admin/readers/:id/remove-content` `{ "reason": "…" }`: hides every comment, thread and
  forum reply of theirs and closes the open reports on them. Adds `"removed": 17` (how many it
  hid now) to the reader.
- `DELETE /admin/readers/:id` `{ "reason": "…" }`: deletes the account as `DELETE /me` does. 204.

Banned and suspended readers stay logged in but get 403 `account_banned` / `account_suspended`
on login and whenever they take part (`docs/accounts-api.md`). Neither hides what they wrote:
that's `remove-content`.

## Comment moderation (role moderator)

- `GET /admin/comments?status=visible|hidden|all&articleId=&storyId=&postId=&before=&limit=` (default
  `visible`, 50, newest first) returns
  `{ items: [{ id, articleId, articleTitle, storyId, storyTitle, postId, postSlug, postTitle, parentId, username, body, stance, likes, team, createdAt, hiddenAt }] }`. `team` marks the team's own replies.
  A comment is on a news article (`articleId`, `articleTitle`), a story (`storyId`,
  `storyTitle`; link to `/stories/:id`) or one of our editorial posts (`postId`, `postSlug`,
  `postTitle`); the others are null. `stance` is the side the commenter picked, if any.
  In the reports queue, a reported comment's `target` also has `storyId`. For the next page, pass
  `before=<last id>`.
- `POST /admin/comments/:id/hide` with an optional `{ "reason": "Spam" }` returns 204. The
  comment disappears from the public comments (news or editorial). Its replies stay; show them as replies
  to a removed comment.
- `POST /admin/comments/:id/unhide` returns 204.
- `POST /admin/comments/:id/reply` with `{ "body": "…" }` (1–2000 characters) answers any visible
  comment (news, story or editorial post) as the team: 201 `{ id }`. The reply goes under that comment on
  the same page, signed `"Politicando"` with `team: true`, and the comment's author (if they have an
  account) gets a `comment_reply` notification. It's in the audit log as `comment.team_reply`. A hidden
  comment is 400 `comment_hidden`; contact details, threats or hate are refused like readers' comments
  (400 `personal_data`, `threat`, `hate`). Use it from this list ("Responder"); the reply then appears
  at the top, marked `team`.
- Hiding something already hidden is a no-op 204. An unknown id is a 404.

## Reports queue (role moderator)

Readers report threads, replies, comments and news articles (`POST /reports`, see
`docs/forums-api.md`). `kind` is `thread`, `post`, `comment` or `article`.

**Most of it runs on its own, 4chan style: only what's illegal or spam is hidden.** Items
reported by 2 different signed-in accounts as `hate`, `personal_data` or `illegal`, or by 3
as `spam`, are hidden automatically; `insult` and `other` never hide anything. For news, 3
accounts reporting `duplicate`, `broken_link` or `not_politics`. Anonymous reports (no
account, no captcha) only ever reach the queue: they never count toward hiding. Hidden items' reports show as resolved with
`resolution: "hidden"`, and the audit log has `report.auto_hide` with no admin. The queue
holds the rest. Unhiding an item (any of the unhide endpoints) dismisses its reports, and then
it takes twice as many new reports to hide it again.

Without an admin screen, the same can be done from the backend repo:
`npm run moderation` lists the last 14 days of reports (open, hidden, dismissed) with the
text, and `npm run moderation -- restore comment 42` brings an item back.

- `GET /admin/reports?status=open|resolved&limit=` returns one item per reported thing, most
  reported first:

  ```json
  { "items": [{
    "kind": "thread", "targetId": 7, "reports": 2, "reasons": ["hate", "insult"], "details": ["Ataque a um grupo"],
    "firstReportedAt": "…", "resolution": null,
    "target": { "text": "Título\n\nTexto…", "hidden": false, "threadId": 7, "articleId": null, "postId": null }
  }] }
  ```

  `target` is what was reported, so you can judge without leaving the queue. Link to the
  thread (`threadId`), news article (`articleId`), story (`storyId`) or editorial post (`postId`, with `postSlug` to link to the post). It is null if the thing no longer exists.
- `POST /admin/reports/resolve` with `{ "kind": "thread", "targetId": 7, "action": "hide" | "dismiss" }`
  returns `{ resolved: 2 }`, closing every open report on that item. `hide` also hides it.
  For an article, `target.text` is its title, excerpt and link. Hiding is right for
  `duplicate` and `not_politics`. For `wrong_tags`, dismiss the report and tell the team, since
  tags are fixed in the matching code, not in the admin.

## News articles (role moderator)

`POST /admin/articles/:id/hide` and `/unhide` return 204 (404 if unknown). A hidden article
disappears everywhere readers look: lists, its page, the news on deputies, initiatives,
Government and President, and comments, votes and reports on it (404).

## Forum moderation (role moderator)

All return 204 (404 if unknown):

- `POST /admin/forum/threads/:id/hide` and `/unhide`: hidden threads disappear from the board.
- `POST /admin/forum/threads/:id/lock` and `/unlock`: locked threads take no replies.
- `POST /admin/forum/threads/:id/pin` and `/unpin`: pinned threads come first on their board.
- `POST /admin/forum/posts/:id/hide` and `/unhide`: hidden replies show as removed.

Replying as the team: `POST /admin/forum/threads/:id/posts` with `{ "body": "…", "replyTo": 31 }`
(`replyTo` optional). Returns 201 `{ id }`. The post is signed "Politicando" with `team: true`,
works in locked threads, and notifies like any reply. Ideas' statuses: see `docs/forums-api.md`.

## Audit log (role moderator)

`GET /admin/audit?entity=&entityId=&before=&limit=` returns every change, newest first:

```json
{
  "items": [
    {
      "id": 12,
      "admin": { "id": 1, "name": "Ana" },
      "action": "comment.hide",
      "entity": "comment",
      "entityId": "345",
      "before": null,
      "after": { "reason": "Spam" },
      "at": "2026-11-15T12:00:00.000Z"
    }
  ]
}
```

- Actions so far: `admin.create`, `admin.update`, `admin.password`, `comment.hide`,
  `comment.unhide`, `case.create`, `case.update`, `case.publish`, `case.unpublish`,
  `interest.create`, `interest.update`, `interest.delete`, `report.hide`, `report.dismiss`,
  `thread.hide`, `thread.unhide`, `thread.lock`, `thread.unlock`, `thread.pin`, `thread.unpin`,
  `post.hide`, `post.unhide`, `article.hide`, `article.unhide`, `editorial.create`, `editorial.update`, `editorial.publish`,
  `editorial.unpublish`, `editorial.feature`, `editorial.unfeature`, `editorial.delete`,
  `user.disable`, `user.enable`, and for reader accounts (entity `reader`, `entityId` the
  reader's id): `reader.view`, `reader.suspend`, `reader.unsuspend`, `reader.ban`,
  `reader.unban`, `reader.remove_content`, `reader.delete`. Their `after` is
  `{ "reason": "…" }`, plus `until` for a suspension and `removed` for removed content;
  `reader.delete` keeps only the username, in `before`.
- A reader's page: `?entity=reader&entityId=812` shows who opened it and what was done.
- `admin` is null if that admin was deleted.
- Show it as a history panel next to any record (`?entity=comment&entityId=345`), and as a
  full log page for admins.
- Passwords are never logged.
