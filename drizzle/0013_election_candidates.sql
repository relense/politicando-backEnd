CREATE TABLE "election_candidates" (
	"election_id" text NOT NULL,
	"place_key" text NOT NULL,
	"list" text NOT NULL,
	"kind" text NOT NULL,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"elected" boolean NOT NULL,
	"deputy_id" integer,
	CONSTRAINT "election_candidates_election_id_place_key_list_kind_position_pk" PRIMARY KEY("election_id","place_key","list","kind","position")
);
--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_place_key_places_key_fk" FOREIGN KEY ("place_key") REFERENCES "public"."places"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "election_candidates_deputy_idx" ON "election_candidates" USING btree ("deputy_id");