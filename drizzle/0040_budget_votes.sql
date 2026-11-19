CREATE TABLE "budget_proposals" (
	"id" integer PRIMARY KEY NOT NULL,
	"year" smallint NOT NULL,
	"number" text NOT NULL,
	"submitted_on" date,
	"title" text NOT NULL,
	"article" text,
	"topics" text[] DEFAULT '{}'::text[] NOT NULL,
	"target" text,
	"kind" text,
	"status" text NOT NULL,
	"result" text NOT NULL,
	"result_phase" text,
	"unanimous" boolean DEFAULT false NOT NULL,
	"author_label" text,
	"author_parties" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_deputies" text[] DEFAULT '{}'::text[] NOT NULL,
	"document_url" text,
	"last_voted_on" date,
	"search_text" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_sources" (
	"year" smallint PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_votes" (
	"proposal_id" integer NOT NULL,
	"seq" smallint NOT NULL,
	"voted_on" date NOT NULL,
	"phase" text,
	"result" text,
	"unanimous" boolean DEFAULT false NOT NULL,
	"label" text,
	"part_label" text,
	"parts" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text,
	"votes" jsonb NOT NULL,
	"ambiguity" text,
	CONSTRAINT "budget_votes_proposal_id_seq_pk" PRIMARY KEY("proposal_id","seq")
);
--> statement-breakpoint
ALTER TABLE "budget_votes" ADD CONSTRAINT "budget_votes_proposal_id_budget_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."budget_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_proposals_year_idx" ON "budget_proposals" USING btree ("year","last_voted_on");--> statement-breakpoint
CREATE INDEX "budget_votes_day_idx" ON "budget_votes" USING btree ("voted_on");