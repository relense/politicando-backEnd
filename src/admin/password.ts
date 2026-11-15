import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/*
 * Password hashing with scrypt from Node's standard library (no native dependency).
 * Stored as "scrypt$N$r$p$<salt>$<hash>", base64url, so parameters can be raised later
 * without invalidating old hashes.
 */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

const scrypt = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: 128 * n * r * 2 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
};

export const verifyPassword = async (password: string, stored: string) => {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
};

/** Verifying against this when the email is unknown keeps response times the same. */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
