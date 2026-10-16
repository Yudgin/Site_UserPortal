import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {
  parseNestedForm, parseBinotelBody, normalizeRouting, decideCallSettings, buildCustomerData, pickRequests,
  clip, NAME_MAX, DESC_MAX, registerBinotelWebhook, clientCategory, isOpen, lastActivityMs, DEFAULT_ROUTING,
} from './binotelWebhook.js'

const FORM = 'requestType=apiCallSettings&externalNumber=0675499555&pbxNumber=0443338049&companyID=12345&callType=0'

test('form: плоскі поля apiCallSettings', () => {
  const d = parseNestedForm(FORM)
  assert.deepEqual(d, { requestType: 'apiCallSettings', externalNumber: '0675499555', pbxNumber: '0443338049', companyID: '12345', callType: '0' })
})

test('form: вкладені поля в PHP-нотації, масиви, %2B і +', () => {
  const raw = 'callDetails%5BgeneralCallID%5D=6926420032&callDetails[historyData][0][waitsec]=3&callDetails[historyData][0][billsec]=46'
    + '&callDetails[historyData][1][waitsec]=1&callDetails[employeeData][name]=%D0%86%D0%B2%D0%B0%D0%BD+%D0%9F'
    + '&n=%2B380671234567&a[]=1&a[]=2&dup=x&dup=y&callTrackingData[fullUrl]=https%3A%2F%2Fx.ua%2F%3Fa%3D1%26b%3D2'
  const d = parseNestedForm(raw)
  assert.equal(d.callDetails.generalCallID, '6926420032')
  assert.deepEqual(d.callDetails.historyData, [{ waitsec: '3', billsec: '46' }, { waitsec: '1' }])
  assert.equal(d.callDetails.employeeData.name, 'Іван П')
  assert.equal(d.n, '+380671234567')
  assert.deepEqual(d.a, ['1', '2'])
  assert.deepEqual(d.dup, ['x', 'y'])
  assert.equal(d.callTrackingData.fullUrl, 'https://x.ua/?a=1&b=2')
})

test('form: прототипні ключі відкидаються', () => {
  const d = parseNestedForm('__proto__[x]=1&a[constructor][y]=2&ok=1')
  assert.equal({}.x, undefined)
  assert.deepEqual(d, { ok: '1' })
})

test('body: JSON за Content-Type і за першим символом; порожнє тіло', () => {
  const j = parseBinotelBody(Buffer.from('{"requestType":"apiCallSettings","callType":0}'), 'application/json')
  assert.equal(j.format, 'json')
  assert.equal(j.data.callType, 0)
  assert.equal(parseBinotelBody(Buffer.from(' {"a":1}'), 'text/plain').format, 'json')
  assert.equal(parseBinotelBody(Buffer.from(FORM), 'application/x-www-form-urlencoded').data.externalNumber, '0675499555')
  assert.deepEqual(parseBinotelBody({}, '').data, {})
})

test('routing: нормалізація номерів, override як число/об’єкт/0, дефолти', () => {
  const r = normalizeRouting({
    scope: 'test', testNumbers: ['0675499555', '+380 67 000 02 55', 'сміття'], mode: 'route', routeId: '466367',
    overrides: { '380969718654': 220956, '0671112233': { id: 73622, type: 'routeWithTime' }, '0501112233': 0 },
  })
  assert.deepEqual(r.testNumbers, ['+380675499555', '+380670000255'])
  assert.equal(r.routeId, 466367)
  assert.deepEqual(r.overrides['+380969718654'], { id: 220956, type: 'route' })
  assert.deepEqual(r.overrides['+380671112233'], { id: 73622, type: 'routeWithTime' })
  assert.deepEqual(r.overrides['+380501112233'], { id: null, type: 'route' })
  assert.equal(normalizeRouting(null).enabled, false)
  assert.equal(normalizeRouting({}).mode, 'passthrough')
  assert.equal(normalizeRouting({ override: { '0675499555': 1 } }).overrides['+380675499555'].id, 1) // однина теж приймається
  assert.equal(normalizeRouting({ assignedToEmployeeNumber: '906' }).assignedToEmployeeNumber, 906)
  assert.equal(normalizeRouting({ assignedToEmployeeNumber: '' }).assignedToEmployeeNumber, null)
})

