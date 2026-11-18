ALTER TABLE "vote_rounds" ADD COLUMN "opens_at" timestamp with time zone DEFAULT now() NOT NULL;;--> statement-breakpoint
UPDATE "vote_rounds" SET "opens_at" = "opened_at";