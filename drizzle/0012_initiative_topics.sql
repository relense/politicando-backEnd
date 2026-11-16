ALTER TABLE "initiatives" ADD COLUMN "topics" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "initiatives_topics_idx" ON "initiatives" USING gin ("topics");