const NOW = Date.parse('2026-10-16T08:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86400e3).toISOString()
const SR = (o) => ({ id: 'sr1', clientName: 'Петренко Іван', status: 'in_work', stage: 'diagnosed', onec: { number: '0001234' }, complaint: 'Не крутиться правий гвинт', createdAt: daysAgo(6), updatedAt: daysAgo(0), ...o })
const lookup = { requests: [SR()], profile: null, orders: [] }
const fields = { requestType: 'apiCallSettings', externalNumber: '0675499555', pbxNumber: '0443338049', callType: '0' }

test('decide: поза scope / вимкнено / нема документа → {}', () => {
  const base = normalizeRouting({ testNumbers: ['0670000255'] })
  assert.deepEqual(decideCallSettings({ fields, routing: base, lookup }), { response: {}, decision: 'out-of-scope' })
  assert.equal(decideCallSettings({ fields, routing: normalizeRouting({ enabled: false }), lookup }).decision, 'disabled')
  assert.equal(decideCallSettings({ fields, routing: normalizeRouting(null), lookup }).decision, 'no-routing-doc')
  assert.equal(decideCallSettings({ fields: { ...fields, externalNumber: 'anonymous' }, routing: base, lookup }).decision, 'no-phone')
  assert.equal(decideCallSettings({ fields: { ...fields, requestType: 'apiCallCompleted' }, routing: base, lookup }).decision, 'not-call-settings')
})

test('decide: passthrough — лише customerData; route — routeData; override перемагає; вихідний без routeData', () => {
  const pass = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all' }), lookup, siteUrl: 'https://my.runferry.com', nowMs: NOW })
  assert.equal(pass.decision, 'passthrough')
  assert.equal(pass.response.routeData, undefined)
  assert.equal(pass.response.customerData.name, 'Петренко Іван')
  assert.equal(pass.response.customerData.linkToCrmUrl, 'https://my.runferry.com/service-request/sr1')

  const route = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367 }), lookup })
  assert.deepEqual(route.response.routeData, { type: 'route', id: 466367 })
  assert.equal(route.decision, 'route')

  const ov = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367, overrides: { '0675499555': 270182 } }), lookup })
  assert.deepEqual(ov.response.routeData, { type: 'route', id: 270182 })
  const none = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367, overrides: { '0675499555': 0 } }), lookup })
  assert.equal(none.response.routeData, undefined)
  assert.equal(none.decision, 'override-none')

  const out = decideCallSettings({ fields: { ...fields, callType: '1', pbxNumber: undefined, internalNumber: '906' }, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367 }), lookup })
  assert.equal(out.response.routeData, undefined)
  assert.ok(out.response.customerData)
  assert.equal(out.decision, 'outgoing')

  const noCd = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367, sendCustomerData: false }), lookup })
  assert.deepEqual(Object.keys(noCd.response), ['routeData'])
  const timeout = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367 }), lookup: null })
  assert.deepEqual(timeout.response, { routeData: { type: 'route', id: 466367 } })
  assert.equal(timeout.decision, 'route+lookup-timeout')
})

