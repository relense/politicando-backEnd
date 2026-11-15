import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { adminSessions, admins, auditLog } from "../db/schema.js";
import { ApiError } from "../errors.js";

export const SESSION_COOKIE = "politicando_admin";
export const SESSION_DAYS = 14;

export type Role = "author" | "moderator" | "admin";
const RANK: Record<Role, number> = { author: 1, moderator: 2, admin: 3 };
export const hasRole = (role: Role, needed: Role) => RANK[role] >= RANK[needed];

export interface Admin {
  id: number;
  email: string;
  name: string;
  role: Role;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

export const createSession = async (db: Db, adminId: number) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  await db.insert(adminSessions).values({ tokenHash: hashToken(token), adminId, expiresAt });
  return { token, expiresAt };
};

export const sessionAdmin = async (db: Db, token: string): Promise<Admin | null> => {
  const [row] = await db
    .select({ id: admins.id, email: admins.email, name: admins.name, role: admins.role })
    .from(adminSessions)
    .innerJoin(admins, eq(admins.id, adminSessions.adminId))
    .where(and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, new Date()), isNull(admins.disabledAt)));
  return row ?? null;
};

export const endSession = (db: Db, token: string) => db.delete(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token)));

export const endAllSessions = (db: Db, adminId: number) => db.delete(adminSessions).where(eq(adminSessions.adminId, adminId));

export const audit = (
  db: Db,
  adminId: number | null,
  action: string,
  entity: string,
  entityId: string | number,
  before: unknown = null,
  after: unknown = null,
) => db.insert(auditLog).values({ adminId, action, entity, entityId: String(entityId), before, after });

/** Returns a check for protected handlers: the signed-in admin with at least `role`, or a 401/403. */
export const adminGuard =
  (db: Db) =>
  async (request: FastifyRequest, role: Role = "author"): Promise<Admin> => {
    const token = request.cookies[SESSION_COOKIE];
    const admin = token ? await sessionAdmin(db, token) : null;
    if (!admin) throw new ApiError(401, "unauthenticated", "Sign in first");
    if (!hasRole(admin.role, role)) throw new ApiError(403, "forbidden", "Your role can't do this");
    return admin;
  };
