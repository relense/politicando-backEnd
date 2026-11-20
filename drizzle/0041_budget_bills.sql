CREATE TABLE "budget_bills" (
	"initiative_id" integer PRIMARY KEY NOT NULL,
	"year" smallint NOT NULL,
	"legislature" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "budget_bills_year_idx" ON "budget_bills" USING btree ("year");