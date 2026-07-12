// Публичное создание НАШЕЙ локальной заявки на обслуживание из клиентской формы /repair/new
// (в дополнение к отправке в 1С). Заявку пишет BACKEND (admin SDK, минуя правила), а поля
// КОНТРОЛИРУЕТ сервер — клиент НЕ может задать статус/связи с калькуляциями/оплатой.
import crypto from 'crypto'
import { rateLimit } from './rateLimit.js'

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
        fill('clientPhone', clip(b.clientPhone, 32))
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