test('isOpen: вік за createdAt/справжніми діями, не за updatedAt; пороги з документа', () => {
  // ремонт з 1С 2023 року в статусі new, updatedAt свіжий від масової синхронізації → не відкритий
  const stale1c = SR({ status: 'new', createdAt: '2023-05-01T10:00:00Z', updatedAt: daysAgo(1), createdBy: '1c-sync',
    stageHistory: [{ stage: 'received', at: daysAgo(2), by: '1c-sync' }] })
  assert.equal(isOpen(stale1c, NOW), false)
  assert.equal(lastActivityMs(stale1c), Date.parse('2023-05-01T10:00:00Z'))
  // той самий ремонт, але майстер змінив етап 3 дні тому → відкритий
  assert.equal(isOpen({ ...stale1c, stageHistory: [...stale1c.stageHistory, { stage: 'diagnosed', at: daysAgo(3), by: 'master@x' }] }, NOW), true)
  // діагностика і рух посилки (np-ttn) теж дії; бекфіл — ні
  assert.equal(isOpen({ ...stale1c, diagnostics: { text: 'x', at: daysAgo(10), by: 'm' } }, NOW), true)
  assert.equal(isOpen({ ...stale1c, stageHistory: [{ stage: 'shipped', at: daysAgo(5), by: 'np-ttn' }] }, NOW), true)
  assert.equal(isOpen({ ...stale1c, stageHistory: [{ stage: 'packed', at: daysAgo(5), by: 'backfill' }] }, NOW), false)
  // межі: активний ≤ 60 днів, виконаний ≤ 14, скасований ніколи
  assert.equal(isOpen(SR({ createdAt: daysAgo(60) }), NOW), true)
  assert.equal(isOpen(SR({ createdAt: daysAgo(61) }), NOW), false)
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(14) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(15) }), NOW), false)
  assert.equal(isOpen(SR({ status: 'cancelled', createdAt: daysAgo(0) }), NOW), false)
  assert.equal(isOpen(SR({ createdAt: undefined }), NOW), false)
  // пороги з документа
  const cfg = normalizeRouting({ openMaxAgeDays: 90, doneGraceDays: 0 })
  assert.equal(isOpen(SR({ createdAt: daysAgo(80) }), NOW, cfg), true)
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(1) }), NOW, cfg), false)
  assert.equal(normalizeRouting({ openMaxAgeDays: 'x', doneGraceDays: null }).openMaxAgeDays, DEFAULT_ROUTING.openMaxAgeDays)
  assert.equal(normalizeRouting({ doneGraceDays: null }).doneGraceDays, DEFAULT_ROUTING.doneGraceDays)
})

test('clientCategory: S2 відкрита / S1 справжня історія (заявка з ТТН, покупка) / профіль не рахується', () => {
  assert.equal(clientCategory(null, NOW), null)
  assert.equal(clientCategory({ requests: [SR()] }, NOW), 'openRequest')
  assert.equal(clientCategory({ requests: [SR({ status: 'done', createdAt: daysAgo(30) })] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [SR({ status: 'new', createdAt: daysAgo(400) })] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [SR({ status: 'cancelled', waybillNumber: '2045' })] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [SR({ status: 'cancelled' })] }, NOW), 'unknown') // передумав до відправки
  assert.equal(clientCategory({ requests: [], orders: [{ status: 'done' }] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [], orders: [{ status: 'lead' }, { status: 'cancelled' }] }, NOW), 'unknown')
  assert.equal(clientCategory({ requests: [], profile: { name: 'Олег' } }, NOW), 'unknown')
  assert.equal(clientCategory({ requests: [], profile: null }, NOW), 'unknown')
})

