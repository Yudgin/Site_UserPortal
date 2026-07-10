// Публичное создание НАШЕЙ локальной заявки на обслуживание из клиентской формы /repair/new
// (в дополнение к отправке в 1С). Заявку пишет BACKEND (admin SDK, минуя правила), а поля
// КОНТРОЛИРУЕТ сервер — клиент НЕ может задать статус/связи с калькуляциями/оплатой.
import crypto from 'crypto'

const nowIso = () => new Date().toISOString()
const clip = (v, n) => (v ? String(v).slice(0, n) : undefined)

export function registerServiceRequests(app, deps) {
  const { adminDb } = deps

  app.post('/api/service-requests', async (req, res) => {
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
        const now = nowIso()
        // status/id/createdAt — только при СОЗДАНИИ (не откатываем уже продвинутую заявку).
        const patch = {
          ...(s.exists ? {} : { id, createdAt: now, createdBy: 'client', status: 'new' }),
          ...(sessionId ? { sessionId } : {}),
          ...(externalRequestId ? { externalRequestId } : {}),
          ...(clip(b.clientName, 120) ? { clientName: clip(b.clientName, 120) } : {}),
          ...(clip(b.clientPhone, 32) ? { clientPhone: clip(b.clientPhone, 32) } : {}),
          ...(clip(b.boat, 120) ? { boat: clip(b.boat, 120) } : {}),
          ...(clip(b.complaint, 2000) ? { complaint: clip(b.complaint, 2000) } : {}),
          updatedAt: now,
        }
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
