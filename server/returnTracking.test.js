// node --test: «клієнт отримав кораблик» за прямим опитуванням НП (returnTracking.js → npDelivery) і його місце в
// задеплоєному правилі «відкрита» (binotelWebhook.js isOpen / npDeliveredMs) — без Firebase і мережі.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { needsTracking, parseNpDate, registerReturnTracking, trackingPatch } from './returnTracking.js'
import { isOpen, npDeliveredMs } from './binotelWebhook.js'

const NOW = Date.parse('2026-10-18T10:00:00.000Z')
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()
const daysAgo = (n) => iso(NOW - n * DAY)

// ---------- чисті функції ----------
test('parseNpDate: Kyiv local time → UTC (summer +3, winter +2), both NP formats', () => {
  assert.equal(parseNpDate('17.10.2026 13:22:15'), '2026-10-17T10:22:15.000Z')
  assert.equal(parseNpDate('2026-10-17 13:22:15'), '2026-10-17T10:22:15.000Z')
  assert.equal(parseNpDate('05.12.2026 09:00:00'), '2026-12-05T07:00:00.000Z')
  assert.equal(parseNpDate('17.10.2026'), '2026-10-16T21:00:00.000Z')
  assert.equal(parseNpDate(''), null)
  assert.equal(parseNpDate('0000-00-00 00:00:00'), null)
  assert.equal(parseNpDate('завтра'), null)
})

test('needsTracking: boat return TTN, not cancelled, delivery unknown from 1C / handover, no final for this TTN', () => {
  const T1 = '20450000000001'
  assert.equal(needsTracking({ returnTtn: T1 }), true)
  assert.equal(needsTracking({ returnTtn: '' }), false)
  assert.equal(needsTracking({ returnTtn: '0' }), false)
  assert.equal(needsTracking({ returnTtn: T1, status: 'cancelled' }), false)
  assert.equal(needsTracking({ returnTtn: T1, npScenario: 'parts' }), false, 'parts parcel is not the boat')
  // отримання вже відоме з 1С (returnDelivery) або людина відмітила «Видано клієнту»
  assert.equal(needsTracking({ returnTtn: T1, returnDelivery: { ttn: null, shippedAt: daysAgo(5), deliveredAt: daysAgo(3) } }), false)
  assert.equal(needsTracking({ returnTtn: T1, stage: 'handed_over', stageHistory: [{ stage: 'handed_over', at: daysAgo(1), by: 'm@x' }] }), false)
  // 1С бачить лише відправку — опитуємо
  assert.equal(needsTracking({ returnTtn: T1, returnDelivery: { ttn: null, shippedAt: daysAgo(5), deliveredAt: null } }), true)
  assert.equal(needsTracking({ returnTtn: T1, npDelivery: { ttn: T1, code: '9', final: 'received', deliveredAt: daysAgo(1) } }), false)
  // нова зворотна ТТН після фіналу старої — опитуємо знову
  assert.equal(needsTracking({ returnTtn: '20450000000002', npDelivery: { ttn: T1, code: '102', final: 'refused' } }), true)
})

test('trackingPatch: received (9/10/11/106) → deliveredAt from RecipientDateTime', () => {
  for (const code of ['9', '10', '11', '106']) {
    const p = trackingPatch({ returnTtn: '20450000000001' }, { Number: '20450000000001', StatusCode: code, Status: 'Відправлення отримано', RecipientDateTime: '17.10.2026 13:22:15' }, NOW)
    assert.equal(p.npDelivery.deliveredAt, '2026-10-17T10:22:15.000Z', code)
    assert.equal(p.npDelivery.approx, false)
    assert.equal(p.npDelivery.ttn, '20450000000001')
    assert.equal(p.npDelivery.final, 'received')
  }
})

test('trackingPatch: received without (or with future) date → now, approx', () => {
  const p = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: 9, Status: 'Відправлення отримано' }, NOW)
  assert.equal(p.npDelivery.deliveredAt, iso(NOW))
  assert.equal(p.npDelivery.approx, true)
  const f = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '9', RecipientDateTime: '20.10.2026 10:00:00' }, NOW)
  assert.equal(f.npDelivery.deliveredAt, iso(NOW))
  assert.equal(f.npDelivery.approx, true)
})

