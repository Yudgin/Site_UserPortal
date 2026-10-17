// node --test: час подій статусу заявки (statusTimes.js) і його запис у спільному ядрі (estimateEngine.updateRequest).
import test from 'node:test'
import assert from 'node:assert/strict'
import { statusTimes, paidRequestPatch } from './statusTimes.js'
import { createEstimateOps } from './estimateEngine.js'
import { isOpen, DEFAULT_ROUTING } from './binotelWebhook.js'

const NOW = '2026-10-16T10:00:00.000Z'
const DAY = 86400000

test('statusTimes: real change → statusChangedAt, done → doneAt, same status → nothing', () => {
  assert.deepEqual(statusTimes('new', 'diagnostics', NOW), { statusChangedAt: NOW })
  assert.deepEqual(statusTimes('in_work', 'done', NOW), { statusChangedAt: NOW, doneAt: NOW })
  assert.deepEqual(statusTimes(undefined, 'done', NOW), { statusChangedAt: NOW, doneAt: NOW })
  assert.deepEqual(statusTimes('done', 'done', NOW), {})
  assert.deepEqual(statusTimes('in_work', undefined, NOW), {})
  assert.deepEqual(statusTimes('done', 'in_work', NOW), { statusChangedAt: NOW })
})

test('paidRequestPatch: done + paidAt, cancelled stays cancelled, repeat keeps the first paidAt', () => {
  assert.deepEqual(paidRequestPatch({ status: 'in_work' }, 'ord1', NOW),
    { paymentId: 'ord1', updatedAt: NOW, paidAt: NOW, status: 'done', statusChangedAt: NOW, doneAt: NOW })
  // документа заявки немає — як і раніше, пишемо 'done'
  assert.equal(paidRequestPatch({}, 'ord1', NOW).status, 'done')
  // скасовану не «воскрешаємо», але гроші прийшли — paidAt є
  assert.deepEqual(paidRequestPatch({ status: 'cancelled' }, 'ord1', NOW), { paymentId: 'ord1', updatedAt: NOW, paidAt: NOW })
  // повтор (помилка Checkbox → reconcile): paidAt і doneAt не зсуваються
  const again = paidRequestPatch({ status: 'done', paidAt: '2026-10-10T00:00:00.000Z', doneAt: '2026-10-10T00:00:00.000Z' }, 'ord1', NOW)
  assert.deepEqual(again, { paymentId: 'ord1', updatedAt: NOW, status: 'done' })
})

test('paid request of an old 1C repair is open (Binotel S2) until the client got the boat + doneGraceDays', () => {
  const nowMs = Date.parse(NOW)
  const old = { status: 'in_work', createdAt: '2025-01-10T00:00:00.000Z' }
  const paid = { ...old, ...paidRequestPatch(old, 'ord1', new Date(nowMs - 3 * DAY).toISOString()) }
  assert.equal(isOpen(paid, nowMs, DEFAULT_ROUTING), true)
  // Правило власника 2026-10-17: відкрита, доки клієнт не отримав кораблик, і ще 14 днів після. Без даних про
  // відправку — наближення з брифу: ≤ transitMaxDays (21) від оплати/завершення.
  assert.equal(isOpen(paid, nowMs + 12 * DAY, DEFAULT_ROUTING), true) // 15 днів після оплати
  assert.equal(isOpen(paid, nowMs + 19 * DAY, DEFAULT_ROUTING), false) // 22 дні після оплати
  const delivered = { ...paid, status: 'done', returnTtn: '2045', returnDelivery: { ttn: '2045', shippedAt: new Date(nowMs - 2 * DAY).toISOString(), deliveredAt: new Date(nowMs).toISOString() } }
  assert.equal(isOpen(delivered, nowMs + 14 * DAY, DEFAULT_ROUTING), true)
  assert.equal(isOpen(delivered, nowMs + 15 * DAY, DEFAULT_ROUTING), false) // 15 днів після отримання
  // без часу завершення той самий ремонт уже закритий
  assert.equal(isOpen({ ...old, status: 'done' }, nowMs, DEFAULT_ROUTING), false)
})

// Мінімальний Firestore для createEstimateOps: get/set одного документа + транзакція (updateRequest у
// фінальному спільному ядрі працює в транзакції: tx.get/tx.set на тих самих посиланнях).
const fakeDb = (docs) => {
  const writes = []
  const db = {
    writes,
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({ exists: !!docs[`${name}/${id}`], id, data: () => docs[`${name}/${id}`] }),
        set: async (data, opts) => { writes.push({ path: `${name}/${id}`, data, opts }) },
      }),
    }),
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { ref.set(data, opts) },
      update: (ref, data) => { ref.set(data, { merge: true }) },
    }),
  }
  return db
}
const owner = { uid: 'u1', email: 'o@x', role: 'owner', centers: [] }

test('updateRequest: status change writes statusChangedAt/doneAt, same status and other fields do not', async () => {
  const db = fakeDb({ 'serviceRequests/r1': { status: 'in_work' } })
  const ops = createEstimateOps({ adminDb: db })
  const r = await ops.updateRequest(owner, { requestId: 'r1', status: 'done' }, { via: 'test' })
  assert.equal(r.ok, true)
  const w = db.writes[0].data
  assert.equal(w.status, 'done')
  assert.ok(w.doneAt && w.statusChangedAt && w.doneAt === w.statusChangedAt && w.updatedAt === w.doneAt)

  const db2 = fakeDb({ 'serviceRequests/r1': { status: 'done' } })
  await createEstimateOps({ adminDb: db2 }).updateRequest(owner, { requestId: 'r1', status: 'done' }, {})
  assert.equal(db2.writes[0].data.doneAt, undefined)
  assert.equal(db2.writes[0].data.statusChangedAt, undefined)

  const db3 = fakeDb({ 'serviceRequests/r1': { status: 'in_work' } })
  await createEstimateOps({ adminDb: db3 }).updateRequest(owner, { requestId: 'r1', boat: 'Carp 3' }, {})
  assert.equal(db3.writes[0].data.statusChangedAt, undefined)
})

test('updateRequest: first diagnostics moves new → diagnostics with statusChangedAt', async () => {
  const db = fakeDb({ 'serviceRequests/r1': { status: 'new' } })
  await createEstimateOps({ adminDb: db }).updateRequest(owner, { requestId: 'r1', diagnostics: 'не крутить гвинт' }, {})
  const w = db.writes[0].data
  assert.equal(w.status, 'diagnostics')
  assert.ok(w.statusChangedAt)
  assert.equal(w.doneAt, undefined)
})
