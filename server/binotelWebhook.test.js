import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {
  parseNestedForm, parseBinotelBody, normalizeRouting, decideCallSettings, buildCustomerData, pickRequests,
  clip, NAME_MAX, DESC_MAX, registerBinotelWebhook, clientCategory, isOpen, lastActivityMs, DEFAULT_ROUTING, currentDelivery, handedOverMs, boatArrived,
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
  // межі: активний ≤ 180 днів (живий in_work 65-денний лишається відкритим), виконаний ≤ 14, скасований ніколи
  assert.equal(isOpen(SR({ createdAt: daysAgo(65) }), NOW), true)
  assert.equal(isOpen(SR({ createdAt: daysAgo(180) }), NOW), true)
  assert.equal(isOpen(SR({ createdAt: daysAgo(181) }), NOW), false)
  // правило власника 2026-10-17: відкрита, доки клієнт не отримав кораблик, і ще 14 днів після
  // виконана без даних про відправку (оплата/хаб без ТТН, самовивіз): ≤ 21 день від завершення (бриф власника)
  assert.equal(isOpen(SR({ status: 'done', doneAt: daysAgo(15), createdAt: daysAgo(40) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'done', paidAt: daysAgo(21), createdAt: daysAgo(120) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'done', paidAt: daysAgo(22), createdAt: daysAgo(120) }), NOW), false)
  // статус 'done' від старого імпорту 1С без ТТН і без часу — давно завершений: вікно 21 день від останньої дії
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(21) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(22) }), NOW), false)
  assert.equal(isOpen(SR({ status: 'done', stage: 'received', createdAt: daysAgo(100), createdBy: '1c-sync' }), NOW), false)
  assert.equal(isOpen(SR({ status: 'done', returnTtn: '2045', createdAt: daysAgo(21) }), NOW), true) // у дорозі
  assert.equal(isOpen(SR({ status: 'done', returnTtn: '2045', createdAt: daysAgo(22) }), NOW), false)
  assert.equal(isOpen(SR({ status: 'done', returnDelivery: { ttn: '2045', shippedAt: daysAgo(30), deliveredAt: daysAgo(14) }, createdAt: daysAgo(40) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'done', returnDelivery: { ttn: '2045', shippedAt: daysAgo(30), deliveredAt: daysAgo(15) }, createdAt: daysAgo(40) }), NOW), false)
  // дата відправки з історії НП важливіша за дату документа
  assert.equal(isOpen(SR({ status: 'done', returnTtn: '2045', returnDelivery: { ttn: '2045', shippedAt: daysAgo(3), deliveredAt: null }, createdAt: daysAgo(300) }), NOW), true)
  assert.equal(isOpen(SR({ status: 'cancelled', createdAt: daysAgo(0) }), NOW), false)
  assert.equal(isOpen(SR({ createdAt: undefined }), NOW), false)
  // пороги з документа
  const cfg = normalizeRouting({ openMaxAgeDays: 60, doneGraceDays: 0 })
  assert.equal(isOpen(SR({ createdAt: daysAgo(65) }), NOW, cfg), false)
  assert.equal(isOpen(SR({ createdAt: daysAgo(50) }), NOW, cfg), true)
  assert.equal(isOpen(SR({ status: 'done', returnDelivery: { ttn: '1', deliveredAt: daysAgo(1) }, createdAt: daysAgo(5) }), NOW, cfg), false)
  assert.equal(normalizeRouting({ transitMaxDays: 30 }).transitMaxDays, 30)
  assert.equal(normalizeRouting({}).transitMaxDays, DEFAULT_ROUTING.transitMaxDays)
  assert.equal(normalizeRouting({ openMaxAgeDays: 'x', doneGraceDays: null }).openMaxAgeDays, DEFAULT_ROUTING.openMaxAgeDays)
  assert.equal(normalizeRouting({ doneGraceDays: null }).doneGraceDays, DEFAULT_ROUTING.doneGraceDays)
})

test('clientCategory: S2 відкрита / S1 справжня історія (заявка з ТТН, покупка) / профіль не рахується', () => {
  assert.equal(clientCategory(null, NOW), null)
  assert.equal(clientCategory({ requests: [SR()] }, NOW), 'openRequest')
  assert.equal(clientCategory({ requests: [SR({ status: 'done', returnTtn: '2045', createdAt: daysAgo(30) })] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [SR({ status: 'done', doneAt: daysAgo(10), createdAt: daysAgo(50) })] }, NOW), 'openRequest')
  assert.equal(clientCategory({ requests: [SR({ status: 'done', createdAt: daysAgo(30) })] }, NOW), 'knownClient') // старий імпорт
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
  const known = decideCallSettings({ fields, routing, lookup: { requests: [SR({ status: 'done', returnTtn: '2045', createdAt: daysAgo(100) })] }, nowMs: NOW })
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
  assert.equal(buyer.description, 'Купив кораблик 12.06.2025, ремонтів у базі немає')
  assert.equal(buyer.linkToCrmUrl, 'https://x/boat-orders/bo1')
  // «ім'я» з цифр (телефон замість імені) пропускаємо
  assert.equal(buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], orders: [{ id: 'b', status: 'done', clientName: '0671233727' }] }).name, '067 549 95 55')

  const nobody = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], profile: null })
  assert.equal(nobody.name, '067 549 95 55')
  assert.equal(nobody.description, 'Немає в базі порталу')
  assert.equal(nobody.linkToCrmUrl, 'https://my.runferry.com/service-requests')
  const asked = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], profile: { name: 'Олег' } })
  assert.equal(asked.name, 'Олег')
  assert.equal(asked.description, 'Звертався, заявок у базі немає')
  assert.equal(buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [] }).assignedToEmployeeNumber, undefined)
})