test('trackingPatch: in transit — write only when the code changes', () => {
  const first = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '5', Status: 'Прямує до міста' }, NOW)
  assert.deepEqual(first, { npDelivery: { ttn: '20450000000001', code: '5', status: 'Прямує до міста', firstCheckedAt: iso(NOW), changedAt: iso(NOW) } })
  const sr = { returnTtn: '20450000000001', npDelivery: first.npDelivery }
  assert.equal(trackingPatch(sr, { StatusCode: '5', Status: 'Прямує до міста' }, NOW + 3600000), null)
  const moved = trackingPatch(sr, { StatusCode: '7', Status: 'Прибув на відділення' }, NOW + 7200000)
  assert.equal(moved.npDelivery.code, '7')
  assert.equal(moved.npDelivery.firstCheckedAt, iso(NOW), 'first check kept')
  assert.equal(moved.npDelivery.changedAt, iso(NOW + 7200000))
  assert.equal(moved.npDelivery.deliveredAt, undefined)
})

test('trackingPatch: refusal / deleted final at once; not found only after 3 days; stale after 45 days', () => {
  assert.equal(trackingPatch({ returnTtn: '1' + '0'.repeat(13) }, { StatusCode: '103' }, NOW).npDelivery.final, 'refused')
  assert.equal(trackingPatch({ returnTtn: '1' + '0'.repeat(13) }, { StatusCode: '2' }, NOW).npDelivery.final, 'deleted')
  const nf = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '3' }, NOW)
  assert.equal(nf.npDelivery.final, undefined)
  const nfLater = trackingPatch({ returnTtn: '20450000000001', npDelivery: nf.npDelivery }, { StatusCode: '3' }, NOW + 3 * DAY)
  assert.equal(nfLater.npDelivery.final, 'not_found')
  const old = { returnTtn: '20450000000001', npDelivery: { ttn: '20450000000001', code: '7', firstCheckedAt: daysAgo(45), changedAt: daysAgo(40) } }
  assert.equal(trackingPatch(old, { StatusCode: '7' }, NOW).npDelivery.final, 'stale')
  // NP не повернула документ — без змін, поки не мине горизонт
  assert.equal(trackingPatch({ ...old, npDelivery: { ...old.npDelivery, firstCheckedAt: daysAgo(2) } }, null, NOW), null)
})

test('trackingPatch: new return TTN restarts tracking (old state ignored)', () => {
  const sr = { returnTtn: '20450000000002', npDelivery: { ttn: '20450000000001', code: '9', final: 'received', deliveredAt: daysAgo(55), firstCheckedAt: daysAgo(60) } }
  const p = trackingPatch(sr, { StatusCode: '1' }, NOW)
  assert.equal(p.npDelivery.ttn, '20450000000002')
  assert.equal(p.npDelivery.firstCheckedAt, iso(NOW))
  assert.equal(p.npDelivery.final, undefined)
})

// ---------- «відкрита» (задеплоєне isOpen + npDelivery) ----------
const T = '20450000000001'
const shippedNp = (n) => ({ stage: 'shipped', at: daysAgo(n), by: 'np-ttn', note: `ТТН ${T}` })
const SR = (o) => ({ status: 'done', createdAt: daysAgo(60), doneAt: daysAgo(25), returnTtn: T, stage: 'shipped', stageHistory: [shippedNp(25)], ...o })
test('isOpen: portal TTN delivered by NP → open 14 days after delivery, then closed', () => {
  assert.equal(isOpen(SR({ npDelivery: { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(13) } }), NOW), true)
  assert.equal(isOpen(SR({ npDelivery: { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(15) } }), NOW), false)
  // без npDelivery: відправлено 25 днів тому, отримання невідоме → transitMaxDays 21 → закрита
  assert.equal(isOpen(SR({}), NOW), false)
  // відправлено 10 днів тому, клієнт отримав 9 днів тому — відкрита (транзит теж дав би true; різниця — на 15-й день)
  const fresh = SR({ doneAt: daysAgo(10), stageHistory: [shippedNp(10)], npDelivery: { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(9) } })
  assert.equal(isOpen(fresh, NOW), true)
  assert.equal(isOpen(fresh, NOW + 6 * DAY), false, 'delivered 15 days ago, though shipped only 16 days ago (transit rule would keep it open)')
  assert.equal(isOpen(SR({ status: 'cancelled', npDelivery: { ttn: T, deliveredAt: daysAgo(1) } }), NOW), false)
})

