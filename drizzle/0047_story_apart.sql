CREATE TABLE "story_apart" (
	"low_id" integer NOT NULL,
	"high_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_apart_low_id_high_id_pk" PRIMARY KEY("low_id","high_id")
);
--> statement-breakpoint
CREATE TABLE "story_article_checks" (
	"story_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"story_size" integer NOT NULL,
	"belongs" boolean NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_article_checks_story_id_article_id_pk" PRIMARY KEY("story_id","article_id")
);
--> statement-breakpoint
ALTER TABLE "story_apart" ADD CONSTRAINT "story_apart_low_id_stories_id_fk" FOREIGN KEY ("low_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_apart" ADD CONSTRAINT "story_apart_high_id_stories_id_fk" FOREIGN KEY ("high_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_article_checks" ADD CONSTRAINT "story_article_checks_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_article_checks" ADD CONSTRAINT "story_article_checks_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Production: 701 (the Government's reaction) was split by hand off 609 (the IVA zero vote) on 2026-11-20.
INSERT INTO "story_apart" ("low_id", "high_id", "reason")
SELECT 609, 701, 'manual' WHERE (SELECT count(*) FROM "stories" WHERE "id" IN (609, 701)) = 2
ON CONFLICT DO NOTHING;
