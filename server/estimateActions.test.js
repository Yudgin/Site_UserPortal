// node --test: действия над фактом на фейковом Firestore (в памяти, с транзакциями) и HTTP-маршруты
// estimates.js с подменой проверки сотрудника — без сети и без firebase-admin.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createEstimateActions } from './estimateActions.js'
import { registerEstimates } from './estimates.js'
import { applyEstimateDiscount, recomputeTotals } from './estimateEngine.js'

// ---------- фейковый Firestore ----------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) { this.data = clone(seed); this.writes = 0 }
  collection(name) {
    const db = this
    if (!db.data[name]) db.data[name] = {}
    return {
      doc(id) {
        const did = id || `auto-${Math.random().toString(36).slice(2, 8)}`
        const ref = {
          id: did, _col: name,
          async get() { const d = db.data[name][did]; return { id: did, exists: !!d, data: () => clone(d) } },
          async set(v, opts) { db._set(name, did, v, opts) },
        }
        return ref
      },
    }
  }
  _set(name, id, v, opts) {
    this.writes++
    if (opts && opts.merge && this.data[name][id]) deepMerge(this.data[name][id], v)
    else this.data[name][id] = clone(v)
  }
  async runTransaction(fn) {
    const db = this
    const tx = {
      async get(ref) { return ref.get() },
      set(ref, v, opts) { db._set(ref._col, ref.id, v, opts) },
    }
    return fn(tx)
  }
}

const line = (refId, lineTotal, extra = {}) => ({ type: 'labor', refId, code: refId, name: { uk: `Робота ${refId}` }, qty: 1, unitPrice: lineTotal, seasonApplied: false, lineTotal, ...extra })
const variant = (id, total, extra = {}) => ({
  id, kind: 'preliminary', stage: 'proposed', status: 'approved', offerId: 'off-1', serviceRequestId: 'sr-1', variantLabel: id,
  title: 'Кошторис', complaint: 'кермо', sections: [{ complaint: 'Кермо', serviceKind: 'repair' }], seasonId: 's', seasonCoefficient: 1, seasonSurchargeApplied: false,
  laborRatePerHour: 500, currency: 'UAH', createdAt: '2026-10-10T00:00:00.000Z', createdBy: 'o@x', requestId: null, discount: null,
  ...recomputeTotals({}, [line('w1', total, { complaintIndex: 0 })]), ...extra,
})
const seed = () => ({
  serviceRequests: {
    'sr-1': { status: 'approved', serviceCenterId: 'c1', offerId: 'off-1', clientPhone: '+380671234567', specialists: [{ uid: 'u-m', name: 'Майстер' }], extraExpenses: [] },
    'sr-2': { status: 'new', serviceCenterId: 'c2' },
  },
  estimateOffers: { 'off-1': { serviceRequestId: 'sr-1', variantIds: ['var-1', 'var-2'], selectedVariantId: 'var-2', status: 'chosen' } },
  priceEstimates: { 'var-1': variant('var-1', 1000), 'var-2': variant('var-2', 2000) },
  serviceCenters: { c1: { name: 'Київ', defaultFopByMethod: { liqpayCard: 'fop-1', cod: 'fop-2' } }, c2: { name: 'Без ФОП' } },
})
const master = { uid: 'u-m', email: 'm@x', role: 'master', centers: [{ centerId: 'c1', perms: ['view', 'actual'] }] }
const viewer = { uid: 'u-v', email: 'v@x', role: 'master', centers: [{ centerId: 'c1', perms: ['view'] }] }
const owner = { uid: 'u-o', email: 'o@x', role: 'owner', centers: [] }

