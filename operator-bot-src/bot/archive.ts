import type { Bot } from 'grammy';
import type { Store } from '../store/store.js';
import type { Task } from '../types.js';
import { escapeHtml } from './callCard.js';

/**
 * Публикует запись о выполненной задаче/напоминании во все чаты и ветки,
 * помеченные как «Архив» (журнал выполненного). Возвращает число отправок.
 */
export async function archiveTask(bot: Bot, store: Store, task: Task): Promise<number> {
  const [chats, threads] = await Promise.all([store.listChats(), store.listThreads()]);
  const targets: { chatId: number; threadId?: number }[] = [];
  for (const chat of chats) {
    if (!chat.present) continue;
    if (chat.isArchive) targets.push({ chatId: chat.id });
    for (const thread of threads) {
      if (thread.chatId === chat.id && thread.isArchive) {
        targets.push({ chatId: chat.id, threadId: thread.threadId });
      }
    }
  }
  if (targets.length === 0) return 0;

  const assignee = await store.getUser(task.assigneeUserId);
  const kindLabel = task.kind === 'reminder' ? 'Напоминание' : 'Задание';
  const lines = [`✅ <b>${kindLabel} выполнено</b>`, escapeHtml(task.title)];
  if (assignee) lines.push(`👤 Исполнитель: ${escapeHtml(assignee.name)}`);
  if (task.doneByName && task.doneByName !== assignee?.name) {
    lines.push(`✔️ Отметил: ${escapeHtml(task.doneByName)}`);
  }
  if (task.result) lines.push(`📝 Результат: ${escapeHtml(task.result)}`);
  const text = lines.join('\n');

  let posted = 0;
  for (const target of targets) {
    try {
      await bot.api.sendMessage(target.chatId, text, {
        parse_mode: 'HTML',
        ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
      });
      posted++;
    } catch (err) {
      console.error(`Не удалось отправить запись в архив в чат ${target.chatId}:`, err);
    }
  }
  return posted;
}
