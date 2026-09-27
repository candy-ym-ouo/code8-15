import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange } from '../../lib/domain.js';
import { evidenceSnapshot, refreshExcerptCardStatus } from '../../lib/excerpts.js';
import { writeEvent } from '../../lib/events.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';

const optionalNote = z.preprocess(
  (value) => (value === '' ? null : value),
  z.string().trim().max(1000).nullable().optional()
);

const cardCreateSchema = z.object({
  quote: z.string().trim().min(1, '请输入摘录内容').max(5000),
  note: optionalNote,
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  annotationIds: z.array(z.string().uuid()).max(20).optional()
});

const cardUpdateSchema = z
  .object({
    quote: z.string().trim().min(1).max(5000).optional(),
    note: optionalNote,
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    version: z.number().int().positive().optional()
  })
  .refine(
    (value) =>
      value.quote !== undefined ||
      value.note !== undefined ||
      value.startPage !== undefined ||
      value.endPage !== undefined,
    { message: '至少提供一个要更新的字段' }
  );

const sourceCreateSchema = z.object({
  annotationId: z.string().uuid('批注标识无效')
});

const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

type SourceWithAnnotation = Prisma.ExcerptSourceGetPayload<{ include: { annotation: true } }>;

function serializeSource(source: SourceWithAnnotation) {
  const annotationLive = source.annotation && !source.annotation.deletedAt ? source.annotation : null;
  return {
    id: source.id,
    cardId: source.cardId,
    annotationId: source.annotationId,
    state: source.state,
    evidence: {
      startPage: source.evidenceStartPage,
      endPage: source.evidenceEndPage,
      excerpt: source.evidenceExcerpt
    },
    annotation: annotationLive
      ? {
          id: annotationLive.id,
          startPage: annotationLive.startPage,
          endPage: annotationLive.endPage,
          content: annotationLive.content
        }
      : null,
    linkedAt: source.linkedAt,
    degradedAt: source.degradedAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

function serializeCard(card: Prisma.ExcerptCardGetPayload<{ include: { sources: { include: { annotation: true } } } }>) {
  return {
    id: card.id,
    bookId: card.bookId,
    version: card.version,
    quote: card.quote,
    note: card.note,
    startPage: card.startPage,
    endPage: card.endPage,
    status: card.status,
    degradedAt: card.degradedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    sources: card.sources.map(serializeSource)
  };
}

function assertVersion(current: number, requested?: number): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', '记录已在其他位置被修改，请刷新后重试');
  }
}

function eventSummary(value: string | null | undefined): string {
  return value ? normalizeText(value).slice(0, 120) : '';
}

type LinkOutcome = 'created' | 'idempotent' | 'revived';

