CREATE TABLE "editorial_views" (
	"post_id" integer NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "editorial_views_post_id_day_pk" PRIMARY KEY("post_id","day")
);
--> statement-breakpoint
ALTER TABLE "editorial_views" ADD CONSTRAINT "editorial_views_post_id_editorial_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."editorial_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "editorial_views_day_idx" ON "editorial_views" USING btree ("day");