CREATE TABLE "budget_news" (
	"proposal_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"about" boolean NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_news_proposal_id_article_id_pk" PRIMARY KEY("proposal_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "budget_statements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "budget_statements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"proposal_id" integer NOT NULL,
	"article_id" integer NOT NULL,
	"party" text,
	"speaker" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_summary_attempts" (
	"proposal_id" integer PRIMARY KEY NOT NULL,
	"tries" smallint DEFAULT 1 NOT NULL,
	"last_error" text NOT NULL,
	"tried_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_summaries" ADD COLUMN "terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_news" ADD CONSTRAINT "budget_news_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_statements" ADD CONSTRAINT "budget_statements_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_news_article_idx" ON "budget_news" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "budget_statements_proposal_idx" ON "budget_statements" USING btree ("proposal_id");