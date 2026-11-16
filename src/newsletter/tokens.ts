import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Signed links, so nothing but the address needs storing. A token is base64url(JSON) + "." +
 * an HMAC of it. Confirmation links expire; unsubscribe links work for as long as the secret is
 * the same (every email we send carries one).
 */

export const CONFIRM_TTL_DAYS = 7;

type Purpose = "confirm" | "unsubscribe";
interface Payload {
  p: Purpose;
  e: string;
  /** Issued at, in seconds (confirmation only). */
  t?: number;
}

const sign = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

export const createToken = (secret: string, purpose: Purpose, email: string, now = Date.now()) => {
  const payload: Payload = purpose === "confirm" ? { p: purpose, e: email, t: Math.floor(now / 1000) } : { p: purpose, e: email };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(secret, data)}`;
};

/** The address the token is for, or null if it's forged, for the other purpose, or expired. */
export const readToken = (secret: string, purpose: Purpose, token: string, now = Date.now()): string | null => {
  const [data, signature, extra] = token.split(".");
  if (!data || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, data));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString()) as Payload;
  } catch {
    return null;
  }
  if (payload.p !== purpose || typeof payload.e !== "string") return null;
  if (purpose === "confirm" && (typeof payload.t !== "number" || now / 1000 - payload.t > CONFIRM_TTL_DAYS * 86_400)) return null;
  return payload.e;
};
