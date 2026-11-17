CREATE TABLE "comment_likes" (
	"comment_id" integer NOT NULL,
	"voter" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_likes_comment_id_voter_pk" PRIMARY KEY("comment_id","voter")
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"importa" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_votes" (
	"story_id" integer NOT NULL,
	"voter" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_votes_story_id_voter_pk" PRIMARY KEY("story_id","voter")
);
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_one_target";--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "story_id" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "story_id" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "stance" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "likes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_votes" ADD CONSTRAINT "story_votes_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_story_idx" ON "articles" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "comments_story_idx" ON "comments" USING btree ("story_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_stance_check" CHECK ("comments"."stance" in ('agree', 'disagree'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_one_target" CHECK (num_nonnulls("comments"."article_id", "comments"."story_id", "comments"."editorial_post_id") = 1);