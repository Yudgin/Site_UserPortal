// node --test: відмітка «клієнт отримав кораблик» за зворотною ТТН НП (returnTracking.js) і правило «відкрита»
// приймача Binotel / голосового шлюзу (binotelWebhook.js isOpen) — без Firebase і мережі.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { needsTracking, parseNpDate, registerReturnTracking, trackingPatch } from './returnTracking.js'
import { isOpen } from './binotelWebhook.js'

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

test('needsTracking: return TTN present, not cancelled, not yet received/final for this TTN', () => {
  assert.equal(needsTracking({ returnTtn: '20450000000001' }), true)
  assert.equal(needsTracking({ returnTtn: '' }), false)
  assert.equal(needsTracking({ returnTtn: '0' }), false)
  assert.equal(needsTracking({ returnTtn: '20450000000001', status: 'cancelled' }), false)
  assert.equal(needsTracking({ returnTtn: '20450000000001', clientReceivedAt: daysAgo(1), clientReceivedTtn: '20450000000001' }), false)
  // нова зворотна ТТН після отримання старої — опитуємо знову
  assert.equal(needsTracking({ returnTtn: '20450000000002', clientReceivedAt: daysAgo(30), clientReceivedTtn: '20450000000001' }), true)
  assert.equal(needsTracking({ returnTtn: '20450000000001', returnTracking: { ttn: '20450000000001', code: '102', final: 'refused' } }), false)
  assert.equal(needsTracking({ returnTtn: '20450000000002', returnTracking: { ttn: '20450000000001', final: 'refused' } }), true)
})

test('trackingPatch: received (9/10/11/106) → clientReceivedAt from RecipientDateTime', () => {
  for (const code of ['9', '10', '11', '106']) {
    const p = trackingPatch({ returnTtn: '20450000000001' }, { Number: '20450000000001', StatusCode: code, Status: 'Відправлення отримано', RecipientDateTime: '17.10.2026 13:22:15' }, NOW)
    assert.equal(p.clientReceivedAt, '2026-10-17T10:22:15.000Z', code)
    assert.equal(p.clientReceivedApprox, false)
    assert.equal(p.clientReceivedTtn, '20450000000001')
    assert.equal(p.clientReceivedSource, 'np')
    assert.equal(p.returnTracking.final, 'received')
  }
})

test('trackingPatch: received without (or with future) date → now, approx', () => {
  const p = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: 9, Status: 'Відправлення отримано' }, NOW)
  assert.equal(p.clientReceivedAt, iso(NOW))
  assert.equal(p.clientReceivedApprox, true)
  const f = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '9', RecipientDateTime: '20.10.2026 10:00:00' }, NOW)
  assert.equal(f.clientReceivedAt, iso(NOW))
  assert.equal(f.clientReceivedApprox, true)
})

test('trackingPatch: in transit — write only when the code changes', () => {
  const first = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '5', Status: 'Прямує до міста' }, NOW)
  assert.deepEqual(first, { returnTracking: { ttn: '20450000000001', code: '5', status: 'Прямує до міста', firstCheckedAt: iso(NOW), changedAt: iso(NOW) } })
  const sr = { returnTtn: '20450000000001', returnTracking: first.returnTracking }
  assert.equal(trackingPatch(sr, { StatusCode: '5', Status: 'Прямує до міста' }, NOW + 3600000), null)
  const moved = trackingPatch(sr, { StatusCode: '7', Status: 'Прибув на відділення' }, NOW + 7200000)
  assert.equal(moved.returnTracking.code, '7')
  assert.equal(moved.returnTracking.firstCheckedAt, iso(NOW), 'first check kept')
  assert.equal(moved.returnTracking.changedAt, iso(NOW + 7200000))
  assert.equal(moved.clientReceivedAt, undefined)
})

