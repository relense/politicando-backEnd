CREATE TABLE "budget_after_vote" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "budget_after_vote_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"year" smallint NOT NULL,
	"date" date NOT NULL,
	"text" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL,
	"proposal_ids" integer[] DEFAULT '{}'::integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_implementations" (
	"proposal_id" integer PRIMARY KEY NOT NULL,
	"year" smallint NOT NULL,
	"status" text NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "budget_after_vote_year_idx" ON "budget_after_vote" USING btree ("year");