test('byClient: сценарій routeWithTime; без id або без пошуку → без routeData; override перемагає; scenarioIds', () => {
  const routing = normalizeRouting({ scope: 'all', mode: 'byClient', categoryRoutes: { openRequest: 501, knownClient: { id: 502, type: 'route' }, unknown: 0 } })
  assert.deepEqual(routing.categoryRoutes.openRequest, { id: 501, type: 'routeWithTime' })
  const open = decideCallSettings({ fields, routing, lookup, nowMs: NOW })
  assert.deepEqual(open.response.routeData, { type: 'routeWithTime', id: 501 })
  assert.equal(open.decision, 'byClient:openRequest')
  assert.equal(open.category, 'openRequest')
  const known = decideCallSettings({ fields, routing, lookup: { requests: [SR({ status: 'done', createdAt: daysAgo(100) })] }, nowMs: NOW })
  assert.deepEqual(known.response.routeData, { type: 'route', id: 502 })
  const unknown = decideCallSettings({ fields, routing, lookup: { requests: [], profile: null }, nowMs: NOW })
  assert.equal(unknown.response.routeData, undefined)
  assert.equal(unknown.decision, 'byClient:unknown-none')
  const noLookup = decideCallSettings({ fields, routing, lookup: null, nowMs: NOW })
  assert.deepEqual(noLookup.response, {})
  const ov = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'byClient', categoryRoutes: { openRequest: 501 }, overrides: { '0675499555': 466367 } }), lookup, nowMs: NOW })
  assert.deepEqual(ov.response.routeData, { type: 'route', id: 466367 })
  const noIds = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', mode: 'byClient' }), lookup, nowMs: NOW })
  assert.equal(noIds.response.routeData, undefined)
  assert.equal(noIds.decision, 'byClient:openRequest-none')
  // синонім scenarioIds {S1, S2}; categoryRoutes важливіший
  const sc = normalizeRouting({ mode: 'byClient', scenarioIds: { S1: 11, S2: 22 } })
  assert.deepEqual(sc.categoryRoutes, { openRequest: { id: 22, type: 'routeWithTime' }, knownClient: { id: 11, type: 'routeWithTime' } })
  assert.equal(normalizeRouting({ categoryRoutes: { openRequest: 5 }, scenarioIds: { S2: 22 } }).categoryRoutes.openRequest.id, 5)
  // вихідний — ніколи routeData, навіть з override
  const out = decideCallSettings({ fields: { ...fields, callType: '1' }, routing: normalizeRouting({ scope: 'all', mode: 'byClient', categoryRoutes: { openRequest: 501 }, overrides: { '0675499555': 466367 } }), lookup, nowMs: NOW })
  assert.equal(out.response.routeData, undefined)
  assert.equal(normalizeRouting({ mode: 'whatever' }).mode, 'passthrough')
})

test('customerData: межі довжини, номер без нулів, етап, кілька заявок, покупка, без історії, відповідальний', () => {
  const cd = buildCustomerData({ phone: '+380675499555', requests: [SR({ clientName: 'Дуже-Дуже Довге Прізвище Ім’я По-батькові Клієнта Сервісу' })], siteUrl: 'https://x', assignedToEmployeeNumber: 906, nowMs: NOW })
  assert.ok(cd.name.length <= NAME_MAX && cd.name.endsWith('…'))
  assert.ok(cd.description.length <= DESC_MAX)
  assert.ok(cd.description.startsWith('Ремонт №1234 · Діагностовано'))
  assert.equal(cd.assignedToEmployeeNumber, 906)
  assert.equal(cd.linkToCrmTitle, 'Заявка №1234')

  const two = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [
    SR(),
    SR({ id: 'sr2', createdAt: daysAgo(2), onec: null, stage: 'received' }),
    SR({ id: 'old', status: 'done', createdAt: daysAgo(300), updatedAt: daysAgo(0) }), // свіжий updatedAt не робить головною
  ] })
  assert.equal(two.linkToCrmUrl.endsWith('/service-request/sr2'), true)
  assert.ok(two.description.startsWith('Ремонт (+1) · Отримано'), two.description)
  assert.equal(two.linkToCrmTitle, 'Заявка (усього 3)')

  const done = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', stage: 'shipped', createdAt: daysAgo(200) })] })
  assert.ok(done.description.startsWith('Останній ремонт №1234 · Відправлено'))
  // старий «new» з 1С — це вже «Останній ремонт», не поточний
  const stale = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'new', stage: null, createdAt: '2023-05-01T10:00:00Z' })] })
  assert.ok(stale.description.startsWith('Останній ремонт №1234 · Нова'), stale.description)

  const buyer = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], orders: [{ id: 'bo1', status: 'done', clientName: 'Сидоренко Олег', soldAt: '2025-06-12T09:00:00Z' }, { id: 'bo0', status: 'lead', clientName: 'Лід' }], siteUrl: 'https://x' })
  assert.equal(buyer.name, 'Сидоренко Олег')
  assert.equal(buyer.description, 'Купив кораблик 12.06.2025, ремонтів не було')
  assert.equal(buyer.linkToCrmUrl, 'https://x/boat-orders/bo1')
  // «ім'я» з цифр (телефон замість імені) пропускаємо
  assert.equal(buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], orders: [{ id: 'b', status: 'done', clientName: '0671233727' }] }).name, '067 549 95 55')

  const nobody = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], profile: null })
  assert.equal(nobody.name, '067 549 95 55')
  assert.equal(nobody.description, 'Новий номер, заявок немає')
  assert.equal(nobody.linkToCrmUrl, 'https://my.runferry.com/service-requests')
  const asked = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], profile: { name: 'Олег' } })
  assert.equal(asked.name, 'Олег')
  assert.equal(asked.description, 'Звертався, заявок немає')
  assert.equal(buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [] }).assignedToEmployeeNumber, undefined)
})