test('pickRequests і clip', () => {
  assert.equal(pickRequests([]).main, null)
  assert.equal(clip('  a  b ', 10), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
})

// ---------- маршрут цілком на підробленому Firestore ----------
function fakeDb({ routing, requests = [], profile = null, orders = [], slowMs = 0, journalMs = 0, throwOnParsedKey = null }) {
  const writes = []
  const reads = []
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), slowMs))
  let auto = 0
  const db = {
    writes,
    reads,
    collection(name) {
      return {
        doc(id) {
          const docId = id || `auto${++auto}`
          return {
            id: docId,
            get: async () => {
              reads.push(name)
              if (name === 'system') return delay({ exists: !!routing, data: () => routing })
              if (name === 'clientProfiles') return delay({ exists: !!profile, data: () => profile })
              return { exists: false, data: () => null }
            },
            set: (data) => {
              // як справжній клієнт Firestore: недопустиме ім'я поля → СИНХРОННИЙ виняток
              if (throwOnParsedKey != null && data.parsed && Object.prototype.hasOwnProperty.call(data.parsed, throwOnParsedKey)) throw new Error('Element at index 0 should not be an empty string.')
              return (async () => {
                if (journalMs && name === 'binotelEvents') await new Promise((r) => setTimeout(r, journalMs))
                writes.push({ coll: name, id: docId, data })
              })()
            },
          }
        },
        where(field, op, value) {
          const src = name === 'boatOrders' ? orders : requests
          const match = (r) => (op === 'in' ? value.includes(r[field]) : r[field] === value)
          return { limit: () => ({ get: async () => { reads.push(name); return delay({ docs: src.filter(match).map((r) => ({ id: r.id, data: () => r })) }) } }) }
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

test('route: короткий, порожній і прихований номер → {} без жодного читання Firestore', async () => {
  const db = fakeDb({ routing: { scope: 'all', mode: 'route', routeId: 466367 } })
  await withServer(db, async (base) => {
    await settle()
    db.reads.length = 0 // прогрів system/binotelRouting при реєстрації — не про дзвінок
    for (const n of ['', '12345678', 'anonymous', '0']) {
      const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: `requestType=apiCallSettings&externalNumber=${n}&pbxNumber=0443338049&callType=0`, headers: { 'x-binotel-token': 'test-token' } })
      assert.deepEqual(await r.json(), {}, `number «${n}»`)
    }
    const decisions = db.writes.filter((w) => w.coll === 'binotelEvents').map((w) => w.data.decision)
    assert.deepEqual(decisions, ['no-phone', 'no-phone', 'no-phone', 'no-phone'])
    assert.deepEqual(db.reads, [], 'no Firestore reads for a missing number')
  })
})

test('ревʼю: поле-об’єкт (externalNumber[toString]) не валить процес — 200 {}, наступний запит працює', async () => {
  const db = fakeDb({ routing: { scope: 'all', mode: 'route', routeId: 466367, mirrorCallEvents: true }, requests: [SR({ clientPhone: '+380675499555' })] })
  await withServer(db, async (base) => {
    const url = `${base}/api/binotel/call-settings`
    const h = { 'x-binotel-token': 'test-token' }
    for (const body of ['requestType=apiCallSettings&externalNumber[toString]=1&callType=0',
      'requestType=apiCallSettings&externalNumber=0675499555&pbxNumber[toString]=1&callType[toString]=1',
      'requestType[valueOf]=1&externalNumber=0675499555']) {
      const r = await fetch(url, { method: 'POST', body, headers: h })
      assert.equal(r.status, 200, body)
      await r.json()
    }
    const rj = await fetch(url, { method: 'POST', body: JSON.stringify({ requestType: 'apiCallSettings', externalNumber: { toString: 1 }, callType: 0 }), headers: { ...h, 'content-type': 'application/json' } })
    assert.deepEqual(await rj.json(), {})
    const ok = await fetch(url, { method: 'POST', body: FORM, headers: h })
    assert.deepEqual((await ok.json()).routeData, { type: 'route', id: 466367 })
    await settle()
  })
})

test('ревʼю: розбір форми лінійний і обмежений (256 КБ «x[]=» і «&=» — швидко)', () => {
  const objPush = 'x[y]=1' + '&x[]='.repeat(50000)
  let t0 = Date.now()
  const a = parseNestedForm(objPush)
  assert.ok(Date.now() - t0 < 300, `object push took ${Date.now() - t0} ms`)
  assert.deepEqual(a, { x: { y: '1' } })
  const empty = '&='.repeat(100000)
  t0 = Date.now()
  assert.deepEqual(parseNestedForm(empty), {})
  assert.ok(Date.now() - t0 < 300, `empty keys took ${Date.now() - t0} ms`)
  const many = Array.from({ length: 5000 }, (_, i) => `k${i}=1`).join('&')
  assert.equal(Object.keys(parseNestedForm(many)).length, 1000) // ліміт пар
  assert.equal(parseNestedForm('a[]=' + Array(300).fill('1').join('&a[]=')).a.length, 200) // ліміт масиву
  assert.equal(parseNestedForm('d=1&d=2&' + 'd=3&'.repeat(300)).d.length, 200)
})

test('ревʼю: синхронна відмова Firestore на parsed — запасний запис без parsed', async () => {
  const db = fakeDb({ routing: { scope: 'all' }, throwOnParsedKey: '' })
  await withServer(db, async (base) => {
    const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: JSON.stringify({ requestType: 'apiCallSettings', externalNumber: '0675499555', '': 'x' }), headers: { 'x-binotel-token': 'test-token', 'content-type': 'application/json' } })
    assert.equal(r.status, 200)
    await r.json()
    const e = db.writes.find((w) => w.coll === 'binotelEvents')
    assert.ok(e, 'fallback journal entry written')
    assert.equal(e.data.parsed, null)
    assert.equal(e.data.parsedRejected, true)
  })
})