async function linkSource(
  tx: Prisma.TransactionClient,
  input: { userId: string; cardId: string; bookId: string; annotationId: string }
): Promise<{ sourceId: string; outcome: LinkOutcome }> {
  const existing = await tx.excerptSource.findUnique({
    where: { cardId_annotationId: { cardId: input.cardId, annotationId: input.annotationId } }
  });
  if (existing && !existing.revokedAt) {
    return { sourceId: existing.id, outcome: 'idempotent' };
  }
  const annotation = await tx.annotation.findFirstOrThrow({
    where: { id: input.annotationId, userId: input.userId, deletedAt: null }
  });
  const evidence = {
    evidenceStartPage: annotation.startPage,
    evidenceEndPage: annotation.endPage,
    evidenceExcerpt: evidenceSnapshot(annotation.content)
  };
  if (existing) {
    await tx.excerptSource.update({
      where: { id: existing.id },
      data: { ...evidence, state: 'LINKED', degradedAt: null, revokedAt: null, linkedAt: new Date() }
    });
    await writeEvent(tx, {
      userId: input.userId,
      bookId: input.bookId,
      entityType: 'EXCERPT_SOURCE',
      entityId: existing.id,
      action: 'RESTORED',
      payload: { cardId: input.cardId, annotationId: input.annotationId }
    });
    return { sourceId: existing.id, outcome: 'revived' };
  }
  const created = await tx.excerptSource.create({
    data: { userId: input.userId, cardId: input.cardId, annotationId: input.annotationId, ...evidence }
  });
  await writeEvent(tx, {
    userId: input.userId,
    bookId: input.bookId,
    entityType: 'EXCERPT_SOURCE',
    entityId: created.id,
    action: 'CREATED',
    payload: { cardId: input.cardId, annotationId: input.annotationId }
  });
  return { sourceId: created.id, outcome: 'created' };
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        include: {
          sources: {
            where: { revokedAt: null },
            orderBy: { linkedAt: 'asc' },
            include: { annotation: true }
          }
        }
      })
    ]);
    return { items: cards.map(serializeCard), pagination: { page, pageSize, total } };
  });

  app.post('/books/:bookId/excerpt-cards', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = cardCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '摘录卡片信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validatePageRange(parsed.data.startPage, parsed.data.endPage, book.pageCount);
    const annotationIds = [...new Set(parsed.data.annotationIds ?? [])];
    if (annotationIds.length > 0) {
      const annotations = await prisma.annotation.findMany({
        where: { id: { in: annotationIds }, userId, deletedAt: null },
        select: { id: true, bookId: true }
      });
      if (annotations.length !== annotationIds.length) {
        throw new AppError(404, 'NOT_FOUND', '部分批注不存在');
      }
      if (annotations.some((annotation) => annotation.bookId !== bookId)) {
        throw new AppError(409, 'SOURCE_BOOK_MISMATCH', '来源批注必须与摘录卡片属于同一本书');
      }
    }

    const card = await prisma.$transaction(async (tx) => {
      const created = await tx.excerptCard.create({
        data: {
          userId,
          bookId,
          quote: normalizeText(parsed.data.quote),
          note: parsed.data.note ? normalizeText(parsed.data.note) : null,
          startPage: parsed.data.startPage,
          endPage: parsed.data.endPage
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'EXCERPT_CARD',
        entityId: created.id,
        action: 'CREATED',
        payload: { startPage: created.startPage, endPage: created.endPage, summary: eventSummary(created.quote) }
      });
      for (const annotationId of annotationIds) {
        await linkSource(tx, { userId, cardId: created.id, bookId, annotationId });
      }
      return tx.excerptCard.findUniqueOrThrow({
        where: { id: created.id },
        include: { sources: { where: { revokedAt: null }, include: { annotation: true } } }
      });
    });
    return reply.status(201).send({ card: serializeCard(card) });
  });

  app.patch('/excerpt-cards/:cardId', async (request) => {
    const id = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = cardUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '摘录卡片信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    assertVersion(existing.version, parsed.data.version);
    const startPage = parsed.data.startPage ?? existing.startPage;
    const endPage = parsed.data.endPage ?? existing.endPage;
    validatePageRange(startPage, endPage, existing.book.pageCount);
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.excerptCard.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: {
          startPage,
          endPage,
          ...(parsed.data.quote !== undefined ? { quote: normalizeText(parsed.data.quote) } : {}),
          ...(parsed.data.note !== undefined
            ? { note: parsed.data.note ? normalizeText(parsed.data.note) : null }
            : {}),
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '摘录卡片已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: id,
        action: 'UPDATED',
        payload: { startPage, endPage }
      });
      return tx.excerptCard.findUniqueOrThrow({
        where: { id },
        include: { sources: { where: { revokedAt: null }, include: { annotation: true } } }
      });
    });
    return { card: serializeCard(updated) };
  });

  app.delete('/excerpt-cards/:cardId', async (request, reply) => {
    const id = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    assertVersion(existing.version, parsed.data?.version);
    await prisma.$transaction(async (tx) => {
      const result = await tx.excerptCard.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '摘录卡片已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: id,
        action: 'DELETED',
        payload: { startPage: existing.startPage, endPage: existing.endPage }
      });
    });
    return reply.status(204).send();
  });

  app.post('/excerpt-cards/:cardId/restore', async (request) => {
    const id = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptCard.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除摘录卡片不存在');
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.excerptCard.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'EXCERPT_CARD',
        entityId: id,
        action: 'RESTORED',
        payload: { startPage: value.startPage, endPage: value.endPage }
      });
      return tx.excerptCard.findUniqueOrThrow({
        where: { id },
        include: { sources: { where: { revokedAt: null }, include: { annotation: true } } }
      });
    });
    return { card: serializeCard(restored) };
  });

  app.post('/excerpt-cards/:cardId/sources', async (request, reply) => {
    const cardId = parseId((request.params as { cardId: string }).cardId, 'cardId');
    const parsed = sourceCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '来源引用信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const card = await prisma.excerptCard.findFirst({ where: { id: cardId, userId, deletedAt: null } });
    if (!card) throw new AppError(404, 'NOT_FOUND', '摘录卡片不存在');
    const annotation = await prisma.annotation.findFirst({
      where: { id: parsed.data.annotationId, userId, deletedAt: null }
    });
    if (!annotation) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    if (annotation.bookId !== card.bookId) {
      throw new AppError(409, 'SOURCE_BOOK_MISMATCH', '来源批注必须与摘录卡片属于同一本书');
    }

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM excerpt_cards WHERE id = ${cardId}::uuid FOR UPDATE`;
        const result = await linkSource(tx, {
          userId,
          cardId,
          bookId: card.bookId,
          annotationId: annotation.id
        });
        await refreshExcerptCardStatus(tx, userId, cardId);
        return result;
      });
      const source = await prisma.excerptSource.findUniqueOrThrow({
        where: { id: outcome.sourceId },
        include: { annotation: true }
      });
      if (outcome.outcome === 'idempotent') {
        return reply.status(200).send({ source: serializeSource(source), idempotent: true });
      }
      if (outcome.outcome === 'revived') {
        return reply.status(200).send({ source: serializeSource(source), restored: true });
      }
      return reply.status(201).send({ source: serializeSource(source) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const source = await prisma.excerptSource.findUnique({
          where: { cardId_annotationId: { cardId, annotationId: annotation.id } },
          include: { annotation: true }
        });
        if (source && !source.revokedAt) {
          return reply.status(200).send({ source: serializeSource(source), idempotent: true });
        }
      }
      throw error;
    }
  });

  app.delete('/excerpt-sources/:sourceId', async (request, reply) => {
    const id = parseId((request.params as { sourceId: string }).sourceId, 'sourceId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptSource.findFirst({
      where: { id, userId, revokedAt: null },
      include: { card: true }
    });
    if (!existing || existing.card.deletedAt) throw new AppError(404, 'NOT_FOUND', '来源引用不存在');
    await prisma.$transaction(async (tx) => {
      await tx.excerptSource.update({ where: { id }, data: { revokedAt: new Date() } });
      await writeEvent(tx, {
        userId,
        bookId: existing.card.bookId,
        entityType: 'EXCERPT_SOURCE',
        entityId: id,
        action: 'DELETED',
        payload: { cardId: existing.cardId, annotationId: existing.annotationId }
      });
      await refreshExcerptCardStatus(tx, userId, existing.cardId);
    });
    return reply.status(204).send();
  });

  app.post('/excerpt-sources/:sourceId/restore', async (request) => {
    const id = parseId((request.params as { sourceId: string }).sourceId, 'sourceId');
    const userId = currentUser(request).id;
    const existing = await prisma.excerptSource.findFirst({
      where: { id, userId },
      include: { card: true, annotation: true }
    });
    if (!existing || !existing.revokedAt) throw new AppError(404, 'NOT_FOUND', '已撤销来源引用不存在');
    if (!isRestoreWindowOpen(existing.revokedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.card.deletedAt) throw new AppError(409, 'CARD_DELETED', '所属摘录卡片已删除');
    if (existing.annotation.deletedAt) {
      throw new AppError(409, 'ANNOTATION_DELETED', '来源批注已删除，请先恢复批注');
    }
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.excerptSource.update({
        where: { id },
        data: {
          state: 'LINKED',
          degradedAt: null,
          revokedAt: null,
          linkedAt: new Date(),
          evidenceStartPage: existing.annotation.startPage,
          evidenceEndPage: existing.annotation.endPage,
          evidenceExcerpt: evidenceSnapshot(existing.annotation.content)
        }
      });
      await writeEvent(tx, {
        userId,
        bookId: existing.card.bookId,
        entityType: 'EXCERPT_SOURCE',
        entityId: id,
        action: 'RESTORED',
        payload: { cardId: existing.cardId, annotationId: existing.annotationId }
      });
      await refreshExcerptCardStatus(tx, userId, existing.cardId);
      return value;
    });
    const source = await prisma.excerptSource.findUniqueOrThrow({
      where: { id: restored.id },
      include: { annotation: true }
    });
    return { source: serializeSource(source) };
  });
};
