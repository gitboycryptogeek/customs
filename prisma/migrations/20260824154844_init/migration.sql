-- CreateTable
CREATE TABLE "source_versions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "supersedesId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "obligations" (
    "id" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "hsPrefix" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rate" DECIMAL(10,5),
    "specificRate" TEXT,
    "basis" TEXT NOT NULL,
    "legalRef" TEXT NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "obligations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conditions" (
    "id" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "hsPrefix" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "appliesToImporterType" TEXT,
    "legalRef" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amendments" (
    "sourceVersionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "targetAct" TEXT NOT NULL,
    "targetSection" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "appliedToObligationId" TEXT,

    CONSTRAINT "amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "sectionRef" TEXT,
    "text" TEXT NOT NULL,
    "tsv" tsvector,
    "ocrConfidence" DOUBLE PRECISION,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aliases" (
    "id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "hsCode" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "addedBy" TEXT NOT NULL DEFAULT 'seed',

    CONSTRAINT "aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_misses" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_misses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_versions_contentHash_key" ON "source_versions"("contentHash");

-- CreateIndex
CREATE INDEX "obligations_hsPrefix_idx" ON "obligations"("hsPrefix");

-- CreateIndex
CREATE INDEX "obligations_type_idx" ON "obligations"("type");

-- CreateIndex
CREATE INDEX "conditions_hsPrefix_idx" ON "conditions"("hsPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "aliases_term_key" ON "aliases"("term");

-- AddForeignKey
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "source_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_appliedToObligationId_fkey" FOREIGN KEY ("appliedToObligationId") REFERENCES "obligations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