// ---------- createActualFromVariant ----------
test('createActualFromVariant: copies the chosen variant, moves the request to in_work, locks the offer, applies pending expenses', async () => {
  const db = new FakeDb(seed())
  db.data.serviceRequests['sr-1'].extraExpenses = [{ id: 'x1', title: 'Доставка', amount: 100, at: 't', by: 'b@x', appliedToEstimateId: null }, { id: 'x0', title: 'стара', amount: 5, appliedToEstimateId: 'other' }]
  const a = createEstimateActions({ adminDb: db })
  const r = await a.createActualFromVariant(master, { requestId: 'sr-1', clientKey: 'key-00000001' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.created, true)
  assert.equal(r.data.total, 2100)
  assert.equal(r.data.status, 'approved') // +5 % — в пределах порога
  assert.equal(r.data.appliedExpenses, 1)
  const est = db.data.priceEstimates[r.data.estimateId]
  assert.equal(est.kind, 'actual')
  assert.equal(est.parentEstimateId, 'var-2')
  assert.equal(est.serviceRequestId, 'sr-1')
  assert.deepEqual(est.payOptions, [{ method: 'liqpayCard', fopId: 'fop-1' }, { method: 'cod', fopId: 'fop-2' }])
  assert.equal(est.fopId, 'fop-1')
  assert.equal(est.lines.length, 2)
  assert.equal(est.lines[1].refId, 'extra:x1')
  assert.equal(est.receiptGoods.length, 2)
  assert.deepEqual(est.specialistPayouts, [{ uid: 'u-m', name: 'Майстер', specialistAmount: 0, centerAdminAmount: 0 }])
  assert.equal(est.createdWithKey, 'key-00000001')
  assert.equal(est.lastEditedVia, 'app')
  const sr = db.data.serviceRequests['sr-1']
  assert.equal(sr.actualEstimateId, r.data.estimateId)
  assert.equal(sr.status, 'in_work')
  assert.equal(sr.extraExpenses[0].appliedToEstimateId, r.data.estimateId)
  assert.equal(sr.extraExpenses[1].appliedToEstimateId, 'other')
  assert.equal(db.data.estimateOffers['off-1'].status, 'locked')
  // Повтор с тем же ключом — идемпотентно, без второго факта.
  const again = await a.createActualFromVariant(master, { requestId: 'sr-1', clientKey: 'key-00000001' })
  assert.equal(again.ok, true)
  assert.equal(again.data.created, false)
  assert.equal(again.data.estimateId, r.data.estimateId)
  // Другой ключ — факт уже есть.
  const other = await a.createActualFromVariant(master, { requestId: 'sr-1', clientKey: 'key-00000002' })
  assert.equal(other.ok, false)
  assert.equal(other.code, 'ALREADY_EXISTS')
})

test('createActualFromVariant: reapproval when the variant total grew with pending expenses; explicit parent; discount kept', async () => {
  const db = new FakeDb(seed())
  db.data.priceEstimates['var-1'] = { ...variant('var-1', 1000), ...applyEstimateDiscount(recomputeTotals({}, [line('w1', 1000, { complaintIndex: 0 })]), { value: 10, kind: 'pct' }) }
  db.data.serviceRequests['sr-1'].extraExpenses = [{ id: 'x1', title: 'Деталь', amount: 500, appliedToEstimateId: null }]
  const a = createEstimateActions({ adminDb: db })
  const r = await a.createActualFromVariant(owner, { requestId: 'sr-1', parentEstimateId: 'var-1' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.total, 1350) // (1000 + 500) − 10 %
  assert.equal(r.data.status, 'pending_approval') // 900 → 1350 = +50 %
  assert.equal(r.data.reapproval.required, true)
  const est = db.data.priceEstimates[r.data.estimateId]
  assert.equal(est.discount.grossTotal, 1500)
  assert.equal(est.parentEstimateId, 'var-1')
})

test('createActualFromVariant: errors — no permission, other center, no variant, no FOP, cancelled, bad parent', async () => {
  const db = new FakeDb(seed())
  const a = createEstimateActions({ adminDb: db })
  assert.equal((await a.createActualFromVariant(viewer, { requestId: 'sr-1' })).code, 'NO_PERM_ACTUAL')
  assert.equal((await a.createActualFromVariant(master, { requestId: 'sr-2' })).code, 'OTHER_CENTER')
  assert.equal((await a.createActualFromVariant(master, { requestId: 'nope' })).code, 'NO_SR')
  db.data.estimateOffers['off-1'].selectedVariantId = null
  assert.equal((await a.createActualFromVariant(master, { requestId: 'sr-1' })).code, 'NO_VARIANT')
  db.data.estimateOffers['off-1'].selectedVariantId = 'var-2'
  // чужой вариант
  db.data.priceEstimates['var-x'] = variant('var-x', 10, { offerId: 'off-9', serviceRequestId: 'sr-9' })
  assert.equal((await a.createActualFromVariant(master, { requestId: 'sr-1', parentEstimateId: 'var-x' })).code, 'BAD_PARENT')
  // центр без ФОП (владелец, заявка центра c2)
  db.data.serviceRequests['sr-2'] = { status: 'approved', serviceCenterId: 'c2', offerId: 'off-1' }
  db.data.priceEstimates['var-2'].serviceRequestId = 'sr-2'
  assert.equal((await a.createActualFromVariant(owner, { requestId: 'sr-2' })).code, 'NO_FOP')
  // скасована
  db.data.serviceRequests['sr-1'].status = 'cancelled'
  assert.equal((await a.createActualFromVariant(master, { requestId: 'sr-1' })).code, 'CANCELLED')
})

// ---------- addExtraExpense / removeExtraExpense ----------
const withActual = () => {
  const s = seed()
  s.priceEstimates['act-1'] = { ...variant('act-1', 2000, { kind: 'actual', stage: 'actual', parentEstimateId: 'var-2', offerId: undefined }), updatedAt: '2026-10-11T00:00:00.000Z', history: [], receiptGoods: [] }
  delete s.priceEstimates['act-1'].offerId
  s.serviceRequests['sr-1'].actualEstimateId = 'act-1'
  s.serviceRequests['sr-1'].status = 'in_work'
  return s
}

test('addExtraExpense: appends an extra line, recomputes, writes history and the request expense; idempotent by clientKey', async () => {
  const db = new FakeDb(withActual())
  const a = createEstimateActions({ adminDb: db })
  const r = await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'Доставка', amount: 150, note: 'НП', clientKey: 'key-00000009' }, { via: 'app' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.applied, true)
  assert.equal(r.data.prevTotal, 2000)
  assert.equal(r.data.total, 2150)
  assert.equal(r.data.status, 'approved')
  const est = db.data.priceEstimates['act-1']
  assert.equal(est.lines.length, 2)
  assert.equal(est.lines[1].refId, r.data.refId)
  assert.equal(est.history.length, 1)
  assert.equal(est.history[0].total, 2000)
  assert.equal(est.lastEditedVia, 'app')
  assert.equal(est.receiptGoods.length, 2)
  const sr = db.data.serviceRequests['sr-1']
  assert.equal(sr.lastEditedVia, 'app') // ядро пишет источник правки и на заявку
  const exp = sr.extraExpenses[0]
  assert.equal(exp.appliedToEstimateId, 'act-1')
  assert.equal(exp.source, 'app')
  assert.equal(exp.note, 'НП')
  assert.equal(exp.clientKey, 'key-00000009')
  assert.equal(r.data.estimateId, 'act-1')
  // повтор — тот же расход, без второй строки
  const dup = await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'Доставка', amount: 150, clientKey: 'key-00000009' }, { via: 'app' })
  assert.equal(dup.ok, true)
  assert.equal(dup.data.duplicate, true)
  assert.equal(dup.data.expenseId, r.data.expenseId)
  assert.equal(db.data.priceEstimates['act-1'].lines.length, 2)
  // рост > 10 % → pending_approval
  const big = await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'Мотор', amount: 1000 }, { via: 'app' })
  assert.equal(big.data.status, 'pending_approval')
  assert.equal(big.data.reapproval.required, true)
  assert.equal(db.data.priceEstimates['act-1'].status, 'pending_approval')
})

