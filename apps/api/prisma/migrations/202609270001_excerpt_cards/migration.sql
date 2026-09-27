-- Excerpt cards with source citations.
-- Cards quote a passage located by book + page range; sources link a card to
-- annotations. When a source annotation is deleted the link degrades but keeps
-- its evidence snapshot; re-linking the same pair is idempotent and revocable.

-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE 'EXCERPT_CARD';
ALTER TYPE "ActivityEntityType" ADD VALUE 'EXCERPT_SOURCE';

-- CreateEnum
CREATE TYPE "ExcerptCardStatus" AS ENUM ('ACTIVE', 'DEGRADED');

-- CreateEnum
CREATE TYPE "ExcerptSourceState" AS ENUM ('LINKED', 'DEGRADED');

-- CreateTable
CREATE TABLE "excerpt_cards" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "quote" VARCHAR(5000) NOT NULL,
    "note" VARCHAR(1000),
    "start_page" INTEGER NOT NULL,
    "end_page" INTEGER NOT NULL,
    "status" "ExcerptCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "degraded_at" TIMESTAMPTZ(3),
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
    "state" "ExcerptSourceState" NOT NULL DEFAULT 'LINKED',
    "evidence_start_page" INTEGER NOT NULL,
    "evidence_end_page" INTEGER NOT NULL,
    "evidence_excerpt" VARCHAR(300) NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "degraded_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "excerpt_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "excerpt_cards_user_id_deleted_at_created_at_idx" ON "excerpt_cards"("user_id", "deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "excerpt_cards_book_id_start_page_end_page_deleted_at_idx" ON "excerpt_cards"("book_id", "start_page", "end_page", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "excerpt_sources_card_id_annotation_id_key" ON "excerpt_sources"("card_id", "annotation_id");

-- CreateIndex
CREATE INDEX "excerpt_sources_user_id_revoked_at_idx" ON "excerpt_sources"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "excerpt_sources_annotation_id_revoked_at_state_idx" ON "excerpt_sources"("annotation_id", "revoked_at", "state");

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
