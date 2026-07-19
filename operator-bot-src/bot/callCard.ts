import { InlineKeyboard } from 'grammy';
import { normalizePhone, type IncomingCallEvent } from '../types.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCallCardText(
  event: IncomingCallEvent,
  counts?: { calls?: number; repairs?: number },
): string {
  const lines: string[] = ['📞 <b>Входящий звонок</b>'];
  const name = event.clientName?.trim();
  lines.push(`👤 ${name ? escapeHtml(name) : 'Неизвестный клиент'}`);
  lines.push(`☎️ +${normalizePhone(event.phone)}`);

  const routeParts: string[] = [];
  if (event.line?.trim()) routeParts.push(escapeHtml(event.line.trim()));
  if (event.employee?.trim()) routeParts.push(escapeHtml(event.employee.trim()));
  if (event.employeeId?.trim()) routeParts.push(`№${escapeHtml(event.employeeId.trim())}`);
  if (routeParts.length > 0) lines.push(`🧭 ${routeParts.join(' / ')}`);

  if (counts && (counts.calls !== undefined || counts.repairs !== undefined)) {
    const statParts: string[] = [];
    if (counts.calls !== undefined) statParts.push(`Звонков: ${counts.calls}`);
    if (counts.repairs !== undefined) statParts.push(`Ремонтов: ${counts.repairs}`);
    lines.push(`📊 ${statParts.join(' · ')}`);
  }

  return lines.join('\n');
}

export function buildCallCardKeyboard(phone: string): InlineKeyboard {
  const digits = normalizePhone(phone);
  return new InlineKeyboard()
    .text('📋 Звонки', `a:calls:${digits}`)
    .text('🔧 Ремонты', `a:repairs:${digits}`)
    .text('🚤 Кораблики', `a:boats:${digits}`)
    .row()
    .text('➕ Ремонт', `a:newrep:${digits}`)
    .text('💬 Консультация', `a:consult:${digits}`)
    .text('⏰ Напоминание', `a:remind:${digits}`)
    .row()
    .text('✅ Обработано', `a:done:${digits}`);
}
