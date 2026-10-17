// Повторне надсилання клієнту посилання на сторінку його заявки (рішення власника 2026-10-17; записка
// runferry-briefs/telephony/resend-link-and-client-received-2026-10-18.md).
// Сторінка клієнта — /serviceshare/<GUID ремонту 1С>: саме це посилання 1С надсилає в SMS після створення ремонту,
// і сторінка читає дані з 1С за цим GUID. Немає GUID — немає сторінки (409 NO_CLIENT_PAGE), іншого посилання не шлемо.
// Канал обирає notifyClient (Telegram без вікна / Viber у 24 год / інакше SMS), запис — у журналі notifications
// (event 'link').
// Два входи, одне ядро resendRequestLink:
//   POST /api/voice-gateway/resend-link — ШІ-помічник голосового шлюзу: Authorization: Bearer VOICE_GATEWAY_TOKEN
//     (Secret Manager voice-gateway-token); тіло {serviceRequestId, gcid?}; gcid — один лист на дзвінок.
//   POST /api/service-requests/:id/resend-link — співробітник (owner/director/master; не-власник — лише свій центр);
//     тіло {clientKey?} — ключ від подвійного тапа, як у /api/notify.
// Спільний ліміт RESEND_LINK_PER_DAY (типово 3) на заявку за 24 год — у Firestore (notifyQuota/link-<id>), бо
// інстансів Cloud Run кілька. Невдала відправка ліміт не з'їдає. Телефону у відповідях немає.
import crypto from 'node:crypto'
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'

const DAY_MS = 24 * 3600 * 1000
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const GCID_RE = /^[A-Za-z0-9._-]{1,56}$/
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/ // як у notifications.js
const nowIso = () => new Date().toISOString()

// GUID ремонту 1С: мета синхронізації (onec.guid), інакше externalRequestId, якщо це GUID (заявки з форми й чату
// до першої синхронізації). Номер ремонту (000000577) не годиться: сторінка за номером не відкривається надійно.
export const clientPageGuid = (sr) => {
  for (const v of [sr?.onec?.guid, sr?.externalRequestId]) {
    const g = String(v || '').trim().toLowerCase()
    if (GUID_RE.test(g)) return g
  }
  return null
}
export const clientPageLink = (sr, siteUrl = 'https://my.runferry.com') => {
  const g = clientPageGuid(sr)
  return g ? `${String(siteUrl).replace(/\/+$/, '')}/serviceshare/${g}` : null
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}
const bearer = (req) => {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)
  return m ? m[1] : ''
}
const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, expose: true, ...extra })
const sendError = (res, e) => {
  // Свої помилки (fail) і 400 від notifyClient — як є; решта (Firestore, мережа) — 500 без подробиць.
  if (e?.expose || (e?.status === 400 && typeof e.code === 'string')) {
    if (e.retryAfterSec) res.setHeader('Retry-After', String(e.retryAfterSec))
    const extra = { ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}), ...(e.notificationId ? { notificationId: e.notificationId } : {}) }
    return res.status(e.status).json({ success: false, error: { code: e.code, message: e.message, ...extra } })
  }
  console.error('resend-link error:', e?.message || e)
  return res.status(500).json({ success: false, error: { code: 'RESEND_FAILED', message: 'Не вдалося надіслати посилання' } })
}

