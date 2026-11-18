# Reader accounts API

Readers have accounts made of a **public username and a password**, with no email. There's no
mail provider yet, so there's no email verification and no "forgot password". Once the backend
setting is on, an account is needed to **comment, post in the forum, vote, like, mark "Importa"
and report**. Reading never needs one.

## Switching it on

The backend setting `LOGIN_REQUIRED` (on `politicando-api` in Render) lists what needs an
account: `comments,forum,votes,reports`. It's **empty by default**: everything stays anonymous,
as today, until the site has its login screens. Then set it to all four. Turning it off again
needs no code change.

While anonymous taking part is allowed, accounts still work: a logged-in reader's votes count per
account and their comments carry their username.

## The session

- Cookie `politicando_session`: httpOnly, Secure, `SameSite=Lax`, `Path=/api/v2`, 30 days. It's
  extended to 30 days again when it's used with under 15 left.
- **Every call that needs the session must go through the site's own server**, the way the admin
  does (`app/api/v2/admin/[...path]`): `/auth/*`, `/me*`, and every write (comments, votes,
  likes, Importa, forum, reports). The cookie then belongs to politicando.pt, so it's first-party
  and gets sent. Keep the proxy's handling: pass `cookie` in, and re-emit `Set-Cookie` without
  `Domain`.
- **Cached server fetches must never forward the cookie.** Public pages stay the same for
  everyone; the reader's own data comes from `/me/state`.
- Without a valid session, routes that need one answer **401**:
  - `unauthenticated` on `/me*`
  - `login_required` on writes, when `LOGIN_REQUIRED` covers them (show "Entra para comentar",
    "Entra para votar"…)

## Logging in

### `POST /auth/register`

```json
{ "username": "ana_silva", "password": "…", "recaptchaToken": "…" }
```

- Username: 3–20 letters, digits or `_`. Shown as typed, unique ignoring case, and screened like
  comments (no personal data or hate). Names such as `admin`, `politicando` and `moderador` are
  reserved.
