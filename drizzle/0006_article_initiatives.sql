CREATE TABLE "article_initiatives" (
	"article_id" integer NOT NULL,
	"initiative_id" integer NOT NULL,
	"score" real,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "article_initiatives_article_id_initiative_id_pk" PRIMARY KEY("article_id","initiative_id")
);
--> statement-breakpoint
ALTER TABLE "article_initiatives" ADD CONSTRAINT "article_initiatives_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_initiatives" ADD CONSTRAINT "article_initiatives_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_initiatives_initiative_idx" ON "article_initiatives" USING btree ("initiative_id");