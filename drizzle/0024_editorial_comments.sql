ALTER TABLE "comments" ALTER COLUMN "article_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "editorial_post_id" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_editorial_post_id_editorial_posts_id_fk" FOREIGN KEY ("editorial_post_id") REFERENCES "public"."editorial_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_editorial_idx" ON "comments" USING btree ("editorial_post_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_one_target" CHECK (num_nonnulls("comments"."article_id", "comments"."editorial_post_id") = 1);