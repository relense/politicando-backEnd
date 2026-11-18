CREATE TABLE "article_local_officials" (
	"article_id" integer NOT NULL,
	"official_id" text NOT NULL,
	"mention_count" integer NOT NULL,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "article_local_officials_article_id_official_id_pk" PRIMARY KEY("article_id","official_id")
);
--> statement-breakpoint
CREATE TABLE "local_officials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"place_key" text NOT NULL,
	"election_id" text NOT NULL,
	"list" text NOT NULL,
	"term_start" date NOT NULL,
	"term_end" date,
	"current" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deputies" ADD COLUMN "wikidata_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "government_members" ADD COLUMN "wikidata_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "article_local_officials" ADD CONSTRAINT "article_local_officials_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_local_officials" ADD CONSTRAINT "article_local_officials_official_id_local_officials_id_fk" FOREIGN KEY ("official_id") REFERENCES "public"."local_officials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_officials" ADD CONSTRAINT "local_officials_place_key_places_key_fk" FOREIGN KEY ("place_key") REFERENCES "public"."places"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_officials" ADD CONSTRAINT "local_officials_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_local_officials_official_idx" ON "article_local_officials" USING btree ("official_id");--> statement-breakpoint
CREATE INDEX "local_officials_place_idx" ON "local_officials" USING btree ("place_key");