test('ревʼю: шлях в іншому регістрі, тіло вже з’їв глобальний парсер — однаково правильне рішення', async () => {
  process.env.BINOTEL_WEBHOOK_TOKEN = 'test-token'
  const db = fakeDb({ routing: { scope: 'all', mode: 'route', routeId: 466367 }, requests: [SR({ clientPhone: '+380675499555' })] })
  const app = express()
  // стара (чутлива до регістру) перевірка — глобальні парсери з'їдають тіло для /API/Binotel/…
  const skip = (mw) => (req, res, next) => (req.path.startsWith('/api/binotel/') ? next() : mw(req, res, next))
  app.use(skip(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })))
  app.use(skip(express.urlencoded({ extended: true })))
  registerBinotelWebhook(app, { adminDb: db })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const base = `http://127.0.0.1:${server.address().port}/API/Binotel/call-settings`
    const rf = await fetch(base, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 'test-token', 'content-type': 'application/x-www-form-urlencoded' } })
    assert.deepEqual((await rf.json()).routeData, { type: 'route', id: 466367 })
    const rj = await fetch(base, { method: 'POST', body: JSON.stringify({ requestType: 'apiCallSettings', externalNumber: '0675499555', pbxNumber: '0443338049', callType: 0 }), headers: { 'x-binotel-token': 'test-token', 'content-type': 'application/json' } })
    assert.deepEqual((await rj.json()).routeData, { type: 'route', id: 466367 })
  } finally { server.close(); delete process.env.BINOTEL_WEBHOOK_TOKEN }
})

test('ревʼю: номер у заявці/замовленні без «+» або з нулем — знаходиться; закритий ремонт — статусом', async () => {
  const routing = { scope: 'all', mode: 'byClient', categoryRoutes: { openRequest: 501, knownClient: 502 } }
  const db = fakeDb({ routing, requests: [SR({ clientPhone: '380675499555' })], orders: [{ id: 'bo1', clientPhone: '0671112233', status: 'done', clientName: 'Сидоренко Олег', soldAt: '2025-06-12T09:00:00Z' }] })
  await withServer(db, async (base) => {
    const url = `${base}/api/binotel/call-settings`
    const r1 = await fetch(url, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 'test-token' } })
    assert.deepEqual((await r1.json()).routeData, { type: 'routeWithTime', id: 501 })
    const r2 = await fetch(url, { method: 'POST', body: FORM.replace('0675499555', '0671112233'), headers: { 'x-binotel-token': 'test-token' } })
    const j2 = await r2.json()
    assert.deepEqual(j2.routeData, { type: 'routeWithTime', id: 502 })
    assert.equal(j2.customerData.name, 'Сидоренко Олег')
  })
  const closed = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', stage: 'received', createdAt: daysAgo(300) })] })
  assert.ok(closed.description.startsWith('Останній ремонт №1234 · Виконано'), closed.description)
  const cancelled = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'cancelled', stage: 'shipped', createdAt: daysAgo(300) })] })
  assert.ok(cancelled.description.startsWith('Останній ремонт №1234 · Скасовано'), cancelled.description)
  // майбутня позначка завершення рахується як дія
  assert.equal(isOpen(SR({ status: 'done', createdAt: daysAgo(40), doneAt: daysAgo(3) }), NOW), true)
})

test('лінії: чужа лінія (camarad) і вхідний без pbxNumber → {} bypass-line; вихідний і lines [] — без фільтра', () => {
  const routing = normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367 })
  assert.deepEqual(routing.lines, ['+380679278039', '+380443338049'])
  const ours = decideCallSettings({ fields: { ...fields, pbxNumber: '0679278039' }, routing, lookup, nowMs: NOW })
  assert.deepEqual(ours.response.routeData, { type: 'route', id: 466367 })
  const camarad = decideCallSettings({ fields: { ...fields, pbxNumber: '0679468531' }, routing, lookup, nowMs: NOW })
  assert.deepEqual(camarad, { response: {}, decision: 'bypass-line' })
  assert.equal(decideCallSettings({ fields: { ...fields, pbxNumber: undefined }, routing, lookup, nowMs: NOW }).decision, 'bypass-line')
  assert.equal(decideCallSettings({ fields: { ...fields, pbxNumber: '380443338049' }, routing, lookup, nowMs: NOW }).decision, 'route') // формат не важливий
  const out = decideCallSettings({ fields: { ...fields, callType: '1', pbxNumber: undefined, internalNumber: '906' }, routing, lookup, nowMs: NOW })
  assert.equal(out.decision, 'outgoing')
  assert.ok(out.response.customerData)
  const noFilter = normalizeRouting({ scope: 'all', mode: 'route', routeId: 466367, lines: [] })
  assert.equal(decideCallSettings({ fields: { ...fields, pbxNumber: '0679468531' }, routing: noFilter, lookup, nowMs: NOW }).decision, 'route')
  // тестовий номер на чужій лінії теж в обхід (фільтр лінії раніше за scope)
  const test = normalizeRouting({ scope: 'test', testNumbers: ['0675499555'] })
  assert.equal(decideCallSettings({ fields: { ...fields, pbxNumber: '0679468531' }, routing: test, lookup, nowMs: NOW }).decision, 'bypass-line')
})

