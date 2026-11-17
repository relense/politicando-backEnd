CREATE TABLE "article_votes" (
	"article_id" integer NOT NULL,
	"voter" text NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_votes_article_id_voter_pk" PRIMARY KEY("article_id","voter"),
	CONSTRAINT "article_votes_value_check" CHECK ("article_votes"."value" in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "upvotes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "downvotes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_votes" ADD CONSTRAINT "article_votes_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;