ALTER TABLE "articles" ADD COLUMN "published_version" integer;--> statement-breakpoint
INSERT INTO "article_revisions" ("article_id", "version", "title", "content", "theme_id")
SELECT "id", "version", "title", "content", "theme_id"
FROM "articles"
WHERE "status" = 'published'
ON CONFLICT ("article_id", "version") DO NOTHING;--> statement-breakpoint
UPDATE "articles"
SET "published_version" = "version"
WHERE "status" = 'published';--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_published_version_check" CHECK ("articles"."status" <> 'published' OR "articles"."published_version" IS NOT NULL);
