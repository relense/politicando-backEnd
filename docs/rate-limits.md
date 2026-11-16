# Rate limits, and what the frontend's server must send

## The limits

Every limit counts per reader IP, per minute unless said otherwise. Past it, the API
answers 429 `{ "error": { "code": "rate_limited" } }`.

| What | Limit |
|---|---|
| Everything (reads included) | 300 a minute |
| Comments, forum threads and replies, newsletter sign-up | 5 a minute |
| Forum votes | 30 a minute |
| Reports | 10 a minute |
| Feedback form | 10 an hour |
| Admin login | 5 a minute |

Everything readers post also needs a reCAPTCHA token.

The reader's IP comes from Cloudflare's `True-Client-IP` (Render sits behind Cloudflare), which
clients can't forge. A client-sent `X-Forwarded-For` is ignored.

## The frontend's server: send the reader's IP

The frontend renders pages on its own server, so without this, every visitor reaches the API
from **the same address**. Then all readers share one allowance of 300 a minute, and busy
moments (or one scraper of the website) can make pages fail for everyone.

With a shared secret, the frontend's server tells the API whose page it's rendering, and each
reader gets their own limit:

1. Both Render services get the same `FRONTEND_API_KEY` (generated once, e.g.
   `openssl rand -hex 32`). It's **server-only**: never `NEXT_PUBLIC_`, never sent to the
   browser.
2. On requests from the frontend's **server** to the API, add the key, and the reader's IP
   **only on requests that aren't cached**:

   ```
   X-Frontend-Key: <FRONTEND_API_KEY>
   X-Reader-IP: <the reader's IP>      (uncached requests only)
   ```

   **Why not on cached ones:** Next's fetch cache keys on the request headers. A reader's IP
   on a `revalidate` fetch would give every reader their own cache entry: no more shared
   cache, and many times the load on the API. Cached fetches with only the key skip the
   general limit (they're shared renders, not one reader), and the cache stays shared.

   On Render, the reader's IP is the `true-client-ip` request header, which Cloudflare sets
   and readers can't forge. Don't use `x-forwarded-for`: readers can put anything in it.

   In `lib/api/client.ts`, `request()` is the one place to do it. Roughly:

   ```ts
   async function serverHeaders(init?: RequestInit & { next?: { revalidate?: number } }) {
     if (typeof window !== "undefined" || !process.env.FRONTEND_API_KEY) return {};
     const key = { "X-Frontend-Key": process.env.FRONTEND_API_KEY };
     const cached = init?.next?.revalidate !== undefined || init?.cache === "force-cache";
     if (cached) return key;
     const { headers } = await import("next/headers");
     const ip = (await headers()).get("true-client-ip");
     return ip ? { ...key, "X-Reader-IP": ip } : key;
   }

   // in request():
   fetch(`${BASE_URL}${path}`, { ...init, headers: { ...init?.headers, ...(await serverHeaders(init)) } });
   ```

   (`headers()` can only be read while rendering a request; outside one, e.g. at build time,
   catch the error and send just the key.)

3. The browser's own requests (comments, votes, the feedback form, when the browser calls the
   API directly) need nothing: they already reach the API with the reader's address. Never
   put the key in browser code.

Without the right key, the API ignores `X-Reader-IP`, so nobody can use it to dodge the limits.
