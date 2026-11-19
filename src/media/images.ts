import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { media } from "../db/schema.js";

/** PNG or JPEG by its first bytes, whatever the sender claimed. */
export const imageType = (bytes: Buffer): "image/png" | "image/jpeg" | null => {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
};

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const EXTENSION = { "image/png": "png", "image/jpeg": "jpg" } as const;
/** "<sha256>.png": what /media serves. */
export const MEDIA_FILE = /^([0-9a-f]{64})\.(png|jpg)$/;

/** Stores an image once per content and returns its file name ("<sha256>.<ext>"). */
export const storeImage = async (db: Db, bytes: Buffer, contentType: "image/png" | "image/jpeg") => {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const [stored] = await db
    .insert(media)
    .values({ hash, contentType, bytes, size: bytes.length })
    .onConflictDoNothing()
    .returning({ hash: media.hash });
  return { file: `${hash}.${EXTENSION[contentType]}`, created: stored !== undefined };
};

export const loadImage = async (db: Db, file: string) => {
  const match = MEDIA_FILE.exec(file);
  if (!match) return null;
  const [row] = await db.select({ contentType: media.contentType, bytes: media.bytes }).from(media).where(eq(media.hash, match[1]!));
  // The extension must match what was stored: one URL per image.
  return row && EXTENSION[row.contentType as keyof typeof EXTENSION] === match[2] ? row : null;
};
