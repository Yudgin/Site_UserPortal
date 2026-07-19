import { InlineKeyboard, type Bot } from 'grammy';
import type { Store } from '../store/store.js';
import type { Task } from '../types.js';
import { escapeHtml } from './callCard.js';

export function formatDueRu(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Отправляет задачу/напоминание исполнителю в личку Telegram (если он привязан). */
export async function deliverTaskToAssignee(bot: Bot, store: Store, task: Task): Promise<boolean> {
  const assignee = await store.getUser(task.assigneeUserId);
  if (!assignee || assignee.telegramUserId === undefined) return false;
  const isReminder = task.kind === 'reminder';
  const lines = [isReminder ? '⏰ <b>Напоминание</b>' : '📋 <b>Задание</b>', escapeHtml(task.title)];
  if (task.dueAt) lines.push(`🗓 ${escapeHtml(formatDueRu(task.dueAt))}`);
  const keyboard = new InlineKeyboard().text(
    isReminder ? '✅ Выполнено' : '✅ Выполнить',
    `tdone:${task.id}`,
  );
  try {
    await bot.api.sendMessage(assignee.telegramUserId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return true;
  } catch (err) {
    console.error(`Не удалось отправить задачу ${task.id} исполнителю:`, err);
    return false;
  }
}
