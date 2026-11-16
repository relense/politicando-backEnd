# Feedback API (for the frontend)

The feedback form, the public corrections log ("Correções") and the admin to handle
messages. Base path: `/api/v2`. Errors use the usual `{ error: { code, message } }`.

Ideas aren't here: they live on the forum's `ideias` board, with votes and the team's status
(see `docs/forums-api.md`). The old `POST /ideas/:id/vote` from the first contract doesn't
exist; use `POST /forums/threads/:id/vote`.

## POST /feedback (multipart/form-data)

| Field | | |
|---|---|---|
| `kind` | required | `error`, `idea`, `broken` or `other` |
| `message` | required | Up to 1000 characters |
| `page` | | The section the reader chose, e.g. "Percursos" (up to 100) |
| `url` | | The page they were on (up to 1000) |
| `correction` | | What's right (up to 1000) |
| `source` | | Where it can be confirmed (up to 1000) |
| `email` | | Only when they want an answer |
| `screenshot` | file | PNG or JPG, up to 5 MB. Checked by its content, not its name or type |
| `recaptchaToken` | required | reCAPTCHA v2 |

Empty fields count as not sent. Returns 201 `{ "id": 12 }`.

| Status | `code` | When |
|---|---|---|
| 400 | `validation_failed` | A field is missing or too long, the email isn't one, or the body isn't multipart. `message` names the field |
| 403 | `captcha_failed` | reCAPTCHA said no |
| 413 | `file_too_large` | Screenshot over 5 MB |
| 415 | `unsupported_file` | Screenshot isn't a PNG or JPG |
| 429 | `rate_limited` | More than 10 messages an hour from one IP |
| 503 | `captcha_unavailable` | Google couldn't be reached |

Note that the forum and comments use `recaptcha_failed`; this form uses `captcha_failed`, as
the page expects.

Privacy, as the privacy page says:
- The email is used only to answer that message and is deleted when the message is closed.
- Screenshots are deleted after 90 days.
- The public log never says who asked.

## GET /feedback/summary

```json
{
  "stats": { "responseDays": 2, "correctionsThisMonth": 38 },
  "corrections": [ { "id": 4, "status": "fixed", "date": "2026-11-16", "area": "Percursos", "title": "…", "url": "/percursos" } ]
}
```

- `responseDays`: median days from a message to the team's first answer, over messages from
  the last 90 days. At least 1. `null` with fewer than 5 answers, so say "em breve" or hide it.
- `correctionsThisMonth`: corrections marked `fixed` with a date in this month (Lisbon).
- `corrections`: the latest 4, as in the log.
- No `ideas` any more: take the top five from `GET /forums/ideias/threads?sort=top&limit=5`.

## GET /corrections?cursor=&limit=

Newest first (by `date`, then `id`). `limit` 1-50, default 20.

```json
{ "items": [{ "id": 4, "status": "fixed", "date": "2026-11-16", "area": "Percursos", "title": "Partido de um deputado corrigido", "url": "/percursos" }], "nextCursor": null }
```

- `status`: `fixed`, `checking` or `rejected`.
- `url`: a path on this site (starts with `/`), a full link, or `null`.

## Admin (moderators)

All of these need an admin session with role moderator or above.

| Method | Path | |
|---|---|---|
| GET | `/admin/feedback?status=&kind=&limit=` | Messages, newest first. `status`: `open`, `answered`, `closed` |
| GET | `/admin/feedback/:id` | One message, with the corrections made from it |
| GET | `/admin/feedback/:id/screenshot` | The image (the `screenshot` field gives this path; null when none or past 90 days) |
| POST | `/admin/feedback/:id/answer` | `{ "reply": "…", "send": true }` emails the reply to the reader. `{ "reply": "…" or null, "send": false }` only notes that it was answered (e.g. from your own email). Sets `answeredAt` the first time, which is what `responseDays` counts |
| PUT | `/admin/feedback/:id/note` | `{ "note": "…" }`, internal |
| POST | `/admin/feedback/:id/close` | Closes it and **deletes the email** |
| POST | `/admin/feedback/:id/correction` | Turns it into a log entry: `{ status, title, url, area?, date? }`. `area` defaults to the reader's `page`, `date` to today |
| GET | `/admin/corrections` | The whole log, with `feedbackId` |
| POST | `/admin/corrections` | Add an entry: `{ status, area, title, url, date? }` |
| PUT | `/admin/corrections/:id` | Change it, e.g. from `checking` to `fixed` |
| DELETE | `/admin/corrections/:id` | Remove it |

Answer errors:
- 400 `no_email`: the reader left no email (or it was deleted on close).
- 400 `empty_reply`: `send: true` with no reply.
- 503 `mail_unavailable`: mail isn't set up on the server yet (`SMTP_URL`). Answer from your
  own email and note it with `send: false`.

Admin message fields: `id, kind, message, page, url, correction, source, email, screenshot,
status, reply, note, createdAt, answeredAt, closedAt, corrections`.
