CREATE TABLE "article_parties" (
	"article_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"mention_count" integer NOT NULL,
	CONSTRAINT "article_parties_article_id_party_id_pk" PRIMARY KEY("article_id","party_id")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source_uri" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"image_url" text,
	"published_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_source_uri_unique" UNIQUE("source_uri")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"article_id" integer NOT NULL,
	"parent_id" integer,
	"username" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "parties_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"acronym" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"assembly_seats" smallint DEFAULT 0 NOT NULL,
	"seats_as_of" date,
	CONSTRAINT "parties_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "seen_source_uris" (
	"source_uri" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_parties" ADD CONSTRAINT "article_parties_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_parties" ADD CONSTRAINT "article_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_parties_party_idx" ON "article_parties" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "articles_feed_idx" ON "articles" USING btree ("published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_article_idx" ON "comments" USING btree ("article_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");