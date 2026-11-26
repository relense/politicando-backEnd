ALTER TABLE "users" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_from" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
-- Until a request records it, the last login is the best guess.
UPDATE "users" SET "last_seen_at" = "last_login_at";