test('відправлено (shipped) без відомого отримання: вікно transitMaxDays (21), а не 180 днів; дата купівлі лише з soldAt', () => {
  const shipped = (n) => SR({ status: 'in_work', stage: 'shipped', createdAt: daysAgo(40), stageHistory: [{ stage: 'shipped', at: daysAgo(n), by: 'np-ttn' }] })
  assert.equal(isOpen(shipped(5), NOW), true)
  assert.equal(isOpen(shipped(21), NOW), true)
  assert.equal(isOpen(shipped(22), NOW), false)
  assert.equal(clientCategory({ requests: [shipped(22)] }, NOW), 'knownClient')
  const noSold = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [], orders: [{ id: 'b', status: 'done', clientName: 'Олег', createdAt: '2026-07-18T10:00:00Z' }] })
  assert.equal(noSold.description, 'Купив кораблик, ремонтів у базі немає')
})

test('ревʼю дельти: перехід 1c-sync у shipped — подія (не перший запис); опечатка в lines не вимикає фільтр', () => {
  const sr = (hist) => SR({ status: 'in_work', stage: 'shipped', createdAt: daysAgo(25), stageHistory: hist })
  // свіжа відправка з 1С після «отримано» → відкрита ще 14 днів
  assert.equal(isOpen(sr([{ stage: 'received', at: daysAgo(40), by: '1c-sync' }, { stage: 'shipped', at: daysAgo(1), by: '1c-sync', note: 'ТТН 2045' }]), NOW), true)
  // перший запис shipped від масового прогону — не подія
  assert.equal(isOpen(sr([{ stage: 'shipped', at: daysAgo(1), by: '1c-sync' }]), NOW), false)
  // інші записи 1c-sync, як і раніше, не рахуються
  assert.equal(isOpen(SR({ status: 'new', createdAt: daysAgo(400), stageHistory: [{ stage: 'received', at: daysAgo(500), by: 'master@x' }, { stage: 'received', at: daysAgo(1), by: '1c-sync' }] }), NOW), false)
  assert.deepEqual(normalizeRouting({ lines: ['0679278039, 0443338049'] }).lines, ['+380679278039', '+380443338049'])
  assert.deepEqual(normalizeRouting({ lines: ['06792780399'] }).lines, DEFAULT_ROUTING.lines)
  assert.deepEqual(normalizeRouting({ lines: [null, ''] }).lines, DEFAULT_ROUTING.lines)
  assert.deepEqual(normalizeRouting({ lines: [] }).lines, [])
  assert.deepEqual(normalizeRouting({ lines: [679278039] }).lines, ['+380679278039'])
})

test('пріоритет: override з force → заголовок X-Runferry-Route-Priority: override; без force і без routeData — без заголовка', async () => {
  const r1 = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', overrides: { '0675499555': { id: 466367, force: true } } }), lookup, nowMs: NOW })
  assert.equal(r1.priority, 'override')
  assert.deepEqual(r1.response.routeData, { type: 'route', id: 466367 })
  assert.equal(decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', overrides: { '0675499555': 466367 } }), lookup, nowMs: NOW }).priority, undefined)
  assert.equal(decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all', overrides: { '0675499555': { id: 0, force: true } } }), lookup, nowMs: NOW }).priority, undefined)
  const db = fakeDb({ routing: { scope: 'all', overrides: { '0675499555': { id: 466367, force: true } } } })
  await withServer(db, async (base) => {
    const r = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: FORM, headers: { 'x-binotel-token': 'test-token' } })
    assert.equal(r.headers.get('x-runferry-route-priority'), 'override')
    assert.deepEqual((await r.json()).routeData, { type: 'route', id: 466367 })
    const r2 = await fetch(`${base}/api/binotel/call-settings`, { method: 'POST', body: FORM.replace('0675499555', '0631234567'), headers: { 'x-binotel-token': 'test-token' } })
    assert.equal(r2.headers.get('x-runferry-route-priority'), null)
    await r2.json()
    assert.equal(db.writes.find((w) => w.coll === 'binotelEvents').data.priority, 'override')
  })
})

test('правило власника: отримання клієнтом з returnDelivery; карточка «Клієнт отримав»', () => {
  const got = (n) => SR({ status: 'done', stage: 'shipped', returnTtn: '2045', returnDelivery: { ttn: '2045', shippedAt: daysAgo(n + 3), deliveredAt: daysAgo(n) }, createdAt: daysAgo(n + 30) })
  assert.equal(isOpen(got(2), NOW), true)
  assert.equal(isOpen(got(14), NOW), true)
  assert.equal(isOpen(got(15), NOW), false)
  assert.equal(clientCategory({ requests: [got(2)] }, NOW), 'openRequest')
  assert.equal(clientCategory({ requests: [got(20)] }, NOW), 'knownClient')
  const cd = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', stage: 'shipped', returnTtn: '2045', returnDelivery: { ttn: '2045', shippedAt: '2026-10-08T09:00:00Z', deliveredAt: '2026-10-10T09:00:00Z' }, createdAt: daysAgo(30) })] })
  assert.ok(cd.description.startsWith('Ремонт №1234 · Клієнт отримав 10.10'), cd.description)
  assert.ok(cd.description.length <= DESC_MAX)
  // скасована з датою доставки — все одно закрита і без «отримав»
  const c = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'cancelled', returnDelivery: { ttn: '1', deliveredAt: daysAgo(1) }, createdAt: daysAgo(5) })] })
  assert.ok(c.description.startsWith('Останній ремонт №1234 · Скасовано'), c.description)
})

