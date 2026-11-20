-- If a parliament sync holds deputies, fail the deploy fast (retry it) rather than stall the API behind the lock.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "deputies" ADD COLUMN "group_periods" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "deputies_full_name_folded_idx" ON "deputies" USING btree (translate(upper("full_name"), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'));--> statement-breakpoint
CREATE INDEX "election_candidates_name_folded_idx" ON "election_candidates" USING btree (translate(upper("name"), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'));