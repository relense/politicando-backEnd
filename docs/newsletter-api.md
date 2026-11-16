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

## Where the links land

The links in the emails point to the API, which does the work and then redirects (302) to the
website:

| link | redirects to |
| --- | --- |
| `GET /newsletter/confirm?token=…` | `<site>/newsletter?estado=confirmado`, or `?estado=invalido` if the link is broken, expired (7 days) or the address has since been removed |
| `GET /newsletter/unsubscribe?token=…` | `<site>/newsletter?estado=cancelado`, or `?estado=invalido` if the link is broken |

`<site>` is the backend's `SITE_URL` (production: the real site address). So the frontend needs
a `/newsletter` page that reads `estado`:

- `confirmado`: "Inscrição confirmada. Obrigado!"
- `cancelado`: "Cancelaste a inscrição. Não vais receber mais emails."
- `invalido`: "Esta ligação já não é válida." Offer the sign-up form again.
- no `estado`: the sign-up form itself.

Every email carries an unsubscribe link, plus the `List-Unsubscribe` headers so Gmail and others
show their own "unsubscribe" button (that one posts to `POST /newsletter/unsubscribe`; the
frontend never calls it).

## Not built yet

Sending the newsletter issues themselves (writing them, choosing when). For now the backend
collects confirmed sign-ups and handles unsubscribing.
