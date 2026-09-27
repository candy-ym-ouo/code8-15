import { Prisma } from '@prisma/client';
import { computeExcerptCardStatus, normalizeText } from './domain.js';
import { writeEvent } from './events.js';

type Tx = Prisma.TransactionClient;

export const EVIDENCE_EXCERPT_MAX = 300;

export function evidenceSnapshot(content: string): string {
  return normalizeText(content).slice(0, EVIDENCE_EXCERPT_MAX);
}

/**
 * 根据当前未撤销来源重算卡片状态；状态变化时落库并写时间线事件。
 * 降级不抹除卡片：quote、页码与来源快照全部保留。
 */
export async function refreshExcerptCardStatus(tx: Tx, userId: string, cardId: string): Promise<void> {
  const card = await tx.excerptCard.findFirst({
    where: { id: cardId, userId, deletedAt: null },
    select: { id: true, bookId: true, status: true }
  });
  if (!card) return;
  const sources = await tx.excerptSource.findMany({
    where: { cardId, revokedAt: null },
    select: { state: true, revokedAt: true }
  });
  const next = computeExcerptCardStatus(sources);
  if (next === card.status) return;
  await tx.excerptCard.update({
    where: { id: cardId },
    data: {
      status: next,
      degradedAt: next === 'DEGRADED' ? new Date() : null,
      version: { increment: 1 }
    }
  });
  await writeEvent(tx, {
    userId,
    bookId: card.bookId,
    entityType: 'EXCERPT_CARD',
    entityId: cardId,
    action: 'UPDATED',
    payload: { status: next, reason: next === 'DEGRADED' ? 'sources_degraded' : 'sources_relinked' }
  });
}

/** 批注被删除：其来源引用降级，证据快照已在关联时留存。 */
export async function degradeExcerptSourcesForAnnotation(tx: Tx, userId: string, annotationId: string): Promise<void> {
  const now = new Date();
  const sources = await tx.excerptSource.findMany({
    where: { annotationId, userId, revokedAt: null, state: 'LINKED', card: { deletedAt: null } },
    select: { id: true, cardId: true, card: { select: { bookId: true } } }
  });
  if (sources.length === 0) return;
  await tx.excerptSource.updateMany({
    where: { id: { in: sources.map((source) => source.id) } },
    data: { state: 'DEGRADED', degradedAt: now }
  });
  for (const source of sources) {
    await writeEvent(tx, {
      userId,
      bookId: source.card.bookId,
      entityType: 'EXCERPT_SOURCE',
      entityId: source.id,
      action: 'UPDATED',
      payload: { cardId: source.cardId, state: 'DEGRADED', reason: 'annotation_deleted' }
    });
  }
  for (const cardId of [...new Set(sources.map((source) => source.cardId))]) {
    await refreshExcerptCardStatus(tx, userId, cardId);
  }
}

/** 批注被恢复：因删除而降级的来源引用自动回链，卡片随之复原。 */
export async function relinkExcerptSourcesForAnnotation(tx: Tx, userId: string, annotationId: string): Promise<void> {
  const sources = await tx.excerptSource.findMany({
    where: { annotationId, userId, revokedAt: null, state: 'DEGRADED', card: { deletedAt: null } },
    select: { id: true, cardId: true, card: { select: { bookId: true } } }
  });
  if (sources.length === 0) return;
  await tx.excerptSource.updateMany({
    where: { id: { in: sources.map((source) => source.id) } },
    data: { state: 'LINKED', degradedAt: null }
  });
  for (const source of sources) {
    await writeEvent(tx, {
      userId,
      bookId: source.card.bookId,
      entityType: 'EXCERPT_SOURCE',
      entityId: source.id,
      action: 'UPDATED',
      payload: { cardId: source.cardId, state: 'LINKED', reason: 'annotation_restored' }
    });
  }
  for (const cardId of [...new Set(sources.map((source) => source.cardId))]) {
    await refreshExcerptCardStatus(tx, userId, cardId);
  }
}

/** 批注内容或页码变化时同步未撤销引用的证据快照，保证降级后留下的是最新证据。 */
export async function refreshEvidenceForAnnotation(
  tx: Tx,
  annotationId: string,
  evidence: { startPage: number; endPage: number; content: string }
): Promise<void> {
  await tx.excerptSource.updateMany({
    where: { annotationId, revokedAt: null },
    data: {
      evidenceStartPage: evidence.startPage,
      evidenceEndPage: evidence.endPage,
      evidenceExcerpt: evidenceSnapshot(evidence.content)
    }
  });
}
