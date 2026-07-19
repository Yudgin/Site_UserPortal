import type { OnecListItem } from '../onec/types.js';
import { escapeHtml } from './callCard.js';

// Лимит Telegram — 4096 символов; держим запас. Часть берёт футер «… ещё N».
const TELEGRAM_SAFE_LENGTH = 3900;
const FOOTER_RESERVE = 48;
const ITEM_BUDGET = TELEGRAM_SAFE_LENGTH - FOOTER_RESERVE;
// Страховка от патологически больших ответов 1С.
const HARD_ITEM_CAP = 100;

// Группы синонимов ключей в ответах 1С: берём первое непустое значение из каждой группы.
const KNOWN_KEY_GROUPS: readonly (readonly string[])[] = [
  ['model', 'Model', 'Модель'],
  ['date', 'Date', 'Период', 'Дата'],
  ['number', 'Number', 'Номер'],
  ['status', 'Status', 'Статус'],
  ['sum', 'Сумма'],
  ['comment', 'Комментарий', 'Описание', 'Desc', 'Dist'],
  ['name', 'Наименование'],
];

const DATE_KEYS = ['date', 'Date', 'Период', 'Дата'] as const;

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Время записи 1С в миллисекундах для сортировки. Понимает ISO
 * (`2025-09-29T12:54:09`) и формат портала `15.12.2025 19:04:52`.
 * Возвращает null, если даты нет или она нечитаема.
 */
export function parseOnecTimestamp(item: OnecListItem): number | null {
  let raw: string | null = null;
  for (const key of DATE_KEYS) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') {
      raw = value.trim();
      break;
    }
  }
  if (raw === null) return null;

  const dmy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = dmy;
    const t = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    return Number.isNaN(t) ? null : t;
  }
  const iso = Date.parse(raw);
  return Number.isNaN(iso) ? null : iso;
}

function formatItem(item: OnecListItem): string {
  const parts: string[] = [];
  for (const group of KNOWN_KEY_GROUPS) {
    for (const key of group) {
      const value = item[key];
      if (isScalar(value) && String(value).trim() !== '') {
        parts.push(String(value).trim());
        break;
      }
    }
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(item)) {
      if (isScalar(value) && String(value).trim() !== '') {
        parts.push(`${key}: ${String(value).trim()}`);
        if (parts.length >= 3) break;
      }
    }
  }
  return parts.length > 0 ? parts.join(' · ') : '(нет данных)';
}

/** Полная HTML-строка пункта (без обрезки). */
function renderItemLine(item: OnecListItem): string {
  return `• ${escapeHtml(formatItem(item))}`;
}

/**
 * Усечённая строка пункта, влезающая в maxLen символов: режем по plain-тексту
 * ДО экранирования, чтобы не разорвать HTML-сущности. Используется ТОЛЬКО когда
 * одна запись длиннее всего сообщения — иначе записи показываем целиком.
 */
function renderItemLineTruncated(item: OnecListItem, maxLen: number): string | null {
  if (maxLen < 8) return null;
  let body = formatItem(item);
  while (body.length > 0) {
    const line = `• ${escapeHtml(body)}…`;
    if (line.length <= maxLen) return line;
    body = body.slice(0, Math.floor(body.length * 0.85));
  }
  return null;
}

/** Сортируем записи новыми вперёд; без даты — в конец, сохраняя исходный порядок. */
export function sortNewestFirst(items: OnecListItem[]): OnecListItem[] {
  return items
    .map((item, index) => ({ item, index, ts: parseOnecTimestamp(item) }))
    .sort((a, b) => {
      if (a.ts === null && b.ts === null) return a.index - b.index;
      if (a.ts === null) return 1;
      if (b.ts === null) return -1;
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * Форматирует список из 1С: самые свежие записи сверху, набираем столько,
 * сколько влезает в сообщение Telegram. Скрытые (более ранние) показываем числом.
 */
export function formatOnecList(title: string, items: OnecListItem[], maxItems?: number): string {
  if (items.length === 0) {
    return `${escapeHtml(title)}: ничего не найдено`;
  }
  const cap = Math.min(maxItems ?? HARD_ITEM_CAP, HARD_ITEM_CAP);
  const ordered = sortNewestFirst(items);

  const header = `<b>${escapeHtml(title)}</b> (${items.length})`;
  const lines: string[] = [header];
  let used = header.length;
  let shown = 0;

  for (const item of ordered) {
    if (shown >= cap) break;
    const line = renderItemLine(item);
    if (used + 1 + line.length <= ITEM_BUDGET) {
      lines.push(line);
      used += 1 + line.length;
      shown += 1;
      continue;
    }
    // Запись целиком не влезает. Если ещё ничего не показано — усекаем только её
    // (одна запись длиннее всего сообщения). Иначе прекращаем: остальное скроем.
    if (shown === 0) {
      const truncated = renderItemLineTruncated(item, ITEM_BUDGET - used - 1);
      if (truncated !== null) {
        lines.push(truncated);
        used += 1 + truncated.length;
        shown += 1;
      }
    }
    break;
  }

  const hidden = items.length - shown;
  if (hidden > 0) {
    lines.push(`… ещё ${hidden} более ранних`);
  }
  return lines.join('\n');
}
