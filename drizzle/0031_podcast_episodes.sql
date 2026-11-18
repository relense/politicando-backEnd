CREATE TABLE "podcast_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "podcast_episodes_published_idx" ON "podcast_episodes" USING btree ("published_at" DESC NULLS LAST);