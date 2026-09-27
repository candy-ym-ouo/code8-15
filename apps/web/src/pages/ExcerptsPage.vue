<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { excerptApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import {
  EXCERPT_SOURCE_STATE_LABELS,
  EXCERPT_STATUS_LABELS,
  type ExcerptCard,
  type ExcerptCardStatus,
  type ExcerptSource
} from '../types/domain';

const cards = ref<ExcerptCard[]>([]);
const loading = ref(true);
const error = ref('');
const success = ref('');
const status = ref<'ALL' | ExcerptCardStatus>('ALL');
const keyword = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const lastDeleted = ref<{ id: string; label: string } | null>(null);

function params(): URLSearchParams {
  const value = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
  if (status.value !== 'ALL') value.set('status', status.value);
  if (keyword.value.trim()) value.set('keyword', keyword.value.trim());
  return value;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await excerptApi.list(params());
    cards.value = result.items;
    total.value = result.pagination.total;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '摘录卡片加载失败';
  } finally {
    loading.value = false;
  }
}

function filter(): void {
  page.value = 1;
  void load();
}

function excerptRange(card: ExcerptCard): string {
  return card.pageStart === card.pageEnd ? `第 ${card.pageStart} 页` : `第 ${card.pageStart}–${card.pageEnd} 页`;
}

function sourceRange(source: ExcerptSource): string {
  return source.annotationStartPage === source.annotationEndPage
    ? `第 ${source.annotationStartPage} 页`
    : `第 ${source.annotationStartPage}–${source.annotationEndPage} 页`;
}

async function deleteCard(card: ExcerptCard): Promise<void> {
  if (!window.confirm(`确定删除这张摘录卡片（${excerptRange(card)}）吗？24 小时内可以撤销。`)) return;
  error.value = '';
  try {
    await excerptApi.delete(card.id, card.version);
    lastDeleted.value = { id: card.id, label: `摘录卡片 ${excerptRange(card)}` };
    success.value = '已删除，可在 24 小时内撤销';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '删除失败';
  }
}

async function restoreLastDeleted(): Promise<void> {
  if (!lastDeleted.value) return;
  error.value = '';
  try {
    await excerptApi.restore(lastDeleted.value.id);
    lastDeleted.value = null;
    success.value = '删除已撤销';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '恢复失败';
  }
}

onMounted(load);
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">EXCERPTS &amp; EVIDENCE</p>
        <h1>摘录卡片</h1>
        <p>卡片引用书目、页码和批注。来源被删除后卡片降级保留，证据不丢失。</p>
      </div>
    </header>

    <form class="card filter-grid" @submit.prevent="filter">
      <label>
        状态
        <select v-model="status">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in EXCERPT_STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>搜索摘录<input v-model="keyword" type="search" placeholder="摘录内容关键词" /></label>
      <button class="button button-primary" type="submit">筛选</button>
    </form>

    <ErrorNotice :message="error" />
    <div v-if="success" class="success-notice" role="status">
      {{ success }}
      <button v-if="lastDeleted" class="text-button" type="button" @click="restoreLastDeleted">
        撤销删除「{{ lastDeleted.label }}」
      </button>
    </div>

    <div v-if="loading" class="state-panel">正在翻找摘录卡片…</div>
    <div v-else-if="cards.length === 0" class="empty-state card">
      <h2>还没有摘录卡片</h2>
      <p>在书目详情里把值得留下的段落记成卡片，并关联批注作为来源。</p>
      <RouterLink class="button button-primary" to="/">回到我的书</RouterLink>
    </div>
    <div v-else class="trace-list">
      <article v-for="card in cards" :key="card.id" class="trace-card card" :data-status="card.status">
        <div class="trace-card-heading">
          <div>
            <span class="trace-type">{{ EXCERPT_STATUS_LABELS[card.status] }}</span>
            <strong>{{ excerptRange(card) }}</strong>
          </div>
          <div class="button-row">
            <button class="text-button danger-text" type="button" @click="deleteCard(card)">删除</button>
          </div>
        </div>
        <p class="preserve-text">{{ card.content }}</p>
        <p v-if="card.note" class="muted preserve-text">我的想法：{{ card.note }}</p>
        <p class="muted">
          来源书目：
          <RouterLink v-if="card.status === 'ACTIVE'" :to="`/books/${card.bookId}`">《{{ card.bookTitle }}》</RouterLink>
          <span v-else>《{{ card.bookTitle }}》（书目已删除，此为留存证据）</span>
          <template v-if="card.bookAuthor"> · {{ card.bookAuthor }}</template>
        </p>
        <ul v-if="card.sources.length" class="source-list">
          <li v-for="source in card.sources" :key="source.id" class="source-item">
            <span class="source-state" :data-state="source.state">{{ EXCERPT_SOURCE_STATE_LABELS[source.state] }}</span>
            <span class="source-text">批注 {{ sourceRange(source) }}：{{ source.annotationExcerpt }}</span>
          </li>
        </ul>
        <p class="muted">记录于 {{ formatDateTime(card.createdAt) }}</p>
      </article>
    </div>

    <nav v-if="total > pageSize" class="pagination" aria-label="摘录卡片分页">
      <button class="button button-quiet" :disabled="page <= 1" @click="page--; load()">上一页</button>
      <span>第 {{ page }} 页，共 {{ Math.ceil(total / pageSize) }} 页</span>
      <button class="button button-quiet" :disabled="page >= Math.ceil(total / pageSize)" @click="page++; load()">下一页</button>
    </nav>
  </section>
</template>
