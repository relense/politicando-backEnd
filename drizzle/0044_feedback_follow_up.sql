ALTER TABLE "feedback_messages" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD COLUMN "follow_up_hash" text;--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_messages_follow_up_idx" ON "feedback_messages" USING btree ("follow_up_hash");