test('pickRequests і clip', () => {
  assert.equal(pickRequests([]).main, null)
  assert.equal(clip('  a  b ', 10), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
})

// ---------- маршрут цілком на підробленому Firestore ----------
function fakeDb({ routing, requests = [], profile = null, orders = [], slowMs = 0, journalMs = 0 }) {
  const writes = []
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), slowMs))
  let auto = 0
  const db = {
    writes,
    collection(name) {
      return {
        doc(id) {
          const docId = id || `auto${++auto}`
          return {
            id: docId,
            get: async () => {
              if (name === 'system') return delay({ exists: !!routing, data: () => routing })
              if (name === 'clientProfiles') return delay({ exists: !!profile, data: () => profile })
              return { exists: false, data: () => null }
            },
            set: async (data) => {
              if (journalMs && name === 'binotelEvents') await new Promise((r) => setTimeout(r, journalMs))
              writes.push({ coll: name, id: docId, data })
            },
          }
        },
        where(field, op, value) {
          const src = name === 'boatOrders' ? orders : requests
          return { limit: () => ({ get: async () => delay({ docs: src.filter((r) => r[field] === value).map((r) => ({ id: r.id, data: () => r })) }) }) }
        },
      }
    },
  }
  return db
}

async function withServer(db, fn, token = 'test-token') {
  process.env.BINOTEL_WEBHOOK_TOKEN = token
  const app = express()
  // як у index.js: глобальні парсери, що пропускають /api/binotel/
  const skip = (mw) => (req, res, next) => (req.path.startsWith('/api/binotel/') ? next() : mw(req, res, next))
  app.use(skip(express.json()))
  app.use(skip(express.urlencoded({ extended: true })))
  registerBinotelWebhook(app, { adminDb: db, siteUrl: 'https://my.runferry.com' })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  try { await fn(base) } finally { server.close(); delete process.env.BINOTEL_WEBHOOK_TOKEN }
}
const settle = () => new Promise((r) => setTimeout(r, 30))

