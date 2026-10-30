-- AlterTable
ALTER TABLE "idp_document" ADD COLUMN     "classification" JSONB,
ADD COLUMN     "conversion" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "formTypeSource" TEXT NOT NULL DEFAULT 'hint',
ADD COLUMN     "normalizedKey" TEXT,
ADD COLUMN     "normalizedMimeType" TEXT;

-- AlterTable
ALTER TABLE "idp_extracted_field" ADD COLUMN     "groupPath" TEXT,
ADD COLUMN     "rowIndex" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'field';

