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
      const m = update.message
      if (!m || !m.chat) return
      const chatId = m.chat.id
      const channelUserId = String(chatId)
      const fromName = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') || null

      // /start — приветствие + запрос контакта
      if (m.text && m.text.trim() === '/start') {
        await send(
          chatId,
          'Вітаємо у сервісі RunFerry! 🚤\n\nОпишіть вашу проблему з корабликом — я орієнтовно оціню ремонт. Щоб ми могли з вами зв’язатися, поділіться, будь ласка, номером телефону кнопкою нижче.',
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
      const { reply, needsManager, usage } = await core.aiReply(session)
      session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
      if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
      if (needsManager) core.applyEscalation(session)
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
      const r = await axios.post(api('setWebhook'), { url, secret_token: SECRET || undefined, allowed_updates: ['message'] })
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
