import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { Reader } from "./sessions.js";

/*
 * Who is taking part. Logged-in readers are keyed by their account ("u:<id>"), so a vote counts
 * once per person whatever their IP; anonymous readers by their IP, as before accounts. Which
 * kinds of taking part need an account is a setting (LOGIN_REQUIRED).
 */

export const PARTICIPATION = ["comments", "forum", "votes", "reports"] as const;
export type Participation = (typeof PARTICIPATION)[number];

export interface Participant {
  /** What the anonymous keys hash (src/forums/identity.ts): the account, or the IP. */
  key: string;
  userId: number | null;
  username: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The logged-in reader, from the session cookie; null when anonymous. */
    reader: Reader | null;
  }
  interface FastifyInstance {
    /** The reader taking part in `what`, or a 401 when that needs an account and there's none. */
    participant: (request: FastifyRequest, what: Participation) => Participant;
  }
}

export const participantFor =
  (loginRequired: readonly Participation[]) =>
  (request: FastifyRequest, what: Participation): Participant => {
    const reader = request.reader;
    if (reader) return { key: `u:${reader.id}`, userId: reader.id, username: reader.username };
    if (loginRequired.includes(what)) throw new ApiError(401, "login_required", "Log in to take part");
    return { key: request.ip, userId: null, username: null };
  };

/** Rate limits count per account when logged in, per IP otherwise. */
export const limitKey = (request: FastifyRequest) => (request.reader ? `u:${request.reader.id}` : request.ip);
