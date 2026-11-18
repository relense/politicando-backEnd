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

Readers guess whether an initiative passes its vote in parliament, **only while the vote is in
the air**, and defend their pick in the vote's megathread. It's a position to argue, not just a
click.

- **Opens:** exactly **7 days** before its plenary session. Votes on the agenda up to two weeks out are already known as `upcoming` (agenda checked every 3 hours). Before opening it can't be predicted. Most days there are only a few open votes, and sometimes none.
- **Closes:** when that plenary session starts (`closesAt`). Show a countdown ("Vota-se quinta: faltam 2 dias").
- **Postponed:** if the vote doesn't happen that day and the initiative comes back on a later agenda, it reopens (pinned again) and earlier picks still count.
- **Settled:** the morning after the vote, by the 04:00 parliament sync. The reader gets a `prediction_result` notification.
- **Private:** each reader's record is theirs alone. There's no leaderboard.

### `GET /predictions/open?limit=10&upcoming=true`

Open votes first (soonest session first), then, with `upcoming=true`, the ones whose picks open
within the week ("Abre terça 12:00"). Without `upcoming`, open votes only. An empty list means
nothing is coming up, so hide the block or say "Sem votações esta semana".

```json
{ "items": [
  { "id": 4123, "type": "Projeto de Lei", "number": "512", "title": "…",
    "plain": { "title": "…", "typeLabel": "Lei", "typeExplainer": "…" },
    "topics": [{ "slug": "habitacao", "label": "Habitação" }],
    "phase": "Discussão generalidade", "phaseDate": "2026-11-12",
    "state": "open", "opensAt": "2026-11-13T15:00:00.000Z", "closesAt": "2026-11-20T15:00:00.000Z",
    "count": 1842, "threadId": 88, "myPick": null, "split": null }
] }
```

- **`state`:** `open`, or `upcoming` (only with `upcoming=true`).
- **`opensAt` → `closesAt`:** the agenda bar ("entrou na agenda segunda → fecha quando a sessão começa"). Picks open exactly at `opensAt`.
- **`count`:** how many readers picked so far ("1 842 previsões até agora"). It's the number only, with no split, so it can't steer anyone. 0 while upcoming.
- **`split`** (`{pass, fail}`) is **null until this reader has picked**, so the crowd can't steer them. Show it after they pick.
- **`threadId`:** the vote's megathread, created when picks open (null while upcoming). Link it from the card ("Defende a tua escolha").
- **`plain` and `topics`:** the same plain-language reading as `GET /initiatives` (by fixed rules, no AI). Use `plain.title` when it isn't null, plus the type explainer. There's no longer summary: for "Ler a proposta em linguagem simples →", link to the initiative page.
- `id` is the initiative (`GET /initiatives/:id`).
- Anonymous readers see the list, so show "Entra para prever".

### `GET /predictions/:initiativeId`: the initiative page's box

The vote of one initiative, in any state, kept forever as history. 404 when the initiative never
had a vote open and none is on the agenda: then show no box.

```json
{ "id": 4123, "title": "…", "plain": { … }, "topics": [ … ], "count": 49, "state": "decided",
  "opensAt": "2026-11-13T15:00:00.000Z", "closesAt": "2026-11-20T15:00:00.000Z", "threadId": 88,
  "myPick": "pass", "split": { "pass": 31, "fail": 18 },
  "voteDate": "2026-11-20", "voteResult": "Rejeitado", "outcome": "miss" }
```

| `state` | When | Box |
|---|---|---|
| `upcoming` | On a plenary agenda more than 7 days out | "Previsões abrem a *opensAt*" (no split, no thread yet) |
| `open` | Within the week, until `closesAt` | The card to pick, with a countdown |
| `closed` | The session started; the result comes with the 04:00 sync | "As previsões fecharam", plus how readers picked |
| `decided` | Settled | The result, how readers picked, the reader's hit or miss, and "Ver a discussão da votação →" |

- **`opensAt`:** when picks open(ed), in every state. **`count`:** how many picked (0 while upcoming).
- **`split`:** while `open`, only once this reader has picked (the same rule as the open list). From `closed` on, for everyone, anonymous readers included.
- **`myPick` and `outcome`:** the logged-in reader's own. Both are null when anonymous.
- **`voteResult`:** null for a `decided` vote settled without a vote (withdrawn, not admitted). Say it was decided without a vote.
- **Postponed:** a postponed vote goes back to `open` with the new `closesAt`, and earlier picks still count.
- **One vote per initiative:** once its vote has happened, an initiative stays `decided`. If the same initiative comes back for another vote (e.g. the final vote after the one na generalidade), it isn't reopened.

### `PUT /predictions/:initiativeId`

`{ "pick": "pass" | "fail" }` → `{ "pick": "pass", "split": { "pass": 12, "fail": 7 } }`.

- **Changing it:** the reader can change it until `closesAt`.
- **Follows the megathread:** picking follows it, so the debate comes to the reader's inbox.
- **Errors:** 401 `login_required`; 404 unknown; 409 `closed` when it isn't open (not on the agenda yet, the session already started, or decided).
- `DELETE /predictions/:initiativeId` takes a pending prediction back.

### The megathread (board `votacoes`, "Votações")

- **Created automatically** when a vote opens: one thread per vote, pinned, opened by "Politicando" (`posterId` `redacao`), linked to the initiative (`link.initiative`).
- **Readers reply, they don't open threads:** `POST /forums/votacoes/threads` returns 403 `board_closed`.
- **Every reply shows its author's side:** in `GET /forums/threads/:id`, each post has `pick`: `"pass"`, `"fail"`, or null for no pick. Show it as a badge ("Passa" / "Chumba") next to the name, like a poll comment.
- **After the vote:** the thread stays open for the aftermath and is unpinned two days later.
- **Ordering:** like any thread, oldest reply first. Nobody's side gets buried by votes.

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
- **`topics`** on each item (`[{slug, label}]`, possibly empty): group by topic for "Acertas mais em habitação (4 de 4) do que em economia (1 de 3)". An initiative can have several topics.

**Question wording:** "Passa na votação?" The vote is often the one na generalidade, not the final one.

## The daily block ("Hoje")

There's no single endpoint. Call these in parallel; each one is cacheable on its own:
- `GET /today`: "Hoje em 5" stories
- `GET /podcast/latest`: today's episode
- `GET /predictions/open?limit=3`: this week's "Passa ou chumba?" (anonymous, so it's cacheable; may be empty)
- `GET /agenda?limit=5`: what's on today

For the reader's own bits, use `GET /me/notifications/unread`.

## Ordering: activity, not popularity

Discussion is never sorted by likes by default, so likes can't bury anyone.
- **Comments:** oldest first, always.
- **Forum threads:** `sort=active` by default (last reply first, 4chan-style bumping). `sort=top` is an option the reader picks, never the default.
