CREATE TABLE "article_government_members" (
	"article_id" integer NOT NULL,
	"member_id" text NOT NULL,
	"mention_count" integer NOT NULL,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	CONSTRAINT "article_government_members_article_id_member_id_pk" PRIMARY KEY("article_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "government_members" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gender" text,
	"photo_url" text,
	"bio" text[] DEFAULT '{}' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deputy_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "government_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"government" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"area" text NOT NULL,
	"area_name" text NOT NULL,
	"area_rank" smallint NOT NULL,
	"rank" smallint NOT NULL,
	"start_date" date,
	"end_date" date,
	"url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governments" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "article_government_members" ADD CONSTRAINT "article_government_members_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_government_members" ADD CONSTRAINT "article_government_members_member_id_government_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."government_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "government_members" ADD CONSTRAINT "government_members_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "government_positions" ADD CONSTRAINT "government_positions_member_id_government_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."government_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_government_members_member_idx" ON "article_government_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "government_members_deputy_idx" ON "government_members" USING btree ("deputy_id");--> statement-breakpoint
CREATE INDEX "government_positions_member_idx" ON "government_positions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "government_positions_government_idx" ON "government_positions" USING btree ("government","area_rank","rank");