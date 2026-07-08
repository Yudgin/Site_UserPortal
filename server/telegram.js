// Telegram-бот RunFerry — первый канал агрегатора мессенджеров.
// Входящие сообщения приходят на /api/telegram/webhook, нормализуются в общую
// модель chatSessions (channel='telegram'), привязываются к профилю клиента по
// телефону (когда клиент делится контактом), и на них отвечает тот же ИИ, что и
// в веб-чате. Ответы уходят обратно через Telegram sendMessage. Эскалация помечает
// сессию как 'escalated' → она видна менеджеру в общем инбоксе.
//
// Персистенция — через firebase-admin (сервер пишет Firestore напрямую, минуя
// клиентские правила; это доверенный backend). ИИ-константы (anthropic, модель,
// системный промпт, слияние ролей, подсчёт usage) передаются из index.js.
import axios from 'axios'
import { FieldValue } from 'firebase-admin/firestore'

const round2 = (n) => Math.round(n * 100) / 100
const nowIso = () => new Date().toISOString()
const genMsgId = () => Math.random().toString(36).slice(2, 10)
const genSessionId = () => 'tg-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

// Нормализация телефона (зеркало src/utils/phone.ts) — ключ профиля клиента
const normalizePhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('80')) d = '380' + d.slice(2)
  else if (d.length === 10 && d.startsWith('0')) d = '38' + d
  else if (d.length === 9) d = '380' + d
  return d
}

// Ставка нормо-часа из расшифровки (зеркало computeLaborRate в src/utils/pricing.ts)
const computeRate = (breakdown) => {
  const comps = (breakdown && breakdown.components) || []
  const salary = comps.filter((c) => c.kind === 'amount').reduce((a, c) => a + c.value, 0)
  let cumulative = salary
  for (const c of comps.filter((c) => c.kind === 'percent' && c.base !== 'revenue')) {
    const from = c.base === 'salary' ? salary : cumulative
    cumulative = round2(cumulative + (from * c.value) / 100)
  }
  const revPct = Math.min(
    comps.filter((c) => c.kind === 'percent' && c.base === 'revenue').reduce((a, c) => a + c.value, 0) / 100,
    0.99
  )
  let rate = cumulative
  if (revPct > 0) rate = round2(cumulative / (1 - revPct))
  return rate
}

// Накопление usage по сессии (зеркало accumulateUsage в ClientChatPage)
const accumulateUsage = (prev, u) => {
  if (!u) return prev
  const base = prev || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  return {
    calls: base.calls + 1,
    inputTokens: base.inputTokens + (u.inputTokens || 0),
    outputTokens: base.outputTokens + (u.outputTokens || 0),
    costUsd: round2(base.costUsd + (u.costUsd || 0) + 0) || base.costUsd,
  }
}

// Срок ответа менеджера при эскалации — приблизительно 48 часов (MVP; точный расчёт
// рабочих часов, как на клиенте, добавим позже).
const escalationDue = () => new Date(Date.now() + 48 * 3600 * 1000).toISOString()

