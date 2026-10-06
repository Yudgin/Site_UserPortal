import { InlineKeyboard } from 'grammy';
import { normalizePhone, } from '../types.js';
import { buildCallCardKeyboard, buildCallCardText, escapeHtml } from './callCard.js';
import { archiveTask } from './archive.js';
import { deliverTaskToAssignee } from './taskDeliver.js';
import { DEFAULT_LANG, isLang, t } from './i18n.js';
export function createDispatcher(bot, deps) {
    const { store, onec } = deps;
    // Дедуп одинаковых уведомлений о статусе: ретраи 1С не должны спамить клиента.
    const recentStatusNotifications = new Map();
    const STATUS_DEDUP_MS = 60_000;
    // Best-effort: после отправки карточек дотягиваем из 1С счётчики звонков/ремонтов.
    async function enrichCards(event, phone, sent) {
        const [calls, repairs] = await Promise.allSettled([
            onec.getCallHistory(phone),
            onec.getRepairs(phone),
        ]);
        const counts = {};
        if (calls.status === 'fulfilled' && Array.isArray(calls.value))
            counts.calls = calls.value.length;
        if (repairs.status === 'fulfilled' && Array.isArray(repairs.value))
            counts.repairs = repairs.value.length;
        if (counts.calls === undefined && counts.repairs === undefined)
            return;
        const text = buildCallCardText(event, counts);
        const keyboard = buildCallCardKeyboard(event.phone);
        for (const ref of sent) {
            try {
                await bot.api.editMessageText(ref.chatId, ref.messageId, text, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                });
            }
            catch {
                // Карточка уже доставлена — обогащение не критично.
            }
        }
    }
    /** Отправляет задачу/напоминание исполнителю в Telegram (если он привязан). */
    async function deliverTask(task) {
        return deliverTaskToAssignee(bot, store, task);
    }
    return {
        async dispatchIncomingCall(event) {
            const phone = normalizePhone(event.phone);
            const text = buildCallCardText(event);
            const keyboard = buildCallCardKeyboard(event.phone);
            // Дедуп повторных звонков: убираем прежние НЕобработанные карточки этого клиента,
            // чтобы в чатах оставалась только последняя.
            if (phone) {
                const stale = await store.findCallCardsByPhone(phone);
                for (const card of stale) {
                    try {
                        await bot.api.deleteMessage(card.chatId, card.messageId);
                    }
                    catch (err) {
                        console.error(`Не удалось удалить прежнюю карточку звонка ${card.messageId}:`, err);
                    }
                    await store.deleteCallCard(card.chatId, card.messageId);
                }
            }
            // Совпадение по сотруднику: общий канал (без employeeIds) получает всё;
            // канал с заданными номерами — только звонки, адресованные одному из них.
            const matchesEmployee = (ids) => {
                if (!ids || ids.length === 0)
                    return true;
                return event.employeeId !== undefined && ids.includes(event.employeeId);
            };
            // Цели маршрутизации: базовая цель чата (General/весь чат) + активные ветки.
            const [chats, threads] = await Promise.all([store.listChats(), store.listThreads()]);
            const targets = [];
            for (const chat of chats) {
                if (!chat.present)
                    continue;
                if (chat.active && chat.events.includes(event.type) && matchesEmployee(chat.employeeIds)) {
                    targets.push({ chatId: chat.id });
                }
                for (const thread of threads) {
                    if (thread.chatId === chat.id &&
                        thread.active &&
                        thread.events.includes(event.type) &&
                        matchesEmployee(thread.employeeIds)) {
                        targets.push({ chatId: chat.id, threadId: thread.threadId });
                    }
                }
            }
            const sent = [];
            for (const target of targets) {
                try {
                    const message = await bot.api.sendMessage(target.chatId, text, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard,
                        ...(target.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
                    });
                    await store.saveCallCard({
                        chatId: target.chatId,
                        messageId: message.message_id,
                        threadId: target.threadId,
                        callId: event.callId,
                        sourceCallId: event.sourceCallId,
                        phone,
                        clientName: event.clientName,
                        createdAt: new Date().toISOString(),
                    });
                    sent.push({ chatId: target.chatId, messageId: message.message_id });
                }
                catch (err) {
                    console.error(`Не удалось отправить карточку звонка в чат ${target.chatId}:`, err);
                }
            }
            if (sent.length > 0) {
                try {
                    await enrichCards(event, phone, sent);
                }
                catch (err) {
                    console.error('Ошибка обогащения карточки данными 1С:', err);
                }
            }
            return { delivered: sent.length };
        },
        async processDueReminders() {
            const due = await store.listDueReminders(new Date().toISOString());
            let sentCount = 0;
            for (const reminder of due) {
                const lines = ['⏰ <b>Напоминание</b>', escapeHtml(reminder.text)];
                if (reminder.phone)
                    lines.push(`☎️ +${escapeHtml(reminder.phone)}`);
                try {
                    await bot.api.sendMessage(reminder.chatId, lines.join('\n'), { parse_mode: 'HTML' });
                    await store.markReminderDone(reminder.id);
                    sentCount++;
                }
                catch (err) {
                    console.error(`Не удалось отправить напоминание ${reminder.id} в чат ${reminder.chatId}:`, err);
                }
            }
            return sentCount;
        },
        async notifyRepairStatus(event) {
            const phone = normalizePhone(event.phone);
            if (!phone)
                return { delivered: 0 };
            // Отсекаем повтор того же уведомления (ретрай 1С) в пределах окна дедупа.
            const dedupKey = `${phone}:${event.repairNumber ?? ''}:${event.status}`;
            const now = Date.now();
            const lastSent = recentStatusNotifications.get(dedupKey);
            if (lastSent !== undefined && now - lastSent < STATUS_DEDUP_MS) {
                return { delivered: 0 };
            }
            recentStatusNotifications.set(dedupKey, now);
            for (const [key, ts] of recentStatusNotifications) {
                if (now - ts > STATUS_DEDUP_MS)
                    recentStatusNotifications.delete(key);
            }
            const clients = await store.findClientLinksByPhone(phone);
            let delivered = 0;
            for (const client of clients) {
                const saved = await store.getUserLanguage(client.telegramUserId);
                const lang = isLang(saved) ? saved : DEFAULT_LANG;
                const lines = [`<b>${t(lang, 'notif_title')}</b>`];
                if (event.repairNumber) {
                    lines.push(t(lang, 'notif_repair_no', { number: escapeHtml(event.repairNumber) }));
                }
                lines.push(t(lang, 'notif_status', { status: escapeHtml(event.status) }));
                if (event.message)
                    lines.push(escapeHtml(event.message));
                const keyboard = event.repairNumber
                    ? new InlineKeyboard().text(t(lang, 'btn_open_repair'), `rd:${event.repairNumber}`)
                    : undefined;
                try {
                    await bot.api.sendMessage(client.chatId, lines.join('\n'), {
                        parse_mode: 'HTML',
                        reply_markup: keyboard,
                    });
                    delivered++;
                }
                catch (err) {
                    console.error(`Не удалось отправить уведомление клиенту ${client.chatId}:`, err);
                }
            }
            return { delivered };
        },
        deliverTask,
        async archiveCompletedTask(task) {
            return archiveTask(bot, store, task);
        },
        async processDueTaskReminders() {
            const due = await store.listDueTaskReminders(new Date().toISOString());
            let sent = 0;
            for (const task of due) {
                const delivered = await deliverTask(task);
                // Помечаем отправленным в любом случае, чтобы не зацикливаться, если не привязан.
                await store.updateTask(task.id, { notifiedAt: new Date().toISOString() });
                if (delivered)
                    sent++;
            }
            return sent;
        },
    };
}
