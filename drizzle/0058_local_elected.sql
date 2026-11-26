CREATE TABLE "local_elected" (
	"election_id" text NOT NULL,
	"place_key" text NOT NULL,
	"organ" text NOT NULL,
	"list" text NOT NULL,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "local_elected_election_id_place_key_organ_list_position_pk" PRIMARY KEY("election_id","place_key","organ","list","position")
);
--> statement-breakpoint
CREATE TABLE "local_elected_sources" (
	"election_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"as_of" date NOT NULL,
	"hash" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_elected" ADD CONSTRAINT "local_elected_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_elected" ADD CONSTRAINT "local_elected_place_key_places_key_fk" FOREIGN KEY ("place_key") REFERENCES "public"."places"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_elected_sources" ADD CONSTRAINT "local_elected_sources_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_elected_place_idx" ON "local_elected" USING btree ("place_key");