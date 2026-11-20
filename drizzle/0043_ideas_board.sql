CREATE TABLE "forum_post_votes" (
	"post_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forum_post_votes_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "forum_status_changes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "forum_status_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"thread_id" integer NOT NULL,
	"status" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forum_posts" ADD COLUMN "team" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD COLUMN "score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "expected_on" date;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "duplicate_of" integer;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD COLUMN "from_thread_id" integer;--> statement-breakpoint
ALTER TABLE "forum_post_votes" ADD CONSTRAINT "forum_post_votes_post_id_forum_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."forum_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_post_votes" ADD CONSTRAINT "forum_post_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_status_changes" ADD CONSTRAINT "forum_status_changes_thread_id_forum_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forum_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forum_post_votes_user_idx" ON "forum_post_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "forum_status_changes_thread_idx" ON "forum_status_changes" USING btree ("thread_id","at");--> statement-breakpoint
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_duplicate_of_forum_threads_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."forum_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The timeline so far: each status change the admin log recorded, then the current status of ideas it missed.
INSERT INTO "forum_status_changes" ("thread_id", "status", "at")
SELECT t.id, l.after->>'status', l.at FROM "audit_log" l JOIN "forum_threads" t ON t.id::text = l.entity_id
WHERE l.action = 'thread.status' AND l.entity = 'thread' AND (l.before->>'status') IS DISTINCT FROM (l.after->>'status');--> statement-breakpoint
INSERT INTO "forum_status_changes" ("thread_id", "status", "at")
SELECT t.id, t.status, coalesce(t.answered_at, t.created_at) FROM "forum_threads" t
WHERE t.status IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "forum_status_changes" c WHERE c.thread_id = t.id);
