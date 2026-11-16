CREATE TABLE "corrections" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "corrections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"status" text NOT NULL,
	"date" date NOT NULL,
	"area" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"feedback_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "feedback_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"page" text,
	"url" text,
	"correction" text,
	"source" text,
	"email" text,
	"screenshot" "bytea",
	"screenshot_type" text,
	"status" text DEFAULT 'open' NOT NULL,
	"reply" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "forum_votes" (
	"thread_id" integer NOT NULL,
	"voter" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_votes_thread_id_voter_pk" PRIMARY KEY("thread_id","voter")
);
--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_feedback_id_feedback_messages_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_thread_id_forum_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forum_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corrections_date_idx" ON "corrections" USING btree ("date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_messages_status_idx" ON "feedback_messages" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "forum_threads_board_score_idx" ON "forum_threads" USING btree ("board","score" DESC NULLS LAST);