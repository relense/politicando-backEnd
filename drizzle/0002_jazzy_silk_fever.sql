ALTER TABLE "articles" ADD COLUMN "excerpt" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "articles" SET "excerpt" = left("content", 300);