- Password: 8–200 characters.
- 201 `{ "user": { "id", "username", "createdAt" } }`, sets the cookie (they're logged in).
- 409 `username_taken`; 400 for a malformed name or a short password; 403 `recaptcha_failed`.
- 3 sign-ups an hour per IP.

### `POST /auth/login`

```json
{ "username": "ana_silva", "password": "…", "recaptchaToken": "…" }
```

- 200 `{ "user": … }`, sets the cookie. The username can be in any case.
- 401 `invalid_credentials` for an unknown name, a wrong password or a banned account: the same
  answer for all three.
- 429 `too_many_attempts` after 10 failures for one username (it unlocks within 15 minutes);
  `rate_limited` past 5 tries a minute per IP.

### `POST /auth/logout` → 204, ends this session and clears the cookie.

## The account

| Call | What |
|---|---|
| `GET /me` | `{ id, username, createdAt }`, or 401 |
| `PUT /me/password` `{ current, new }` | 204; logs out every other session. 401 if `current` is wrong |
| `GET /me/activity` | Their own visible comments and forum threads and replies, newest first (100 of each) |
| `GET /me/export` | Everything stored about them, as a JSON download (GDPR access) |
| `DELETE /me` `{ password }` | 204, see below |

`DELETE /me` deletes the account for good:
- Votes, likes, Importa marks and forum votes come off the totals.
- Comments and forum replies are removed.
- Threads they opened stay, blanked ("[apagado]"), so other people's replies keep their place.
- Saved, hidden, muted and read lists are deleted.
- Reports they made stay for the moderators, no longer linked to them.

## Syncing what the browser keeps

### `GET /me/state`

```json
{
  "saved": {
    "articles": [812, 790], "stories": [41], "editorial": [3],
    "comments": [1203], "threads": [17], "replies": [4410]
  },
  "hidden": [777],
  "muted": { "sources": ["publico.pt"], "parties": ["chega"] },
  "read": [41, 39],
  "follows": { "stories": [41], "threads": [17] },
  "votes": {
    "articles": { "812": 1, "640": -1 },
    "editorial": { "metodo-de-hondt-explicado": 1 },
    "stories": [41],
    "comments": [1203],
    "forum": [17]
  }
}
```

Lists are newest first. It replaces `reader-prefs`, `article-votes`, `story-importa`,
`comment-likes`, `ideas-voted` and `stories-read` for a logged-in reader. `votes.editorial` lists
the blog posts the reader marked "Importa" (always `1`; blog posts no longer have downvotes).

### Changes: one call per change, all return 204, all idempotent

| Call | What |
|---|---|
| `PUT` / `DELETE /me/saved/:kind/:id` | Save or unsave. `kind`: `article` (news), `story`, `editorial` (a blog post, by its `id`), `comment`, `thread` (forum) or `reply` (a post in a forum thread). 404 for something that doesn't exist or was hidden |
| `PUT` / `DELETE /me/hidden/:articleId` | Hide a news article from the feed, or show it again |
| `PUT` / `DELETE /me/muted/{source\|party}/:value` | Mute an outlet (its domain, e.g. `publico.pt`) or a party (its slug) |
| `PUT /me/read/:storyId` | Mark a story read |

Votes, likes and Importa keep their own endpoints (`POST /articles/:id/vote`,
`/editorial/:slug/vote`, `/stories/:id/vote`, `/comments/:id/like`, `/forums/threads/:id/vote`).
With a session they count once per account, whatever the device or IP.

The same caps as the browser apply: the newest 500 saved of each kind and 500 hidden, 50 muted
of each kind, 200 read. Past a cap, the oldest go.

### `GET /me/saved`: the saved page

Saved blog posts, comments, forum threads and replies, with what's needed to show them and link
to them, newest saved first. Things hidden or deleted since are left out. News and stories
aren't here: they're ids in `/me/state`, which the site already knows how to load.

```json
{
  "editorial": [{ "savedAt": "…", "id": 3, "slug": "partidos-nas-noticias", "kind": "article", "title": "…", "subtitle": "…", "coverImageUrl": null, "publishedAt": "…" }],
  "comments": [{ "savedAt": "…", "id": 1203, "body": "…", "username": "ana", "likes": 4, "createdAt": "…", "articleId": 812, "storyId": null, "postSlug": null }],
  "threads": [{ "savedAt": "…", "id": 17, "board": "geral", "title": "…", "nickname": "…", "score": 9, "replyCount": 12, "createdAt": "…" }],
  "replies": [{ "savedAt": "…", "id": 4410, "threadId": 17, "threadTitle": "…", "board": "geral", "body": "…", "nickname": null, "createdAt": "…" }]
}
```

A comment is on exactly one of `articleId`, `storyId` or `postSlug` (a blog post): link there.

### `POST /me/merge`: on first login

Send what the browser had before logging in. It's added to what the account already has, and
the merged state comes back (the same shape as `GET /me/state`):

```json
{
  "saved": { "articles": [812, 790], "stories": [] },
  "hidden": [777],
  "muted": { "sources": [], "parties": [] },
  "read": [41, 39]
}
```

Every field is optional (`saved` also takes `editorial`, `comments`, `threads` and `replies`);
lists are newest first. **Votes aren't merged**: an anonymous vote has
already been counted, so adding it to the account would count it twice. After merging, use the
account's `votes` and clear the browser's own copies.

## What changes on existing routes

- Comments: `recaptchaToken` is only needed when anonymous. A logged-in reader's comment always
  shows their username; any `username` sent is ignored. Each comment has
  **`account: true|false`**: true means `username` is an account (you could link it to a profile
  later), false means a free-text name from before accounts.
- Forum threads and replies: the same. `recaptchaToken` is optional for accounts, `nickname` is
  the username, and there's `account: true|false`. `posterId` still works per thread.
- Reports and votes: no body change; with `LOGIN_REQUIRED` on, they need the session.

## Moderators

- `GET /admin/users?q=` lists accounts, most reported first.
- `POST /admin/users/:id/disable` bans an account: it's logged out and can't log in or take part.
  `POST /admin/users/:id/enable` lifts the ban.
- From the terminal: `npm run moderation -- ban <username>` and `unban <username>`.

## Copy to update on the site

Pages that promise "sem conta" need new wording once login is on: /guardadas, /sobre,
/privacidade, /termos, the forum and comment forms. The privacy page should also list the new
cookie (`politicando_session`) and what an account stores: the username, a password hash,
the lists above, and the reader's comments, posts and votes.

## Inbox, "Seguir" and predictions

See [engagement-api.md](engagement-api.md): `/me/notifications`, `/me/follows`, `/predictions` and
`/me/predictions`.
