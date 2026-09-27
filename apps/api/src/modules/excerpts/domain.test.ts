import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_EVIDENCE_MAX,
  annotationEvidence,
  excerptCardStatus,
  excerptSourceState,
  planSourceLink
} from './domain.js';

describe('excerpt card status', () => {
  it('is active while the book exists and degrades after book deletion', () => {
    expect(excerptCardStatus(null)).toBe('ACTIVE');
    expect(excerptCardStatus(new Date('2026-09-27T00:00:00.000Z'))).toBe('DEGRADED');
  });
});

describe('excerpt source state', () => {
  const deletedAt = new Date('2026-09-27T00:00:00.000Z');

  it('is active when neither revoked nor annotation deleted', () => {
    expect(excerptSourceState(null, null)).toBe('ACTIVE');
  });

  it('keeps evidence when the annotation is deleted', () => {
    expect(excerptSourceState(null, deletedAt)).toBe('SOURCE_MISSING');
  });

  it('treats user revoke as revoked even if the annotation is gone', () => {
    expect(excerptSourceState(deletedAt, null)).toBe('REVOKED');
    expect(excerptSourceState(deletedAt, deletedAt)).toBe('REVOKED');
  });
});

describe('annotation evidence snapshot', () => {
  it('keeps short content unchanged', () => {
    expect(annotationEvidence('这一段值得记住。')).toBe('这一段值得记住。');
  });

  it('truncates long content to the evidence limit', () => {
    const long = '字'.repeat(ANNOTATION_EVIDENCE_MAX + 50);
    const snapshot = annotationEvidence(long);
    expect(snapshot).toHaveLength(ANNOTATION_EVIDENCE_MAX);
    expect(snapshot).toBe(long.slice(0, ANNOTATION_EVIDENCE_MAX));
  });
});

describe('source link idempotency plan', () => {
  it('creates when no link exists', () => {
    expect(planSourceLink(null)).toBe('create');
  });

  it('returns existing when an active link is already present', () => {
    expect(planSourceLink({ revokedAt: null })).toBe('existing');
  });

  it('restores the original record when the link was revoked', () => {
    expect(planSourceLink({ revokedAt: new Date() })).toBe('restore');
  });
});