test('trackingPatch: refusal / deleted final at once; not found only after 3 days; stale after 45 days', () => {
  assert.equal(trackingPatch({ returnTtn: '1' + '0'.repeat(13) }, { StatusCode: '103' }, NOW).returnTracking.final, 'refused')
  assert.equal(trackingPatch({ returnTtn: '1' + '0'.repeat(13) }, { StatusCode: '2' }, NOW).returnTracking.final, 'deleted')
  const nf = trackingPatch({ returnTtn: '20450000000001' }, { StatusCode: '3' }, NOW)
  assert.equal(nf.returnTracking.final, undefined)
  const nfLater = trackingPatch({ returnTtn: '20450000000001', returnTracking: nf.returnTracking }, { StatusCode: '3' }, NOW + 3 * DAY)
  assert.equal(nfLater.returnTracking.final, 'not_found')
  const old = { returnTtn: '20450000000001', returnTracking: { ttn: '20450000000001', code: '7', firstCheckedAt: daysAgo(45), changedAt: daysAgo(40) } }
  assert.equal(trackingPatch(old, { StatusCode: '7' }, NOW).returnTracking.final, 'stale')
  // NP не повернула документ — без змін, поки не мине горизонт
  assert.equal(trackingPatch({ ...old, returnTracking: { ...old.returnTracking, firstCheckedAt: daysAgo(2) } }, null, NOW), null)
})

test('trackingPatch: new return TTN restarts tracking (old state ignored)', () => {
  const sr = { returnTtn: '20450000000002', returnTracking: { ttn: '20450000000001', code: '9', final: 'received', firstCheckedAt: daysAgo(60) } }
  const p = trackingPatch(sr, { StatusCode: '1' }, NOW)
  assert.equal(p.returnTracking.ttn, '20450000000002')
  assert.equal(p.returnTracking.firstCheckedAt, iso(NOW))
  assert.equal(p.returnTracking.final, undefined)
})

// ---------- «відкрита» (isOpen) ----------
const SR = (o) => ({ status: 'done', createdAt: daysAgo(60), ...o })
test('isOpen: received → open 14 days after receipt, then closed (owner 2026-10-17)', () => {
  assert.equal(isOpen(SR({ doneAt: daysAgo(30), clientReceivedAt: daysAgo(13) }), NOW), true)
  assert.equal(isOpen(SR({ doneAt: daysAgo(30), clientReceivedAt: daysAgo(15) }), NOW), false)
  // in_work (статус не встиг змінитись), але отримав 20 днів тому — завершена
  assert.equal(isOpen(SR({ status: 'in_work', createdAt: daysAgo(40), clientReceivedAt: daysAgo(20) }), NOW), false)
  // скасована — ніколи
  assert.equal(isOpen(SR({ status: 'cancelled', clientReceivedAt: daysAgo(1) }), NOW), false)
})

test('isOpen: done long ago but the return parcel is still on its way / at the branch → open', () => {
  const ttn = '20450000000001'
  const sr = SR({ doneAt: daysAgo(20), returnTtn: ttn, stage: 'shipped', returnTracking: { ttn, code: '7', firstCheckedAt: daysAgo(19) } })
  assert.equal(isOpen(sr, NOW), true)
  // відмова/повернення (final) — далі колишнє правило: виконана 20 днів тому → закрита
  assert.equal(isOpen({ ...sr, returnTracking: { ...sr.returnTracking, code: '103', final: 'refused' } }, NOW), false)
  // стан стосується іншої (старої) ТТН — не рахується
  assert.equal(isOpen({ ...sr, returnTtn: '20450000000009' }, NOW), false)
})

test('isOpen: without the new fields the old rule stays (doneGraceDays from last activity)', () => {
  assert.equal(isOpen(SR({ doneAt: daysAgo(10) }), NOW), true)
  assert.equal(isOpen(SR({ doneAt: daysAgo(16) }), NOW), false)
  assert.equal(isOpen({ status: 'in_work', createdAt: daysAgo(100) }, NOW), true)
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
  'sr-done-before': { status: 'done', returnTtn: '20450000000003', clientReceivedAt: daysAgo(30), clientReceivedTtn: '20450000000003' },
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
  assert.equal(a.db.data.serviceRequests['sr-got'].clientReceivedAt, '2026-10-17T10:22:15.000Z')
  assert.equal(a.db.data.serviceRequests['sr-got'].returnTracking.final, 'received')
  assert.equal(a.db.data.serviceRequests['sr-way'].returnTracking.code, '7')
  assert.equal(a.db.data.serviceRequests['sr-way'].clientReceivedAt, undefined)
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
  assert.deepEqual(dry.json.changes.find((c) => c.id === 'sr-got'), { id: 'sr-got', code: '9', final: 'received', clientReceivedAt: '2026-10-17T10:22:15.000Z', approx: false })
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
