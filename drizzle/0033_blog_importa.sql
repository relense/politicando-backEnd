-- Blog posts: one "Importa" instead of up and down votes. Upvotes become Importa marks;
-- downvotes go.
ALTER TABLE "editorial_posts" ADD COLUMN "importa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DELETE FROM "editorial_votes" WHERE "value" <> 1;--> statement-breakpoint
UPDATE "editorial_posts" p SET "importa" = (SELECT count(*)::int FROM "editorial_votes" v WHERE v."post_id" = p."id");--> statement-breakpoint
ALTER TABLE "editorial_votes" DROP CONSTRAINT "editorial_votes_value_check";--> statement-breakpoint
ALTER TABLE "editorial_votes" DROP COLUMN "value";--> statement-breakpoint
ALTER TABLE "editorial_votes" DROP COLUMN "updated_at";
