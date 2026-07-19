// Deep-link Telegram: посилання t.me/<бот>?start=<токен>, яке привʼязує клієнта до заявки.
// Адмін генерує посилання із заявки (токен випадковий, зберігається в tgLinks/{token} і на
// заявці — стабільний, повторний запит повертає той самий URL). Обробка кліку — в telegram.js
// (гілка `/start <токен>`): бот одразу знає клієнта, привʼязує чат і вмикає сповіщення.
import axios from 'axios'
import crypto from 'crypto'
import { verifyFirebaseAdmin } from './adminAuth.js'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
let cachedUsername = process.env.TELEGRAM_BOT_USERNAME || ''

// Ім'я бота: env → getMe (кешується до перезапуску).
const botUsername = async () => {
  if (cachedUsername) return cachedUsername
  if (!TOKEN) return ''
  try {
    const { data } = await axios.get(`https://api.telegram.org/bot${TOKEN}/getMe`, { timeout: 10000 })
    cachedUsername = data?.result?.username || ''
  } catch (e) {
    console.error('tg getMe:', e.message)
  }
  return cachedUsername
}

// Токен: 32 base64url-символи (валідний payload deep-link: A-Z a-z 0-9 _ -, ≤64).
const newToken = () => crypto.randomBytes(24).toString('base64url')

export function registerTelegramLinks(app, deps) {
  const { adminDb } = deps

  // Створити (або повернути існуюче) Telegram-посилання для заявки.
  app.post('/api/telegram/link', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    }
    if (!adminDb) return res.status(503).json({ success: false })
    if (!TOKEN) return res.status(503).json({ success: false, error: { code: 'NO_BOT', message: 'TELEGRAM_BOT_TOKEN не задано' } })
    try {
      const srId = String(req.body?.serviceRequestId || '')
      if (!srId) return res.status(400).json({ success: false, error: { code: 'BAD_REQ', message: 'Потрібен serviceRequestId' } })
      const srRef = adminDb.collection('serviceRequests').doc(srId)
      const srSnap = await srRef.get()
      if (!srSnap.exists) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
      const sr = srSnap.data()

      const username = await botUsername()
      if (!username) return res.status(503).json({ success: false, error: { code: 'NO_USERNAME', message: 'Не вдалося отримати імʼя бота (getMe)' } })

      let token = sr.tgLinkToken || ''
      if (!token) {
        token = newToken()
        await srRef.set({ tgLinkToken: token, updatedAt: new Date().toISOString() }, { merge: true })
      }
      // Снапшот данных клиента кладём/обновляем в tgLinks — бот привяжет их при клике.
      await adminDb.collection('tgLinks').doc(token).set({
        serviceRequestId: srId,
        phone: sr.clientPhone || null,
        clientName: sr.clientName || null,
        requestNo: sr.externalRequestId || srId,
        createdAt: new Date().toISOString(),
      }, { merge: true })

      return res.json({ success: true, data: { url: `https://t.me/${username}?start=${token}`, token, connected: !!sr.tgSessionId } })
    } catch (e) {
      console.error('tg link error:', e?.message || e)
      res.status(500).json({ success: false, error: { code: 'LINK_FAILED', message: 'Не вдалося створити посилання' } })
    }
  })
}

export default registerTelegramLinks
