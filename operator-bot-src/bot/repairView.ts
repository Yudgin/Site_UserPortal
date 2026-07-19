import { InlineKeyboard } from 'grammy';
import type { OnecListItem } from '../onec/types.js';
import { escapeHtml } from './callCard.js';
import { sortNewestFirst } from './format.js';
import { t, type Lang } from './i18n.js';

const MAX_REPAIR_BUTTONS = 40;
const REPAIR_LABEL_MAX = 48;
const MAX_DETAIL_LENGTH = 3900;

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Сумма в гривнах с разделением разрядов обычным пробелом, напр. 1000200 -> «1 000 200 ₴». */
function money(value: unknown): string | null {
  const n = num(value);
  if (n === null) return null;
  const grouped = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${grouped} ₴`;
}

/** «000000238» -> «238» (для подписи кнопки). */
function shortNumber(number: string): string {
  const stripped = number.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** День и месяц из даты 1С (ISO или «15.12.2025 19:04:52») -> «15.12». */
function dayMonth(raw: string | null): string | null {
  if (!raw) return null;
  const dmy = raw.match(/^(\d{2})\.(\d{2})\./);
  if (dmy) return `${dmy[1]}.${dmy[2]}`;
  const iso = raw.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}.${iso[1]}`;
  return raw;
}

function repairNumber(item: OnecListItem): string | null {
  return str(item.Number) ?? str(item.number) ?? str(item.Номер);
}

/** Свести многострочное/«рваное» описание из 1С в одну строку. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Клавиатура: по кнопке на каждый ремонт (свежие сверху), callback rd:<Number>. */
export function buildRepairsKeyboard(repairs: OnecListItem[]): InlineKeyboard {
  const ordered = sortNewestFirst(repairs).slice(0, MAX_REPAIR_BUTTONS);
  const buttons: { label: string; data: string }[] = [];
  for (const repair of ordered) {
    const number = repairNumber(repair);
    if (number === null) continue;
    const date = dayMonth(str(repair.Date) ?? str(repair.Дата) ?? str(repair.date));
    const dist = str(repair.Dist) ?? str(repair.Disc) ?? str(repair.Описание);
    let label = `№${shortNumber(number)}`;
    if (date) label += ` · ${date}`;
    if (dist) label += ` · ${oneLine(dist)}`;
    if (label.length > REPAIR_LABEL_MAX) label = `${label.slice(0, REPAIR_LABEL_MAX - 1)}…`;
    buttons.push({ label, data: `rd:${number}` });
  }
  // Каждый ремонт — отдельный ряд; .row() ставим МЕЖДУ кнопками, без хвостового пустого ряда.
  const keyboard = new InlineKeyboard();
  buttons.forEach((button, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(button.label, button.data);
  });
  return keyboard;
}

/** Сообщение со списком ремонтов: заголовок + клавиатура. */
export function buildRepairsListView(
  repairs: OnecListItem[],
  lang: Lang,
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const keyboard = buildRepairsKeyboard(repairs);
  const shown = keyboard.inline_keyboard.length;
  let text = `${t(lang, 'repairs_title', { count: repairs.length })}\n${t(lang, 'repairs_hint')}`;
  if (shown < repairs.length) {
    text += `\n${t(lang, 'repairs_shown', { shown })}`;
  }
  return { text, keyboard };
}

