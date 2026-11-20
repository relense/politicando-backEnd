ALTER TABLE "users" ADD COLUMN "newsletter_wanted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Readers who asked for the newsletter before this (a pending row for their still-unconfirmed email).
UPDATE "users" u SET "newsletter_wanted" = true
WHERE u."email" IS NOT NULL AND u."email_confirmed_at" IS NULL
  AND EXISTS (SELECT 1 FROM "newsletter_subscribers" n WHERE n."email" = u."email" AND n."confirmed_at" IS NULL);