test('ревʼю правила: returnDelivery перекривається новішою подією, іншим номером ТТН; посилка запчастин — не повернення', () => {
  const delivered40 = { ttn: '2045', shippedAt: daysAgo(43), deliveredAt: daysAgo(40) }
  // гарантійне повторне відкриття: майстер поставив 'received' 2 дні тому → кораблик у нас → відкрита
  const reopened = SR({ status: 'in_work', stage: 'received', returnTtn: '2045', returnDelivery: delivered40, createdAt: daysAgo(60),
    statusChangedAt: daysAgo(2), stageHistory: [{ stage: 'received', at: daysAgo(2), by: 'master@x' }] })
  assert.equal(isOpen(reopened, NOW), true)
  // нова відправка з порталу (np-ttn 1 день тому, інший номер) при старій доставці з 1С → у дорозі → відкрита
  const reshipped = SR({ status: 'done', stage: 'shipped', returnTtn: '9999', returnDelivery: delivered40, createdAt: daysAgo(60),
    stageHistory: [{ stage: 'shipped', at: daysAgo(1), by: 'np-ttn', note: 'ТТН 9999' }] })
  assert.equal(isOpen(reshipped, NOW), true)
  // без новіших подій стара доставка закриває
  assert.equal(isOpen(SR({ status: 'done', returnTtn: '2045', returnDelivery: delivered40, createdAt: daysAgo(60) }), NOW), false)
  // номер у 1С = 0 (null у returnDelivery) — не порівнюємо, доставку беремо
  assert.equal(isOpen(SR({ status: 'new', stage: 'received', returnDelivery: { ttn: null, shippedAt: daysAgo(8), deliveredAt: daysAgo(7) }, createdAt: daysAgo(25),
    stageHistory: [{ stage: 'received', at: daysAgo(20), by: '1c-sync' }] }), NOW), true)
  assert.equal(isOpen(SR({ status: 'new', stage: 'received', returnDelivery: { ttn: null, shippedAt: daysAgo(17), deliveredAt: daysAgo(15) }, createdAt: daysAgo(25),
    stageHistory: [{ stage: 'received', at: daysAgo(20), by: '1c-sync' }] }), NOW), false)
  // посилка в дорозі за історією 1С (без отримання) → 21 день від відправки
  assert.equal(isOpen(SR({ status: 'new', returnDelivery: { ttn: null, shippedAt: daysAgo(5), deliveredAt: null }, createdAt: daysAgo(300) }), NOW), true)
  // запчастини (npScenario parts) — етап 'shipped' не закриває ремонт у роботі
  assert.equal(isOpen(SR({ status: 'in_work', stage: 'shipped', npScenario: 'parts', returnTtn: '7', createdAt: daysAgo(40),
    stageHistory: [{ stage: 'shipped', at: daysAgo(30), by: 'np-ttn' }] }), NOW), true)
})

test('ревʼю правила: «Клієнт отримав» — дата за Києвом, рік якщо не поточний; перекрита доставка — без підпису', () => {
  const night = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', returnDelivery: { ttn: null, shippedAt: '2026-10-08T09:00:00Z', deliveredAt: '2026-10-10T21:30:00Z' }, createdAt: daysAgo(20) })] })
  assert.ok(night.description.includes('Клієнт отримав 11.10'), night.description) // 00:30 11.10 за Києвом
  const old = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', returnDelivery: { ttn: null, shippedAt: '2025-07-20T09:00:00Z', deliveredAt: '2025-07-22T09:00:00Z' }, createdAt: daysAgo(400) })] })
  assert.ok(old.description.includes('Клієнт отримав 22.07.2025'), old.description)
  const reopened = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'in_work', stage: 'received', returnDelivery: { ttn: null, deliveredAt: daysAgo(40) },
    createdAt: daysAgo(60), stageHistory: [{ stage: 'received', at: daysAgo(2), by: 'master@x' }] })] })
  assert.ok(!reopened.description.includes('отримав'), reopened.description)
})

