# Newsletter API (for the frontend)

Double opt-in: signing up sends an email with a confirmation link, and nothing else is sent
until it's clicked. We store only the address, when it signed up and whether it confirmed.
Unconfirmed addresses are deleted after 7 days; unsubscribing deletes the address.

Base path: `/api/v2`.

## POST /newsletter/subscribe

```json
{ "email": "ana@example.pt", "recaptchaToken": "…" }
```

reCAPTCHA works the same as for comments (same site key and widget).

| status | body | meaning |
| --- | --- | --- |
| 202 | `{ "status": "pending" }` | Done. Show "Enviámos-te um email: confirma a inscrição na ligação que lá está." |
| 400 | `code: "invalid_email"` | Not a valid address |
| 400 | `code: "invalid_request"` | Missing fields |
| 403 | `code: "recaptcha_failed"` | reCAPTCHA failed; reset the widget |
| 429 | `code: "rate_limited"` | Too many attempts; try again in a minute |
| 503 | `code: "recaptcha_unavailable"`, `"mail_unavailable"` or `"newsletter_unavailable"` | Temporary; try later (`newsletter_unavailable`: not switched on in this environment) |

**Already subscribed: a silent 202.** The answer is always the same, so the form can't be used
to find out who is subscribed. An already-confirmed address gets no new email. A pending one
gets the confirmation email again, at most once every 10 minutes. So the 202 message should
say "if this address isn't subscribed yet, you'll get an email", or just "check your email".

## The links: pages with a button

Mail security scanners (Outlook, corporate filters) open every link in an email. So the links
open pages on the website, and **nothing happens until the reader presses the button**. Never
call these endpoints on page load.

| page | shows | the button calls |
| --- | --- | --- |
| `/newsletter/confirmar?token=…` | "Confirma a tua inscrição na newsletter" + **Confirmar** | `POST /newsletter/confirm` `{ "token": "…" }` |
| `/newsletter/cancelar?token=…` | "Queres deixar de receber a newsletter?" + **Cancelar inscrição** | `POST /newsletter/unsubscribe` `{ "token": "…" }` |

- `POST /newsletter/confirm`: 200 `{ "status": "confirmed" }` ("Inscrição confirmada. Obrigado!");
  400 `invalid_token` when the link is broken, expired (7 days) or the address was removed since
  ("Esta ligação já não é válida", with the sign-up form).
- `POST /newsletter/unsubscribe`: 200 `{ "status": "unsubscribed" }` ("Cancelaste a inscrição. Não
  vais receber mais emails."); 400 `invalid_token`.
- Links in emails sent before this change point at `GET /newsletter/confirm` and
  `GET /newsletter/unsubscribe`: those now redirect to the pages above, without acting.
- Keep the `/newsletter?estado=…` page working for a while (very old links landed there).

Every email also carries the `List-Unsubscribe` headers, so Gmail and others show their own
"unsubscribe" button. That one is made for one click and posts to
`POST /newsletter/unsubscribe?token=…` directly; the frontend never calls it.

**From an account:** registering with an email and the newsletter box ticked, or
`PUT /me/email` with `newsletter: true`, subscribes that address, confirmed together with the
account's email by one email (see `docs/accounts-api.md`).

## Not built yet

Sending the newsletter issues themselves (writing them, choosing when). For now the backend
collects confirmed sign-ups and handles unsubscribing.
