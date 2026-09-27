-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEntityType" ADD VALUE 'EXCERPT_CARD';
ALTER TYPE "ActivityEntityType" ADD VALUE 'EXCERPT_SOURCE';

-- CreateTable
CREATE TABLE "excerpt_cards" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "note" VARCHAR(2000),
    "page_start" INTEGER NOT NULL,
    "page_end" INTEGER NOT NULL,
    "book_title_snapshot" VARCHAR(300) NOT NULL,
    "book_author_snapshot" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "excerpt_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excerpt_sources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "annotation_id" UUID NOT NULL,
    "annotation_excerpt" VARCHAR(280) NOT NULL,
    "annotation_start_page" INTEGER NOT NULL,
    "annotation_end_page" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "excerpt_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "excerpt_cards_user_id_deleted_at_created_at_idx" ON "excerpt_cards"("user_id", "deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "excerpt_cards_book_id_deleted_at_created_at_idx" ON "excerpt_cards"("book_id", "deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "excerpt_sources_user_id_revoked_at_created_at_idx" ON "excerpt_sources"("user_id", "revoked_at", "created_at");

-- CreateIndex
CREATE INDEX "excerpt_sources_annotation_id_revoked_at_idx" ON "excerpt_sources"("annotation_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "excerpt_sources_card_id_annotation_id_key" ON "excerpt_sources"("card_id", "annotation_id");

-- AddForeignKey
ALTER TABLE "excerpt_cards" ADD CONSTRAINT "excerpt_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excerpt_cards" ADD CONSTRAINT "excerpt_cards_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excerpt_sources" ADD CONSTRAINT "excerpt_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excerpt_sources" ADD CONSTRAINT "excerpt_sources_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "excerpt_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excerpt_sources" ADD CONSTRAINT "excerpt_sources_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "annotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

