-- Existing database only. No table or report is deleted.
-- Run once before starting the updated bot; reruns are safe.
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "sourceMessageKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Report_sourceMessageKey_key"
ON "Report" ("sourceMessageKey");

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platformChatId" TEXT;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "editorialPlatform" TEXT;

ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "submissionCompletedAt" TIMESTAMP(3);
-- Existing records lack a source key; retain their legacy submission behavior.
UPDATE "Report" SET "submissionCompletedAt" = "createdAt"
WHERE "sourceMessageKey" IS NULL AND "submissionCompletedAt" IS NULL;
