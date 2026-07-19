import { randomUUID } from 'node:crypto';
import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { AppConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { OnecClient } from '../onec/client.js';
import {
  OnecApiError,
  OnecNotConfiguredError,
  type NewRepairRequest,
  type OnecListItem,
} from '../onec/types.js';
import {
  normalizePhone,
  type CallResultRecord,
  type ChatInfo,
  type ClientLink,
  type PendingPrompt,
  type PromptKind,
  type Reminder,
  type Task,
} from '../types.js';
import {
  buildClientMenuKeyboard,
  buildLanguageKeyboard,
  buildSharePhoneKeyboard,
  clientMenuText,
  clientWelcome,
} from './clientFlow.js';
import { DEFAULT_LANG, isLang, t, type Lang } from './i18n.js';
import { formatOnecList } from './format.js';
import { parseReminderInput } from './reminderParse.js';
import { buildServiceChoiceKeyboard, extractServiceOptions } from './serviceChoice.js';
import {
  buildRepairDetailKeyboard,
  buildRepairsListView,
  formatRepairDetail,
} from './repairView.js';
import { escapeHtml } from './callCard.js';
import { archiveTask } from './archive.js';
import { buildTaskAssigneeKeyboard, markResultReviewed, publishCallResult } from './results.js';
import { deliverTaskToAssignee } from './taskDeliver.js';

export interface BotDeps {
  config: AppConfig;
  store: Store;
  onec: OnecClient;
}

const ACTION_RE = /^a:(\w+):(\d+)$/;
const REMIND_RE = /^r:(\w+):(\d+)$/;
const SERVICE_RE = /^s:([\w-]+):(\d+)$/;
const CONFIRM_DONE_RE = /^dn:(yes|no):(\d+)$/;
const REPAIR_DETAIL_RE = /^rd:([\w-]+)$/;
const LANG_SET_RE = /^lang:set:(\w+)$/;
const TASK_DONE_RE = /^tdone:(.+)$/;
const RESULT_REVIEW_RE = /^rv:(.+)$/;
const TASK_ASSIGN_RE = /^tu:([\w-]+):(\d+)$/;
// Язык операторских (групповых) сообщений — оставляем русский, как было.
const OPERATOR_LANG: Lang = 'ru';

function userDisplayName(user: { first_name: string; last_name?: string; username?: string }): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name !== '' ? name : (user.username ?? 'оператор');
}

