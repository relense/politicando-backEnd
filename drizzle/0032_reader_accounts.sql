CREATE TABLE "user_hidden" (
	"user_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_hidden_user_id_article_id_pk" PRIMARY KEY("user_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "user_mutes" (
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mutes_user_id_kind_value_pk" PRIMARY KEY("user_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "user_reads" (
	"user_id" integer NOT NULL,
	"story_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_reads_user_id_story_id_pk" PRIMARY KEY("user_id","story_id")
);
--> statement-breakpoint
CREATE TABLE "user_saves" (
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_saves_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "article_votes" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "comment_likes" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "editorial_votes" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "story_votes" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "user_hidden" ADD CONSTRAINT "user_hidden_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mutes" ADD CONSTRAINT "user_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reads" ADD CONSTRAINT "user_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saves" ADD CONSTRAINT "user_saves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint
ALTER TABLE "article_votes" ADD CONSTRAINT "article_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_votes" ADD CONSTRAINT "editorial_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_posts" ADD CONSTRAINT "forum_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_votes" ADD CONSTRAINT "story_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_votes_user_idx" ON "article_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "comment_likes_user_idx" ON "comment_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "comments_user_idx" ON "comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "editorial_votes_user_idx" ON "editorial_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "forum_posts_user_idx" ON "forum_posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "forum_threads_user_idx" ON "forum_threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "forum_votes_user_idx" ON "forum_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "story_votes_user_idx" ON "story_votes" USING btree ("user_id");