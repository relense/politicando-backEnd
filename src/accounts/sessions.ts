import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
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

/** Why the account can't take part right now: banned, or suspended until a date. */
export type Restriction = { code: "account_banned" } | { code: "account_suspended"; until: Date };

export interface Reader {
  id: number;
  username: string;
  /** Set while banned or suspended: still logged in (to read, export or delete), but can't take part. */
  restriction?: Restriction | null;
}

export const restrictionOf = (user: { disabledAt: Date | null; suspendedUntil: Date | null }, now = new Date()): Restriction | null =>
  user.disabledAt ? { code: "account_banned" } : user.suspendedUntil && user.suspendedUntil > now ? { code: "account_suspended", until: user.suspendedUntil } : null;

/** How often a reader's last-seen time is written: at most once an hour per account. */
const SEEN_EVERY_MS = 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

export const readerCookieOptions = (secure: boolean) => ({ path: "/api/v2", httpOnly: true, sameSite: "lax" as const, secure });

export const createReaderSession = async (db: Db, userId: number) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
  await db.insert(userSessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
};

/**
 * The session's reader, or null (unknown or expired). A banned or suspended account keeps its
 * session, flagged (`restriction`), so taking part answers 403 with why. Returns a new expiry
 * when it was extended.
 */
export const sessionReader = async (db: Db, token: string): Promise<{ reader: Reader; renewedUntil: Date | null } | null> => {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({
      id: users.id, username: users.username, expiresAt: userSessions.expiresAt,
      disabledAt: users.disabledAt, suspendedUntil: users.suspendedUntil, lastSeenAt: users.lastSeenAt,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, new Date())));
  if (!row) return null;
  if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    await db.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.id, row.id));
  }
  let renewedUntil: Date | null = null;
  if (row.expiresAt.getTime() - Date.now() < RENEW_BELOW_DAYS * DAY) {
    renewedUntil = new Date(Date.now() + SESSION_DAYS * DAY);
    await db.update(userSessions).set({ expiresAt: renewedUntil }).where(eq(userSessions.tokenHash, tokenHash));
  }
  return { reader: { id: row.id, username: row.username, restriction: restrictionOf(row) }, renewedUntil };
};

export const endReaderSession = (db: Db, token: string) => db.delete(userSessions).where(eq(userSessions.tokenHash, hashToken(token)));

/** Every session of the account, or every one but the current token's. */
export const endReaderSessions = (db: Db, userId: number, except?: string) =>
  db
    .delete(userSessions)
    .where(and(eq(userSessions.userId, userId), except ? ne(userSessions.tokenHash, hashToken(except)) : undefined));
