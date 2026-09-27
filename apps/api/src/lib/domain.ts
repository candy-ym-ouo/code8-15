import { BOOK_STATUSES, MOOD_TAGS, type BookStatus, type ExcerptCardStatus, type ExcerptSourceState, type MoodTag } from '@paper-book-traces/shared';
import { AppError } from './errors.js';

export const STATUS_TRANSITIONS: Record<BookStatus, BookStatus[]> = {
  TO_READ: ['READING', 'ABANDONED'],
  READING: ['PAUSED', 'READ', 'ABANDONED'],
  PAUSED: ['READING', 'READ', 'ABANDONED'],
  READ: ['READING'],
  ABANDONED: []
};

export function normalizeText(value: string): string {
  return value.normalize('NFC').trim();
}

export function parsePositivePage(value: number, field = 'pageNumber'): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(422, 'VALIDATION_ERROR', '页码必须为大于等于 1 的整数', {
      [field]: '页码必须为大于等于 1 的整数'
    });
  }
  return value;
}

export function validatePageRange(startPage: number, endPage: number, pageCount: number | null): void {
  parsePositivePage(startPage, 'startPage');
  parsePositivePage(endPage, 'endPage');
  if (startPage > endPage) {
    throw new AppError(422, 'VALIDATION_ERROR', '起始页不能大于结束页', {
      endPage: '结束页必须大于等于起始页'
    });
  }
  if (pageCount !== null && endPage > pageCount) {
    throw new AppError(422, 'VALIDATION_ERROR', `页码不能超过总页数 ${pageCount}`, {
      endPage: `页码不能超过总页数 ${pageCount}`
    });
  }
}

export function validateSinglePage(pageNumber: number, pageCount: number | null): void {
  parsePositivePage(pageNumber);
  if (pageCount !== null && pageNumber > pageCount) {
    throw new AppError(422, 'VALIDATION_ERROR', `页码不能超过总页数 ${pageCount}`, {
      pageNumber: `页码不能超过总页数 ${pageCount}`
    });
  }
}

export function assertBookStatus(value: string): asserts value is BookStatus {
  if (!BOOK_STATUSES.includes(value as BookStatus)) {
    throw new AppError(422, 'VALIDATION_ERROR', '书目状态无效', { status: '书目状态无效' });
  }
}

export function validateStatusTransition(current: BookStatus, next: BookStatus): void {
  if (current === next) {
    if (current === 'READ') {
      throw new AppError(409, 'STATUS_UNCHANGED', '当前已是已读完状态');
    }
    return;
  }
  if (!STATUS_TRANSITIONS[current].includes(next)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', '不允许执行该状态变更');
  }
}

export function normalizeMoodTags(tags: MoodTag[]): MoodTag[] {
  const unique = [...new Set(tags)];
  if (unique.length < 1 || unique.length > 3) {
    throw new AppError(422, 'VALIDATION_ERROR', '请选择 1 至 3 个情绪标签', {
      moodTags: '请选择 1 至 3 个情绪标签'
    });
  }
  if (unique.some((tag) => !MOOD_TAGS.includes(tag))) {
    throw new AppError(422, 'VALIDATION_ERROR', '包含未知情绪标签', {
      moodTags: '包含未知情绪标签'
    });
  }
  return unique;
}

export function isRestoreWindowOpen(deletedAt: Date | null, now = new Date()): boolean {
  return Boolean(deletedAt && now.getTime() - deletedAt.getTime() <= 24 * 60 * 60 * 1000);
}

/**
 * 摘录卡片只有在“曾经有过来源、且所有未撤销来源都已降级”时才降级。
 * 从未关联来源的卡片以书目和页码自证，不算降级。
 */
export function computeExcerptCardStatus(
  sources: Array<{ state: ExcerptSourceState; revokedAt: Date | null }>
): ExcerptCardStatus {
  const active = sources.filter((source) => !source.revokedAt);
  if (active.length === 0) return 'ACTIVE';
  return active.some((source) => source.state === 'LINKED') ? 'ACTIVE' : 'DEGRADED';
}

export function isStrictlyEditable(editableUntil: Date, now = new Date()): boolean {
  return now.getTime() <= editableUntil.getTime();
}