/** Подробный вид одного ремонта (HTML). */
export function formatRepairDetail(detail: OnecListItem, lang: Lang): string {
  const lines: string[] = [];
  const number = str(detail.FixNumber) ?? str(detail.requestId) ?? str(detail.Number);
  lines.push(`🔧 <b>${t(lang, 'repair')}${number ? ` №${number}` : ''}</b>`);

  const complaint = str(detail.complaint);
  if (complaint) lines.push(`📝 ${t(lang, 'complaint')}: ${escapeHtml(oneLine(complaint))}`);

  const options = Array.isArray(detail.repairOptions)
    ? (detail.repairOptions as OnecListItem[])
    : [];
  const selectedId = str(detail.selectedRepairOptionId);
  if (selectedId) {
    const selected = options.find((o) => str(o.id) === selectedId);
    const desc = selected ? (str(selected.description) ?? selectedId) : selectedId;
    const price = selected ? money(selected.price) : null;
    lines.push(
      `✅ ${t(lang, 'selected_option')}: ${escapeHtml(oneLine(desc))}${price ? ` — ${price}` : ''}`,
    );
  }

  const finalPrice = money(detail.finalPrice);
  if (finalPrice) lines.push(`💰 ${t(lang, 'total')}: ${finalPrice}`);
  lines.push(`💳 ${t(lang, 'payment')}: ${t(lang, detail.paymentStatus === true ? 'paid' : 'unpaid')}`);

  const shipment =
    detail.shipment && typeof detail.shipment === 'object'
      ? (detail.shipment as OnecListItem)
      : null;
  const ttn = str(shipment?.ttn) ?? str(detail.TrackToFix);
  if (ttn && ttn !== '0') {
    const history = Array.isArray(shipment?.statusHistory)
      ? (shipment?.statusHistory as OnecListItem[])
      : [];
    const lastStatus = history.length > 0 ? str(history[history.length - 1]?.status) : null;
    lines.push(
      `📦 ${t(lang, 'ttn_to_service')}: ${escapeHtml(ttn)}${lastStatus ? ` — ${escapeHtml(lastStatus)}` : ''}`,
    );
  }
  const returnTtn = str(detail.returnTtn) ?? str(detail.TrackToClient);
  if (returnTtn && returnTtn !== '0') lines.push(`📦 ${t(lang, 'ttn_return')}: ${escapeHtml(returnTtn)}`);

  const client =
    detail.ClientInfo && typeof detail.ClientInfo === 'object'
      ? (detail.ClientInfo as OnecListItem)
      : null;
  if (client) {
    const fio = [str(client.LastName), str(client.FirstName), str(client.MiddleName)]
      .filter((p): p is string => p !== null)
      .join(' ');
    if (fio) lines.push(`👤 ${t(lang, 'client')}: ${escapeHtml(fio)}`);
    const city = str(client.City);
    if (city) lines.push(`🏙 ${t(lang, 'city')}: ${escapeHtml(city)}`);
    const warehouse = str(client.tWarehouse);
    if (warehouse) lines.push(`🏤 ${t(lang, 'warehouse')}: ${escapeHtml(warehouse)}`);
  }

  if (options.length > 0) {
    lines.push(`🔧 ${t(lang, 'repair_options')}:`);
    for (const option of options) {
      const desc = str(option.description) ?? str(option.id) ?? '';
      const price = money(option.price);
      const selected = selectedId !== null && str(option.id) === selectedId;
      lines.push(`  • ${escapeHtml(oneLine(desc))}${price ? ` — ${price}` : ''}${selected ? ' ✅' : ''}`);
    }
  }

  const invoice = Array.isArray(detail.finalInvoice)
    ? (detail.finalInvoice as OnecListItem[])
    : [];
  if (invoice.length > 0) {
    lines.push(`🧾 ${t(lang, 'final_invoice')}:`);
    for (const item of invoice) {
      const desc = str(item.description) ?? '';
      const price = money(item.price);
      lines.push(`  • ${escapeHtml(oneLine(desc))}${price ? ` — ${price}` : ''}`);
    }
  }

  const text = lines.join('\n');
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

/** Кнопка оплаты Monopay, если ремонт не оплачен и есть ссылка. */
export function buildRepairDetailKeyboard(detail: OnecListItem, lang: Lang): InlineKeyboard | undefined {
  const url = str(detail.monopayUrl);
  if (detail.paymentStatus !== true && url && /^https:\/\//.test(url)) {
    return new InlineKeyboard().url(t(lang, 'btn_pay'), url);
  }
  return undefined;
}
