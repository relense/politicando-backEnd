CREATE TABLE "past_initiatives" (
	"id" integer PRIMARY KEY NOT NULL,
	"legislature" text NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"submitted_at" date,
	"published_at" date,
	"author_groups" text[] NOT NULL,
	"party_slugs" text[] NOT NULL,
	"other_author" text,
	"text_url" text
);
--> statement-breakpoint
CREATE INDEX "past_initiatives_legislature_idx" ON "past_initiatives" USING btree ("legislature");