test('route: токен — 403 без нього, ?k= приймається, form і JSON', async () => {
  const db = fakeDb({ routing: { scope: 'test', testNumbers: ['0675499555'], mode: 'route', routeId: 466367, mirrorCallEvents: true }, requests: [SR({ clientPhone: '+380675499555' })] })
  await withServer(db, async (base) => {
    const url = `${base}/api/binotel/call-settings`
    assert.equal((await fetch(url, { method: 'POST', body: FORM, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403)
    assert.equal((await fetch(url, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 'wrong' } })).status, 403)

    const r1 = await fetch(url, { method: 'POST', body: FORM, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-binotel-token': 'test-token', 'x-binotel-via': '1c' } })
    assert.equal(r1.status, 200)
    const j1 = await r1.json()
    assert.deepEqual(j1.routeData, { type: 'route', id: 466367 })
    assert.equal(j1.customerData.name, 'Петренко Іван')

    const r2 = await fetch(`${url}?k=test-token`, { method: 'POST', body: JSON.stringify({ requestType: 'apiCallSettings', externalNumber: '380675499555', pbxNumber: '0443338049', callType: 0 }), headers: { 'content-type': 'application/json' } })
    assert.deepEqual((await r2.json()).routeData, { type: 'route', id: 466367 })

    // номер не з тестового списку → {}
    const r3 = await fetch(url, { method: 'POST', body: FORM.replace('0675499555', '0631234567'), headers: { 'x-binotel-token': 'test-token' } })
    assert.deepEqual(await r3.json(), {})

    await settle()
    const journal = db.writes.filter((w) => w.coll === 'binotelEvents')
    assert.equal(journal.length, 3)
    assert.equal(journal[0].data.via, '1c')
    assert.equal(journal[0].data.raw, FORM)
    assert.equal(journal[0].data.decision, 'route')
    assert.equal(journal[0].data.serviceRequestId, 'sr1')
    assert.ok(journal[0].data.expireAt instanceof Date)
    assert.equal(journal[1].data.format, 'json')
    assert.equal(journal[2].data.decision, 'out-of-scope')
    const mirror = db.writes.filter((w) => w.coll === 'callEvents')
    assert.equal(mirror.length, 2) // лише вхідні, на які відповіли по суті (r3 поза scope — без дзеркала)
    assert.equal(mirror[0].data.lastType, 'call.incoming')
  })
})

test('route: повільний Firestore → {} у межах бюджету, без токена в env → 503', async () => {
  process.env.BINOTEL_LOOKUP_BUDGET_MS = '100'
  const { registerBinotelWebhook: reg } = await import('./binotelWebhook.js?slow')
  delete process.env.BINOTEL_LOOKUP_BUDGET_MS
  const db = fakeDb({ routing: { scope: 'all', mode: 'route', routeId: 466367 }, slowMs: 400 })
  process.env.BINOTEL_WEBHOOK_TOKEN = 't'
  const app = express()
  reg(app, { adminDb: db })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const t0 = Date.now()
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/binotel/call-settings`, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 't' } })
    assert.deepEqual(await r.json(), {})
    assert.ok(Date.now() - t0 < 350, `took ${Date.now() - t0} ms`)
  } finally { server.close(); delete process.env.BINOTEL_WEBHOOK_TOKEN }

  const app2 = express()
  registerBinotelWebhook(app2, { adminDb: db })
  const s2 = await new Promise((r) => { const s = app2.listen(0, () => r(s)) })
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/binotel/call-settings`, { method: 'POST', body: FORM })
    assert.equal(r.status, 503)
  } finally { s2.close() }
})

test('route: журнал записаний ДО відповіді; повільний журнал тримає відповідь ≤ бюджету; покупець з boatOrders', async () => {
  const routing = { scope: 'all', mode: 'byClient', categoryRoutes: { openRequest: 501, knownClient: 502 } }
  const orders = [{ id: 'bo1', clientPhone: '+380675499555', status: 'done', clientName: 'Сидоренко Олег', soldAt: '2025-06-12T09:00:00Z' }]
  const db = fakeDb({ routing, orders })
  await withServer(db, async (base) => {
    const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: FORM, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-binotel-token': 'test-token', 'x-binotel-via': '1c' } })
    const j = await r.json()
    assert.deepEqual(j.routeData, { type: 'routeWithTime', id: 502 })
    assert.equal(j.customerData.name, 'Сидоренко Олег')
    // без settle(): запис уже є в момент відповіді
    const e = db.writes.find((w) => w.coll === 'binotelEvents')
    assert.ok(e, 'journal must be written before the response')
    assert.equal(e.data.contentType, 'application/x-www-form-urlencoded')
    assert.equal(e.data.routingMode, 'byClient')
    assert.equal(e.data.category, 'knownClient')
    assert.equal(e.data.decision, 'byClient:knownClient')
  })

  const slow = fakeDb({ routing, journalMs: 1500 })
  await withServer(slow, async (base) => {
    const t0 = Date.now()
    const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 'test-token' } })
    await r.json()
    const took = Date.now() - t0
    assert.ok(took >= 280 && took < 900, `took ${took} ms`)
  })
})

test('route: короткий, порожній і прихований номер → {} без пошуку', async () => {
  const db = fakeDb({ routing: { scope: 'all', mode: 'route', routeId: 466367 } })
  await withServer(db, async (base) => {
    for (const n of ['', '12345678', 'anonymous', '0']) {
      const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: `requestType=apiCallSettings&externalNumber=${n}&pbxNumber=0443338049&callType=0`, headers: { 'x-binotel-token': 'test-token' } })
      assert.deepEqual(await r.json(), {}, `number «${n}»`)
    }
    const decisions = db.writes.filter((w) => w.coll === 'binotelEvents').map((w) => w.data.decision)
    assert.deepEqual(decisions, ['no-phone', 'no-phone', 'no-phone', 'no-phone'])
  })
})
