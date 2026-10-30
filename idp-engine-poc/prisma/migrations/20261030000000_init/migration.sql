-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "idp_document" (
    "id" UUID NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "formType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idp_page" (
    "id" UUID NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,

    CONSTRAINT "idp_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idp_extraction" (
    "id" UUID NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "schemaHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "externalId" TEXT,
    "rawKey" TEXT,
    "costUsd" DECIMAL(10,5),
    "estCostUsd" DECIMAL(10,5),
    "latencyMs" INTEGER,
    "modelVersion" TEXT,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "idp_extraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idp_extracted_field" (
    "id" UUID NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extractionId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "canonicalKey" TEXT,
    "valueType" TEXT NOT NULL,
    "value" JSONB,
    "confidence" DOUBLE PRECISION,
    "confidenceSource" TEXT NOT NULL,
    "page" INTEGER,
    "bbox" JSONB,
    "groundingText" TEXT,
    "flags" TEXT[],

    CONSTRAINT "idp_extracted_field_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idp_document_tenantId_sha256_key" ON "idp_document"("tenantId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "idp_page_documentId_pageNumber_key" ON "idp_page"("documentId", "pageNumber");

-- CreateIndex
CREATE INDEX "idp_extraction_tenantId_requestHash_idx" ON "idp_extraction"("tenantId", "requestHash");

-- CreateIndex
CREATE INDEX "idp_extraction_documentId_idx" ON "idp_extraction"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "idp_extracted_field_extractionId_path_key" ON "idp_extracted_field"("extractionId", "path");

-- AddForeignKey
ALTER TABLE "idp_page" ADD CONSTRAINT "idp_page_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "idp_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_extraction" ADD CONSTRAINT "idp_extraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "idp_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_extracted_field" ADD CONSTRAINT "idp_extracted_field_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "idp_extraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

