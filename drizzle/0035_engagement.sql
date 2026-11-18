CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"actor_name" text,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"user_id" integer NOT NULL,
	"initiative_id" integer NOT NULL,
	"pick" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"vote_date" date,
	"vote_result" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "predictions_user_id_initiative_id_pk" PRIMARY KEY("user_id","initiative_id"),
	CONSTRAINT "predictions_pick_check" CHECK ("predictions"."pick" in ('pass', 'fail'))
);
--> statement-breakpoint
CREATE TABLE "user_follows" (
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_unread_once_idx" ON "notifications" USING btree ("user_id","kind","target_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "predictions_pending_idx" ON "predictions" USING btree ("initiative_id") WHERE outcome is null;--> statement-breakpoint
CREATE INDEX "user_follows_target_idx" ON "user_follows" USING btree ("kind","target_id");