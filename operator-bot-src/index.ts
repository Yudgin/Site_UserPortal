import { randomUUID } from 'node:crypto';
import { webhookCallback } from 'grammy';
import type { RequestHandler } from 'express';
import { loadConfig } from './config.js';
import { MemoryStore } from './store/store.js';
import type { Store } from './store/store.js';
import { FirestoreStore } from './store/firestore.js';
import { FileStore } from './store/file.js';
import { createOnecClient } from './onec/client.js';
import { createBot } from './bot/index.js';
import { createDispatcher } from './bot/dispatcher.js';
import { createServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const store: Store =
    config.store === 'firestore'
      ? new FirestoreStore(config.firestoreProjectId)
      : config.store === 'file'
        ? new FileStore(config.fileStorePath)
        : new MemoryStore();
  const onec = createOnecClient(config);

  // Засеваем админ-пользователей из ADMIN_EMAILS, чтобы они могли войти через Google.
  for (const email of config.adminEmails) {
    const existing = await store.getUserByEmail(email);
    if (!existing) {
      const nowIso = new Date().toISOString();
      await store.saveUser({
        id: randomUUID(),
        name: email,
        email,
        role: 'admin',
        active: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } else if (existing.role !== 'admin' || !existing.active) {
      await store.updateUser(existing.id, { role: 'admin', active: true });
    }
  }

  const deps = { config, store, onec };
  const bot = createBot(deps);
  const dispatcher = createDispatcher(bot, deps);

  let telegramWebhook: RequestHandler | undefined;
  if (config.mode === 'webhook') {
    telegramWebhook = webhookCallback(bot, 'express', {
      secretToken: config.telegramWebhookSecret || undefined,
    });
  }

  // Username бота нужен порталу для ссылки привязки Telegram (best-effort).
  let botUsername: string | undefined;
  try {
    botUsername = (await bot.api.getMe()).username;
  } catch (err) {
    console.error('Не удалось получить username бота:', err);
  }

  const app = createServer({ config, store, dispatcher, webhookCallback: telegramWebhook, botUsername });

  const server = app.listen(config.port, () => {
    console.log(
      `HTTP-сервер запущен на порту ${config.port} (режим: ${config.mode}, хранилище: ${config.store})`,
    );
  });

  let remindersTimer: NodeJS.Timeout | undefined;

  if (config.mode === 'webhook') {
    // Сервис уже слушает порт (Cloud Run видит его «здоровым»). Установку webhook
    // делаем best-effort: без PUBLIC_URL или при сбое Telegram контейнер не падает.
    if (config.publicUrl) {
      const webhookUrl = `${config.publicUrl}/api/telegram/webhook`;
      try {
        // Ставим webhook только если адрес отличается — Cloud Run с min-instances=0
        // делает холодный старт на каждый апдейт, и переустановка на каждом старте
        // лишняя. Главное: НЕ передаём drop_pending_updates, иначе сообщения,
        // пришедшие во время холодного старта (в т.ч. регистрация веток), теряются.
        const info = await bot.api.getWebhookInfo();
        if (info.url !== webhookUrl) {
          await bot.api.setWebhook(webhookUrl, {
            secret_token: config.telegramWebhookSecret || undefined,
          });
          console.log(`Webhook Telegram установлен: ${webhookUrl}`);
        } else {
          console.log('Webhook Telegram уже настроен — пропускаю установку.');
        }
      } catch (err) {
        console.error('Не удалось установить webhook (сервис продолжит работу):', err);
      }
    } else {
      console.warn('PUBLIC_URL не задан — webhook не установлен. Задайте PUBLIC_URL и перезапустите сервис.');
    }
  } else {
    void bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      console.error('Ошибка long polling Telegram:', err);
    });
    console.log('Бот запущен в режиме long polling');

    // Локально нет Cloud Scheduler — проверяем напоминания сами раз в минуту.
    remindersTimer = setInterval(() => {
      dispatcher.processDueReminders().catch((err: unknown) => {
        console.error('Ошибка при отправке напоминаний:', err);
      });
      dispatcher.processDueTaskReminders().catch((err: unknown) => {
        console.error('Ошибка при отправке напоминаний-задач:', err);
      });
    }, 60_000);
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`Получен сигнал ${signal}, останавливаю приложение...`);
    if (remindersTimer) clearInterval(remindersTimer);
    void bot.stop().catch((err: unknown) => {
      console.error('Ошибка при остановке бота:', err);
    });
    server.close(() => {
      console.log('HTTP-сервер остановлен');
      process.exit(0);
    });
    // Страховка: не висеть из-за незакрытых keep-alive соединений.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('Не удалось запустить приложение:', err);
  process.exit(1);
});