export function registerRequestLink(app, deps) {
  const {
    adminDb,
    notifyClient,
    siteUrl = 'https://my.runferry.com',
    verifyStaff = verifyFirebaseStaff,
    gatewayToken = process.env.VOICE_GATEWAY_TOKEN || '',
    perDay = Number(process.env.RESEND_LINK_PER_DAY || 3),
    now = () => Date.now(),
  } = deps
  if (!gatewayToken) console.warn('⚠️  VOICE_GATEWAY_TOKEN not set — POST /api/voice-gateway/resend-link answers 503')

  const quotaRef = (id) => adminDb.collection('notifyQuota').doc(`link-${id}`)
  // Забрати слот ліміту (транзакція: два інстанси не пропустять четвертий лист). → id слота для повернення.
  const takeSlot = async (id) => adminDb.runTransaction(async (tx) => {
    const ref = quotaRef(id)
    const snap = await tx.get(ref)
    const t = now()
    const hits = (snap.exists && Array.isArray(snap.data().hits) ? snap.data().hits : [])
      .filter((h) => h && Number.isFinite(Date.parse(h.at)) && t - Date.parse(h.at) < DAY_MS)
    if (hits.length >= perDay) {
      const oldest = Math.min(...hits.map((h) => Date.parse(h.at)))
      throw fail(429, 'LIMIT', 'Посилання на цю заявку вже надсилали сьогодні — спробуйте пізніше',
        { retryAfterSec: Math.max(60, Math.ceil((oldest + DAY_MS - t) / 1000)) })
    }
    const slot = { at: new Date(t).toISOString(), id: crypto.randomBytes(6).toString('hex') }
    tx.set(ref, { serviceRequestId: id, hits: [...hits, slot], updatedAt: nowIso() })
    return { slot, remaining: perDay - hits.length - 1 }
  })
  const returnSlot = (id, slotId) => adminDb.runTransaction(async (tx) => {
    const ref = quotaRef(id)
    const snap = await tx.get(ref)
    if (!snap.exists) return
    const hits = (Array.isArray(snap.data().hits) ? snap.data().hits : []).filter((h) => h && h.id !== slotId)
    tx.set(ref, { serviceRequestId: id, hits, updatedAt: nowIso() })
  }).catch((e) => console.warn('resend-link: slot not returned:', e?.message || e))

  // Відповідь без телефону і без тексту: id запису журналу, канал, скільки ще можна сьогодні.
  const view = (rec, extra) => ({ notificationId: rec.id || null, status: rec.status, channel: rec.channel || null, ...extra })

  async function resendRequestLink({ serviceRequestId, key = null, by, meta = null, sr: preloaded = null }) {
    let sr = preloaded
    if (!sr) {
      const snap = await adminDb.collection('serviceRequests').doc(serviceRequestId).get()
      sr = snap.exists ? snap.data() : null
    }
    if (!sr) throw fail(404, 'NO_SR', 'Заявку не знайдено')
    const link = clientPageLink(sr, siteUrl)
    if (!link) throw fail(409, 'NO_CLIENT_PAGE', 'У заявки немає сторінки клієнта (немає GUID ремонту 1С)')
    if (!sr.clientPhone && !sr.tgSessionId && !sr.sessionId) throw fail(409, 'NO_RECIPIENT', 'У заявки немає телефону чи чату клієнта')

    // Повтор того самого ключа (другий виклик інструмента в одному дзвінку, подвійний тап) — без нового листа і ліміту.
    if (key) {
      const prev = await adminDb.collection('notifications').doc(`ntf-${serviceRequestId}-link-${key}`).get()
      if (prev.exists && prev.data().status === 'sent') return view(prev.data(), { repeated: true })
    }
    const { slot, remaining } = await takeSlot(serviceRequestId)
    let rec
    try {
      rec = await notifyClient({ serviceRequestId, event: 'link', link, clientKey: key, by, meta })
    } catch (e) {
      await returnSlot(serviceRequestId, slot.id)
      throw e
    }
    if (rec?.skipped) {
      await returnSlot(serviceRequestId, slot.id)
      return view(rec, { repeated: true })
    }
    if (rec?.status !== 'sent') {
      await returnSlot(serviceRequestId, slot.id)
      throw fail(502, 'SEND_FAILED', 'Не вдалося надіслати посилання (канал доставки відмовив)', { notificationId: rec?.id })
    }
    return view(rec, { repeated: false, remainingToday: remaining })
  }

  // ---------- голосовий шлюз ----------
  // Загальний запобіжник на випадок витоку токена: не більше 30 запитів за хвилину на весь шлюз.
  const gatewayLimiter = rateLimit({ name: 'vg-resend-link', windowMs: 60 * 1000, max: 30, keyFn: () => 'gateway' })
  const gatewayGuard = (req, res, next) => {
    if (!gatewayToken) return res.status(503).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'VOICE_GATEWAY_TOKEN not set' } })
    if (!safeEqual(bearer(req), gatewayToken)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } })
    next()
  }
  app.post('/api/voice-gateway/resend-link', gatewayGuard, gatewayLimiter, async (req, res) => {
    try {
      const { serviceRequestId, gcid } = req.body || {}
      const id = typeof serviceRequestId === 'string' ? serviceRequestId.trim() : ''
      if (!SR_ID_RE.test(id)) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'serviceRequestId required' } })
      const g = gcid == null || gcid === '' ? null : String(gcid).trim()
      if (g !== null && !GCID_RE.test(g)) return res.status(400).json({ success: false, error: { code: 'BAD_GCID', message: 'gcid: 1–56 symbols A-Z a-z 0-9 . _ -' } })
      const key = g ? `vgcall-${g.replace(/\./g, '_')}` : null
      const data = await resendRequestLink({ serviceRequestId: id, key, by: 'voice-gateway', meta: { source: 'voice-gateway', ...(g ? { gcid: g } : {}) } })
      res.json({ success: true, data })
    } catch (e) {
      sendError(res, e)
    }
  })

  // ---------- співробітник (кнопка в застосунку/порталі — за бажанням власника) ----------
  const staffLimiter = rateLimit({ name: 'staff-resend-link', windowMs: 60 * 1000, max: 10, keyFn: (req) => req.staff.uid,
    message: 'Забагато запитів — зачекайте хвилину' })
  app.post('/api/service-requests/:id/resend-link', async (req, res) => {
    const staff = await verifyStaff(req, ['owner', 'director', 'master'])
    if (!staff) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника, директора або майстра' } })
    try {
      const id = String(req.params.id || '')
      if (!SR_ID_RE.test(id)) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Невірний id заявки' } })
      const { clientKey } = req.body || {}
      if (clientKey != null && clientKey !== '' && !CLIENT_KEY_RE.test(String(clientKey))) {
        return res.status(400).json({ success: false, error: { code: 'BAD_CLIENT_KEY', message: 'clientKey: 8–64 символи A-Z a-z 0-9 _ -' } })
      }
      const snap = await adminDb.collection('serviceRequests').doc(id).get()
      const sr = snap.exists ? snap.data() : null
      if (!sr) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
      if (staff.role !== 'owner') {
        const own = !!sr.serviceCenterId && staff.centers.some((c) => c && c.centerId === sr.serviceCenterId)
        if (!own) return res.status(403).json({ success: false, error: { code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' } })
      }
      req.staff = staff
      let passed = false
      staffLimiter(req, res, () => { passed = true })
      if (!passed) return
      const data = await resendRequestLink({ serviceRequestId: id, key: clientKey ? String(clientKey) : null, by: staff.email || staff.uid, meta: { source: 'staff' }, sr })
      res.json({ success: true, data })
    } catch (e) {
      sendError(res, e)
    }
  })

  return { resendRequestLink }
}

export default registerRequestLink
