// Операторский Telegram-бот (поглощение проекта TelegramBot). Логика бота НЕ переписана:
// исходники лежат в operator-bot-src/ (TypeScript), компилируются командой
// `npm run build:operator-bot` в server/operator-bot/ (ESM-JS, коммитится) и подключаются
// здесь как библиотека. Решения владельца: тот же бот с переездом вебхука к нам; операторы —
// коллекция botOperators; ремонты — сразу наши заявки; хостинг — этот Cloud Run.
//
// Внешний контракт (1С и Telegram менять не будут) сохранён байт в байт, но живёт под
// префиксом /operator-bot:
//   POST /operator-bot/api/events/call          (X-Auth-Token = OPERATOR_BOT_EVENTS_TOKEN)
//   POST /operator-bot/api/events/repair-status (тот же токен)
//   POST /operator-bot/api/cron/reminders       (X-Auth-Token = OPERATOR_BOT_CRON_TOKEN|events)
//   ANY  /operator-bot/api/telegram/webhook     (X-Telegram-Bot-Api-Secret-Token)
//   /operator-bot/admin/  — прежняя админка бота (вход по Bearer OPERATOR_BOT_ADMIN_TOKEN;
//                           Google-вход отключён — настройки чатов/веток/пользователей).
// Хранилище — Firestore ЭТОГО проекта: коллекции bot_* (users → botOperators), чтобы не
// пересекаться с порталом (users, callResults, botTasks — зеркало). Зеркало в журнал портала
// (portalMirror) ходит по HTTP на самого себя: PORTAL_BASE_URL/CALLS_INGEST_TOKEN.
// Пока TELEGRAM_OPERATOR_BOT_TOKEN не задан — модуль «спит» (безопасно деплоится).
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { webhookCallback } from 'grammy'
import { FirestoreStore } from './operator-bot/store/firestore.js'
import { createOnecClient } from './operator-bot/onec/client.js'
import { createBot } from './operator-bot/bot/index.js'
import { createDispatcher } from './operator-bot/bot/dispatcher.js'
import { createRouter } from './operator-bot/http/server.js'
import { syncRepairGuids } from './onecSync.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOUNT = '/operator-bot'

// Конфиг бота из env ЭТОГО сервера (имена с префиксом OPERATOR_BOT_/TELEGRAM_OPERATOR_,
// 1С-реквизиты — общие с остальным порталом).
const buildConfig = () => {
  const publicUrl = (process.env.OPERATOR_BOT_PUBLIC_URL || process.env.PUBLIC_BACKEND_URL || '').replace(/\/+$/, '')
  const eventsAuthToken = process.env.OPERATOR_BOT_EVENTS_TOKEN || ''
  const adminToken = process.env.OPERATOR_BOT_ADMIN_TOKEN || ''
  return {
    botToken: process.env.TELEGRAM_OPERATOR_BOT_TOKEN || '',
    mode: 'webhook',
    publicUrl: publicUrl ? `${publicUrl}${MOUNT}` : '',
    publicRootUrl: publicUrl, // корень бэкенда без префикса — для зеркала журнала (/api/calls/*)
    telegramWebhookSecret: process.env.TELEGRAM_OPERATOR_WEBHOOK_SECRET || '',
    port: 0,
    store: 'firestore',
    fileStorePath: '',
    firestoreProjectId: undefined,
    onec: {
      baseUrl: (process.env.ONEC_BASE_URL || 'https://portal.runferry.com/api/hs/facebook').replace(/\/+$/, ''),
      username: process.env.ONEC_USERNAME || undefined,
      password: process.env.ONEC_PASSWORD || undefined,
      callResultPath: process.env.ONEC_CALL_RESULT_PATH || undefined,
      boatsPath: process.env.ONEC_BOATS_PATH || '/{phone}/BoatList',
      consultationPath: process.env.ONEC_CONSULTATION_PATH || '/{phone}/consultation_NEW',
      botBaseUrl: process.env.ONEC_BOT_BASE_URL ? process.env.ONEC_BOT_BASE_URL.replace(/\/+$/, '') : undefined,
      botUsername: process.env.ONEC_BOT_USERNAME || undefined,
      botPassword: process.env.ONEC_BOT_PASSWORD || undefined,
    },
    eventsAuthToken,
    adminToken,
    cronAuthToken: process.env.OPERATOR_BOT_CRON_TOKEN || eventsAuthToken,
    googleClientId: undefined, // Google-вход в старую админку отключён; доступ — Bearer-токен владельца
    sessionSecret: adminToken || randomUUID(),
    adminEmails: (process.env.OPERATOR_BOT_ADMIN_EMAILS || 'admin@runferry.de').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    defaults: {
      serviceCode: process.env.DEFAULT_SERVICE_CODE || '000000001',
      cityGuid: process.env.DEFAULT_CITY_GUID || '',
      warehouseGuid: process.env.DEFAULT_WAREHOUSE_GUID || '',
    },
    timezone: process.env.TZ || 'Europe/Kyiv',
  }
}

