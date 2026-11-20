CREATE TABLE "story_merge_checks" (
	"low_id" integer NOT NULL,
	"high_id" integer NOT NULL,
	"signature" text NOT NULL,
	"same" boolean NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_merge_checks_low_id_high_id_pk" PRIMARY KEY("low_id","high_id")
);
--> statement-breakpoint
CREATE TABLE "story_merges" (
	"from_id" integer PRIMARY KEY NOT NULL,
	"into_id" integer NOT NULL,
	"reason" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_merge_checks" ADD CONSTRAINT "story_merge_checks_low_id_stories_id_fk" FOREIGN KEY ("low_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_merge_checks" ADD CONSTRAINT "story_merge_checks_high_id_stories_id_fk" FOREIGN KEY ("high_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_merges" ADD CONSTRAINT "story_merges_into_id_stories_id_fk" FOREIGN KEY ("into_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_merges_into_idx" ON "story_merges" USING btree ("into_id");