test('повторна перевірка: гарантія на оплаченій (done зафіксовано), самовивіз+гарантія, повторна відправка 1С новим номером, запис 1c-sync тієї ж відправки', () => {
  // 1) оплачено 80 днів тому, отримано 76 днів тому, майстер прийняв по гарантії 3 дні тому → кораблик у нас → відкрита
  const warranty = SR({ status: 'done', paymentId: 'o', paidAt: daysAgo(80), doneAt: daysAgo(80), statusChangedAt: daysAgo(80), stage: 'diagnosed',
    returnDelivery: { ttn: null, shippedAt: daysAgo(78), deliveredAt: daysAgo(76) }, createdAt: daysAgo(99),
    stageHistory: [{ stage: 'received', at: daysAgo(99), by: '1c-sync' }, { stage: 'received', at: daysAgo(3), by: 'master@x' }, { stage: 'diagnosed', at: daysAgo(2), by: 'master@x' }] })
  assert.equal(isOpen(warranty, NOW), true)
  // 2) оплачено, самовивіз (без ТТН), потім гарантійний прийом → відкрита
  const pickupWarranty = SR({ status: 'done', paidAt: daysAgo(60), doneAt: daysAgo(60), stage: 'received', createdAt: daysAgo(90),
    stageHistory: [{ stage: 'received', at: daysAgo(5), by: 'master@x' }] })
  assert.equal(isOpen(pickupWarranty, NOW), true)
  // старий імпорт 'done' без часу, а потім справжня подія майстра → у роботі → відкрита
  assert.equal(isOpen(SR({ status: 'done', stage: 'received', createdAt: daysAgo(300), stageHistory: [{ stage: 'received', at: daysAgo(40), by: 'master@x' }] }), NOW), true)
  // звичайний потік: етапи до оплати → 21 день від оплати
  const normal = SR({ status: 'done', doneAt: daysAgo(10), paidAt: daysAgo(10), createdAt: daysAgo(30), stageHistory: [{ stage: 'diagnosed', at: daysAgo(25), by: 'm' }] })
  assert.equal(isOpen(normal, NOW), true)
  assert.equal(isOpen({ ...normal, doneAt: daysAgo(22), paidAt: daysAgo(22) }, NOW), false)
  // запаковано після оплати, ще не відправлено → у нас
  assert.equal(isOpen({ ...normal, doneAt: daysAgo(40), paidAt: daysAgo(40), stageHistory: [{ stage: 'packed', at: daysAgo(30), by: 'm' }] }, NOW), true)
  // 3) 1С відправила повторно з новим номером B (у заявці лишився старий A), клієнт отримав учора → відкрита
  const reship1c = SR({ status: 'done', returnTtn: '20451000000001', stage: 'shipped', createdAt: daysAgo(60),
    returnDelivery: { ttn: '20451000000002', shippedAt: daysAgo(3), deliveredAt: daysAgo(1) },
    stageHistory: [{ stage: 'received', at: daysAgo(59), by: '1c-sync' }, { stage: 'shipped', at: daysAgo(40), by: '1c-sync', note: 'ТТН 20451000000001' }] })
  assert.equal(isOpen(reship1c, NOW), true)
  // 4) запис 1c-sync 'shipped' часом прогону (після отримання) не перекриває доставку тієї ж посилки
  const sameShip = SR({ status: 'in_work', returnTtn: '7', stage: 'shipped', createdAt: daysAgo(40),
    returnDelivery: { ttn: '7', shippedAt: daysAgo(17), deliveredAt: daysAgo(16.7) },
    stageHistory: [{ stage: 'received', at: daysAgo(39), by: '1c-sync' }, { stage: 'shipped', at: daysAgo(16.5), by: '1c-sync', note: 'ТТН 7' }] })
  assert.equal(currentDelivery(sameShip)?.deliveredAt, daysAgo(16.7))
  assert.equal(isOpen(sameShip, NOW), false) // 16,7 днів після отримання > 14
})

test('третє коло: відправка з returnTtn без запису shipped після «запаковано» → 21 день; після повторного прийому → у нас', () => {
  const paid = { status: 'done', paymentId: 'o', paidAt: daysAgo(30), doneAt: daysAgo(30), statusChangedAt: daysAgo(30), createdAt: daysAgo(50), returnTtn: '20450000000001' }
  // упакували після оплати, потім ТТН без запису 'shipped' → у дорозі від останньої дії (29 днів) → закрита
  assert.equal(isOpen(SR({ ...paid, stage: 'packed', stageHistory: [{ stage: 'packed', at: daysAgo(29), by: 'm@x' }] }), NOW), false)
  assert.equal(isOpen(SR({ ...paid, paidAt: daysAgo(12), doneAt: daysAgo(12), statusChangedAt: daysAgo(12), stage: 'packed', stageHistory: [{ stage: 'packed', at: daysAgo(10), by: 'm@x' }] }), NOW), true)
  // гарантійний повторний прийом після такої відправки → кораблик у нас → відкрита
  assert.equal(isOpen(SR({ ...paid, stage: 'received', stageHistory: [{ stage: 'packed', at: daysAgo(29), by: 'm@x' }, { stage: 'received', at: daysAgo(25), by: 'm@x' }] }), NOW), true)
})

