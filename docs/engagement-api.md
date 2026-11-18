# Engagement API: inbox, "Seguir", "Passa ou chumba?" (for the frontend)

What brings readers back, without Reddit's karma or public profiles.

**Rules for everything here:**
- No karma, no public profile pages, no leaderboards. Usernames on posts aren't links.
- Inboxes, follows and prediction records are private to the account.
- Votes are about content ("Importa"), never a score on a person.

All of this needs a logged-in reader (the session cookie, see `accounts-api.md`), except
`GET /predictions/open`. Send these calls through the site's same-origin proxy and never
cache them.

## Inbox ("Responderam-te")

### `GET /me/notifications?cursor=`

Newest first, 30 a page, with `nextCursor` for the next page (null at the end).

```json
{
  "items": [
    {
      "id": 41, "kind": "comment_reply", "actorName": "rui", "count": 1,
      "createdAt": "…", "read": false, "snippet": "Discordo de ti",
      "link": { "commentId": 1203, "articleId": 812, "storyId": null, "postSlug": null,
                "threadId": null, "postId": null, "initiativeId": null },
      "threadTitle": null, "board": null, "headline": null, "prediction": null
    }
  ],
  "nextCursor": null
}
```

| `kind` | When | Show | Link to |
|---|---|---|---|
| `comment_reply` | Someone replied to the reader's comment | "**rui** respondeu-te: *snippet*" | The comment (`commentId`) on the article (`articleId`), story (`storyId`) or blog post (`postSlug`) |
| `forum_reply` | Someone answered one of the reader's forum posts | "**rui** respondeu-te em *threadTitle*" | Post `postId` in thread `threadId` |
| `thread_update` | New replies in a thread the reader follows | "*count* novas respostas em *threadTitle*" (latest: `actorName`) | Thread `threadId` |
| `story_update` | New outlets covered a story the reader follows | "Novidades: *headline*" (`count` = runs with new coverage) | Story `storyId` |
| `prediction_result` | A prediction was settled | "Acertaste!" / "Falhaste": *initiativeTitle* was `prediction.result` | Initiative `initiativeId` |

- **Coalescing:** updates (`thread_update`, `story_update`) are one unread line per thread or story, whose `count` goes up and which moves back to the top. Once read, the next update starts a new line.
- **Hidden content:** anything hidden or deleted since is left out of the list and the count.
- **Retention:** notifications are deleted after 90 days.

### `GET /me/notifications/unread`

`{ "count": 3 }`, for the bell. It's cheap: poll it every 60 seconds or so while the tab is
visible, and when the tab regains focus.

### `POST /me/notifications/read`

`{ "ids": [41, 42] }` marks those read; `{}` marks all read. Returns 204. Opening the inbox
doesn't mark anything by itself, so call this when the reader opens the inbox, or clicks a line.

## "Seguir"

| Call | What |
|---|---|
| `PUT /me/follows/story/:id` | Follow a story: told when new outlets cover it (checked after each hourly news run) |
| `PUT /me/follows/thread/:id` | Follow a forum thread: told about new replies |
| `DELETE /me/follows/{story\|thread}/:id` | Stop following |

- Calls return 204, or 404 for something missing or hidden.
- **Followed already:** opening a thread, replying in one, and commenting on a story follow it automatically. Show the "A seguir" state so readers can unfollow.
- **In `/me/state`:** `follows: { stories: [ids], threads: [ids] }`, newest first.
- **Cap:** the newest 200 of each kind are kept.

## "Passa ou chumba?"

Readers guess whether an initiative passes its **next deciding vote** in parliament.
- **Open automatically:** anything still waiting for a deciding vote is open. Nobody has to curate it.
- **Settled on its own:** the morning after the vote, by the 04:00 parliament sync. The reader gets a `prediction_result` notification.
- **Private:** each reader's record is theirs alone. There's no leaderboard.

### `GET /predictions/open?limit=10`

```json
{ "items": [
  { "id": 4123, "type": "Projeto de Lei", "number": "512", "title": "…",
    "phase": "Discussão generalidade", "phaseDate": "2026-11-12",
    "onAgenda": true, "myPick": null, "split": null }
] }
```

- **Order:** items named in an upcoming plenary agenda (`onAgenda`: likely voted soon) come first, then those in debate, then the newest.
- **`split`** (`{pass, fail}`, how everyone picked) is **null until this reader has picked**, so the crowd can't steer them. Show it after they pick.
- `id` is the initiative (`GET /initiatives/:id`).
- Anonymous readers see the list, so show "Entra para prever".

### `PUT /predictions/:initiativeId`

`{ "pick": "pass" | "fail" }` → `{ "pick": "pass", "split": { "pass": 12, "fail": 7 } }`.

- **Changing it:** the reader can change it until the vote. Only votes from the **day after the last change** count, so a change on the vote day waits for the next vote. This stops anyone "predicting" a result already in the news.
- **Errors:** 401 `login_required`; 404 unknown; 409 `closed` when it's already decided.
- `DELETE /predictions/:initiativeId` takes a pending prediction back.

### `GET /me/predictions`

```json
{
  "record": { "hits": 7, "misses": 3, "pending": 2, "streak": 3 },
  "items": [
    { "initiativeId": 4123, "title": "…", "pick": "pass", "outcome": "hit",
      "voteDate": "2026-11-20", "voteResult": "Aprovado", "updatedAt": "…",
      "split": { "pass": 12, "fail": 7 } }
  ]
}
```

- **`outcome`:** `hit`, `miss`, `void`, or null while waiting.
- **`void`:** no vote settled it (withdrawn, not admitted, "Prejudicado"). Don't count it either way.
- **`streak`:** hits in a row, latest first. Show it only to the reader ("3 seguidas!").

**Question wording:** "Passa na próxima votação?" The next deciding vote is often the one na generalidade, not the final one.

## The daily block ("Hoje")

There's no single endpoint. Call these in parallel; each one is cacheable on its own:
- `GET /today`: "Hoje em 5" stories
- `GET /podcast/latest`: today's episode
- `GET /predictions/open?limit=3`: today's "Passa ou chumba?" (anonymous, so it's cacheable)
- `GET /agenda?limit=5`: what's on today

For the reader's own bits, use `GET /me/notifications/unread`.

## Ordering: activity, not popularity

Discussion is never sorted by likes by default, so likes can't bury anyone.
- **Comments:** oldest first, always.
- **Forum threads:** `sort=active` by default (last reply first, 4chan-style bumping). `sort=top` is an option the reader picks, never the default.
