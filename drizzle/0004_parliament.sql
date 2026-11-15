CREATE TABLE "article_deputies" (
	"article_id" integer NOT NULL,
	"deputy_id" integer NOT NULL,
	"mention_count" integer NOT NULL,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "article_deputies_article_id_deputy_id_pk" PRIMARY KEY("article_id","deputy_id")
);
--> statement-breakpoint
CREATE TABLE "deputies" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"parliamentary_group" text,
	"party_id" integer,
	"constituency" text NOT NULL,
	"situation" text NOT NULL,
	"active" boolean NOT NULL,
	"seat" smallint,
	"parliament_role" text,
	"gender" text,
	"birth_date" date,
	"profession" text,
	"education" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"committees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"past_legislatures" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "initiative_deputies" (
	"initiative_id" integer NOT NULL,
	"deputy_id" integer NOT NULL,
	CONSTRAINT "initiative_deputies_initiative_id_deputy_id_pk" PRIMARY KEY("initiative_id","deputy_id")
);
--> statement-breakpoint
CREATE TABLE "initiative_parties" (
	"initiative_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	CONSTRAINT "initiative_parties_initiative_id_party_id_pk" PRIMARY KEY("initiative_id","party_id")
);
--> statement-breakpoint
CREATE TABLE "initiatives" (
	"id" integer PRIMARY KEY NOT NULL,
	"legislature" text NOT NULL,
	"type" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"phase" text NOT NULL,
	"phase_date" date NOT NULL,
	"submitted_at" date,
	"published_at" date,
	"other_author" text,
	"text_url" text,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_deputies" ADD CONSTRAINT "article_deputies_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_deputies" ADD CONSTRAINT "article_deputies_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deputies" ADD CONSTRAINT "deputies_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_deputies" ADD CONSTRAINT "initiative_deputies_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_deputies" ADD CONSTRAINT "initiative_deputies_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_parties" ADD CONSTRAINT "initiative_parties_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_parties" ADD CONSTRAINT "initiative_parties_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_deputies_deputy_idx" ON "article_deputies" USING btree ("deputy_id");--> statement-breakpoint
CREATE INDEX "deputies_party_idx" ON "deputies" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "initiative_deputies_deputy_idx" ON "initiative_deputies" USING btree ("deputy_id");--> statement-breakpoint
CREATE INDEX "initiative_parties_party_idx" ON "initiative_parties" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "initiatives_feed_idx" ON "initiatives" USING btree ("phase_date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "initiatives_status_idx" ON "initiatives" USING btree ("status");