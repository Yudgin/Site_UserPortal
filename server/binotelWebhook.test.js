import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {
  parseNestedForm, parseBinotelBody, normalizeRouting, decideCallSettings, buildCustomerData, pickRequests,
  clip, NAME_MAX, DESC_MAX, registerBinotelWebhook,
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

const SR = (o) => ({ id: 'sr1', clientName: 'Петренко Іван', status: 'in_work', stage: 'diagnosed', onec: { number: '0001234' }, complaint: 'Не крутиться правий гвинт', updatedAt: '2026-10-15', ...o })
const lookup = { requests: [SR()], profile: null }
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
  const pass = decideCallSettings({ fields, routing: normalizeRouting({ scope: 'all' }), lookup, siteUrl: 'https://my.runferry.com' })
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

test('customerData: межі довжини, номер без нулів, етап, кілька заявок, без заявок, відповідальний', () => {
  const cd = buildCustomerData({ phone: '+380675499555', requests: [SR({ clientName: 'Дуже-Дуже Довге Прізвище Ім’я По-батькові Клієнта Сервісу' })], siteUrl: 'https://x', assignedToEmployeeNumber: '906' })
  assert.ok(cd.name.length <= NAME_MAX && cd.name.endsWith('…'))
  assert.ok(cd.description.length <= DESC_MAX)
  assert.ok(cd.description.startsWith('Ремонт №1234 · Діагностовано'))
  assert.equal(cd.assignedToEmployeeNumber, '906')
  assert.equal(cd.linkToCrmTitle, 'Заявка №1234')

  const two = buildCustomerData({ phone: '+380675499555', requests: [SR(), SR({ id: 'sr2', updatedAt: '2026-10-16', onec: null, stage: 'received' }), SR({ id: 'old', status: 'done', updatedAt: '2026-10-17' })] })
  assert.equal(two.linkToCrmUrl.endsWith('/service-request/sr2'), true) // найсвіжіша активна, не виконана
  assert.ok(two.description.startsWith('Ремонт (+1) · Отримано'))
  assert.equal(two.linkToCrmTitle, 'Заявка (усього 3)')

  const done = buildCustomerData({ phone: '+380675499555', requests: [SR({ status: 'done', stage: 'shipped' })] })
  assert.ok(done.description.startsWith('Останній ремонт №1234 · Відправлено'))

  const nobody = buildCustomerData({ phone: '+380675499555', requests: [], profile: null })
  assert.equal(nobody.name, '067 549 95 55')
  assert.equal(nobody.description, 'Новий номер, заявок немає')
  assert.equal(nobody.linkToCrmUrl, 'https://my.runferry.com/service-requests')
  assert.equal(buildCustomerData({ phone: '+380675499555', requests: [], profile: { name: 'Олег' } }).name, 'Олег')
  assert.equal(buildCustomerData({ phone: '+380675499555', requests: [] }).assignedToEmployeeNumber, undefined)
})

test('pickRequests і clip', () => {
  assert.equal(pickRequests([]).main, null)
  assert.equal(clip('  a  b ', 10), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
})

// ---------- маршрут цілком на підробленому Firestore ----------
function fakeDb({ routing, requests = [], profile = null, slowMs = 0 }) {
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
            set: async (data) => { writes.push({ coll: name, id: docId, data }) },
          }
        },
        where(field, op, value) {
          return { limit: () => ({ get: async () => delay({ docs: requests.filter((r) => r[field] === value).map((r) => ({ id: r.id, data: () => r })) }) }) }
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
