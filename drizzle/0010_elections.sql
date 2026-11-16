CREATE TABLE "election_lists" (
	"election_id" text NOT NULL,
	"list" text NOT NULL,
	"name" text NOT NULL,
	"coalition" boolean DEFAULT false NOT NULL,
	"citizens" boolean DEFAULT false NOT NULL,
	"party_slugs" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "election_lists_election_id_list_pk" PRIMARY KEY("election_id","list")
);
--> statement-breakpoint
CREATE TABLE "election_results" (
	"election_id" text NOT NULL,
	"organ" text NOT NULL,
	"place_key" text NOT NULL,
	"list" text NOT NULL,
	"votes" integer NOT NULL,
	"pct" real NOT NULL,
	"valid_pct" real,
	"mandates" integer,
	"presidents" integer,
	CONSTRAINT "election_results_election_id_organ_place_key_list_pk" PRIMARY KEY("election_id","organ","place_key","list")
);
--> statement-breakpoint
CREATE TABLE "election_turnout" (
	"election_id" text NOT NULL,
	"organ" text NOT NULL,
	"place_key" text NOT NULL,
	"registered" integer,
	"voters" integer NOT NULL,
	"turnout_pct" real,
	"blank" integer NOT NULL,
	"null" integer NOT NULL,
	"total_mandates" integer,
	CONSTRAINT "election_turnout_election_id_organ_place_key_pk" PRIMARY KEY("election_id","organ","place_key")
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"organs" text[] NOT NULL,
	"source_url" text NOT NULL,
	"imported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "places" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"parent_key" text,
	"dicofre" text
);
--> statement-breakpoint
ALTER TABLE "election_lists" ADD CONSTRAINT "election_lists_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_results" ADD CONSTRAINT "election_results_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_results" ADD CONSTRAINT "election_results_place_key_places_key_fk" FOREIGN KEY ("place_key") REFERENCES "public"."places"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_turnout" ADD CONSTRAINT "election_turnout_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_turnout" ADD CONSTRAINT "election_turnout_place_key_places_key_fk" FOREIGN KEY ("place_key") REFERENCES "public"."places"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "election_results_place_idx" ON "election_results" USING btree ("place_key");--> statement-breakpoint
CREATE INDEX "places_parent_idx" ON "places" USING btree ("parent_key");