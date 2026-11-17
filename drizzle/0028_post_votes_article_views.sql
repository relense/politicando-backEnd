CREATE TABLE "article_views" (
	"article_id" integer NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "article_views_article_id_day_pk" PRIMARY KEY("article_id","day")
);
--> statement-breakpoint
CREATE TABLE "editorial_votes" (
	"post_id" integer NOT NULL,
	"voter" text NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_votes_post_id_voter_pk" PRIMARY KEY("post_id","voter"),
	CONSTRAINT "editorial_votes_value_check" CHECK ("editorial_votes"."value" in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "editorial_posts" ADD COLUMN "upvotes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "editorial_posts" ADD COLUMN "downvotes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_views" ADD CONSTRAINT "article_views_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_votes" ADD CONSTRAINT "editorial_votes_post_id_editorial_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."editorial_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_views_day_idx" ON "article_views" USING btree ("day");