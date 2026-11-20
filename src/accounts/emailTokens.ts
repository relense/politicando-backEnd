import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
 * Signed links for account emails, so nothing extra needs storing: base64url(JSON) + "." + an
 * HMAC of it, keyed apart from the newsletter's tokens. A confirmation link is for one account
 * and one address; a reset link works once, because it carries a fingerprint of the password it
 * replaces, and only for an hour.
 */

export const VERIFY_TTL_HOURS = 7 * 24;
export const RESET_TTL_HOURS = 1;

/** `n`: whether the link was sent mentioning the newsletter (informational; the account's stored choice decides). */
type Payload = { p: "verify"; u: number; e: string; t: number; n?: boolean } | { p: "reset"; u: number; h: string; t: number };

const key = (secret: string) => createHmac("sha256", secret).update("account-email").digest();
const sign = (secret: string, data: string) => createHmac("sha256", key(secret)).update(data).digest("base64url");
const seconds = (now: number) => Math.floor(now / 1000);

/** A short fingerprint of the password hash: changing the password makes old reset links fail. */
export const passwordFingerprint = (passwordHash: string) => createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);

const encode = (secret: string, payload: Payload) => {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(secret, data)}`;
};

const decode = (secret: string, token: string, now: number): Payload | null => {
  const [data, signature, extra] = token.split(".");
  if (!data || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, data));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as Payload;
    if (typeof payload.u !== "number" || typeof payload.t !== "number") return null;
    const ttl = (payload.p === "verify" ? VERIFY_TTL_HOURS : RESET_TTL_HOURS) * 3_600;
    return seconds(now) - payload.t <= ttl ? payload : null;
  } catch {
    return null;
  }
};

export const verifyToken = (secret: string, userId: number, email: string, now = Date.now(), newsletter?: boolean) =>
  encode(secret, { p: "verify", u: userId, e: email, t: seconds(now), ...(newsletter !== undefined && { n: newsletter }) });

export const readVerifyToken = (secret: string, token: string, now = Date.now()) => {
  const payload = decode(secret, token, now);
  return payload?.p === "verify" && typeof payload.e === "string"
    ? { userId: payload.u, email: payload.e, newsletter: typeof payload.n === "boolean" ? payload.n : null }
    : null;
};

export const resetToken = (secret: string, userId: number, passwordHash: string, now = Date.now()) =>
  encode(secret, { p: "reset", u: userId, h: passwordFingerprint(passwordHash), t: seconds(now) });

export const readResetToken = (secret: string, token: string, now = Date.now()) => {
  const payload = decode(secret, token, now);
  return payload?.p === "reset" && typeof payload.h === "string" ? { userId: payload.u, fingerprint: payload.h } : null;
};
