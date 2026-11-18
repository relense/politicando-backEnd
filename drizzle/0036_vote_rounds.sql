CREATE TABLE "vote_rounds" (
	"initiative_id" integer PRIMARY KEY NOT NULL,
	"agenda_event_id" text NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"thread_id" integer,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vote_rounds" ADD CONSTRAINT "vote_rounds_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_rounds" ADD CONSTRAINT "vote_rounds_thread_id_forum_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forum_threads"("id") ON DELETE set null ON UPDATE no action;