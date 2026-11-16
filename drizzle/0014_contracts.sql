CREATE TABLE "contract_imports" (
	"year" smallint PRIMARY KEY NOT NULL,
	"source_modified" text NOT NULL,
	"contracts" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_parties" (
	"contract_id" text NOT NULL,
	"role" text NOT NULL,
	"position" smallint NOT NULL,
	"nif" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	CONSTRAINT "contract_parties_contract_id_role_position_pk" PRIMARY KEY("contract_id","role","position")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"procedure_id" text,
	"procedure" text NOT NULL,
	"procedure_kind" text NOT NULL,
	"contract_types" text[] NOT NULL,
	"object" text NOT NULL,
	"description" text,
	"price" double precision NOT NULL,
	"base_price" double precision,
	"effective_price" double precision,
	"published_at" date NOT NULL,
	"signed_at" date,
	"cpv" text,
	"cpv_description" text,
	"deadline_days" integer,
	"places" text[] NOT NULL,
	"place_keys" text[] NOT NULL,
	"legal_basis" text,
	"direct_award_reason" text,
	"framework_agreement" text,
	"centralized" boolean,
	"invited" smallint,
	"documents_url" text,
	"status" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_parties" ADD CONSTRAINT "contract_parties_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_parties_nif_idx" ON "contract_parties" USING btree ("nif","role");--> statement-breakpoint
CREATE INDEX "contracts_published_idx" ON "contracts" USING btree ("published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contracts_price_idx" ON "contracts" USING btree ("price" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contracts_procedure_idx" ON "contracts" USING btree ("procedure_kind","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contracts_place_keys_idx" ON "contracts" USING gin ("place_keys");--> statement-breakpoint
CREATE INDEX "contracts_search_idx" ON "contracts" USING gin (to_tsvector('portuguese', "object"));