test('addExtraExpense: blocked when paid / pay in progress; not current estimate; validation; viewer has no right', async () => {
  const db = new FakeDb(withActual())
  const a = createEstimateActions({ adminDb: db })
  assert.equal((await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-9', title: 'x', amount: 1 })).code, 'NOT_CURRENT')
  assert.equal((await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: '', amount: 1 })).code, 'BAD_EXPENSE')
  assert.equal((await a.addExtraExpense(viewer, { requestId: 'sr-1', estimateId: 'act-1', title: 'x', amount: 1 })).code, 'NO_PERM_ACTUAL')
  db.data.priceEstimates['act-1'].payInitiatedAt = new Date().toISOString()
  assert.equal((await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'x', amount: 1 })).code, 'PAY_IN_PROGRESS')
  db.data.priceEstimates['act-1'].payInitiatedAt = null
  db.data.priceEstimates['act-1'].status = 'paid'
  assert.equal((await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'x', amount: 1 })).code, 'PAID')
  // без факта — расход только на заявку
  const db2 = new FakeDb(seed())
  const r = await createEstimateActions({ adminDb: db2 }).addExtraExpense(master, { requestId: 'sr-1', title: 'Деталь', amount: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.data.applied, false)
  assert.equal(db2.data.serviceRequests['sr-1'].extraExpenses.length, 1)
})

