import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { EXCERPT_CARD_STATUSES, type ExcerptCardStatus } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';
import { annotationEvidence, excerptCardStatus, excerptSourceState, planSourceLink } from './domain.js';

const optionalNote = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().trim().max(2000).nullable().optional()
);

const cardCreateSchema = z.object({
  content: z.string().trim().min(1, '请输入摘录内容').max(10000),
  note: optionalNote,
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive().optional(),
  annotationIds: z.array(z.string().uuid()).max(20).optional()
});

const cardUpdateSchema = z
  .object({
    content: z.string().trim().min(1).max(10000).optional(),
    note: optionalNote,
    pageStart: z.number().int().positive().optional(),
    pageEnd: z.number().int().positive().optional(),
    version: z.number().int().positive().optional()
  })
  .refine(
    (value) =>
      value.content !== undefined ||
      value.note !== undefined ||
      value.pageStart !== undefined ||
      value.pageEnd !== undefined,
    { message: '至少提供一个要更新的字段' }
  );

const sourceCreateSchema = z.object({
  annotationId: z.string().uuid('批注标识无效')
});

const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

type CardRecord = {
  id: string;
  userId: string;
  bookId: string;
  version: number;
  content: string;
  note: string | null;
  pageStart: number;
  pageEnd: number;
  bookTitleSnapshot: string;
  bookAuthorSnapshot: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type BookRef = { title: string; author: string | null; deletedAt: Date | null } | null;

type SourceRecord = {
  id: string;
  cardId: string;
  annotationId: string;
  annotationExcerpt: string;
  annotationStartPage: number;
  annotationEndPage: number;
  createdAt: Date;
  revokedAt: Date | null;
};

type AnnotationRef = { content: string; startPage: number; endPage: number; deletedAt: Date | null } | null;

function serializeSource(source: SourceRecord, annotation: AnnotationRef) {
  const state = excerptSourceState(source.revokedAt, annotation?.deletedAt ?? null);
  const live = state === 'ACTIVE' && annotation;
  return {
    id: source.id,
    cardId: source.cardId,
    annotationId: source.annotationId,
    state,
    annotationExcerpt: live ? annotationEvidence(annotation.content) : source.annotationExcerpt,
    annotationStartPage: live ? annotation.startPage : source.annotationStartPage,
    annotationEndPage: live ? annotation.endPage : source.annotationEndPage,
    createdAt: source.createdAt,
    revokedAt: source.revokedAt
  };
}

function serializeCard(
  card: CardRecord,
  book: BookRef,
  sources: Array<ReturnType<typeof serializeSource>>
) {
  const status = excerptCardStatus(book?.deletedAt ?? null);
  const bookAlive = status === 'ACTIVE' && book;
  return {
    id: card.id,
    bookId: card.bookId,
    content: card.content,
    note: card.note,
    pageStart: card.pageStart,
    pageEnd: card.pageEnd,
    status,
    bookTitle: bookAlive ? book.title : card.bookTitleSnapshot,
    bookAuthor: bookAlive ? book.author : card.bookAuthorSnapshot,
    version: card.version,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    sources
  };
}

function assertVersion(current: number, requested?: number): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', '摘录卡片已在其他位置被修改，请刷新后重试');
  }
}

function eventSummary(value: string | null | undefined): string {
  return value ? normalizeText(value).slice(0, 120) : '';
}

