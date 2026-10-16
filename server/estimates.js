// Фактический кошторис из приложения сервиса (этап B брифа calculations-brief-2026-10-16):
//   POST   /api/estimates/actual              — создать факт по выбранному варианту пропозиції
//   POST   /api/estimates/:id/lines           — добавить позицию: { kind:'extra', title, amount, note?, clientKey }
//   DELETE /api/estimates/:id/lines/:refId    — убрать позицию extra:<id>
// Все маршруты — активный сотрудник owner/director/master (Bearer ID-token), затем права по центру заявки
// (мастер — perm «actual»), лимит 30/мин на uid. Приложение в priceEstimates/estimateOffers напрямую
// не пишет никогда — только сюда. Позиции из прайса (kind:'price') — B2, не реализовано (501).
// Поля оплаты не трогаются; клиент оповещается событием 'actual' через notifyClient (идемпотентно по заявке).
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'
import { createEstimateActions } from './estimateActions.js'

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
const err = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } })
const sendResult = (res, r, okStatus = 200) => (r.ok ? res.status(okStatus).json({ success: true, data: r.data }) : err(res, r.status || 500, r.code || 'FAILED', r.message || 'Не вдалося виконати дію'))

// deps: { adminDb, notifyClient?, verifyStaff? (подмена в тестах), actions? (подмена в тестах) }
export function registerEstimates(app, deps) {
  const { adminDb, notifyClient } = deps
  const verifyStaff = deps.verifyStaff || ((req) => verifyFirebaseStaff(req, ['owner', 'director', 'master']))
  const actions = deps.actions || (adminDb ? createEstimateActions({ adminDb }) : null)

  const staffOnly = async (req, res, next) => {
    const staff = await verifyStaff(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для власника, директора або майстра')
    req.staff = staff
    next()
  }
  const limiter = rateLimit({ name: 'estimates-app', windowMs: 60 * 1000, max: Number(process.env.ESTIMATES_PER_MIN || 30), keyFn: (req) => req.staff.uid, message: 'Забагато змін кошторису поспіль — зачекайте хвилину' })
  const ready = (req, res, next) => (actions ? next() : err(res, 503, 'NO_DB', 'Firestore не налаштовано'))

  // Оповещение клиента о готовом факте: ошибка доставки не отменяет созданный факт.
  const notifyActual = async (serviceRequestId, staff) => {
    if (typeof notifyClient !== 'function') return { status: 'skipped', error: 'notify not configured' }
    try {
      const rec = await notifyClient({ serviceRequestId, event: 'actual', by: staff.email || staff.uid })
      return { status: rec?.status || 'failed', channel: rec?.channel || null, via: rec?.via || null, skipped: !!rec?.skipped, error: rec?.error || null }
    } catch (e) {
      return { status: 'failed', channel: null, via: null, skipped: false, error: e?.message || String(e) }
    }
  }

  app.post('/api/estimates/actual', ready, staffOnly, limiter, async (req, res) => {
    try {
      const b = req.body || {}
      const requestId = String(b.serviceRequestId || '').trim()
      if (!requestId || !ID_RE.test(requestId)) return err(res, 400, 'NEED_REQUEST', 'Потрібна заявка')
      const parentEstimateId = b.parentEstimateId ? String(b.parentEstimateId).trim() : null
      if (parentEstimateId && !ID_RE.test(parentEstimateId)) return err(res, 400, 'BAD_PARENT', 'Некоректний id варіанта')
      const clientKey = b.clientKey ? String(b.clientKey) : null
      if (clientKey && !CLIENT_KEY_RE.test(clientKey)) return err(res, 400, 'BAD_CLIENT_KEY', 'Некоректний clientKey')
      const r = await actions.createActualFromVariant(req.staff, { requestId, parentEstimateId, clientKey }, { via: 'app' })
      if (!r.ok) return sendResult(res, r)
      const notify = r.data.created ? await notifyActual(requestId, req.staff) : { status: 'skipped', skipped: true, error: null }
      return res.status(r.data.created ? 201 : 200).json({ success: true, data: { ...r.data, notify } })
    } catch (e) {
      console.error('estimates/actual error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося скласти фактичний кошторис')
    }
  })

  app.post('/api/estimates/:id/lines', ready, staffOnly, limiter, async (req, res) => {
    try {
      const estimateId = String(req.params.id || '')
      if (!ID_RE.test(estimateId)) return err(res, 400, 'BAD_ID', 'Некоректний id кошторису')
      const b = req.body || {}
      const kind = String(b.kind || 'extra')
      if (kind === 'price') return err(res, 501, 'NOT_SUPPORTED', 'Позиції з прайсу з телефону поки не додаються — відкрийте редактор у порталі')
      if (kind !== 'extra') return err(res, 400, 'BAD_KIND', 'Невідомий тип позиції')
      const clientKey = b.clientKey ? String(b.clientKey) : null
      if (clientKey && !CLIENT_KEY_RE.test(clientKey)) return err(res, 400, 'BAD_CLIENT_KEY', 'Некоректний clientKey')
      const snap = await adminDb.collection('priceEstimates').doc(estimateId).get()
      if (!snap.exists) return err(res, 404, 'NO_ESTIMATE', 'Кошторис не знайдено')
      const est = snap.data()
      if (est.kind !== 'actual') return err(res, 400, 'NOT_ACTUAL', 'Позиції додаються лише до фактичного кошторису')
      if (!est.serviceRequestId) return err(res, 409, 'NO_SR', 'Кошторис не прив’язано до заявки')
      const r = await actions.addExtraExpense(req.staff, { requestId: est.serviceRequestId, estimateId, title: b.title, amount: b.amount, note: b.note, clientKey }, { via: 'app' })
      return sendResult(res, r, r.ok && !r.data.duplicate ? 201 : 200)
    } catch (e) {
      console.error('estimates/lines add error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося додати позицію')
    }
  })

  app.delete('/api/estimates/:id/lines/:refId', ready, staffOnly, limiter, async (req, res) => {
    try {
      const estimateId = String(req.params.id || '')
      if (!ID_RE.test(estimateId)) return err(res, 400, 'BAD_ID', 'Некоректний id кошторису')
      const refId = String(req.params.refId || '')
      const m = refId.match(/^extra:([A-Za-z0-9_-]{1,64})$/)
      if (!m) return err(res, 400, 'NOT_EXTRA', 'З телефону вилучаються лише позиції поза прайсом (extra:<id>)')
      const snap = await adminDb.collection('priceEstimates').doc(estimateId).get()
      if (!snap.exists) return err(res, 404, 'NO_ESTIMATE', 'Кошторис не знайдено')
      const est = snap.data()
      if (!est.serviceRequestId) return err(res, 409, 'NO_SR', 'Кошторис не прив’язано до заявки')
      const r = await actions.removeExtraExpense(req.staff, { requestId: est.serviceRequestId, estimateId, expenseId: m[1] }, { via: 'app' })
      return sendResult(res, r)
    } catch (e) {
      console.error('estimates/lines remove error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося вилучити позицію')
    }
  })

  return { actions }
}

export default registerEstimates
