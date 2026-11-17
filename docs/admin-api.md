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

## Roles

| role | can |
| --- | --- |
| `author` | sign in, change their password, write and publish their own editorial posts (`docs/editorial-api.md`) |
| `moderator` | everything an author can, plus edit and feature any editorial post, moderate comments and forums, handle reports, curate the corruption record and declared interests (`docs/cases-api.md`), and read the audit log |
| `admin` | everything, plus invite, edit and disable admins |

## Admins (role admin)

- `GET /admin/admins` returns
  `{ items: [{ id, email, name, role, disabled, createdAt, lastLoginAt }] }`.
- `POST /admin/admins` takes `{ email, name, role, password }` and returns 201 with the
  admin, or 409 `email_taken`. You set a first password; hand it over safely and ask them to
  change it.
- `PATCH /admin/admins/:id` takes `{ name?, role?, disabled? }`. Disabling signs them out
  everywhere. You can't disable yourself or drop your own admin role (400 `self_lockout`).

The very first admin is created on the server: `npm run admin:create -- <email> "<name>" admin`.

## Comment moderation (role moderator)

- `GET /admin/comments?status=visible|hidden|all&articleId=&postId=&before=&limit=` (default
  `visible`, 50, newest first) returns
  `{ items: [{ id, articleId, articleTitle, postId, postSlug, postTitle, parentId, username, body, createdAt, hiddenAt }] }`.
  A comment is on a news article (`articleId`, `articleTitle`) or on one of our editorial
  posts (`postId`, `postSlug`, `postTitle`); the other side is null. For the next page, pass
  `before=<last id>`.
- `POST /admin/comments/:id/hide` with an optional `{ "reason": "Spam" }` returns 204. The
  comment disappears from the public comments (news or editorial). Its replies stay; show them as replies
  to a removed comment.
- `POST /admin/comments/:id/unhide` returns 204.
- Hiding something already hidden is a no-op 204. An unknown id is a 404.

## Reports queue (role moderator)

Readers report threads, replies, comments and news articles (`POST /reports`, see
`docs/forums-api.md`). `kind` is `thread`, `post`, `comment` or `article`.

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
  thread (`threadId`), news article (`articleId`) or editorial post (`postId`). It is null if the thing no longer exists.
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
  `editorial.unpublish`, `editorial.feature`, `editorial.unfeature`, `editorial.delete`.
- `admin` is null if that admin was deleted.
- Show it as a history panel next to any record (`?entity=comment&entityId=345`), and as a
  full log page for admins.
- Passwords are never logged.
