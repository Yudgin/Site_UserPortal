// Telegram-бот RunFerry — канал агрегатора мессенджеров. Транспорт (webhook-формат,
// проверка секрета, отправка) — здесь; бизнес-логика (сессии, ИИ, профиль, эскалация)
// — в общем ядре messengerCore.js. Входящие -> chatSessions (channel='telegram').
import axios from 'axios'
import { createMessengerCore, nowIso, genMsgId, accumulateUsage } from './messengerCore.js'

export function registerTelegramBot(app, deps) {
  const core = createMessengerCore(deps)
  const { adminDb } = deps
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
  const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''
  if (!TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN is not set — Telegram bot disabled (see .env.example)')

  const api = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`

  const send = async (chatId, text, extra = {}) => {
    if (!TOKEN) return null
    try {
      const r = await axios.post(api('sendMessage'), { chat_id: chatId, text, ...extra }, { timeout: 15000 })
      return r.data
    } catch (e) {
      console.error('tgSend error:', (e.response && e.response.data) || e.message)
      return null
    }
  }

  // Обработка сообщения из БИЗНЕС-аккаунта (Telegram Business / Secretary Mode):
  // клиент пишет на личный аккаунт владельца, бот читает и отвечає від його імені.
  // Ключевой нюанс: business_message приходит и на сообщения САМОГО владельца — их не
  // трогаем, а лишь ставим бота на паузу для цього чату (людина перехопила діалог).
  // В приватному бізнес-чаті chat.id == id клієнта, тож from.id === chat.id ⇒ це клієнт.
  const handleBusinessMessage = async (bm) => {
    if (!adminDb) return
    const chat = bm.chat
    if (!chat || chat.type !== 'private' || !bm.from) return
    const text = (bm.text || '').trim()
    if (!text) return
    const connId = bm.business_connection_id
    const chatId = chat.id
    const channelUserId = String(chatId)
    const isFromClient = bm.from.id === chatId

    let session =
      (await core.findSession('telegram', channelUserId)) ||
      core.newSession('telegram', channelUserId, [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null)
    session.businessConnectionId = connId

    // Ручное сообщение владельца/менеджера → фиксируем и ставим бота на паузу в этом чате.
    if (!isFromClient) {
      session.messages.push({ id: genMsgId(), role: 'manager', text, at: nowIso() })
      session.botPaused = true
      await core.saveSession(session)
      return
    }

    // Сообщение клиента.
    session.messages.push({ id: genMsgId(), role: 'client', text, at: nowIso() })
    if (session.botPaused) {
      // Диалог ведёт человек — сохраняем сообщение (видно в инбоксе), но ИИ не отвечает.
      await core.saveSession(session)
      return
    }
    const { reply, needsManager, intent, usage } = await core.aiReply(session)
    session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
    if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
    session.topic = intent
    if (needsManager) core.applyEscalation(session, intent)
    await core.saveSession(session)
    await send(chatId, reply, { business_connection_id: connId })
    if (needsManager) {
      await send(chatId, 'Ваш запит передано менеджеру — ми зв’яжемося з вами найближчим часом. 🙌', { business_connection_id: connId })
    }
  }

  app.post('/api/telegram/webhook', async (req, res) => {
    // Отвечаем 200 сразу, чтобы Telegram не ретраил доставку.
    res.sendStatus(200)
    try {
      if (SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
        console.warn('tg webhook: bad secret token')
        return
      }
      if (!adminDb || !TOKEN) return
      const update = req.body || {}

      // Business (Secretary Mode): статус подключения бота к бизнес-аккаунту.
      if (update.business_connection) {
        const bc = update.business_connection
        console.log('tg business_connection:', bc.id, 'enabled=', bc.is_enabled, 'can_reply=', bc.can_reply)
        return
      }
      // Business: сообщение в чате личного аккаунта владельца.
      if (update.business_message) {
        await handleBusinessMessage(update.business_message)
        return
      }

      const m = update.message
      if (!m || !m.chat) return
      const chatId = m.chat.id
      const channelUserId = String(chatId)
      const fromName = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') || null

      // /start — приветствие + запрос контакта
      if (m.text && m.text.trim() === '/start') {
        await send(
          chatId,
          'Вітаємо у RunFerry! 🚤\n\nНапишіть, чим допомогти: ремонт/сервіс кораблика, купівля нового чи інше питання. Щоб ми могли з вами зв’язатися, поділіться, будь ласка, номером телефону кнопкою нижче.',
          {
            reply_markup: {
              keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        )
        return
      }

      let session = (await core.findSession('telegram', channelUserId)) || core.newSession('telegram', channelUserId, fromName)

      // клиент поделился контактом → сохраняем телефон + профиль
      if (m.contact && m.contact.phone_number) {
        const phone = m.contact.phone_number
        const cname =
          (session.contact && session.contact.name) ||
          [m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ') ||
          fromName ||
          undefined
        session.contact = { ...(session.contact || {}), phone, ...(cname ? { name: cname } : {}) }
        await core.saveSession(session)
        await core.upsertProfile(phone, { name: cname, sessionId: session.id })
        await send(chatId, 'Дякуємо! 📱 Тепер опишіть, будь ласка, що сталося з корабликом.', {
          reply_markup: { remove_keyboard: true },
        })
        return
      }

      const text = (m.text || '').trim()
      if (!text) {
        await send(chatId, 'Надішліть, будь ласка, текстовий опис проблеми.')
        return
      }

      session.messages.push({ id: genMsgId(), role: 'client', text, at: nowIso() })
      const { reply, needsManager, intent, usage } = await core.aiReply(session)
      session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
      if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
      session.topic = intent
      if (needsManager) core.applyEscalation(session, intent)
      await core.saveSession(session)
      await send(chatId, reply)
      if (needsManager) {
        await send(chatId, 'Ваш запит передано менеджеру — ми зв’яжемося з вами найближчим часом. 🙌')
      }
    } catch (e) {
      console.error('tg webhook error:', e.message)
    }
  })

  // Разовая настройка вебхука (защищена секретом):
  // GET /api/telegram/setup?url=https://<домен>/api/telegram/webhook&secret=<TELEGRAM_WEBHOOK_SECRET>
  app.get('/api/telegram/setup', async (req, res) => {
    if (!TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
    if (SECRET && req.query.secret !== SECRET) return res.status(403).json({ error: 'bad secret' })
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'pass ?url=https://<домен>/api/telegram/webhook' })
    try {
      const r = await axios.post(api('setWebhook'), {
        url,
        secret_token: SECRET || undefined,
        allowed_updates: ['message', 'business_connection', 'business_message'],
      })
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })

  app.get('/api/telegram/info', async (req, res) => {
    if (!TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
    if (SECRET && req.query.secret !== SECRET) return res.status(403).json({ error: 'bad secret' })
    try {
      const r = await axios.get(api('getWebhookInfo'))
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })
}

export default registerTelegramBot