export function registerTelegramBot(app, deps) {
  const { adminDb, anthropic, AI_MODEL, CHAT_SYSTEM, mergeConsecutiveMessages, buildUsage } = deps
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

  // Компактный прайс-контекст для ИИ, собранный из priceList/current на сервере.
  const buildPriceContext = async () => {
    if (!adminDb) return ''
    try {
      const snap = await adminDb.doc('priceList/current').get()
      if (!snap.exists) return ''
      const pl = snap.data()
      const s = pl.settings || {}
      const rate = s.rateBreakdown ? computeRate(s.rateBreakdown) : s.laborRatePerHour || 0
      const mats = new Map((pl.materials || []).map((m) => [m.id, m]))
      const lines = (pl.works || [])
        .filter((w) => w.active && w.publicVisible)
        .map((w) => {
          const labor = Math.round((w.laborHours || 0) * rate)
          const matCost = Math.round(
            (w.materials || []).reduce((a, r) => a + ((mats.get(r.materialId) || {}).price || 0) * (r.qty || 1), 0)
          )
          const name = (w.name && w.name.uk) || w.code
          return `${w.code} — ${name}: ~${labor + matCost} грн${matCost ? ` (робота ~${labor}, матеріали ~${matCost})` : ''}`
        })
      return lines.join('\n')
    } catch (e) {
      console.error('tg buildPriceContext:', e.message)
      return ''
    }
  }

  // ---- работа с сессиями (Admin SDK, минуя клиентские правила) ----
  const findSession = async (channelUserId) => {
    const q = await adminDb
      .collection('chatSessions')
      .where('channel', '==', 'telegram')
      .where('channelUserId', '==', String(channelUserId))
      .limit(1)
      .get()
    return q.empty ? null : q.docs[0].data()
  }
  const saveSession = async (session) => {
    await adminDb.collection('chatSessions').doc(session.id).set({ ...session, updatedAt: nowIso() })
  }
  const upsertProfile = async (phone, { name, sessionId }) => {
    const id = normalizePhone(phone)
    if (!id) return
    await adminDb
      .collection('clientProfiles')
      .doc(id)
      .set(
        {
          id,
          phone: id,
          updatedAt: nowIso(),
          ...(name ? { name } : {}),
          ...(sessionId ? { sessionIds: FieldValue.arrayUnion(sessionId) } : {}),
        },
        { merge: true }
      )
  }

  // Ответ ИИ по истории сессии (тот же CHAT_SYSTEM, что и в веб-чате)
  const aiReply = async (session) => {
    const history = mergeConsecutiveMessages(
      session.messages
        .filter((m) => !m.internal && m.text)
        .map((m) => ({ role: m.role === 'client' ? 'user' : 'assistant', content: String(m.text) }))
    )
    if (!history.length || history[0].role !== 'user') {
      return { reply: 'Опишіть, будь ласка, вашу проблему з корабликом.', needsManager: false }
    }
    const priceContext = await buildPriceContext()
    const system = CHAT_SYSTEM + (priceContext ? `\n\nПРАЙС (лише ці позиції можна використовувати для оцінки):\n${priceContext}` : '')
    try {
      const msg = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1500,
        system,
        messages: history,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { reply: { type: 'string' }, needsManager: { type: 'boolean' } },
              required: ['reply', 'needsManager'],
            },
          },
        },
      })
      const raw = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = { reply: raw, needsManager: false }
      }
      return {
        reply: parsed.reply || 'Вибачте, не вдалося сформувати відповідь.',
        needsManager: !!parsed.needsManager,
        usage: buildUsage(msg.usage),
      }
    } catch (e) {
      console.error('tg aiReply error:', e.message)
      return { reply: 'Вибачте, сталася технічна помилка. Спробуйте, будь ласка, ще раз трохи пізніше.', needsManager: false }
    }
  }

  // ---- webhook приёма сообщений ----
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

      // найти/создать сессию
      let session = await findSession(channelUserId)
      if (!session) {
        session = {
          id: genSessionId(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          status: 'active',
          lang: 'uk',
          requestId: null,
          contact: fromName ? { name: fromName } : null,
          messages: [],
          escalation: null,
          reminders: [],
          channel: 'telegram',
          channelUserId,
        }
      }

      // клиент поделился контактом → сохраняем телефон + профиль
      if (m.contact && m.contact.phone_number) {
        const phone = m.contact.phone_number
        const cname =
          (session.contact && session.contact.name) ||
          [m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ') ||
          fromName ||
          undefined
        session.contact = { ...(session.contact || {}), phone, ...(cname ? { name: cname } : {}) }
        await saveSession(session)
        await upsertProfile(phone, { name: cname, sessionId: session.id })
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

      // сообщение клиента → ответ ИИ
      session.messages.push({ id: genMsgId(), role: 'client', text, at: nowIso() })
      const { reply, needsManager, usage } = await aiReply(session)
      session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
      if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
      if (needsManager && session.status === 'active') {
        session.status = 'escalated'
        session.escalation = {
          escalatedAt: nowIso(),
          reason: 'Автоматичний помічник передав запит менеджеру',
          dueAt: escalationDue(),
          resolvedAt: null,
          managerEmail: null,
        }
      }
      await saveSession(session)
      await send(chatId, reply)
      if (needsManager) {
        await send(chatId, 'Ваш запит передано менеджеру — ми зв’яжемося з вами найближчим часом. 🙌')
      }
    } catch (e) {
      console.error('tg webhook error:', e.message)
    }
  })

  // ---- разовая настройка вебхука (защищена секретом) ----
  // Вызвать: GET /api/telegram/setup?url=https://<домен>/api/telegram/webhook&secret=<TELEGRAM_WEBHOOK_SECRET>
  app.get('/api/telegram/setup', async (req, res) => {
    if (!TOKEN) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
    if (SECRET && req.query.secret !== SECRET) return res.status(403).json({ error: 'bad secret' })
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'pass ?url=https://<домен>/api/telegram/webhook' })
    try {
      const r = await axios.post(api('setWebhook'), {
        url,
        secret_token: SECRET || undefined,
        allowed_updates: ['message'],
      })
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })

  // Статус/диагностика вебхука
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
