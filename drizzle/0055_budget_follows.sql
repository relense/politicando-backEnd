CREATE TABLE "budget_vote_notices" (
	"proposal_id" integer NOT NULL,
	"seq" smallint NOT NULL,
	"voted_on" date NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_vote_notices_proposal_id_seq_voted_on_pk" PRIMARY KEY("proposal_id","seq","voted_on")
);
--> statement-breakpoint
DROP INDEX "notifications_unread_once_idx";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "detail" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_unread_once_idx" ON "notifications" USING btree ("user_id","kind","target_id") WHERE read_at is null and kind <> 'budget_vote';--> statement-breakpoint
-- Votes already stored are old news: only votes that come in after this are announced.
INSERT INTO "budget_vote_notices" ("proposal_id", "seq", "voted_on") SELECT "proposal_id", "seq", "voted_on" FROM "budget_votes" ON CONFLICT DO NOTHING;
