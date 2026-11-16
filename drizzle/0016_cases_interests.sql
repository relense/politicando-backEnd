CREATE TABLE "case_events" (
	"case_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"sources" smallint[] NOT NULL,
	CONSTRAINT "case_events_case_id_position_pk" PRIMARY KEY("case_id","position")
);
--> statement-breakpoint
CREATE TABLE "case_people" (
	"case_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"role_at_time" text,
	"party_id" integer,
	"deputy_id" integer,
	"government_member_id" text,
	"status" text NOT NULL,
	"outcome" text,
	"final" boolean DEFAULT false NOT NULL,
	CONSTRAINT "case_people_case_id_position_pk" PRIMARY KEY("case_id","position")
);
--> statement-breakpoint
CREATE TABLE "case_sources" (
	"case_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"published_at" date,
	"kind" text NOT NULL,
	CONSTRAINT "case_sources_case_id_position_pk" PRIMARY KEY("case_id","position")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"crimes" text[] NOT NULL,
	"status" text NOT NULL,
	"status_date" date,
	"started_at" date,
	"published" boolean DEFAULT false NOT NULL,
	"reviewed_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "interests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"person_name" text NOT NULL,
	"deputy_id" integer,
	"government_member_id" text,
	"kind" text NOT NULL,
	"entity_name" text NOT NULL,
	"nif" text,
	"description" text,
	"start_date" date,
	"end_date" date,
	"declared_at" date,
	"source_url" text NOT NULL,
	"source_title" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_people" ADD CONSTRAINT "case_people_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_people" ADD CONSTRAINT "case_people_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_people" ADD CONSTRAINT "case_people_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_people" ADD CONSTRAINT "case_people_government_member_id_government_members_id_fk" FOREIGN KEY ("government_member_id") REFERENCES "public"."government_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sources" ADD CONSTRAINT "case_sources_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interests" ADD CONSTRAINT "interests_deputy_id_deputies_id_fk" FOREIGN KEY ("deputy_id") REFERENCES "public"."deputies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interests" ADD CONSTRAINT "interests_government_member_id_government_members_id_fk" FOREIGN KEY ("government_member_id") REFERENCES "public"."government_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_people_deputy_idx" ON "case_people" USING btree ("deputy_id");--> statement-breakpoint
CREATE INDEX "case_people_member_idx" ON "case_people" USING btree ("government_member_id");--> statement-breakpoint
CREATE INDEX "case_people_party_idx" ON "case_people" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "cases_published_idx" ON "cases" USING btree ("published","status_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "interests_deputy_idx" ON "interests" USING btree ("deputy_id");--> statement-breakpoint
CREATE INDEX "interests_member_idx" ON "interests" USING btree ("government_member_id");--> statement-breakpoint
CREATE INDEX "interests_nif_idx" ON "interests" USING btree ("nif");