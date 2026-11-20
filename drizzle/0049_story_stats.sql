ALTER TABLE "stories" ADD COLUMN "article_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "source_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "first_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "last_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "stories_last_at_idx" ON "stories" USING btree ("last_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- Recomputes one story's numbers over its visible articles. The story row is locked first, so
-- the count runs after any other writer of that story commits (counting first, then waiting for
-- the row, would save numbers that miss what the other writer just added).
CREATE OR REPLACE FUNCTION refresh_story_stats(sid integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM stories WHERE id = sid FOR NO KEY UPDATE;
  UPDATE stories s SET article_count = x.n, source_count = x.sources, first_at = x.first_at, last_at = x.last_at
  FROM (
    SELECT count(*)::int AS n, count(DISTINCT a.source)::int AS sources, min(a.published_at) AS first_at, max(a.published_at) AS last_at
    FROM articles a WHERE a.story_id = sid AND a.hidden_at IS NULL
  ) x
  WHERE s.id = sid;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION articles_story_stats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.story_id IS NOT NULL THEN
    PERFORM refresh_story_stats(OLD.story_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.story_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.story_id IS DISTINCT FROM OLD.story_id OR NEW.hidden_at IS DISTINCT FROM OLD.hidden_at
      OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.source IS DISTINCT FROM OLD.source) THEN
    PERFORM refresh_story_stats(NEW.story_id);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER articles_story_stats
  AFTER INSERT OR DELETE OR UPDATE OF story_id, hidden_at, published_at, source ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_story_stats();--> statement-breakpoint
-- Backfill.
UPDATE stories s SET article_count = x.n, source_count = x.sources, first_at = x.first_at, last_at = x.last_at
FROM (
  SELECT a.story_id, count(*)::int AS n, count(DISTINCT a.source)::int AS sources, min(a.published_at) AS first_at, max(a.published_at) AS last_at
  FROM articles a WHERE a.story_id IS NOT NULL AND a.hidden_at IS NULL GROUP BY a.story_id
) x
WHERE s.id = x.story_id;