test('npDeliveredMs: only for the current returnTtn and not superseded by a later shipment or work', () => {
  const nd = { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(5) }
  assert.equal(npDeliveredMs(SR({ npDelivery: nd })), NOW - 5 * DAY)
  assert.equal(npDeliveredMs(SR({ npDelivery: nd, returnTtn: '20450000000009' })), 0, 'other TTN')
  assert.equal(npDeliveredMs(SR({ npDelivery: { ...nd, deliveredAt: null } })), 0)
  // гарантія: після отримання кораблик знову в роботі
  assert.equal(npDeliveredMs(SR({ npDelivery: nd, stageHistory: [shippedNp(25), { stage: 'received', at: daysAgo(2), by: 'm@x' }] })), 0)
  // нова відправка порталом після отримання (інший номер)
  const otherShip = { stage: 'shipped', at: daysAgo(1), by: 'np-ttn', note: 'ТТН 20450000000009' }
  assert.equal(npDeliveredMs(SR({ npDelivery: nd, stageHistory: [shippedNp(25), otherShip] })), 0)
})

test('npDeliveredMs: the same parcel\'s TTN entered after the client already got it still counts', () => {
  // майстер вніс номер у застосунку через день після доставки: запис 'shipped' пізніший за deliveredAt
  const late = { stage: 'shipped', at: daysAgo(19), by: 'master@x', note: `ТТН ${T}` }
  const sr = SR({ doneAt: daysAgo(21), stageHistory: [late], npDelivery: { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(20) } })
  assert.equal(npDeliveredMs(sr), NOW - 20 * DAY)
  assert.equal(isOpen(sr, NOW), false, '14 days from delivery, not 21 from entering the number')
  // той самий сценарій, але номер внесено до доставки — так само
  const early = SR({ doneAt: daysAgo(21), stageHistory: [{ ...late, at: daysAgo(21) }], npDelivery: { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(20) } })
  assert.equal(isOpen(early, NOW), false)
})

test('isOpen: 1C delivery and handover still win when later than NP', () => {
  const nd = { ttn: T, code: '9', final: 'received', deliveredAt: daysAgo(20) }
  assert.equal(isOpen(SR({ npDelivery: nd }), NOW), false)
  assert.equal(isOpen(SR({ npDelivery: nd, stageHistory: [shippedNp(25), { stage: 'handed_over', at: daysAgo(3), by: 'm@x' }] }), NOW), true)
  assert.equal(isOpen(SR({ npDelivery: nd, returnDelivery: { ttn: null, shippedAt: daysAgo(24), deliveredAt: daysAgo(4) } }), NOW), true)
})

// ---------- маршрут reconcile ----------
const makeDb = (docs) => {
  const data = { serviceRequests: JSON.parse(JSON.stringify(docs)), system: {} }
  const updates = []
  const ref = (name, id) => ({
    id,
    get: async () => ({ exists: !!data[name][id], data: () => data[name][id] }),
    set: async (v, opts) => { data[name][id] = opts?.merge ? { ...(data[name][id] || {}), ...v } : { ...v } },
    update: async (v) => { updates.push({ id, v }); data[name][id] = { ...data[name][id], ...v } },
  })
  const adminDb = {
    collection: (name) => ({
      doc: (id) => ref(name, id),
      where: (field, op, value) => {
        assert.deepEqual([field, op, value], ['returnTtn', '>', ''])
        return {
          select: () => ({
            get: async () => {
              const docsOut = Object.entries(data[name]).filter(([, v]) => typeof v.returnTtn === 'string' && v.returnTtn > '')
                .map(([id, v]) => ({ id, ref: ref(name, id), data: () => v }))
              return { size: docsOut.length, docs: docsOut }
            },
          }),
        }
      },
    }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => { r.set(v, o) } }),
  }
  return { adminDb, data, updates }
}