test('removeExtraExpense: removes the line and the request expense, re-applies status', async () => {
  const db = new FakeDb(withActual())
  const a = createEstimateActions({ adminDb: db })
  const added = await a.addExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', title: 'Мотор', amount: 1000 }, { via: 'app' })
  assert.equal(db.data.priceEstimates['act-1'].status, 'pending_approval')
  const r = await a.removeExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', expenseId: added.data.expenseId }, { via: 'app' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.total, 2000)
  assert.equal(r.data.status, 'approved')
  assert.equal(db.data.priceEstimates['act-1'].lines.length, 1)
  assert.equal(db.data.serviceRequests['sr-1'].extraExpenses.length, 0)
  assert.equal(db.data.priceEstimates['act-1'].history.length, 2)
  assert.equal((await a.removeExtraExpense(master, { requestId: 'sr-1', estimateId: 'act-1', expenseId: 'nope' })).code, 'NO_EXPENSE')
})

// ---------- HTTP ----------
const makeApp = (db, staff, notifyClient) => {
  const app = express()
  app.use(express.json())
  registerEstimates(app, { adminDb: db, notifyClient, verifyStaff: async () => staff })
  return app
}
const call = (app, method, path, body) => new Promise((resolve) => {
  const server = app.listen(0, async () => {
    const port = server.address().port
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const json = await res.json()
      resolve({ status: res.status, json })
    } finally { server.close() }
  })
})

test('HTTP: create actual → 201 with notify result; lines add/remove; price lines 501; forbidden without staff', async () => {
  const db = new FakeDb(seed())
  const notified = []
  const app = makeApp(db, master, async (p) => { notified.push(p); return { status: 'sent', channel: 'sms', via: 'sms' } })
  const c = await call(app, 'POST', '/api/estimates/actual', { serviceRequestId: 'sr-1', clientKey: 'key-00000001' })
  assert.equal(c.status, 201, JSON.stringify(c.json))
  assert.equal(c.json.success, true)
  assert.equal(c.json.data.total, 2000)
  assert.deepEqual(c.json.data.notify, { status: 'sent', channel: 'sms', via: 'sms', skipped: false, error: null })
  assert.deepEqual(notified, [{ serviceRequestId: 'sr-1', event: 'actual', by: 'm@x' }])
  const estId = c.json.data.estimateId
  // повтор — 200, без второго оповещения
  const again = await call(app, 'POST', '/api/estimates/actual', { serviceRequestId: 'sr-1', clientKey: 'key-00000001' })
  assert.equal(again.status, 200)
  assert.equal(again.json.data.created, false)
  assert.equal(notified.length, 1)
  // добавить витрату
  const add = await call(app, 'POST', `/api/estimates/${estId}/lines`, { kind: 'extra', title: 'Доставка', amount: 120, clientKey: 'key-00000002' })
  assert.equal(add.status, 201, JSON.stringify(add.json))
  assert.equal(add.json.data.total, 2120)
  assert.equal(add.json.data.refId.startsWith('extra:'), true)
  // позиции прайса — не реализовано
  const price = await call(app, 'POST', `/api/estimates/${estId}/lines`, { kind: 'price', workCode: 'W1', qty: 1 })
  assert.equal(price.status, 501)
  assert.equal(price.json.error.code, 'NOT_SUPPORTED')
  // удалить
  const del = await call(app, 'DELETE', `/api/estimates/${estId}/lines/${add.json.data.refId}`)
  assert.equal(del.status, 200, JSON.stringify(del.json))
  assert.equal(del.json.data.total, 2000)
  const bad = await call(app, 'DELETE', `/api/estimates/${estId}/lines/w1`)
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'NOT_EXTRA')
  // не факт
  const notActual = await call(app, 'POST', '/api/estimates/var-1/lines', { kind: 'extra', title: 'x', amount: 1 })
  assert.equal(notActual.status, 400)
  assert.equal(notActual.json.error.code, 'NOT_ACTUAL')
  // без сотрудника
  const anon = makeApp(db, null)
  const f = await call(anon, 'POST', '/api/estimates/actual', { serviceRequestId: 'sr-1' })
  assert.equal(f.status, 403)
  // валидация
  const v = await call(app, 'POST', '/api/estimates/actual', { serviceRequestId: 'bad id!' })
  assert.equal(v.status, 400)
  assert.equal(v.json.error.code, 'NEED_REQUEST')
})

test('HTTP: notify failure does not undo the created estimate', async () => {
  const db = new FakeDb(seed())
  const app = makeApp(db, owner, async () => { throw new Error('sms down') })
  const c = await call(app, 'POST', '/api/estimates/actual', { serviceRequestId: 'sr-1' })
  assert.equal(c.status, 201)
  assert.equal(c.json.data.notify.status, 'failed')
  assert.match(c.json.data.notify.error, /sms down/)
  assert.ok(db.data.serviceRequests['sr-1'].actualEstimateId)
})
