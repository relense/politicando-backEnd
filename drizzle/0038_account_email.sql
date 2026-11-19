ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_reminded_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_confirmed_email_idx" ON "users" USING btree ("email") WHERE "users"."email_confirmed_at" is not null;