export function registerOperatorBot(app, deps) {
  const { adminDb } = deps
  const config = buildConfig()
  if (!config.botToken) {
    console.log('operatorBot: TELEGRAM_OPERATOR_BOT_TOKEN не задано — модуль вимкнено (фаза Б4)')
    return
  }
  if (!adminDb) { console.error('operatorBot: нет Firestore (adminDb) — модуль выключен'); return }
  if (!config.eventsAuthToken || !config.adminToken || !config.telegramWebhookSecret) {
    console.error('operatorBot: нужны OPERATOR_BOT_EVENTS_TOKEN, OPERATOR_BOT_ADMIN_TOKEN и TELEGRAM_OPERATOR_WEBHOOK_SECRET — модуль выключен')
    return
  }
  // Зеркало в журнал портала — на самого себя (те же эндпоинты /api/calls/*, что раньше
  // дёргал внешний бот). Env читаются лениво внутри portalMirror.
  if (!process.env.PORTAL_BASE_URL && config.publicRootUrl) process.env.PORTAL_BASE_URL = config.publicRootUrl
  if (!process.env.PORTAL_CALLS_TOKEN && process.env.CALLS_INGEST_TOKEN) process.env.PORTAL_CALLS_TOKEN = process.env.CALLS_INGEST_TOKEN
  if (process.env.PORTAL_BASE_URL && process.env.PORTAL_CALLS_TOKEN) console.log(`operatorBot: зеркало журналу → ${process.env.PORTAL_BASE_URL}/api/calls/*`)
  else console.warn('operatorBot: зеркало в журнал ВЫКЛЮЧЕНО (нет OPERATOR_BOT_PUBLIC_URL или CALLS_INGEST_TOKEN)')

  const store = new FirestoreStore(undefined, { collectionPrefix: 'bot_', collectionNames: { users: 'botOperators' } })
  const onec = createOnecClient(config)

  // Ремонт, созданный оператором из бота (1С repair_NEW → GUID) — сразу наша заявка sr-ext-<guid>
  // (та же схема, что у ежедневной синхронизации; ручной перенос и автоимпорт сходятся).
  const onRepairCreated = ({ id }) => {
    syncRepairGuids([id]).then((r) => {
      if (r) console.log(`operatorBot: ремонт ${id} → заявка (created=${r.created} updated=${r.updated} errors=${r.errors.length})`)
    }).catch((e) => console.error('operatorBot onRepairCreated:', e?.message || e))
  }

  const botDeps = { config, store, onec, onRepairCreated }
  const bot = createBot(botDeps)
  const dispatcher = createDispatcher(bot, botDeps)
  // grammy по таймауту (дефолт 10 с, onTimeout 'throw') и при любой ошибке middleware реджектит
  // promise; Express 4 его отбрасывает → unhandledRejection → упал бы ВЕСЬ процесс портала.
  // Поэтому: по таймауту отвечаем 200 и даём обработчику дожить в фоне (1С отвечает до 15 с),
  // а любой reject ловим сами и тоже отвечаем 200, чтобы Telegram не ретраил апдейт бесконечно.
  const grammyWebhook = webhookCallback(bot, 'express', {
    secretToken: config.telegramWebhookSecret,
    timeoutMilliseconds: 25000,
    onTimeout: 'return',
  })
  const telegramWebhook = (req, res, next) => {
    Promise.resolve(grammyWebhook(req, res, next)).catch((e) => {
      console.error('operatorBot webhook:', e?.message || e)
      if (res.headersSent) return
      // Бот не инициализировался (getMe упал: Telegram/сеть) — 503, пусть Telegram повторит;
      // ошибка внутри обработчика — 200, иначе «ядовитый» апдейт заблокирует очередь ретраями.
      res.sendStatus(typeof bot.isInited === 'function' && !bot.isInited() ? 503 : 200)
    })
  }

  // Роутер монтируем СИНХРОННО — иначе он лёг бы после catch-all json-server (index.js) и все
  // /operator-bot/* отвечали бы 404. botUsername дописываем позже: createRouter читает
  // deps.botUsername при запросе, а не при создании.
  const routerDeps = {
    config, store, dispatcher, webhookCallback: telegramWebhook, botUsername: undefined,
    adminStaticDir: path.join(HERE, 'operator-bot', 'public', 'admin'),
  }
  app.use(MOUNT, createRouter(routerDeps))
  console.log(`operatorBot: смонтирован під ${MOUNT}`)

  ;(async () => {
    // Владелец — админ в реестре операторов бота (как в standalone-запуске).
    for (const email of config.adminEmails) {
      try {
        const existing = await store.getUserByEmail(email)
        const now = new Date().toISOString()
        if (!existing) await store.saveUser({ id: randomUUID(), name: email, email, role: 'admin', active: true, createdAt: now, updatedAt: now })
        else if (existing.role !== 'admin' || !existing.active) await store.updateUser(existing.id, { role: 'admin', active: true })
      } catch (e) { console.error('operatorBot: seed admin', email, e?.message || e) }
    }
    try { routerDeps.botUsername = (await bot.api.getMe()).username } catch (e) { console.error('operatorBot: getMe', e?.message || e) }
    console.log(`operatorBot: бот @${routerDeps.botUsername || '?'}`)

    // Вебхук Telegram — best-effort и только если адрес отличается (как в оригинале).
    if (config.publicUrl) {
      const url = `${config.publicUrl}/api/telegram/webhook`
      try {
        const info = await bot.api.getWebhookInfo()
        if (info.url !== url) {
          await bot.api.setWebhook(url, { secret_token: config.telegramWebhookSecret })
          console.log('operatorBot: webhook установлен', url)
        }
      } catch (e) { console.error('operatorBot: setWebhook', e?.message || e) }
    } else {
      console.warn('operatorBot: OPERATOR_BOT_PUBLIC_URL не задан — webhook не переустанавливаю')
    }
  })().catch((e) => console.error('operatorBot init:', e?.message || e))
}

export default registerOperatorBot
