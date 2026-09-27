import type { ExcerptCardStatus, ExcerptSourceState } from '@paper-book-traces/shared';

export const ANNOTATION_EVIDENCE_MAX = 280;

/**
 * 卡片状态由书目是否删除推导：书目被删除后卡片降级，
 * 但卡片本身与证据快照保留，不随书目级联删除。
 */
export function excerptCardStatus(bookDeletedAt: Date | null): ExcerptCardStatus {
  return bookDeletedAt ? 'DEGRADED' : 'ACTIVE';
}

/**
 * 来源引用状态：用户撤销优先；批注被删除（含随书目级联）后来源缺失，
 * 快照仍作为证据保留在引用上。
 */
export function excerptSourceState(
  revokedAt: Date | null,
  annotationDeletedAt: Date | null
): ExcerptSourceState {
  if (revokedAt) return 'REVOKED';
  if (annotationDeletedAt) return 'SOURCE_MISSING';
  return 'ACTIVE';
}

/** 批注证据快照：保留原文，只截断到固定长度。 */
export function annotationEvidence(content: string): string {
  return content.length > ANNOTATION_EVIDENCE_MAX ? content.slice(0, ANNOTATION_EVIDENCE_MAX) : content;
}

export type SourceLinkPlan = 'create' | 'restore' | 'existing';

/**
 * 重复关联幂等：同一卡片与同一批注只存在一条引用记录。
 * 已撤销的引用再次关联时恢复原记录，而不是新建。
 */
export function planSourceLink(existing: { revokedAt: Date | null } | null): SourceLinkPlan {
  if (!existing) return 'create';
  return existing.revokedAt ? 'restore' : 'existing';
}
