CREATE TABLE "agenda_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"all_day" boolean NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"start_day" date NOT NULL,
	"end_day" date,
	"until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"place" jsonb,
	"district" text,
	"online" jsonb,
	"attend" jsonb NOT NULL,
	"organizer" text,
	"party_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_url" text,
	"featured" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agenda_events" ADD CONSTRAINT "agenda_events_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_events_starts_idx" ON "agenda_events" USING btree ("starts_at","id");--> statement-breakpoint
CREATE INDEX "agenda_events_until_idx" ON "agenda_events" USING btree ("until");