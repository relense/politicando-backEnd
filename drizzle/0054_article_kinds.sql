ALTER TABLE "articles" ADD COLUMN "kind" text DEFAULT 'news' NOT NULL;--> statement-breakpoint
-- Articles stored before: labelled from their URL, as src/ingestion/kind.ts does for new ones.
UPDATE "articles" SET "kind" = CASE
  WHEN "url" ~* '[^/]/(opiniao|opiniao-dn|opinion|cronicas?|colunistas?|editorial)(/|$|\?)' THEN 'opinion'
  WHEN "url" ~* '[^/]/(podcasts?|programas)(/|$|\?)' THEN 'podcast'
  WHEN "url" ~* '[^/]/(newsletters?)(/|$|\?)' THEN 'newsletter'
  ELSE 'news' END;--> statement-breakpoint
-- Only news makes stories: the others leave theirs (a story left with none drops out of every list).
UPDATE "articles" SET "story_id" = NULL WHERE "kind" <> 'news' AND "story_id" IS NOT NULL;
