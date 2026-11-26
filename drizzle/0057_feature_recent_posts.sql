-- New posts are now featured when they first go live. The ones published since the last pick
-- (19–24 Nov 2026) went out before that rule, so they're featured now too.
UPDATE "editorial_posts" SET "featured" = true WHERE "status" = 'published' AND "featured" = false AND "published_at" >= '2026-11-19';
