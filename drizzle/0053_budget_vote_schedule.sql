CREATE TABLE "budget_schedule" (
	"year" smallint NOT NULL,
	"number" text NOT NULL,
	"voting_day" date NOT NULL,
	"venue" text NOT NULL,
	"position" integer NOT NULL,
	"document_url" text NOT NULL,
	CONSTRAINT "budget_schedule_year_number_voting_day_venue_pk" PRIMARY KEY("year","number","voting_day","venue")
);
--> statement-breakpoint
CREATE TABLE "budget_schedule_documents" (
	"url" text PRIMARY KEY NOT NULL,
	"year" smallint NOT NULL,
	"title" text NOT NULL,
	"voting_day" date NOT NULL,
	"venue" text NOT NULL,
	"numbers" text[] DEFAULT '{}' NOT NULL,
	"read_at" timestamp with time zone,
	"error" text,
	"tried_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "budget_schedule_day_idx" ON "budget_schedule" USING btree ("year","voting_day");