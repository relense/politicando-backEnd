CREATE TABLE "budget_summaries" (
	"proposal_id" integer PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"automatic" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
