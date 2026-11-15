ALTER TABLE "deputies" ADD COLUMN "seat_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deputies" ADD COLUMN "positions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "deputies" ADD COLUMN "importance" smallint DEFAULT 0 NOT NULL;