function formatDateTimeRu(date: Date): string {
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function onecListErrorText(err: unknown): string {
  if (err instanceof OnecNotConfiguredError) return `⚠️ ${err.message}`;
  if (err instanceof OnecApiError) return `⚠️ 1С недоступна или вернула ошибку: ${err.message}`;
  return '⚠️ 1С недоступна. Попробуйте позже.';
}

function extractField(result: unknown, keys: string[]): string | null {
  if (result === null || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** Достаёт номер созданного документа из нестрогого ответа 1С. */
function extractDocNumber(result: unknown): string | null {
  return extractField(result, [
    'number',
    'Number',
    'Номер',
    'repair_number',
    'RepairNumber',
    'НомерЗаявки',
  ]);
}

// Реальный ответ repair_NEW: { ID, Status: "Успешно", TTN: <номер Новой Почты> }
function extractTtn(result: unknown): string | null {
  return extractField(result, ['TTN', 'Ttn', 'ttn']);
}

function extractStatus(result: unknown): string | null {
  return extractField(result, ['Status', 'status', 'Статус']);
}

export function createBot(deps: BotDeps): Bot {
  const { config, store, onec } = deps;
  const bot = new Bot(config.botToken);

  // Последнее справочное сообщение (звонки/ремонты/кораблики) в каждом чате —
  // чтобы при показе нового списка удалить предыдущий и не засорять чат.
  // In-memory достаточно: это косметика, после перезапуска просто не удалим старое.
  const lastInfoMessageByChat = new Map<number, number>();
  // Последнее сообщение с деталями ремонта — отдельно от списка, чтобы открытие
  // нового ремонта заменяло прошлые детали, не удаляя сам список ремонтов.
  const lastDetailMessageByChat = new Map<number, number>();

  // Троттлинг предупреждения «нет прав на удаление»: не чаще раза в 10 минут на чат.
  const noRightsWarnedAt = new Map<number, number>();
  const NO_RIGHTS_WARN_INTERVAL_MS = 10 * 60_000;

  // Недавно закрытые карточки (chatId:messageId -> когда) — чтобы отличить ответ на
  // уже закрытую карточку от обычного reply и предупредить о потере резюме.
  const recentlyClosedCards = new Map<string, number>();
  const CLOSED_CARD_TTL_MS = 60 * 60_000;
  function markCardClosed(chatId: number, messageId: number): void {
    const now = Date.now();
    recentlyClosedCards.set(`${chatId}:${messageId}`, now);
    // Чистим старьё, чтобы map не рос бесконечно.
    for (const [key, ts] of recentlyClosedCards) {
      if (now - ts > CLOSED_CARD_TTL_MS) recentlyClosedCards.delete(key);
    }
  }
  function wasCardRecentlyClosed(chatId: number, messageId: number): boolean {
    const ts = recentlyClosedCards.get(`${chatId}:${messageId}`);
    return ts !== undefined && Date.now() - ts <= CLOSED_CARD_TTL_MS;
  }

  /** Распознаём ошибку Telegram «у бота нет прав удалять сообщения». */
  function isNoDeleteRights(err: unknown): boolean {
    if (!(err instanceof GrammyError)) return false;
    const d = err.description.toLowerCase();
    return d.includes('not enough rights') || d.includes("message can't be deleted");
  }

  /** Предупреждение оператору, что боту нужны права админа (троттлится). */
  async function warnNoDeleteRights(chatId: number): Promise<void> {
    const now = Date.now();
    const last = noRightsWarnedAt.get(chatId) ?? 0;
    if (now - last < NO_RIGHTS_WARN_INTERVAL_MS) return;
    noRightsWarnedAt.set(chatId, now);
    try {
      await bot.api.sendMessage(
        chatId,
        '⚠️ Не удалось удалить сообщение — у бота нет прав.\nНазначьте бота администратором группы с правом «Удаление сообщений».',
      );
    } catch (err) {
      console.error('Не удалось отправить предупреждение о правах:', err);
    }
  }

  /** Удаление сообщения best-effort. Своё бот удаляет в пределах 48ч; чужие
   *  (ответы операторов) — только админом с правом удаления. Если прав нет —
   *  показываем (троттлено) предупреждение. «Сообщение уже удалено» — не ошибка. */
  async function deleteMessageSafe(chatId: number, messageId: number): Promise<void> {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (err) {
      if (isNoDeleteRights(err)) {
        await warnNoDeleteRights(chatId);
        return;
      }
      // «message to delete not found» — сообщение уже удалено, это не проблема.
      if (err instanceof GrammyError && err.description.toLowerCase().includes('not found')) {
        return;
      }
      console.error(`Не удалось удалить сообщение ${messageId} в чате ${chatId}:`, err);
    }
  }

  async function deletePrevInfoMessage(chatId: number): Promise<void> {
    // Открытые детали ремонта тоже убираем — они принадлежат прошлому списку.
    const prevDetail = lastDetailMessageByChat.get(chatId);
    if (prevDetail !== undefined) {
      lastDetailMessageByChat.delete(chatId);
      await deleteMessageSafe(chatId, prevDetail);
    }
    const prev = lastInfoMessageByChat.get(chatId);
    if (prev !== undefined) {
      lastInfoMessageByChat.delete(chatId);
      await deleteMessageSafe(chatId, prev);
    }
  }

  /** Закрыть звонок во ВСЕХ группах: удалить карточку в каждой, забыть её,
   *  и удалить сообщения-резюме операторов (если бот админ). */
  async function closeCallEverywhere(callId: string): Promise<void> {
    try {
      const cards = await store.findCallCardsByCallId(callId);
      for (const card of cards) {
        markCardClosed(card.chatId, card.messageId);
        await deleteMessageSafe(card.chatId, card.messageId);
        await store.deleteCallCard(card.chatId, card.messageId);
      }
      // Резюме операторов — чужие сообщения, удалятся только при правах админа;
      // без прав deleteMessageSafe сам предупредит оператора.
      const results = await store.findCallResultsByCallId(callId);
      for (const result of results) {
        if (typeof result.operatorMessageId === 'number') {
          await deleteMessageSafe(result.chatId, result.operatorMessageId);
        }
        // Ответ бота «Результат разговора зафиксирован…» — своё сообщение,
        // удаляется без прав админа.
        if (typeof result.botReplyMessageId === 'number') {
          await deleteMessageSafe(result.chatId, result.botReplyMessageId);
        }
      }
    } catch (err) {
      console.error('Ошибка закрытия звонка во всех группах:', err);
    }
  }

  // --- Учёт чатов, где состоит бот ---

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    const status = update.new_chat_member.status;
    const nowIso = new Date().toISOString();

    if (status === 'member' || status === 'administrator') {
      if (chat.type === 'private') return;
      const existing = await store.getChat(chat.id);
      const info: ChatInfo = {
        id: chat.id,
        title: chat.title,
        type: chat.type,
        present: true,
        // Новый чат добавляем ВЫКЛЮЧЕННЫМ и без событий — активацию и типы
        // событий назначает оператор в админке. Настройки из веб-панели при
        // повторном добавлении бота не сбрасываем.
        active: existing?.active ?? false,
        events: existing?.events ?? [],
        isForum: ('is_forum' in chat ? chat.is_forum : undefined) ?? existing?.isForum,
        addedAt: existing?.addedAt ?? nowIso,
        updatedAt: nowIso,
      };
      await store.upsertChat(info);
    } else if (status === 'left' || status === 'kicked') {
      await store.updateChat(chat.id, { present: false });
    }
  });

  // --- Обнаружение веток (тем форум-чатов) ---

  /** Запоминаем тему: создаём при первом появлении, обновляем имя при изменении. */
  async function discoverThread(
    chatId: number,
    threadId: number,
    name: string | undefined,
  ): Promise<void> {
    const existing = await store.getThread(chatId, threadId);
    if (existing) {
      if (name && name !== existing.name) {
        await store.updateThread(chatId, threadId, { name });
      }
      return;
    }
    const nowIso = new Date().toISOString();
    await store.upsertThread({
      chatId,
      threadId,
      name: name ?? `Тема ${threadId}`,
      // Новую ветку добавляем ВЫКЛЮЧЕННОЙ и без событий — оператор включит её
      // и выберет типы событий в админке вручную.
      active: false,
      events: [],
      addedAt: nowIso,
      updatedAt: nowIso,
    });
    // Раз есть тема — чат точно форум.
    await store.updateChat(chatId, { isForum: true });
    console.log(`Обнаружена новая ветка: chat=${chatId} thread=${threadId} name=${name ?? `Тема ${threadId}`}`);
  }

  bot.on('message:forum_topic_created', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (threadId === undefined) return;
    await discoverThread(ctx.chat.id, threadId, ctx.message.forum_topic_created.name);
  });

  bot.on('message:forum_topic_edited', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    const newName = ctx.message.forum_topic_edited.name;
    if (threadId === undefined || newName === undefined) return;
    await store.updateThread(ctx.chat.id, threadId, { name: newName });
  });

  // Команда /here — вручную зарегистрировать ТЕКУЩУЮ тему (ветку) форума.
  // Нужна для тем, созданных ДО прихода бота: Telegram не даёт ботам список
  // существующих тем, поэтому без активности их невозможно обнаружить.
  bot.command('here', async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    console.log(
      `/here: chat=${ctx.chat?.id} thread=${threadId} is_topic_message=${ctx.message?.is_topic_message}`,
    );
    if (threadId === undefined || ctx.message?.is_topic_message !== true) {
      await ctx.reply('Отправьте эту команду ВНУТРИ нужной темы (ветки) форум-группы.');
      return;
    }
    await discoverThread(ctx.chat.id, threadId, undefined);
    await ctx.reply(
      '✅ Ветка зарегистрирована. Откройте админку → вкладку «Чаты»: под этой группой ' +
        'появилась эта ветка — там можно выбрать, какие события в неё направлять.',
      { reply_parameters: { message_id: ctx.message.message_id } },
    );
  });

  // Любое сообщение в теме — повод узнать тему (для тем, созданных до прихода бота).
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (msg.is_topic_message && msg.message_thread_id !== undefined) {
      const reply = msg.reply_to_message;
      const name =
        reply && 'forum_topic_created' in reply ? reply.forum_topic_created?.name : undefined;
      await discoverThread(ctx.chat.id, msg.message_thread_id, name).catch((err) => {
        console.error('Ошибка обнаружения темы:', err);
      });
    }
    await next();
  });

  /** Язык пользователя из хранилища (или украинский по умолчанию). */
  async function resolveLang(telegramUserId: number | undefined): Promise<Lang> {
    if (telegramUserId === undefined) return DEFAULT_LANG;
    const saved = await store.getUserLanguage(telegramUserId);
    return isLang(saved) ? saved : DEFAULT_LANG;
  }

  /** Имя исполнителя задачи: из связанного аккаунта портала или из Telegram. */
  async function resolveDoerName(from: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  }): Promise<string> {
    const user = await store.getUserByTelegramId(from.id);
    return user?.name ?? userDisplayName(from);
  }

  /** Привязка Telegram к аккаунту портала по одноразовому токену из ссылки. */
  async function handleTelegramLink(ctx: Context, fromId: number, token: string): Promise<void> {
    const link = await store.getLinkToken(token);
    if (!link || link.expiresAt < new Date().toISOString()) {
      await ctx.reply('Ссылка привязки недействительна или истекла. Сгенерируйте новую в портале.');
      return;
    }
    await store.updateUser(link.userId, { telegramUserId: fromId });
    await store.deleteLinkToken(token);
    const user = await store.getUser(link.userId);
    await ctx.reply(
      `✅ Telegram привязан к аккаунту «${user?.name ?? ''}».\nТеперь сюда будут приходить ваши задачи и напоминания.`,
    );
  }

  bot.command('start', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const from = ctx.from;
    // Глубокая ссылка привязки: t.me/bot?start=link_<token>
    const startParam = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (from && startParam.startsWith('link_')) {
      await handleTelegramLink(ctx, from.id, startParam.slice('link_'.length));
      return;
    }
    const lang = await resolveLang(from?.id);
    const existing = from ? await store.getClientByTelegramId(from.id) : null;
    if (existing) {
      // Клиент уже подтвердил номер — показываем меню.
      await ctx.reply(clientMenuText(lang, existing.name), {
        reply_markup: buildClientMenuKeyboard(lang),
      });
      return;
    }
    await ctx.reply(clientWelcome(lang), { reply_markup: buildSharePhoneKeyboard(lang) });
  });

  bot.command('language', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const lang = await resolveLang(ctx.from?.id);
    await ctx.reply(t(lang, 'choose_language'), { reply_markup: buildLanguageKeyboard() });
  });

  // --- Выбор языка ---

  bot.callbackQuery('lang:pick', async (ctx) => {
    const lang = await resolveLang(ctx.from?.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, 'choose_language'), { reply_markup: buildLanguageKeyboard() });
  });

  bot.callbackQuery(LANG_SET_RE, async (ctx) => {
    const match = LANG_SET_RE.exec(ctx.callbackQuery.data);
    const from = ctx.from;
    if (!match || !from || !isLang(match[1])) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = match[1];
    await store.setUserLanguage(from.id, lang);
    await ctx.answerCallbackQuery({ text: t(lang, 'language_set') });
    const linked = await store.getClientByTelegramId(from.id);
    if (linked) {
      await ctx.reply(`${t(lang, 'language_set')}\n${t(lang, 'menu')}`, {
        reply_markup: buildClientMenuKeyboard(lang),
      });
    } else {
      // Ещё не подтвердил номер — показываем приветствие на выбранном языке.
      await ctx.reply(clientWelcome(lang), { reply_markup: buildSharePhoneKeyboard(lang) });
    }
  });

  // --- Клиент подтвердил номер кнопкой «Поделиться номером» ---

  bot.on('message:contact', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const from = ctx.from;
    const contact = ctx.message.contact;
    if (!from) return;
    const lang = await resolveLang(from.id);
    // Принимаем только СВОЙ контакт (нельзя подставить чужой номер).
    if (contact.user_id !== from.id) {
      await ctx.reply(t(lang, 'share_own_phone'), { reply_markup: buildSharePhoneKeyboard(lang) });
      return;
    }
    const phone = normalizePhone(contact.phone_number);
    if (!phone) {
      await ctx.reply(t(lang, 'phone_unrecognized'), { reply_markup: buildSharePhoneKeyboard(lang) });
      return;
    }
    const link: ClientLink = {
      telegramUserId: from.id,
      chatId: ctx.chat.id,
      phone,
      name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || undefined,
      linkedAt: new Date().toISOString(),
    };
    try {
      await store.saveClientLink(link);
    } catch (err) {
      console.error('Не удалось сохранить связку клиента:', err);
      await ctx.reply(t(lang, 'save_phone_failed'));
      return;
    }
    // Убираем reply-клавиатуру и показываем меню.
    await ctx.reply(clientMenuText(lang, link.name), { reply_markup: { remove_keyboard: true } });
    await ctx.reply(t(lang, 'menu'), { reply_markup: buildClientMenuKeyboard(lang) });
  });

  // --- Клиент: мои ремонты ---

  // --- Выполнение задачи/напоминания ---

  bot.callbackQuery(TASK_DONE_RE, async (ctx) => {
    const match = TASK_DONE_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message || !ctx.from) {
      await ctx.answerCallbackQuery({ text: 'Действие недоступно', show_alert: true });
      return;
    }
    const taskId = match[1];
    const task = await store.getTask(taskId);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Задача не найдена', show_alert: true });
      return;
    }
    if (task.status === 'done') {
      await ctx.answerCallbackQuery({ text: 'Уже выполнено' });
      return;
    }
    const doneByName = await resolveDoerName(ctx.from);
    if (task.kind === 'reminder') {
      const updated = await store.updateTask(taskId, {
        status: 'done',
        doneAt: new Date().toISOString(),
        doneByName,
      });
      await ctx.answerCallbackQuery({ text: 'Отмечено выполненным' });
      try {
        await ctx.editMessageText(`✅ <b>Выполнено</b>\n${escapeHtml(task.title)}`, {
          parse_mode: 'HTML',
        });
      } catch (err) {
        console.error('Не удалось обновить сообщение напоминания:', err);
      }
      if (updated) await archiveTask(bot, store, updated);
      return;
    }
    // Задание — спрашиваем результат выполнения.
    await ctx.answerCallbackQuery();
    const sent = await ctx.reply(
      '📋 Опишите результат выполнения задания (ответьте на это сообщение):',
      { reply_markup: { force_reply: true, selective: true } },
    );
    await store.savePrompt({
      id: randomUUID(),
      kind: 'task.result',
      chatId: message.chat.id,
      promptMessageId: sent.message_id,
      payload: { taskId },
      createdAt: new Date().toISOString(),
    });
  });

  bot.callbackQuery('my:repairs', async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || chatId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = await resolveLang(from.id);
    const link = await store.getClientByTelegramId(from.id);
    if (!link) {
      await ctx.answerCallbackQuery();
      await ctx.reply(t(lang, 'confirm_phone_first'), { reply_markup: buildSharePhoneKeyboard(lang) });
      return;
    }
    await ctx.answerCallbackQuery();
    await deletePrevInfoMessage(chatId);
    let repairs: OnecListItem[];
    try {
      repairs = await onec.getRepairs(link.phone);
    } catch (err) {
      console.error('Ошибка запроса ремонтов клиента:', err);
      const errMsg = await ctx.reply(t(lang, 'service_unavailable'));
      lastInfoMessageByChat.set(chatId, errMsg.message_id);
      return;
    }
    if (repairs.length === 0) {
      const empty = await ctx.reply(t(lang, 'no_repairs'));
      lastInfoMessageByChat.set(chatId, empty.message_id);
      return;
    }
    const view = buildRepairsListView(repairs, lang);
    const sent = await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.keyboard,
    });
    lastInfoMessageByChat.set(chatId, sent.message_id);
  });

  // --- Вспомогательные действия ---

  async function replyWithOnecList(
    ctx: Context,
    chatId: number,
    replyToMessageId: number,
    title: string,
    load: () => Promise<OnecListItem[]>,
  ): Promise<void> {
    // Прежний справочный список в этом чате убираем перед показом нового.
    await deletePrevInfoMessage(chatId);
    let sent;
    try {
      const items = await load();
      sent = await ctx.reply(formatOnecList(title, items), {
        parse_mode: 'HTML',
        reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
      });
    } catch (err) {
      console.error(`Ошибка запроса к 1С (${title}):`, err);
      sent = await ctx.reply(onecListErrorText(err), {
        reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
      });
    }
    lastInfoMessageByChat.set(chatId, sent.message_id);
  }

  async function askWithForceReply(
    ctx: Context,
    kind: PromptKind,
    question: string,
    chatId: number,
    cardMessageId: number,
    phone: string,
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const card = await store.findCallCard(chatId, cardMessageId);
      const sent = await ctx.reply(question, {
        reply_markup: { force_reply: true, selective: true },
        reply_parameters: { message_id: cardMessageId, allow_sending_without_reply: true },
      });
      const prompt: PendingPrompt = {
        id: randomUUID(),
        kind,
        chatId,
        promptMessageId: sent.message_id,
        payload: { phone, callId: card?.callId, clientName: card?.clientName, ...extraPayload },
        createdAt: new Date().toISOString(),
      };
      await store.savePrompt(prompt);
    } catch (err) {
      console.error('Не удалось отправить вопрос оператору (force reply):', err);
      try {
        await ctx.reply('⚠️ Не удалось создать запрос. Попробуйте нажать кнопку ещё раз.');
      } catch {
        // Чат недоступен — уведомить оператора нечем, ошибка уже в логах.
      }
    }
  }

  /** Удаление prompt не должно ронять основной сценарий: ошибку только логируем. */
  async function deletePromptSafe(promptId: string): Promise<void> {
    try {
      await store.deletePrompt(promptId);
    } catch (err) {
      console.error('Не удалось удалить ожидающий prompt:', err);
    }
  }

  // --- Кнопки карточки звонка ---

  bot.callbackQuery(ACTION_RE, async (ctx) => {
    const match = ACTION_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const action = match[1];
    const phone = match[2];
    const chatId = message.chat.id;
    const messageId = message.message_id;

    switch (action) {
      case 'calls':
        await ctx.answerCallbackQuery();
        await replyWithOnecList(ctx, chatId, messageId, 'Звонки', () => onec.getCallHistory(phone));
        return;

      case 'repairs': {
        await ctx.answerCallbackQuery();
        await deletePrevInfoMessage(chatId);
        let repairs: OnecListItem[];
        try {
          repairs = await onec.getRepairs(phone);
        } catch (err) {
          console.error('Ошибка запроса к 1С (Ремонты):', err);
          const errMsg = await ctx.reply(onecListErrorText(err), {
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          });
          lastInfoMessageByChat.set(chatId, errMsg.message_id);
          return;
        }
        if (repairs.length === 0) {
          const empty = await ctx.reply('Ремонты: ничего не найдено', {
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          });
          lastInfoMessageByChat.set(chatId, empty.message_id);
          return;
        }
        const view = buildRepairsListView(repairs, OPERATOR_LANG);
        const sent = await ctx.reply(view.text, {
          parse_mode: 'HTML',
          reply_markup: view.keyboard,
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        });
        lastInfoMessageByChat.set(chatId, sent.message_id);
        return;
      }

      case 'boats': {
        // Эндпоинт корабликов может быть не настроен — тогда показываем алерт
        // и НЕ трогаем предыдущий список (нового сообщения не будет).
        let items: OnecListItem[];
        try {
          items = await onec.getSoldBoats(phone);
        } catch (err) {
          if (err instanceof OnecNotConfiguredError) {
            await ctx.answerCallbackQuery({
              text: 'Эндпоинт корабликов ещё не подключён в 1С',
              show_alert: true,
            });
            return;
          }
          console.error('Ошибка запроса к 1С (Кораблики):', err);
          await ctx.answerCallbackQuery();
          await deletePrevInfoMessage(chatId);
          const errMsg = await ctx.reply(onecListErrorText(err), {
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          });
          lastInfoMessageByChat.set(chatId, errMsg.message_id);
          return;
        }
        await ctx.answerCallbackQuery();
        await deletePrevInfoMessage(chatId);
        const sent = await ctx.reply(formatOnecList('Кораблики', items), {
          parse_mode: 'HTML',
          reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
        });
        lastInfoMessageByChat.set(chatId, sent.message_id);
        return;
      }

      case 'newrep': {
        await ctx.answerCallbackQuery();
        let options: ReturnType<typeof extractServiceOptions> = [];
        try {
          options = extractServiceOptions(await onec.getServiceCenters());
        } catch (err) {
          console.error('Не удалось получить список сервис-центров из 1С:', err);
        }
        if (options.length === 0) {
          // 1С недоступна или список пуст — создаём заявку с сервисом по умолчанию
          await askWithForceReply(
            ctx,
            'repair.description',
            '🔧 Опишите проблему для новой заявки на ремонт (ответьте на это сообщение).\nДля отмены напишите «отмена».',
            chatId,
            messageId,
            phone,
          );
          return;
        }
        await ctx.reply('🔧 Выберите сервис-центр для ремонта:', {
          reply_markup: buildServiceChoiceKeyboard(options, phone),
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      case 'consult':
        await ctx.answerCallbackQuery();
        await askWithForceReply(
          ctx,
          'consultation.text',
          '💬 Опишите тему консультации (ответьте на это сообщение):',
          chatId,
          messageId,
          phone,
        );
        return;

      case 'remind': {
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard()
          .text('Через 1 час', `r:1h:${phone}`)
          .text('Через 3 часа', `r:3h:${phone}`)
          .row()
          .text('Завтра 9:00', `r:tom9:${phone}`)
          .text('Свой вариант', `r:custom:${phone}`);
        await ctx.reply('⏰ Когда напомнить?', {
          reply_markup: keyboard,
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      case 'task': {
        // Создание задания клиентского контекста: сначала выбираем исполнителя.
        const users = (await store.listUsers()).filter((u) => u.active !== false);
        if (users.length === 0) {
          await ctx.answerCallbackQuery({
            text: 'Нет активных пользователей — добавьте их в админке (вкладка «Пользователи»)',
            show_alert: true,
          });
          return;
        }
        await ctx.answerCallbackQuery();
        await ctx.reply('📝 Кому назначить задание?', {
          reply_markup: buildTaskAssigneeKeyboard(users, phone),
          reply_parameters: { message_id: messageId },
        });
        return;
      }

      case 'done': {
        const card = await store.findCallCard(chatId, messageId);
        if (!card) {
          // Карточка уже не отслеживается (звонок закрыли в другой группе).
          await ctx.answerCallbackQuery({ text: 'Звонок уже обработан' });
          await deleteMessageSafe(chatId, messageId);
          return;
        }
        if (await store.hasCallResult(card.callId)) {
          await ctx.answerCallbackQuery({ text: 'Звонок обработан — скрыт во всех группах' });
          await closeCallEverywhere(card.callId);
        } else {
          // Резюме разговора нет — спрашиваем подтверждение.
          await ctx.answerCallbackQuery();
          await ctx.reply(
            '⚠️ По этому звонку нет резюме (описания разговора).\nВы уверены, что хотите закрыть?',
            {
              reply_markup: new InlineKeyboard()
                .text('Да, закрыть', `dn:yes:${phone}`)
                .text('Отмена', `dn:no:${phone}`),
              reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
            },
          );
        }
        return;
      }

      default:
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
    }
  });

  // --- Подтверждение закрытия звонка без резюме ---

  bot.callbackQuery(CONFIRM_DONE_RE, async (ctx) => {
    const match = CONFIRM_DONE_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const decision = match[1];
    const chatId = message.chat.id;
    await ctx.answerCallbackQuery();

    // Удаляем сам вопрос-подтверждение в любом случае.
    await deleteMessageSafe(chatId, message.message_id);

    if (decision === 'no') {
      // Отмена — карточку звонка оставляем.
      return;
    }

    // «Да, закрыть»: карточка — это сообщение, на которое отвечал вопрос.
    const cardMessageId =
      'reply_to_message' in message ? message.reply_to_message?.message_id : undefined;
    let callId: string | undefined;
    if (cardMessageId !== undefined) {
      const card = await store.findCallCard(chatId, cardMessageId);
      callId = card?.callId;
    }
    if (callId !== undefined) {
      await closeCallEverywhere(callId);
    } else if (cardMessageId !== undefined) {
      // Карточка уже не отслеживается — удаляем хотя бы здесь.
      await deleteMessageSafe(chatId, cardMessageId);
    }
  });

  // --- «Принять» результат разговора (канал «Результаты») ---

  bot.callbackQuery(RESULT_REVIEW_RE, async (ctx) => {
    const match = RESULT_REVIEW_RE.exec(ctx.callbackQuery.data);
    if (!match) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const resultId = match[1];
    const existing = await store.getCallResult(resultId);
    if (!existing) {
      await ctx.answerCallbackQuery({ text: 'Результат не найден (устаревшая карточка)', show_alert: true });
      return;
    }
    if (existing.reviewedAt) {
      await ctx.answerCallbackQuery({
        text: `Уже принято${existing.reviewedByName ? `: ${existing.reviewedByName}` : ''}`,
      });
      return;
    }
    const reviewerName = ctx.from ? userDisplayName(ctx.from) : 'Руководитель';
    // Нажатую карточку редактируем всегда — даже если список опубликованных
    // ссылок ещё не сохранился (нажали сразу после публикации).
    const message = ctx.callbackQuery.message;
    const pressedRef = message
      ? { chatId: message.chat.id, messageId: message.message_id }
      : undefined;
    const updated = await markResultReviewed(bot, store, resultId, reviewerName, pressedRef);
    await ctx.answerCallbackQuery(
      updated ? { text: 'Принято ✅' } : { text: 'Результат не найден', show_alert: true },
    );
  });

  // --- Выбор исполнителя нового задания (кнопка «Задача») ---

  bot.callbackQuery(TASK_ASSIGN_RE, async (ctx) => {
    const match = TASK_ASSIGN_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const assigneeId = match[1];
    const phone = match[2];
    const chatId = message.chat.id;

    // Якорь для ответов — карточка (результата/звонка), на которую отвечало
    // сообщение выбора: reply сохраняет ветку форума и даёт визуальный контекст.
    const anchorMessageId =
      ('reply_to_message' in message ? message.reply_to_message?.message_id : undefined) ??
      message.message_id;

    if (assigneeId === 'cancel') {
      await ctx.answerCallbackQuery({ text: 'Создание задания отменено' });
      await deleteMessageSafe(chatId, message.message_id);
      return;
    }

    const assignee = await store.getUser(assigneeId);
    if (!assignee || assignee.active === false) {
      await ctx.answerCallbackQuery({ text: 'Пользователь не найден или деактивирован', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    // Промпт отправляем ДО удаления сообщения выбора: его якорь — живая карточка.
    await askWithForceReply(
      ctx,
      'task.title',
      `📝 Опишите задание для ${assignee.name} (ответьте на это сообщение).\nДля отмены напишите «отмена».`,
      chatId,
      anchorMessageId,
      phone,
      { assigneeUserId: assignee.id, assigneeName: assignee.name },
    );
    // Сообщение выбора больше не нужно — убираем, чтобы не копилось.
    await deleteMessageSafe(chatId, message.message_id);
  });

  // --- Выбор сервис-центра для новой заявки на ремонт ---

  bot.callbackQuery(SERVICE_RE, async (ctx) => {
    const match = SERVICE_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const serviceId = match[1];
    const phone = match[2];
    const chatId = message.chat.id;

    if (serviceId === 'cancel') {
      // Отмена оформления на шаге выбора сервиса — убираем сообщение выбора.
      await ctx.answerCallbackQuery({ text: 'Оформление отменено' });
      await deleteMessageSafe(chatId, message.message_id);
      return;
    }

    // Название сервиса берём из текста нажатой кнопки — в callback_data оно не помещается
    let serviceName = serviceId;
    const keyboardRows =
      'reply_markup' in message ? (message.reply_markup?.inline_keyboard ?? []) : [];
    for (const row of keyboardRows) {
      for (const button of row) {
        if ('callback_data' in button && button.callback_data === ctx.callbackQuery.data) {
          serviceName = button.text;
        }
      }
    }

    await ctx.answerCallbackQuery();

    // Сообщение с выбором отвечало на карточку звонка — оттуда возьмём клиента
    const cardMessageId =
      'reply_to_message' in message ? message.reply_to_message?.message_id : undefined;

    // Убираем клавиатуру, чтобы сервис не выбрали дважды
    try {
      await ctx.editMessageText(`🔧 Сервис-центр: ${serviceName}`);
    } catch (err) {
      console.error('Не удалось зафиксировать выбор сервис-центра в сообщении:', err);
    }

    await askWithForceReply(
      ctx,
      'repair.description',
      `🔧 Сервис «${serviceName}». Опишите проблему для заявки на ремонт (ответьте на это сообщение).\nДля отмены напишите «отмена».`,
      chatId,
      cardMessageId ?? message.message_id,
      phone,
      // message.message_id — сообщение выбора сервиса; удалим его после оформления.
      { serviceId, serviceName, serviceChoiceMessageId: message.message_id },
    );
  });

  // --- Детали конкретного ремонта ---

  bot.callbackQuery(REPAIR_DETAIL_RE, async (ctx) => {
    const match = REPAIR_DETAIL_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const repairNumber = match[1];
    const chatId = message.chat.id;
    // В личке — язык клиента, в группе — язык оператора.
    const lang =
      message.chat.type === 'private' ? await resolveLang(ctx.from?.id) : OPERATOR_LANG;
    await ctx.answerCallbackQuery();

    // Прошлые детали заменяем новыми, сам список ремонтов оставляем.
    const prevDetail = lastDetailMessageByChat.get(chatId);
    if (prevDetail !== undefined) {
      lastDetailMessageByChat.delete(chatId);
      await deleteMessageSafe(chatId, prevDetail);
    }

    let detail: OnecListItem;
    try {
      detail = await onec.getRepairDetail(repairNumber);
    } catch (err) {
      console.error(`Ошибка запроса деталей ремонта ${repairNumber}:`, err);
      const errText = message.chat.type === 'private' ? t(lang, 'service_unavailable') : onecListErrorText(err);
      const errMsg = await ctx.reply(errText, {
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
      lastDetailMessageByChat.set(chatId, errMsg.message_id);
      return;
    }
    const sent = await ctx.reply(formatRepairDetail(detail, lang), {
      parse_mode: 'HTML',
      reply_markup: buildRepairDetailKeyboard(detail, lang),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
    lastDetailMessageByChat.set(chatId, sent.message_id);
  });

  // --- Выбор времени напоминания ---

  bot.callbackQuery(REMIND_RE, async (ctx) => {
    const match = REMIND_RE.exec(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!match || !message) {
      await ctx.answerCallbackQuery({ text: 'Сообщение устарело, действие недоступно', show_alert: true });
      return;
    }
    const choice = match[1];
    const phone = match[2];
    const chatId = message.chat.id;

    if (choice === 'custom') {
      await ctx.answerCallbackQuery();
      const sent = await ctx.reply(
        '⏰ Напишите время и текст, например: "30м перезвонить" / "2ч отправить КП" / "завтра 10:30 уточнить адрес"',
        { reply_markup: { force_reply: true, selective: true } },
      );
      const prompt: PendingPrompt = {
        id: randomUUID(),
        kind: 'reminder.custom',
        chatId,
        promptMessageId: sent.message_id,
        payload: { phone },
        createdAt: new Date().toISOString(),
      };
      await store.savePrompt(prompt);
      return;
    }

    const now = new Date();
    let dueAt: Date;
    if (choice === '1h') {
      dueAt = new Date(now.getTime() + 3_600_000);
    } else if (choice === '3h') {
      dueAt = new Date(now.getTime() + 3 * 3_600_000);
    } else if (choice === 'tom9') {
      // Завтра 09:00 в локальном времени процесса (TZ контейнера).
      dueAt = new Date(now);
      dueAt.setDate(dueAt.getDate() + 1);
      dueAt.setHours(9, 0, 0, 0);
    } else {
      await ctx.answerCallbackQuery({ text: 'Неизвестный вариант', show_alert: true });
      return;
    }

    const reminder: Reminder = {
      id: randomUUID(),
      chatId,
      text: `Перезвонить клиенту +${phone}`,
      phone,
      dueAt: dueAt.toISOString(),
      createdById: ctx.from.id,
      createdByName: userDisplayName(ctx.from),
      done: false,
      createdAt: now.toISOString(),
    };
    await store.saveReminder(reminder);
    await ctx.answerCallbackQuery();
    await ctx.reply(`⏰ Напоминание установлено на ${formatDateTimeRu(dueAt)}`);
  });

  // --- Ответы оператора (reply) ---

  bot.on('message:text', async (ctx) => {
    const message = ctx.message;
    const replyTo = message.reply_to_message;
    const from = message.from;
    if (!replyTo || !from) return;

    const text = message.text.trim();
    if (text === '') return;
    const chatId = ctx.chat.id;
    const nowIso = new Date().toISOString();
    const operatorName = userDisplayName(from);

    const prompt = await store.findPromptByMessage(chatId, replyTo.message_id);
    if (prompt) {
      const phone = typeof prompt.payload.phone === 'string' ? prompt.payload.phone : '';
      const clientName =
        typeof prompt.payload.clientName === 'string' ? prompt.payload.clientName.trim() : '';

      if (prompt.kind === 'repair.description') {
        if (text.toLowerCase() === 'отмена') {
          await deletePromptSafe(prompt.id);
          await deleteMessageSafe(chatId, prompt.promptMessageId);
          await deleteMessageSafe(chatId, message.message_id);
          const cancelScid = prompt.payload.serviceChoiceMessageId;
          if (typeof cancelScid === 'number') await deleteMessageSafe(chatId, cancelScid);
          await ctx.reply('✖️ Оформление ремонта отменено');
          return;
        }
        const [lastName, firstName] = clientName.split(/\s+/);
        const chosenServiceId =
          typeof prompt.payload.serviceId === 'string' && prompt.payload.serviceId !== ''
            ? prompt.payload.serviceId
            : config.defaults.serviceCode;
        const chosenServiceName =
          typeof prompt.payload.serviceName === 'string' ? prompt.payload.serviceName : null;
        const request: NewRepairRequest = {
          phone_number: `+${phone}`,
          Service: chosenServiceId,
          Disc: text,
        };
        if (config.defaults.cityGuid !== '') request.City = config.defaults.cityGuid;
        if (config.defaults.warehouseGuid !== '') request.tWarehouse = config.defaults.warehouseGuid;
        if (lastName) request.LastName = lastName;
        if (firstName) request.FirstName = firstName;

        let replyText: string;
        let created = false;
        try {
          const result: unknown = await onec.createRepair(request);
          const status = extractStatus(result);
          if (status !== null && status !== 'Успешно') {
            replyText = `⚠️ 1С не приняла заявку: ${status}`;
          } else {
            created = true;
            const parts = ['✅ Заявка на ремонт создана'];
            if (chosenServiceName !== null) parts.push(`Сервис-центр: ${chosenServiceName}`);
            const docNumber = extractDocNumber(result);
            if (docNumber !== null) parts.push(`№ ${docNumber}`);
            const ttn = extractTtn(result);
            if (ttn !== null) parts.push(`ТТН Нової Пошти: ${ttn}`);
            replyText = parts.join('\n');
          }
        } catch (err) {
          console.error('Ошибка создания заявки на ремонт в 1С:', err);
          replyText = `⚠️ Не удалось создать заявку: ${errorMessage(err)}`;
        }
        // Prompt удаляем до ответа, чтобы повторный reply не создал дубликат заявки.
        await deletePromptSafe(prompt.id);

        if (created) {
          // Заявка оформлена — убираем переписку по ней, оставляя только подтверждение:
          // вопрос бота, ответ оператора и сообщение выбора сервиса.
          await deleteMessageSafe(chatId, prompt.promptMessageId);
          await deleteMessageSafe(chatId, message.message_id);
          const serviceChoiceMessageId = prompt.payload.serviceChoiceMessageId;
          if (typeof serviceChoiceMessageId === 'number') {
            await deleteMessageSafe(chatId, serviceChoiceMessageId);
          }
          // Подтверждение — самостоятельным сообщением (отвечать не на что: ответ удалён).
          await ctx.reply(replyText);
        } else {
          await ctx.reply(replyText, {
            reply_parameters: { message_id: message.message_id },
          });
        }
        return;
      }

      if (prompt.kind === 'consultation.text') {
        let sentTo1C = false;
        let suffix: string;
        try {
          const { sent } = await onec.createConsultation(phone, text);
          sentTo1C = sent;
          suffix = sent ? ' и передана в 1С' : ' (1С: эндпоинт не настроен — сохранено локально)';
        } catch (err) {
          console.error('Ошибка передачи консультации в 1С:', err);
          suffix = ' (1С: ошибка передачи — сохранено локально)';
        }
        try {
          await store.saveConsultation({
            id: randomUUID(),
            phone,
            clientName: clientName !== '' ? clientName : undefined,
            text,
            chatId,
            createdById: from.id,
            createdByName: operatorName,
            createdAt: nowIso,
            sentTo1C,
          });
        } catch (err) {
          // Prompt не удаляем — оператор может ответить ещё раз.
          console.error('Ошибка сохранения заявки на консультацию:', err);
          await ctx.reply('⚠️ Не удалось записать консультацию. Попробуйте ответить ещё раз.', {
            reply_parameters: { message_id: message.message_id },
          });
          return;
        }
        await deletePromptSafe(prompt.id);
        await ctx.reply(`✅ Заявка на консультацию записана${suffix}`, {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }

      if (prompt.kind === 'task.title') {
        if (text.toLowerCase() === 'отмена') {
          await deletePromptSafe(prompt.id);
          await deleteMessageSafe(chatId, prompt.promptMessageId);
          await deleteMessageSafe(chatId, message.message_id);
          await ctx.reply('✖️ Создание задания отменено');
          return;
        }
        const assigneeUserId =
          typeof prompt.payload.assigneeUserId === 'string' ? prompt.payload.assigneeUserId : '';
        const assignee = assigneeUserId ? await store.getUser(assigneeUserId) : null;
        if (!assignee || assignee.active === false) {
          await deletePromptSafe(prompt.id);
          await ctx.reply('⚠️ Исполнитель не найден или деактивирован — начните создание задания заново.', {
            reply_parameters: { message_id: message.message_id },
          });
          return;
        }
        // Телефон клиента добавляем в текст — контекст задания сохраняется.
        const title = phone !== '' ? `${text} — клиент +${phone}` : text;
        const task: Task = {
          id: randomUUID(),
          kind: 'task',
          title,
          assigneeUserId: assignee.id,
          creatorName: operatorName,
          status: 'open',
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        // Сначала сохраняем (чтобы не отправить исполнителю «мёртвую» задачу
        // при сбое записи), потом доставляем и помечаем notifiedAt.
        try {
          await store.saveTask(task);
        } catch (err) {
          console.error('Ошибка сохранения задания:', err);
          await ctx.reply('⚠️ Не удалось сохранить задание. Попробуйте ответить ещё раз.', {
            reply_parameters: { message_id: message.message_id },
          });
          return;
        }
        const delivered = await deliverTaskToAssignee(bot, store, task);
        if (delivered) {
          await store.updateTask(task.id, { notifiedAt: nowIso });
        }
        await deletePromptSafe(prompt.id);
        await deleteMessageSafe(chatId, prompt.promptMessageId);
        const deliveryNote = delivered
          ? 'и отправлено в Telegram'
          : '(Telegram не привязан — увидит в портале)';
        await ctx.reply(`📝 Задание для ${assignee.name} создано ${deliveryNote}`, {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }

      if (prompt.kind === 'task.result') {
        const taskId = typeof prompt.payload.taskId === 'string' ? prompt.payload.taskId : '';
        const task = taskId ? await store.getTask(taskId) : null;
        if (!task) {
          await deletePromptSafe(prompt.id);
          await ctx.reply('Задача не найдена — возможно, уже выполнена.', {
            reply_parameters: { message_id: message.message_id },
          });
          return;
        }
        const updatedTask = await store.updateTask(taskId, {
          status: 'done',
          result: text,
          doneAt: nowIso,
          doneByName: await resolveDoerName(from),
        });
        await deletePromptSafe(prompt.id);
        await ctx.reply('✅ Задание выполнено, результат записан.', {
          reply_parameters: { message_id: message.message_id },
        });
        if (updatedTask) await archiveTask(bot, store, updatedTask);
        return;
      }

      // prompt.kind === 'reminder.custom'
      const parsed = parseReminderInput(text, new Date());
      if (!parsed) {
        // Промпт не удаляем — оператор может ответить ещё раз.
        await ctx.reply('Не понял время. Примеры: 30м, 2ч, завтра 10:30', {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }
      const reminder: Reminder = {
        id: randomUUID(),
        chatId,
        text: parsed.text,
        phone: phone !== '' ? phone : undefined,
        callId: typeof prompt.payload.callId === 'string' ? prompt.payload.callId : undefined,
        dueAt: parsed.dueAt.toISOString(),
        createdById: from.id,
        createdByName: operatorName,
        done: false,
        createdAt: nowIso,
      };
      try {
        await store.saveReminder(reminder);
      } catch (err) {
        // Prompt не удаляем — оператор может ответить ещё раз; дубликата нет, т.к. ничего не сохранено.
        console.error('Ошибка сохранения напоминания:', err);
        await ctx.reply('⚠️ Не удалось сохранить напоминание. Попробуйте ответить ещё раз.', {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }
      await deletePromptSafe(prompt.id);
      await ctx.reply(`⏰ Напоминание установлено на ${formatDateTimeRu(parsed.dueAt)}`, {
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    const card = await store.findCallCard(chatId, replyTo.message_id);
    if (!card) {
      // Если это был ответ на уже закрытую карточку — предупреждаем, чтобы
      // резюме не потерялось молча. Иначе это обычный reply — игнорируем.
      if (wasCardRecentlyClosed(chatId, replyTo.message_id)) {
        await ctx.reply(
          '⚠️ Звонок уже закрыт (обработан в другой группе) — резюме не сохранено.',
          { reply_parameters: { message_id: message.message_id } },
        );
      }
      return;
    }

    let sentTo1C = false;
    let suffix: string;
    try {
      const { sent } = await onec.sendCallResult({
        // В 1С возвращаем её собственный id звонка; внутренний UUID её не интересует.
        callId: card.sourceCallId ?? card.callId,
        phone: card.phone,
        result: text,
        operatorId: from.id,
        operatorName,
        chatId,
        timestamp: nowIso,
      });
      sentTo1C = sent;
      suffix = sent ? ' и передан в 1С' : ' (1С: эндпоинт ещё не подключён — сохранено локально)';
    } catch (err) {
      if (err instanceof OnecNotConfiguredError) {
        suffix = ' (1С: эндпоинт ещё не подключён — сохранено локально)';
      } else {
        console.error('Ошибка передачи результата звонка в 1С:', err);
        suffix = ' (1С: ошибка передачи — сохранено локально)';
      }
    }

    // Сначала шлём подтверждение, чтобы запомнить его id и убрать вместе с
    // карточкой при «Обработано». Если отправка не удалась — результат всё равно
    // сохраняем (подтверждение не критично).
    let botReplyMessageId: number | undefined;
    try {
      const confirm = await ctx.reply(`✅ Результат разговора зафиксирован${suffix}`, {
        reply_parameters: { message_id: message.message_id },
      });
      botReplyMessageId = confirm.message_id;
    } catch (err) {
      console.error('Не удалось отправить подтверждение фиксации результата:', err);
    }

    const resultRecord: CallResultRecord = {
      id: randomUUID(),
      callId: card.callId,
      phone: card.phone,
      chatId,
      messageId: card.messageId,
      operatorMessageId: message.message_id,
      botReplyMessageId,
      clientName: card.clientName,
      resultText: text,
      operatorId: from.id,
      operatorName,
      createdAt: nowIso,
      sentTo1C,
    };
    await store.saveCallResult(resultRecord);

    // Публикуем карточку результата в каналы «Результаты» (best-effort):
    // руководитель просматривает резюме и помечает их «Принято».
    try {
      const sentRefs = await publishCallResult(bot, store, resultRecord);
      if (sentRefs.length > 0) {
        await store.updateCallResult(resultRecord.id, { resultMessages: sentRefs });
      }
    } catch (err) {
      console.error('Не удалось опубликовать результат в каналы «Результаты»:', err);
    }
  });

  bot.catch((err) => {
    console.error('Ошибка обработки обновления Telegram:', err.error);
  });

  return bot;
}
