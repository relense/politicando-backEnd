import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userSessions, users } from "../db/schema.js";

/*
 * Reader sessions, like the admin's (src/admin/sessions.ts): a random token in an httpOnly
 * cookie, only its SHA-256 stored. Scoped to the whole API, since taking part happens on many
 * routes; SameSite=Lax, and the website forwards it through its own server.
 */

export const READER_COOKIE = "politicando_session";
const SESSION_DAYS = 30;
/** A session used with less than this left is extended to a full SESSION_DAYS again. */
const RENEW_BELOW_DAYS = 15;
const DAY = 24 * 60 * 60 * 1000;

export interface Reader {
  id: number;
  username: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

export const readerCookieOptions = (secure: boolean) => ({ path: "/api/v2", httpOnly: true, sameSite: "lax" as const, secure });

export const createReaderSession = async (db: Db, userId: number) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
  await db.insert(userSessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
};

/** The session's reader, or null (unknown, expired, or a disabled account). Returns a new expiry when it was extended. */
export const sessionReader = async (db: Db, token: string): Promise<{ reader: Reader; renewedUntil: Date | null } | null> => {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ id: users.id, username: users.username, expiresAt: userSessions.expiresAt })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, new Date()), isNull(users.disabledAt)));
  if (!row) return null;
  let renewedUntil: Date | null = null;
  if (row.expiresAt.getTime() - Date.now() < RENEW_BELOW_DAYS * DAY) {
    renewedUntil = new Date(Date.now() + SESSION_DAYS * DAY);
    await db.update(userSessions).set({ expiresAt: renewedUntil }).where(eq(userSessions.tokenHash, tokenHash));
  }
  return { reader: { id: row.id, username: row.username }, renewedUntil };
};

export const endReaderSession = (db: Db, token: string) => db.delete(userSessions).where(eq(userSessions.tokenHash, hashToken(token)));

/** Every session of the account, or every one but the current token's. */
export const endReaderSessions = (db: Db, userId: number, except?: string) =>
  db
    .delete(userSessions)
    .where(and(eq(userSessions.userId, userId), except ? ne(userSessions.tokenHash, hashToken(except)) : undefined));
