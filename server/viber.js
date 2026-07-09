// Viber-бот RunFerry — канал агрегатора мессенджеров. Транспорт (формат событий,
// проверка подписи X-Viber-Content-Signature, отправка через chatapi.viber.com) — здесь;
// бизнес-логика (сессии, ИИ, эскалация) — в общем ядре messengerCore.js.
// Входящие -> chatSessions (channel='viber'). Требует Viber Chatbot (Bot API) токен
// (создаётся через партнёра / панель Viber; см. docs/messenger-integration-plan.md).
//
// Важно: Viber НЕ передаёт номер телефона клиента (нет кнопки «поділитися контактом»).
// Поэтому бот ПРОСИТ клиента прислать номер текстом (core.phoneAskLine) и извлекает его из
// сообщения (core.captureContactPhone → normalizePhone), после чего привязывает clientProfile.
import axios from 'axios'
import crypto from 'crypto'
import { createMessengerCore, nowIso, genMsgId, accumulateUsage } from './messengerCore.js'

const SENDER_NAME = 'RunFerry'
const WELCOME =
  'Вітаємо у RunFerry! 🚤 Напишіть, чим допомогти: ремонт/сервіс кораблика, купівля нового чи інше питання — і я підкажу або підключу менеджера.'

export function registerViberBot(app, deps) {
  const core = createMessengerCore(deps)
  const { adminDb } = deps
  const TOKEN = process.env.VIBER_BOT_TOKEN || ''
  const SETUP_SECRET = process.env.VIBER_WEBHOOK_SECRET || ''
  if (!TOKEN) console.warn('⚠️  VIBER_BOT_TOKEN is not set — Viber bot disabled (see .env.example)')

  // Проверка подписи Viber: HMAC-SHA256(тіло, token) у hex, заголовок X-Viber-Content-Signature.
  const verifySig = (req) => {
    if (!TOKEN) return false
    const sig = req.get('X-Viber-Content-Signature')
    if (!sig || !req.rawBody) return false
    const expected = crypto.createHmac('sha256', TOKEN).update(req.rawBody).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  const send = async (userId, text) => {
    if (!TOKEN) return null
    try {
      const r = await axios.post(
        'https://chatapi.viber.com/pa/send_message',
        { receiver: userId, min_api_version: 1, sender: { name: SENDER_NAME }, type: 'text', text },
        { headers: { 'X-Viber-Auth-Token': TOKEN }, timeout: 15000 }
      )
      return r.data
    } catch (e) {
      console.error('viberSend error:', (e.response && e.response.data) || e.message)
      return null
    }
  }

  // Отправитель по сессии (для доставки ответа менеджера из веб-инбокса).
  const sendToSession = (session, text) => send(session.channelUserId, text)
  if (deps.senders) deps.senders.viber = sendToSession

  app.post('/api/viber/webhook', async (req, res) => {
    if (!verifySig(req)) {
      console.warn('viber webhook: bad signature')
      return res.sendStatus(403)
    }
    const ev = req.body || {}

    // conversation_started: приветствие возвращаем прямо в теле ответа (политика Viber).
    if (ev.event === 'conversation_started') {
      return res.json({ sender: { name: SENDER_NAME }, type: 'text', text: WELCOME })
    }

    res.sendStatus(200) // остальные события подтверждаем сразу, обрабатываем асинхронно
    try {
      if (ev.event !== 'message' || !adminDb || !TOKEN) return
      const userId = ev.sender && ev.sender.id
      const name = (ev.sender && ev.sender.name) || null
      const text = ev.message && ev.message.type === 'text' ? String(ev.message.text || '').trim() : ''
      if (!userId) return

      let session = (await core.findSession('viber', userId)) || core.newSession('viber', userId, name)
      if (!text) {
        await send(userId, 'Надішліть, будь ласка, текстовий опис проблеми.')
        return
      }

      session.messages.push({ id: genMsgId(), role: 'client', text, at: nowIso() })
      await core.captureContactPhone(session, text) // клиент присылает номер текстом (Viber не даёт телефон)
      const { reply, needsManager, intent, usage } = await core.aiReply(session)
      session.messages.push({ id: genMsgId(), role: 'ai', text: reply, at: nowIso() })
      if (usage) session.aiUsage = accumulateUsage(session.aiUsage, usage)
      session.topic = intent
      if (needsManager) core.applyEscalation(session, intent)
      const ask = core.phoneAskLine(session) // если номера ещё нет — попросити (один раз)
      await core.saveSession(session)
      await send(userId, ask ? `${reply}\n\n${ask}` : reply)
      if (needsManager) {
        await send(userId, 'Ваш запит передано менеджеру — ми зв’яжемося з вами найближчим часом. 🙌')
      }
    } catch (e) {
      console.error('viber webhook error:', e.message)
    }
  })

  // Разовая настройка вебхука (защищена секретом, если задан VIBER_WEBHOOK_SECRET):
  // GET /api/viber/setup?url=https://<домен>/api/viber/webhook&secret=<VIBER_WEBHOOK_SECRET>
  app.get('/api/viber/setup', async (req, res) => {
    if (!TOKEN) return res.status(503).json({ error: 'VIBER_BOT_TOKEN not set' })
    if (SETUP_SECRET && req.query.secret !== SETUP_SECRET) return res.status(403).json({ error: 'bad secret' })
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'pass ?url=https://<домен>/api/viber/webhook' })
    try {
      const r = await axios.post(
        'https://chatapi.viber.com/pa/set_webhook',
        { url, event_types: ['message', 'conversation_started', 'subscribed', 'unsubscribed'], send_name: true, send_photo: false },
        { headers: { 'X-Viber-Auth-Token': TOKEN } }
      )
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })

  // Диагностика аккаунта бота
  app.get('/api/viber/info', async (req, res) => {
    if (!TOKEN) return res.status(503).json({ error: 'VIBER_BOT_TOKEN not set' })
    if (SETUP_SECRET && req.query.secret !== SETUP_SECRET) return res.status(403).json({ error: 'bad secret' })
    try {
      const r = await axios.post('https://chatapi.viber.com/pa/get_account_info', {}, { headers: { 'X-Viber-Auth-Token': TOKEN } })
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })
}

export default registerViberBot
