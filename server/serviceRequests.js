// Публичное создание НАШЕЙ локальной заявки на обслуживание из клиентской формы /repair/new
// (в дополнение к отправке в 1С). Заявку пишет BACKEND (admin SDK, минуя правила), а поля
// КОНТРОЛИРУЕТ сервер — клиент НЕ может задать статус/связи с калькуляциями/оплатой.
import crypto from 'crypto'
import { rateLimit } from './rateLimit.js'
import { normPhone } from './phone.js'

const nowIso = () => new Date().toISOString()
const clip = (v, n) => (v ? String(v).slice(0, n) : undefined)
const isEmpty = (v) => v === undefined || v === null || v === ''

// Публичный эндпоинт: 10 заявок/час на IP (анти-спам; id детерминированные и угадываемые).
const srLimiter = rateLimit({ name: 'service-requests', windowMs: 60 * 60 * 1000, max: 10 })

export function registerServiceRequests(app, deps) {
  const { adminDb } = deps

  app.post('/api/service-requests', srLimiter, async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const b = req.body || {}
      const sessionId = clip(b.sessionId, 64) || ''
      const externalRequestId = clip(b.externalRequestId, 64) || ''
      // Детерминированный id: по обращению (совпадает с master-созданной) → по 1С-заявке → случайный.
      const id = sessionId ? `sr-${sessionId}` : externalRequestId ? `sr-ext-${externalRequestId}` : `sr-${crypto.randomUUID().slice(0, 16)}`
      const ref = adminDb.collection('serviceRequests').doc(id)

      // Центр 1С, обраний клієнтом у формі (repair_ServoceList ID) → наш реєстр serviceCenters за
      // externalId (той самий код, що пише синк). Не знайдено — центр не ставимо і НЕ створюємо.
      let centerId = ''
      const centerExt = clip(b.serviceCenterExternalId, 32)
      if (centerExt) {
        try {
          const cs = await adminDb.collection('serviceCenters').where('externalId', '==', centerExt).limit(1).get()
          if (!cs.empty) centerId = cs.docs[0].id
        } catch (e) { console.warn('service-requests: center lookup failed:', e.message) }
      }
      // Телефон — канонічний +380…; нерозпізнаний лишаємо як ввів клієнт (обрізаний).
      const phone = normPhone(b.clientPhone) || clip(b.clientPhone, 32)

      const finalId = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        const cur = s.exists ? s.data() : null
        const now = nowIso()
        // status/id/createdAt — только при СОЗДАНИИ (не откатываем уже продвинутую заявку).
        const patch = {
          ...(s.exists ? {} : { id, createdAt: now, createdBy: 'client', status: 'new' }),
          updatedAt: now,
        }
        // Контент/связи: на СОЗДАНИИ ставим; на существующей — только ЗАПОЛНЯЕМ ПУСТЫЕ поля.
        // Иначе повторный (или подделанный по угадываемому id) запрос затёр бы PII реальной заявки.
        const fill = (key, val) => { if (val === undefined) return; if (!s.exists || isEmpty(cur[key])) patch[key] = val }
        fill('sessionId', sessionId || undefined)
        fill('externalRequestId', externalRequestId || undefined)
        fill('clientName', clip(b.clientName, 120))
        fill('clientPhone', phone)
        fill('serviceCenterId', centerId || undefined)
        fill('clientCityRef', clip(b.clientCityRef, 64))
        fill('clientCityName', clip(b.clientCityName, 120))
        fill('clientWarehouseRef', clip(b.clientWarehouseRef, 64))
        fill('clientWarehouseName', clip(b.clientWarehouseName, 200))
        fill('boat', clip(b.boat, 120))
        fill('complaint', clip(b.complaint, 2000))
        tx.set(ref, patch, { merge: true })
        return id
      })
      return res.json({ success: true, data: { id: finalId } })
    } catch (e) {
      console.error('service-requests create:', e.message)
      res.status(500).json({ success: false })
    }
  })
}

export default registerServiceRequests
