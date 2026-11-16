CREATE TABLE "article_presidents" (
	"article_id" integer NOT NULL,
	"president_id" text NOT NULL,
	"mention_count" integer NOT NULL,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "article_presidents_article_id_president_id_pk" PRIMARY KEY("article_id","president_id")
);
--> statement-breakpoint
CREATE TABLE "presidents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"term_start" date NOT NULL,
	"term_end" date,
	"bio" text[] DEFAULT '{}' NOT NULL,
	"photo_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "presidency" jsonb;--> statement-breakpoint
ALTER TABLE "article_presidents" ADD CONSTRAINT "article_presidents_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_presidents" ADD CONSTRAINT "article_presidents_president_id_presidents_id_fk" FOREIGN KEY ("president_id") REFERENCES "public"."presidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_presidents_president_idx" ON "article_presidents" USING btree ("president_id");