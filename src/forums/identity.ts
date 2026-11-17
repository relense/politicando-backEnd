import { createHmac } from "node:crypto";

/*
 * Anonymous identity without accounts. A poster's ID is a keyed hash of their IP and the
 * thread: stable within a thread (so a conversation can be followed), different across
 * threads (so nobody can be tracked from thread to thread), and impossible to reverse
 * without the server secret. The IP itself is never stored.
 */

const mac = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("base64url");

export const posterId = (secret: string, ip: string, threadId: number) => mac(secret, `${ip}|thread|${threadId}`).slice(0, 8);

/** Identifies a reporter (to count one report per person) without storing their IP. */
export const reporterKey = (secret: string, ip: string) => mac(secret, `${ip}|report`).slice(0, 16);

/** Counts one upvote per reader per thread without storing their IP. */
export const voterKey = (secret: string, ip: string, threadId: number) => mac(secret, `${ip}|vote|${threadId}`).slice(0, 16);

/** Counts one vote per reader per news article without storing their IP. */
export const articleVoterKey = (secret: string, ip: string, articleId: number) =>
  mac(secret, `${ip}|article-vote|${articleId}`).slice(0, 16);

/** Counts one "Importa" per reader per story without storing their IP. */
export const storyVoterKey = (secret: string, ip: string, storyId: number) => mac(secret, `${ip}|story-vote|${storyId}`).slice(0, 16);

/** Counts one like per reader per comment without storing their IP. */
export const commentLikerKey = (secret: string, ip: string, commentId: number) =>
  mac(secret, `${ip}|comment-like|${commentId}`).slice(0, 16);

/** Counts one vote per reader per editorial post without storing their IP. */
export const postVoterKey = (secret: string, ip: string, postId: number) => mac(secret, `${ip}|post-vote|${postId}`).slice(0, 16);