const startApp = async ({ docs, np, token = 'adm-token' }) => {
  const app = express()
  app.use(express.json())
  const db = makeDb(docs)
  const calls = []
  registerReturnTracking(app, {
    adminDb: db.adminDb,
    np: async (model, method, props) => { calls.push({ model, method, props }); return np(props) },
    adminToken: token,
    verifyAdmin: async () => false,
    now: () => NOW,
  })
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const run = (q = '', headers = { 'x-admin-token': token }) => fetch(`${base}/api/np/return-tracking/reconcile${q}`, { method: 'POST', headers })
    .then(async (r) => ({ status: r.status, json: await r.json() }))
  return { run, db, calls, close: () => new Promise((r) => server.close(r)) }
}

const DOCS = {
  'sr-got': { status: 'done', returnTtn: '20450000000001', clientPhone: '+380671234567' },
  'sr-way': { status: 'done', returnTtn: '20450000000002', clientPhone: '0501112233' },
  'sr-1c-delivered': { status: 'done', returnTtn: '20450000000003', returnDelivery: { ttn: null, shippedAt: daysAgo(10), deliveredAt: daysAgo(8) } },
  'sr-cancel': { status: 'cancelled', returnTtn: '20450000000004' },
  'sr-none': { status: 'in_work', returnTtn: '' },
}
const NP_OK = (props) => ({
  success: true,
  data: props.Documents.map((d) => d.DocumentNumber === '20450000000001'
    ? { Number: d.DocumentNumber, StatusCode: '9', Status: 'Відправлення отримано', RecipientDateTime: '17.10.2026 13:22:15' }
    : { Number: d.DocumentNumber, StatusCode: '7', Status: 'Прибув на відділення' }),
})

test('reconcile: polls only what needs it, writes receipt and transit state, passes recipient phone to NP', async (t) => {
  const a = await startApp({ docs: DOCS, np: NP_OK })
  t.after(a.close)
  const r = await a.run()
  assert.equal(r.status, 200)
  assert.equal(r.json.tracked, 2)
  assert.equal(r.json.received, 1)
  assert.equal(r.json.written, 2)
  assert.equal(a.calls.length, 1)
  assert.deepEqual(a.calls[0].props.Documents, [
    { DocumentNumber: '20450000000001', Phone: '380671234567' },
    { DocumentNumber: '20450000000002', Phone: '380501112233' },
  ])
  assert.equal(a.db.data.serviceRequests['sr-got'].npDelivery.deliveredAt, '2026-10-17T10:22:15.000Z')
  assert.equal(a.db.data.serviceRequests['sr-got'].npDelivery.final, 'received')
  assert.equal(a.db.data.serviceRequests['sr-way'].npDelivery.code, '7')
  assert.equal(a.db.data.serviceRequests['sr-way'].npDelivery.deliveredAt, undefined)
  assert.deepEqual(Object.keys(a.db.updates[0].v), ['npDelivery'], 'only npDelivery is written')
  assert.equal(a.db.data.system.returnTracking.runningSince, null)
  // другий прогін: отримана більше не опитується, у дорозі без зміни коду — без запису
  const before = a.db.updates.length
  const r2 = await a.run()
  assert.equal(r2.json.tracked, 1)
  assert.equal(r2.json.written, 0)
  assert.equal(a.db.updates.length, before)
})

test('reconcile: dryRun shows changes without writing; bad token → 403; NP failure → error, nothing written', async (t) => {
  const a = await startApp({ docs: DOCS, np: NP_OK })
  t.after(a.close)
  const dry = await a.run('?dryRun=1')
  assert.equal(dry.json.dryRun, true)
  assert.equal(dry.json.written, 0)
  assert.deepEqual(dry.json.changes.find((c) => c.id === 'sr-got'), { id: 'sr-got', code: '9', final: 'received', deliveredAt: '2026-10-17T10:22:15.000Z', approx: false })
  assert.ok(!JSON.stringify(dry.json).includes('380671234567'), 'no phones in the answer')
  assert.equal(a.db.updates.length, 0)
  assert.equal((await a.run('', { 'x-admin-token': 'wrong' })).status, 403)
  const b = await startApp({ docs: DOCS, np: () => ({ success: false, errors: ['API key expired'] }) })
  t.after(b.close)
  const r = await b.run()
  assert.equal(r.status, 200)
  assert.equal(r.json.errors.length, 1)
  assert.match(r.json.errors[0], /API key expired/)
  assert.equal(b.db.updates.length, 0)
})
