import { and, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { feedbackMessages } from "../db/schema.js";

/** Screenshots sent with feedback are kept 90 days (as the privacy page says). */
export const SCREENSHOT_DAYS = 90;

/** Removes screenshots past their 90 days. Runs on every new message, every admin read and every hourly ingest. */
export const purgeFeedback = (db: Db, now = new Date()) =>
  db
    .update(feedbackMessages)
    .set({ screenshot: null, screenshotType: null })
    .where(and(isNotNull(feedbackMessages.screenshot), lt(feedbackMessages.createdAt, new Date(now.getTime() - SCREENSHOT_DAYS * 86_400_000))));