async function loadCardWithSources(cardId: string, userId: string) {
  const card = await prisma.excerptCard.findFirst({
    where: { id: cardId, userId, deletedAt: null },
    include: {
      book: { select: { title: true, author: true, deletedAt: true } },
      sources: {
        where: { revokedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { annotation: { select: { content: true, startPage: true, endPage: true, deletedAt: true } } }
      }
    }
  });
  if (!card) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
  return card;
}

export const excerptRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/excerpt-cards', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    const { page, pageSize, skip } = paginationFromQuery(request);
    const where = { userId, bookId, deletedAt: null };
    const [total, cards] = await Promise.all([
      prisma.excerptCard.count({ where }),
      prisma.excerptCard.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          sources: {
            where: { revokedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { annotation: { select: { content: true, startPage: true, endPage: true, deletedAt: true } } }
          }
        }
      })
    ]);
    return {
      items: cards.map((card) =>
        serializeCard(
          card,
          { title: book.title, author: book.author, deletedAt: null },
          card.sources.map((source) => serializeSource(source, source.annotation))
        )
      ),
      pagination: { page, pageSize, total }
    };
  });

  app.post('/books/:bookId/excerpt-cards', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = cardCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '摘录卡片信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    const pageStart = parsed.data.pageStart;
    const pageEnd = parsed.data.pageEnd ?? pageStart;
    validatePageRange(pageStart, pageEnd, book.pageCount);
    const annotationIds = [...new Set(parsed.data.annotationIds ?? [])];
    const annotations = annotationIds.length
      ? await prisma.annotation.findMany({
          where: { id: { in: annotationIds }, userId, deletedAt: null }
        })
      : [];
    if (annotations.length !== annotationIds.length) {
      throw new AppError(404, 'NOT_FOUND', '部分批注不存在');
    }
    if (annotations.some((annotation) => annotation.bookId !== bookId)) {
      throw new AppError(409, 'ANNOTATION_BOOK_MISMATCH', '批注与摘录卡片不属于同一本书');
    }

    const created = await prisma.$transaction(async (tx) => {
      const card = await tx.excerptCard.create({
        data: {
          userId,
          bookId,
          content: normalizeText(parsed.data.content),
          note: parsed.data.note ? normalizeText(parsed.data.note) : null,
          pageStart,
          pageEnd,
          bookTitleSnapshot: book.title,
          bookAuthorSnapshot: book.author
        }
      });
      for (const annotation of annotations) {
        const source = await tx.excerptSource.create({
          data: {
            userId,
            cardId: card.id,
            annotationId: annotation.id,
            annotationExcerpt: annotationEvidence(annotation.content),
            annotationStartPage: annotation.startPage,
            annotationEndPage: annotation.endPage
          }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'EXCERPT_SOURCE',
          entityId: source.id,
          action: 'CREATED',
          payload: { cardId: card.id, startPage: annotation.startPage, endPage: annotation.endPage }
        });
      }
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'EXCERPT_CARD',
        entityId: card.id,
        action: 'CREATED',
        payload: { startPage: pageStart, endPage: pageEnd, summary: eventSummary(card.content) }
      });
      return card;
    });
    const card = await loadCardWithSources(created.id, userId);
    return reply.status(201).send({
      card: serializeCard(card, card.book, card.sources.map((source) => serializeSource(source, source.annotation)))
    });
  });

  app.get('/excerpt-cards', async (request) => {
    const userId = currentUser(request).id;
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' && query.status !== 'ALL' ? query.status : undefined;
    if (status && !EXCERPT_CARD_STATUSES.includes(status as ExcerptCardStatus)) {
      throw new AppError(422, 'VALIDATION_ERROR', '摘录卡片状态无效');
    }
    const bookId = typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    const { page, pageSize, skip } = paginationFromQuery(request);

    const where: Prisma.ExcerptCardWhereInput = {
      userId,
      deletedAt: null,
      ...(bookId ? { bookId } : {}),
      ...(keyword ? { content: { contains: keyword, mode: 'insensitive' } } : {}),
      ...(status === 'DEGRADED'
        ? { book: { deletedAt: { not: null } } }
        : status === 'ACTIVE'
          ? { book: { deletedAt: null } }
          : {})
    };
    const [total, cards] = await Promise.all([
      prisma.excerptCard.count({ where }),
      prisma.excerptCard.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          book: { select: { title: true, author: true, deletedAt: true } },
          sources: {
            where: { revokedAt: null },
            orderBy: { createdAt: 'asc' },
            include: { annotation: { select: { content: true, startPage: true, endPage: true, deletedAt: true } } }
          }
        }
      })
    ]);
    return {
      items: cards.map((card) =>
        serializeCard(card, card.book, card.sources.map((source) => serializeSource(source, source.annotation)))
      ),
      pagination: { page, pageSize, total }
    };
  });

  app.get('/excerpt-cards/:cardId', async (request) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const userId = currentUser(request).id;
    const card = await loadCardWithSources(cardId, userId);
    return {
      card: serializeCard(card, card.book, card.sources.map((source) => serializeSource(source, source.annotation)))
    };
  });

  app.patch('/excerpt-cards/:cardId', async (request) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = cardUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '摘录卡片信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({
      where: { id: cardId, userId, deletedAt: null },
      include: { book: { select: { pageCount: true, deletedAt: true } } }
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    assertVersion(existing.version, parsed.data.version);
    const pageStart = parsed.data.pageStart ?? existing.pageStart;
    const pageEnd = parsed.data.pageEnd ?? existing.pageEnd;
    // 书目已删除的降级卡片只校验页码本身，书目总页数不再可得
    validatePageRange(pageStart, pageEnd, existing.book.deletedAt ? null : existing.book.pageCount);
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.excerptCard.updateMany({
        where: { id: cardId, userId, deletedAt: null, version: existing.version },
        data: {
          ...(parsed.data.content !== undefined ? { content: normalizeText(parsed.data.content) } : {}),
          ...(parsed.data.note !== undefined
            ? { note: parsed.data.note ? normalizeText(parsed.data.note) : null }
            : {}),
          pageStart,
          pageEnd,
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '摘录卡片已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: cardId,
        action: 'UPDATED',
        payload: { startPage: pageStart, endPage: pageEnd }
      });
      return tx.excerptCard.findUniqueOrThrow({ where: { id: cardId } });
    });
    const card = await loadCardWithSources(updated.id, userId);
    return {
      card: serializeCard(card, card.book, card.sources.map((source) => serializeSource(source, source.annotation)))
    };
  });

  app.delete('/excerpt-cards/:cardId', async (request, reply) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({ where: { id: cardId, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    assertVersion(existing.version, parsed.data?.version);
    await prisma.$transaction(async (tx) => {
      const result = await tx.excerptCard.updateMany({
        where: { id: cardId, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '摘录卡片已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: cardId,
        action: 'DELETED',
        payload: { startPage: existing.pageStart, endPage: existing.pageEnd }
      });
    });
    return reply.status(204).send();
  });

  app.post('/excerpt-cards/:cardId/restore', async (request) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({ where: { id: cardId, userId } });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除摘录卡片不存在');
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    await prisma.$transaction(async (tx) => {
      await tx.excerptCard.update({
        where: { id: cardId },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: cardId,
        action: 'RESTORED',
        payload: { startPage: existing.pageStart, endPage: existing.pageEnd }
      });
    });
    const card = await loadCardWithSources(cardId, userId);
    return {
      card: serializeCard(card, card.book, card.sources.map((source) => serializeSource(source, source.annotation)))
    };
  });

  app.post('/excerpt-cards/:cardId/sources', async (request, reply) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = sourceCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '来源引用信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const card = await prisma.excerptCard.findFirst({
      where: { id: cardId, userId, deletedAt: null },
      include: { book: { select: { deletedAt: true } } }
    });
    if (!card) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    if (card.book.deletedAt) {
      throw new AppError(409, 'CARD_DEGRADED', '书目已删除，降级卡片不能新增来源引用');
    }
    const annotation = await prisma.annotation.findFirst({
      where: { id: parsed.data.annotationId, userId, deletedAt: null }
    });
    if (!annotation) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    if (annotation.bookId !== card.bookId) {
      throw new AppError(409, 'ANNOTATION_BOOK_MISMATCH', '批注与摘录卡片不属于同一本书');
    }

    const existing = await prisma.excerptSource.findUnique({
      where: { cardId_annotationId: { cardId, annotationId: annotation.id } }
    });
    const plan = planSourceLink(existing);
    if (plan === 'existing' && existing) {
      return reply.status(200).send({ source: serializeSource(existing, annotation), idempotent: true });
    }

    try {
      const source = await prisma.$transaction(async (tx) => {
        const value =
          plan === 'restore' && existing
            ? await tx.excerptSource.update({
                where: { id: existing.id },
                // 恢复时刷新证据快照，与批注当前内容保持一致
                data: {
                  revokedAt: null,
                  annotationExcerpt: annotationEvidence(annotation.content),
                  annotationStartPage: annotation.startPage,
                  annotationEndPage: annotation.endPage
                }
              })
            : await tx.excerptSource.create({
                data: {
                  userId,
                  cardId,
                  annotationId: annotation.id,
                  annotationExcerpt: annotationEvidence(annotation.content),
                  annotationStartPage: annotation.startPage,
                  annotationEndPage: annotation.endPage
                }
              });
        await writeEvent(tx, {
          userId,
          bookId: card.bookId,
          entityType: 'EXCERPT_SOURCE',
          entityId: value.id,
          action: plan === 'restore' ? 'RESTORED' : 'CREATED',
          payload: { cardId, startPage: annotation.startPage, endPage: annotation.endPage }
        });
        return value;
      });
      return reply
        .status(plan === 'restore' ? 200 : 201)
        .send({ source: serializeSource(source, annotation), ...(plan === 'restore' ? { restored: true } : {}) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await prisma.excerptSource.findUnique({
          where: { cardId_annotationId: { cardId, annotationId: annotation.id } }
        });
        if (concurrent && !concurrent.revokedAt) {
          return reply.status(200).send({ source: serializeSource(concurrent, annotation), idempotent: true });
        }
      }
      throw error;
    }
  });

  app.delete('/excerpt-sources/:sourceId', async (request, reply) => {
    const sourceId = parseId((request.params as { sourceId: string }).sourceId, 'sourceId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptSource.findFirst({
      where: { id: sourceId, userId, revokedAt: null },
      include: { card: { select: { bookId: true, deletedAt: true } } }
    });
    if (!existing || existing.card.deletedAt) throw new AppError(404, 'NOT_FOUND', '来源引用不存在');
    await prisma.$transaction(async (tx) => {
      await tx.excerptSource.update({
        where: { id: sourceId },
        data: { revokedAt: new Date() }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.card.bookId,
        entityType: 'EXCERPT_SOURCE',
        entityId: sourceId,
        action: 'DELETED',
        payload: { cardId: existing.cardId, annotationId: existing.annotationId }
      });
    });
    return reply.status(204).send();
  });

  app.post('/excerpt-sources/:sourceId/restore', async (request) => {
    const sourceId = parseId((request.params as { sourceId: string }).sourceId, 'sourceId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptSource.findFirst({
      where: { id: sourceId, userId },
      include: {
        card: { select: { bookId: true, deletedAt: true } },
        annotation: { select: { content: true, startPage: true, endPage: true, deletedAt: true } }
      }
    });
    if (!existing || !existing.revokedAt) throw new AppError(404, 'NOT_FOUND', '已撤销来源引用不存在');
    if (!isRestoreWindowOpen(existing.revokedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.card.deletedAt) throw new AppError(409, 'CARD_DELETED', '所属摘录卡片已删除');
    const annotationAlive = existing.annotation && !existing.annotation.deletedAt;
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.excerptSource.update({
        where: { id: sourceId },
        // 批注仍有效时刷新快照；批注已删除则保留撤销前的证据
        data: annotationAlive
          ? {
              revokedAt: null,
              annotationExcerpt: annotationEvidence(existing.annotation.content),
              annotationStartPage: existing.annotation.startPage,
              annotationEndPage: existing.annotation.endPage
            }
          : { revokedAt: null }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.card.bookId,
        entityType: 'EXCERPT_SOURCE',
        entityId: sourceId,
        action: 'RESTORED',
        payload: { cardId: existing.cardId, annotationId: existing.annotationId }
      });
      return value;
    });
    return { source: serializeSource(restored, existing.annotation) };
  });
};