test('четверте коло: перекрита доставка 1С зберігає дату відправки; повернення кораблика — не лише «останній етап received»', () => {
  const base = { status: 'done', returnTtn: '20451234567890', stage: 'shipped', createdAt: daysAgo(330),
    returnDelivery: { ttn: '20451234567890', shippedAt: daysAgo(102), deliveredAt: daysAgo(100) } }
  const firstShip = [{ stage: 'shipped', at: daysAgo(327), by: '1c-sync' }]
  // A) діагностика після доставки (гарантія)
  assert.equal(isOpen(SR({ ...base, stageHistory: firstShip, diagnostics: { text: 'x', at: daysAgo(25), by: 'm' } }), NOW), true)
  // B) статус done → in_work після доставки
  assert.equal(isOpen(SR({ ...base, status: 'in_work', statusChangedAt: daysAgo(25), stageHistory: firstShip }), NOW), true)
  // C) етапи після доставки, без повторної відправки
  assert.equal(isOpen(SR({ ...base, stage: 'packed', stageHistory: [...firstShip, { stage: 'received', at: daysAgo(60), by: 'm' }, { stage: 'repaired', at: daysAgo(40), by: 'm' }, { stage: 'packed', at: daysAgo(30), by: 'm' }] }), NOW), true)
  // D) старий імпорт без дат: гарантійний received 30 днів тому, diagnosed 22 → у нас
  const old = { status: 'done', returnTtn: '20451234567890', stage: 'diagnosed', createdAt: daysAgo(330), returnDelivery: { ttn: '20451234567890', shippedAt: null, deliveredAt: null } }
  assert.equal(isOpen(SR({ ...old, stageHistory: [...firstShip, { stage: 'received', at: daysAgo(30), by: 'm' }, { stage: 'diagnosed', at: daysAgo(22), by: 'm' }] }), NOW), true)
  // D2) лише received
  assert.equal(isOpen(SR({ ...old, stage: 'received', stageHistory: [...firstShip, { stage: 'received', at: daysAgo(30), by: 'm' }] }), NOW), true)
  // третє коло, продовження: оплачено 30, packed 29, гарантійний received 25, далі diagnosed 22 / waiting_parts 22 → у нас
  const paid = { status: 'done', paymentId: 'o', paidAt: daysAgo(30), doneAt: daysAgo(30), statusChangedAt: daysAgo(30), createdAt: daysAgo(50), returnTtn: '20450000000001' }
  const hist = [{ stage: 'packed', at: daysAgo(29), by: 'm@x' }, { stage: 'received', at: daysAgo(25), by: 'm@x' }]
  assert.equal(isOpen(SR({ ...paid, stage: 'diagnosed', diagnostics: { text: 'x', at: daysAgo(22), by: 'm' }, stageHistory: [...hist, { stage: 'diagnosed', at: daysAgo(22), by: 'm@x' }] }), NOW), true)
  assert.equal(isOpen(SR({ ...paid, stage: 'waiting_parts', stageHistory: [...hist, { stage: 'waiting_parts', at: daysAgo(22), by: 'm@x' }] }), NOW), true)
  // ціль третього кола лишається: packed після оплати + ТТН без дати, без повторного прийому → закрита
  assert.equal(isOpen(SR({ ...paid, stage: 'packed', stageHistory: [{ stage: 'packed', at: daysAgo(29), by: 'm@x' }] }), NOW), false)
  // звичайний перший прийом (до нього нічого) — не повернення
  assert.equal(isOpen(SR({ ...paid, stage: 'packed', stageHistory: [{ stage: 'received', at: daysAgo(45), by: 'm@x' }, { stage: 'packed', at: daysAgo(29), by: 'm@x' }] }), NOW), false)
})

test('п\'яте коло: старий імпорт з відправкою без дати — гарантійна робота без «received» і «received» без запису shipped', () => {
  const old = { status: 'done', returnTtn: '20451234567890', createdAt: daysAgo(330) }
  // запис 'shipped' лише від 1c-sync/backfill (без справжньої дати), потім одразу 'waiting_parts' → у нас
  assert.equal(isOpen(SR({ ...old, stage: 'waiting_parts', stageHistory: [{ stage: 'shipped', at: daysAgo(327), by: '1c-sync' }, { stage: 'waiting_parts', at: daysAgo(20), by: 'm' }] }), NOW), true)
  assert.equal(isOpen(SR({ ...old, stage: 'shipped', stageHistory: [{ stage: 'shipped', at: daysAgo(300), by: 'backfill' }], diagnostics: { text: 'x', at: daysAgo(30), by: 'm' } }), NOW), true)
  // без жодного запису 'shipped', але справжній 'received' на старому 'done' без часу → у нас
  assert.equal(isOpen(SR({ ...old, stage: 'received', stageHistory: [{ stage: 'received', at: daysAgo(25), by: 'm' }] }), NOW), true)
  // старий імпорт без жодних справжніх подій → давно отримано → закрита
  assert.equal(isOpen(SR({ ...old, stage: 'shipped', stageHistory: [{ stage: 'shipped', at: daysAgo(327), by: '1c-sync' }] }), NOW), false)
})

test('«Видано клієнту» (handed_over, власник 2026-10-18): 14 днів від відмітки; гарантія або нова відправка її перекривають', () => {
  const paid = { status: 'done', paidAt: daysAgo(40), doneAt: daysAgo(40), createdAt: daysAgo(60) }
  // самовивіз: видано 10 днів тому → відкрита; 15 днів тому → закрита (навіть якщо оплата була давно)
  const pickup = (n) => SR({ ...paid, stage: 'handed_over', stageHistory: [{ stage: 'packed', at: daysAgo(n + 1), by: 'm' }, { stage: 'handed_over', at: daysAgo(n), by: 'm', note: 'самовивіз' }] })
  assert.equal(isOpen(pickup(10), NOW), true)
  assert.equal(isOpen(pickup(14), NOW), true)
  assert.equal(isOpen(pickup(15), NOW), false)
  // відправлено (np-ttn) 20 днів тому, клієнт отримав — видано 3 дні тому → відкрита ще 11 днів, а не за вікном 21
  const shippedThenHanded = SR({ ...paid, stage: 'handed_over', returnTtn: '7', stageHistory: [{ stage: 'shipped', at: daysAgo(20), by: 'np-ttn' }, { stage: 'handed_over', at: daysAgo(3), by: 'app:m' }] })
  assert.equal(isOpen(shippedThenHanded, NOW), true)
  assert.equal(isOpen({ ...shippedThenHanded, stageHistory: [{ stage: 'shipped', at: daysAgo(30), by: 'np-ttn' }, { stage: 'handed_over', at: daysAgo(16), by: 'app:m' }] }, NOW), false)
  // гарантія: видано 60 днів тому, прийняли 5 днів тому → кораблик у нас → відкрита
  const warranty = SR({ ...paid, stage: 'received', stageHistory: [{ stage: 'handed_over', at: daysAgo(60), by: 'm' }, { stage: 'received', at: daysAgo(5), by: 'm' }] })
  assert.equal(handedOverMs(warranty), 0)
  assert.equal(isOpen(warranty, NOW), true)
  // нова відправка після видачі → у дорозі від неї
  const reship = SR({ ...paid, stage: 'shipped', returnTtn: '8', stageHistory: [{ stage: 'handed_over', at: daysAgo(60), by: 'm' }, { stage: 'shipped', at: daysAgo(2), by: 'np-ttn' }] })
  assert.equal(handedOverMs(reship), 0)
  assert.equal(isOpen(reship, NOW), true)
  // відмітка від 1c-sync/backfill не вважається (лише людина)
  assert.equal(handedOverMs(SR({ stageHistory: [{ stage: 'handed_over', at: daysAgo(1), by: 'backfill' }] })), 0)
  // видача пізніше за доставку з 1С — перемагає видача
  const both = SR({ ...paid, stage: 'handed_over', returnDelivery: { ttn: null, shippedAt: daysAgo(25), deliveredAt: daysAgo(20) },
    stageHistory: [{ stage: 'handed_over', at: daysAgo(4), by: 'm' }] })
  assert.equal(isOpen(both, NOW), true)
  // видача клієнту — не «повернення в роботу» для правила кораблика, що повернувся
  assert.equal(clientCategory({ requests: [pickup(30)] }, NOW), 'knownClient')
  assert.equal(clientCategory({ requests: [pickup(2)] }, NOW), 'openRequest')
})

