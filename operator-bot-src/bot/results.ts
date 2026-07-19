import { InlineKeyboard, type Bot } from 'grammy';
import type { Store } from '../store/store.js';
import type { CallResultRecord, User } from '../types.js';
import { escapeHtml } from './callCard.js';

/**
 * Карточка результата разговора для каналов «Результаты»: руководитель видит
 * резюме операторов, может открыть историю клиента (звонки/ремонты/кораблики)
 * и пометить результат «Принято», чтобы не держать в голове, что уже просмотрено.
 */

export function buildResultCardText(result: CallResultRecord): string {
  const lines = ['💬 <b>Результат разговора</b>'];
  if (result.clientName?.trim()) lines.push(`👤 ${escapeHtml(result.clientName.trim())}`);
  lines.push(`☎️ +${escapeHtml(result.phone)}`);
  lines.push(`📝 ${escapeHtml(result.resultText)}`);
  lines.push(`🎧 Оператор: ${escapeHtml(result.operatorName)}`);
  if (result.reviewedAt) {
    lines.push(`✅ <b>Принято</b>${result.reviewedByName ? `: ${escapeHtml(result.reviewedByName)}` : ''}`);
  }
  return lines.join('\n');
}

export function buildResultCardKeyboard(result: CallResultRecord): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('📋 Звонки', `a:calls:${result.phone}`)
    .text('🔧 Ремонты', `a:repairs:${result.phone}`)
    .text('🚤 Кораблики', `a:boats:${result.phone}`)
    .row()
    .text('⏰ Напоминание', `a:remind:${result.phone}`)
    .text('📝 Задача', `a:task:${result.phone}`);
  if (!result.reviewedAt) {
    keyboard.row().text('✅ Принять', `rv:${result.id}`);
  }
  return keyboard;
}

/** Клавиатура выбора исполнителя задачи: по кнопке на активного пользователя + отмена. */
export function buildTaskAssigneeKeyboard(users: User[], phone: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const user of users) {
    if (user.active === false) continue;
    keyboard.text(user.name, `tu:${user.id}:${phone}`).row();
  }
  keyboard.text('✖️ Отмена', `tu:cancel:${phone}`);
  return keyboard;
}

/**
 * Публикует карточку результата во все чаты и ветки, помеченные «Результаты».
 * Возвращает ссылки на отправленные сообщения (для последующей пометки «Принято»).
 */
export async function publishCallResult(
  bot: Bot,
  store: Store,
  result: CallResultRecord,
): Promise<{ chatId: number; messageId: number }[]> {
  const [chats, threads] = await Promise.all([store.listChats(), store.listThreads()]);
  const targets: { chatId: number; threadId?: number }[] = [];
  for (const chat of chats) {
    if (!chat.present) continue;
    if (chat.isResults) targets.push({ chatId: chat.id });
    for (const thread of threads) {
      if (thread.chatId === chat.id && thread.isResults) {
        targets.push({ chatId: chat.id, threadId: thread.threadId });
      }
    }
  }
  if (targets.length === 0) return [];

  const text = buildResultCardText(result);
  const keyboard = buildResultCardKeyboard(result);
  const sent: { chatId: number; messageId: number }[] = [];
  for (const target of targets) {
    try {
      const message = await bot.api.sendMessage(target.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
      });
      sent.push({ chatId: target.chatId, messageId: message.message_id });
    } catch (err) {
      console.error(`Не удалось отправить результат разговора в чат ${target.chatId}:`, err);
    }
  }
  return sent;
}

/**
 * Помечает результат «Принято» и обновляет ВСЕ опубликованные карточки
 * (во всех каналах «Результаты»), чтобы статус был виден везде.
 * pressedRef — карточка, на которой нажали кнопку: редактируем её в любом
 * случае, даже если список resultMessages ещё не успел сохраниться (гонка
 * «нажали сразу после публикации»).
 */
export async function markResultReviewed(
  bot: Bot,
  store: Store,
  resultId: string,
  reviewerName: string,
  pressedRef?: { chatId: number; messageId: number },
): Promise<CallResultRecord | null> {
  const updated = await store.updateCallResult(resultId, {
    reviewedAt: new Date().toISOString(),
    reviewedByName: reviewerName,
  });
  if (!updated) return null;

  const refs = [...(updated.resultMessages ?? [])];
  if (
    pressedRef &&
    !refs.some((r) => r.chatId === pressedRef.chatId && r.messageId === pressedRef.messageId)
  ) {
    refs.push(pressedRef);
  }

  const text = buildResultCardText(updated);
  const keyboard = buildResultCardKeyboard(updated);
  for (const ref of refs) {
    try {
      await bot.api.editMessageText(ref.chatId, ref.messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      // Сообщение могли удалить вручную — статус в хранилище уже обновлён.
      console.error(`Не удалось обновить карточку результата в чате ${ref.chatId}:`, err);
    }
  }
  return updated;
}