test('карточка: «Видано клієнту ДД.ММ» для відкритої; для закритої — «Останній ремонт · Видано клієнту»', () => {
  const open = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', paidAt: daysAgo(20), stage: 'handed_over', createdAt: daysAgo(30),
    stageHistory: [{ stage: 'handed_over', at: '2026-10-12T21:30:00Z', by: 'm' }] })] })
  assert.ok(open.description.startsWith('Ремонт №1234 · Видано клієнту 13.10'), open.description) // 00:30 13.10 за Києвом
  const closed = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'done', stage: 'handed_over', createdAt: daysAgo(120),
    stageHistory: [{ stage: 'handed_over', at: daysAgo(90), by: 'm' }] })] })
  assert.ok(closed.description.startsWith('Останній ремонт №1234 · Видано клієнту'), closed.description)
  assert.ok(closed.description.length <= DESC_MAX)
})

test('фаза «чекаємо кораблик» (власник 2026-10-18): з ТТН — поки посилка жива; «не знайдено» — закрита; без ТТН — до ручної відмітки', () => {
  const awaiting = (o) => SR({ status: 'new', stage: null, stageHistory: [], createdAt: daysAgo(10), ...o })
  assert.equal(boatArrived(awaiting({})), false)
  // з ТТН, посилка в дорозі → відкрита
  assert.equal(isOpen(awaiting({ waybillNumber: '2045', incomingDelivery: { ttn: '2045', status: 'Прямує до міста', notFound: false } }), NOW), true)
  // «Номер не знайдено» → клієнт не відправив → закрита
  assert.equal(isOpen(awaiting({ waybillNumber: '2045', incomingDelivery: { ttn: '2045', status: 'Номер не знайдено', notFound: true } }), NOW), false)
  // без ТТН → клієнт привезе сам → відкрита (до відмітки «Отримано»)
  assert.equal(isOpen(awaiting({}), NOW), true)
  // страховка 90 днів від останньої дії
  assert.equal(isOpen(awaiting({ createdAt: daysAgo(90) }), NOW), true)
  assert.equal(isOpen(awaiting({ createdAt: daysAgo(91) }), NOW), false)
  assert.equal(isOpen(awaiting({ createdAt: daysAgo(80) }), NOW, normalizeRouting({ awaitingMaxDays: 30 })), false)
  // посилка отримана (НП) — кораблик у нас, хоч етапу ще немає → правило 180
  const arrivedNp = awaiting({ waybillNumber: '2045', createdAt: daysAgo(120), incomingDelivery: { ttn: '2045', arrivedAt: daysAgo(100) } })
  assert.equal(boatArrived(arrivedNp), true)
  assert.equal(isOpen(arrivedNp, NOW), true)
  // відмітили «Отримано» (привіз сам) → кораблик у нас
  assert.equal(boatArrived(awaiting({ stage: 'received', stageHistory: [{ stage: 'received', at: daysAgo(1), by: 'm', note: 'привіз сам' }] })), true)
  // 1С поставила етап 'received' (1c-sync) — теж уже приїхав
  assert.equal(boatArrived(awaiting({ stage: 'received', stageHistory: [{ stage: 'received', at: daysAgo(3), by: '1c-sync' }] })), true)
  // скасована — закрита завжди
  assert.equal(isOpen(awaiting({ status: 'cancelled' }), NOW), false)
  // категорія для дзвінка: чекаємо → S2; «не знайдено» без інших заявок → S1 (історія є — заявка не скасована без ТТН)
  assert.equal(clientCategory({ requests: [awaiting({})] }, NOW), 'openRequest')
})

test('карточка: «Чекаємо посилку» / «Чекаємо кораблик (привезе сам)»', () => {
  const withTtn = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'new', stage: null, stageHistory: [], waybillNumber: '2045', createdAt: daysAgo(5) })] })
  assert.ok(withTtn.description.startsWith('Ремонт №1234 · Чекаємо посилку'), withTtn.description)
  const walkIn = buildCustomerData({ nowMs: NOW, phone: '+380675499555', requests: [SR({ status: 'new', stage: null, stageHistory: [], createdAt: daysAgo(5) })] })
  assert.ok(walkIn.description.startsWith('Ремонт №1234 · Чекаємо кораблик (привезе сам)'), walkIn.description)
  assert.ok(walkIn.description.length <= DESC_MAX)
})
