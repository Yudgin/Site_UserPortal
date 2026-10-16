// node --test: делегований шлях створення ТТН із застосунку (/api/np/ttn/create для owner/director
// за роллю) і превʼю (/api/np/ttn/preview) — без Firebase і без мережі: adminDb у памʼяті, НП і
// перевірка співробітника підмінені. Повний шлях власника за email — що лишився як був.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { computeCod, normalizeCost, registerNpTtn } from './novaPoshtaTtn.js'

const OWNER_EMAIL = 'admin@runferry.de'

// ---------- in-memory Firestore ----------
const makeDb = () => {
  const data = {
    serviceRequests: {
      'sr-1': { id: 'sr-1', serviceCenterId: 'c1', clientName: 'Іванов Іван Іванович', clientPhone: '+380671234567', externalRequestId: '000577', clientCityRef: 'city-1', clientCityName: 'Київ', clientWarehouseRef: 'wh-1', clientWarehouseName: 'Відділення №1', actualEstimateId: 'est-1', stage: 'packed' },
      'sr-2': { id: 'sr-2', serviceCenterId: 'c2', clientName: 'Петренко', clientPhone: '+380501112233', clientCityRef: 'city-2', clientWarehouseRef: 'wh-2' },
      'sr-3': { id: 'sr-3', clientName: 'Без центру' },
      'sr-4': { id: 'sr-4', serviceCenterId: 'c1', clientName: 'Сидоренко', returnTtn: '20450222222222', stage: 'shipped', clientCityRef: 'city-1', clientWarehouseRef: 'wh-1' },
      'sr-5': { id: 'sr-5', serviceCenterId: 'c1', clientName: 'Без адреси', clientPhone: '+380931112233', actualEstimateId: 'est-paid' },
      'sr-6': { id: 'sr-6', serviceCenterId: 'c3', clientName: 'Центр без шаблону', clientCityRef: 'city-1', clientWarehouseRef: 'wh-1' },
    },
    serviceCenters: {
      c1: { name: 'Київ', returnTtnTemplateId: 'tpl-ret', incomingTtnTemplateId: 'tpl-in' },
      c2: { name: 'Львів', returnTtnTemplateId: 'tpl-in' }, // помилково прив'язаний шаблон «на ремонт»
      c3: { name: 'Одеса' },
    },
    npTemplates: {
      'tpl-ret': { name: 'З ремонту, великий', scenario: 'return', fopId: 'fop1', size: 'big', weight: 2, seatsAmount: 1, volumeGeneral: 0.02, serviceType: 'WarehouseWarehouse', description: 'Прикормочний кораблик', payerType: 'recipient', cod: true, active: true },
      'tpl-in': { name: 'На ремонт', scenario: 'incoming', fopId: 'fop1', size: 'big', weight: 2, seatsAmount: 1, senderTarget: 'client', recipientTarget: 'service', description: 'Кораблик на ремонт', payerType: 'sender', cod: false, active: true },
    },
    priceEstimates: {
      'est-1': { total: 12500, status: 'approved' },
      'est-paid': { total: 9000, status: 'paid', paymentId: 'pay-1' },
    },
  }
  const writes = []
  const adminDb = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({ exists: !!data[name]?.[id], data: () => data[name][id] }),
        set: async (patch, opts) => {
          writes.push({ name, id, patch, opts })
          data[name] = data[name] || {}
          data[name][id] = { ...(data[name][id] || {}), ...patch }
        },
      }),
    }),
  }
  return { adminDb, data, writes }
}

const FOPS = {
  fop1: { id: 'fop1', name: 'ФОП Тестовий', methods: {}, novaPoshta: { apiKey: 'key-1', senderRef: 'snd', contactRef: 'cnt', cityRef: 'city-fop', warehouseRef: 'wh-fop', senderPhone: '380441112233' } },
  fopNoKey: { id: 'fopNoKey', name: 'Без ключа', novaPoshta: {} },
}

const DIRECTOR_C1 = { uid: 'dir1', email: 'dir1@runferry.test', role: 'director', centers: [{ centerId: 'c1', perms: [] }] }
const DIRECTOR_C2 = { uid: 'dir2', email: 'dir2@runferry.test', role: 'director', centers: [{ centerId: 'c2', perms: [] }] }
const MASTER_C1 = { uid: 'm1', email: 'm1@runferry.test', role: 'master', centers: [{ centerId: 'c1', perms: ['view'] }] }
const OWNER = { uid: 'own', email: OWNER_EMAIL, role: 'owner', centers: [] }
const DELEGATED_OWNER = { uid: 'down', email: 'down@runferry.test', role: 'owner', centers: [] }

let uidSeq = 0
const startApp = async (opts = {}) => {
  const app = express()
  app.use(express.json())
  const db = makeDb()
  const npCalls = []
  const npFake = opts.np || (async (apiKey, model, method, props) => {
    npCalls.push({ apiKey, model, method, props })
    if (model === 'Counterparty') return { success: true, data: [{ Ref: 'cp-1', ContactPerson: { data: [{ Ref: 'cont-1' }] } }] }
    if (model === 'InternetDocument') return { success: true, data: [{ IntDocNumber: '20450999999999', Ref: 'doc-1', CostOnSite: '90', EstimatedDeliveryDate: '18.10.2026' }] }
    return { success: false, errors: ['unexpected'] }
  })
  const notifyCalls = []
  // Кожному застосунку — свій uid у лімітерах (спільна Map процесу).
  const staffBase = opts.staff === undefined ? DIRECTOR_C1 : opts.staff
  const staff = staffBase ? { ...staffBase, uid: `${staffBase.uid}-${++uidSeq}` } : null
  registerNpTtn(app, {
    adminDb: db.adminDb,
    verifyStaff: async (_req, roles) => (staff && roles.includes(staff.role) ? staff : null),
    resolveFop: (id) => FOPS[id] || null,
    np: npFake,
    notifyClient: opts.notifyClient === undefined
      ? async (args) => { notifyCalls.push(args); return { id: 'ntf-1', status: 'sent', channel: 'sms', via: 'sms', error: null } }
      : opts.notifyClient,
    createPerMinute: opts.createPerMinute ?? 5,
    createPerDay: opts.createPerDay ?? 30,
    previewPerMinute: opts.previewPerMinute ?? 30,
  })
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const create = (body) => fetch(`${base}/api/np/ttn/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json(), retryAfter: r.headers.get('retry-after') }))
  const preview = (srId) => fetch(`${base}/api/np/ttn/preview?serviceRequestId=${encodeURIComponent(srId)}`).then(async (r) => ({ status: r.status, json: await r.json() }))
  return { create, preview, db, npCalls, notifyCalls, close: () => new Promise((r) => server.close(r)) }
}

const lastSave = (t) => t.npCalls.filter((c) => c.model === 'InternetDocument').at(-1)?.props

// ---------- чисті функції ----------
test('normalizeCost clamps to 1–20000 and falls back to 300', () => {
  assert.equal(normalizeCost(500), 500)
  assert.equal(normalizeCost('1500.6'), 1501)
  assert.equal(normalizeCost(20000), 20000)
  assert.equal(normalizeCost(20001), 300)
  assert.equal(normalizeCost(0), 300)
  assert.equal(normalizeCost(-5), 300)
  assert.equal(normalizeCost('abc'), 300)
  assert.equal(normalizeCost(undefined), 300)
})

test('computeCod: unpaid actual estimate → its total; paid → 0; explicit wins; template without cod → 0', async () => {
  const { adminDb, data } = makeDb()
  const tpl = data.npTemplates['tpl-ret']
  const fop = FOPS.fop1
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl, fop, recipientTarget: 'client' }), 12500)
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-5'], srId: 'sr-5', tpl, fop, recipientTarget: 'client' }), 0, 'paid estimate')
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-2'], srId: 'sr-2', tpl, fop, recipientTarget: 'client' }), 0, 'no estimate')
  assert.equal(await computeCod(adminDb, { explicit: 777, sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl, fop, recipientTarget: 'client' }), 777)
  assert.equal(await computeCod(adminDb, { explicit: 0, sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl, fop, recipientTarget: 'client' }), 0, 'explicit 0 = without COD')
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl: { ...tpl, cod: false }, fop, recipientTarget: 'client' }), 0)
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl, fop: { ...fop, methods: { cod: false } }, recipientTarget: 'client' }), 0, 'FOP refuses COD')
  assert.equal(await computeCod(adminDb, { sr: data.serviceRequests['sr-1'], srId: 'sr-1', tpl, fop, recipientTarget: 'service' }), 0)
})

// ---------- делегований шлях: гейти ----------
test('create: anonymous and master are refused; director of another center → OTHER_CENTER', async () => {
  const anon = await startApp({ staff: null })
  try {
    const r = await anon.create({ serviceRequestId: 'sr-1' })
    assert.equal(r.status, 403)
    assert.equal(r.json.error.code, 'FORBIDDEN')
  } finally { await anon.close() }
  const master = await startApp({ staff: MASTER_C1 })
  try {
    const r = await master.create({ serviceRequestId: 'sr-1' })
    assert.equal(r.status, 403, 'master only enters an existing number, never creates')
  } finally { await master.close() }
  const dir2 = await startApp({ staff: DIRECTOR_C2 })
  try {
    const r = await dir2.create({ serviceRequestId: 'sr-1' })
    assert.equal(r.status, 403)
    assert.equal(r.json.error.code, 'OTHER_CENTER')
    assert.match(r.json.error.message, /іншого сервісного центру/)
    assert.equal(dir2.npCalls.length, 0)
  } finally { await dir2.close() }
})

test('create: delegated needs serviceRequestId; boatOrderId is not accepted', async () => {
  const t = await startApp()
  try {
    let r = await t.create({ boatOrderId: 'bo-1', templateId: 'tpl-ret' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'BAD_REQ')
    r = await t.create({ serviceRequestId: 'sr-missing' })
    assert.equal(r.status, 404)
    assert.equal(r.json.error.code, 'NO_SR')
  } finally { await t.close() }
})

test('create: request without a center / center without a template / wrong scenario', async () => {
  const t = await startApp()
  try {
    let r = await t.create({ serviceRequestId: 'sr-3' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'NO_CENTER')
  } finally { await t.close() }
  const owner = await startApp({ staff: DELEGATED_OWNER })
  try {
    let r = await owner.create({ serviceRequestId: 'sr-6' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'NO_CENTER_TEMPLATE')
    assert.match(r.json.error.message, /з ремонту/)
    r = await owner.create({ serviceRequestId: 'sr-2' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'BAD_SCENARIO')
    assert.equal(owner.npCalls.length, 0)
  } finally { await owner.close() }
})

// ---------- делегований шлях: створення ----------
test('create: director uses the center template, ignores templateId/fopId/codAmount, writes returnTtn + stage', async () => {
  const t = await startApp()
  try {
    const r = await t.create({ serviceRequestId: 'sr-1', templateId: 'tpl-in', fopId: 'fopNoKey', codAmount: 1, cost: 500 })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.ttn, '20450999999999')
    assert.equal(r.json.data.scenario, 'return')
    assert.equal(r.json.data.codAmount, 12500, 'COD = unpaid actual estimate, not the body')
    assert.equal(r.json.data.cost, '90')
    assert.equal(r.json.data.estimatedDelivery, '18.10.2026')
    assert.equal(r.json.data.notification, undefined, 'no notify flag — no notification')
    const mp = lastSave(t)
    assert.equal(mp.Weight, '2')
    assert.equal(mp.SeatsAmount, '1')
    assert.equal(mp.VolumeGeneral, '0.02')
    assert.equal(mp.Cost, '500')
    assert.equal(mp.Description, 'Прикормочний кораблик №000577')
    assert.equal(mp.Sender, 'snd')
    assert.equal(mp.CitySender, 'city-fop')
    assert.equal(mp.CityRecipient, 'city-1')
    assert.equal(mp.RecipientAddress, 'wh-1')
    assert.equal(mp.Recipient, 'cp-1')
    assert.equal(mp.ContactRecipient, 'cont-1')
    assert.equal(mp.RecipientsPhone, '+380671234567')
    assert.equal(mp.PayerType, 'Recipient')
    assert.deepEqual(mp.BackwardDeliveryData, [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: '12500' }])
    const cp = t.npCalls.find((c) => c.model === 'Counterparty').props
    assert.equal(cp.LastName, 'Іванов')
    assert.equal(cp.FirstName, 'Іван')
    assert.equal(cp.MiddleName, 'Іванович')
    assert.equal(cp.CityRef, 'city-1')
    assert.ok(t.npCalls.every((c) => c.apiKey === 'key-1'), 'FOP of the template')
    const w = t.db.writes.find((x) => x.name === 'serviceRequests' && x.id === 'sr-1')
    assert.equal(w.patch.returnTtn, '20450999999999')
    assert.equal(w.patch.waybillNumber, undefined)
    assert.equal(w.patch.stage, 'shipped')
    assert.equal(w.patch.npCodAmount, 12500)
    assert.equal(w.patch.npCostOnSite, '90')
    assert.equal(w.patch.npEstimatedDelivery, '18.10.2026')
    assert.equal(w.patch.npFopId, 'fop1')
    assert.equal(w.patch.npScenario, 'return')
    assert.equal(w.patch.npCreatedBy, 'dir1@runferry.test')
    assert.equal(w.patch.waitingParts, null)
    assert.ok(w.patch.stageHistory, 'arrayUnion with the shipped entry')
    assert.deepEqual(w.opts, { merge: true })
  } finally { await t.close() }
})

test('create: cost out of range falls back to 300; already shipped request keeps its stage', async () => {
  const t = await startApp()
  try {
    const r = await t.create({ serviceRequestId: 'sr-4', replace: true, cost: 50000 })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(lastSave(t).Cost, '300')
    const w = t.db.writes.find((x) => x.id === 'sr-4')
    assert.equal(w.patch.stage, undefined, 'no second «shipped» entry')
    assert.equal(w.patch.returnTtn, '20450999999999')
  } finally { await t.close() }
})

test('create: existing returnTtn → 409 TTN_EXISTS unless replace:true', async () => {
  const t = await startApp()
  try {
    let r = await t.create({ serviceRequestId: 'sr-4' })
    assert.equal(r.status, 409)
    assert.equal(r.json.error.code, 'TTN_EXISTS')
    assert.equal(r.json.error.ttn, '20450222222222')
    assert.equal(t.npCalls.length, 0)
    r = await t.create({ serviceRequestId: 'sr-4', replace: true })
    assert.equal(r.status, 200)
  } finally { await t.close() }
})

test('create: no client branch → NO_CLIENT_ADDRESS; refs from the body are used; paid estimate → no COD', async () => {
  const t = await startApp()
  try {
    let r = await t.create({ serviceRequestId: 'sr-5' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'NO_CLIENT_ADDRESS')
    assert.match(r.json.error.message, /відділення/i)
    assert.equal(t.npCalls.length, 0, 'no silent fallback to a fixed recipient')
    r = await t.create({ serviceRequestId: 'sr-5', clientCityRef: 'city-9', clientWarehouseRef: 'wh-9' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const mp = lastSave(t)
    assert.equal(mp.CityRecipient, 'city-9')
    assert.equal(mp.RecipientAddress, 'wh-9')
    assert.equal(mp.BackwardDeliveryData, undefined, 'estimate is paid')
    assert.equal(r.json.data.codAmount, 0)
  } finally { await t.close() }
})

test('create: notify:true calls notifyClient after success and returns its status; a failure does not undo the waybill', async () => {
  const t = await startApp()
  try {
    const r = await t.create({ serviceRequestId: 'sr-1', notify: true })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.data.notification, { status: 'sent', channel: 'sms', via: 'sms', error: null, skipped: false })
    assert.equal(t.notifyCalls.length, 1)
    assert.deepEqual(t.notifyCalls[0], { serviceRequestId: 'sr-1', event: 'ttn', ttn: '20450999999999', by: 'dir1@runferry.test' })
  } finally { await t.close() }
  const failing = await startApp({ notifyClient: async () => { throw new Error('немає доступного каналу') } })
  try {
    const r = await failing.create({ serviceRequestId: 'sr-1', notify: true })
    assert.equal(r.status, 200)
    assert.equal(r.json.data.ttn, '20450999999999')
    assert.equal(r.json.data.notification.status, 'failed')
    assert.match(r.json.data.notification.error, /каналу/)
    assert.ok(failing.db.writes.some((w) => w.id === 'sr-1' && w.patch.returnTtn), 'waybill is still written')
  } finally { await failing.close() }
  const none = await startApp({ notifyClient: null })
  try {
    const r = await none.create({ serviceRequestId: 'sr-1', notify: true })
    assert.equal(r.json.data.notification.status, 'failed')
  } finally { await none.close() }
})

test('create: Nova Poshta errors are passed through as 502 NP_ERROR with npErrors', async () => {
  const t = await startApp({ np: async (_k, model) => (model === 'Counterparty' ? { success: true, data: [{ Ref: 'cp' }] } : { success: false, errors: ['RecipientAddress is invalid'] }) })
  try {
    const r = await t.create({ serviceRequestId: 'sr-1' })
    assert.equal(r.status, 502)
    assert.equal(r.json.error.code, 'NP_ERROR')
    assert.equal(r.json.error.message, 'RecipientAddress is invalid')
    assert.deepEqual(r.json.error.npErrors, ['RecipientAddress is invalid'])
    assert.equal(t.db.writes.length, 0)
  } finally { await t.close() }
})

test('create: per-minute and per-day limits are per uid and count only accepted requests', async () => {
  const t = await startApp({ createPerMinute: 1 })
  try {
    assert.equal((await t.create({ serviceRequestId: 'sr-1' })).status, 200)
    const r = await t.create({ serviceRequestId: 'sr-1', replace: true })
    assert.equal(r.status, 429)
    assert.equal(r.json.error.code, 'RATE_LIMITED')
    assert.match(r.json.error.message, /хвилину/)
    assert.equal(r.retryAfter, '60')
  } finally { await t.close() }
  const d = await startApp({ createPerDay: 1 })
  try {
    assert.equal((await d.create({ serviceRequestId: 'sr-4' })).status, 409, 'rejected before the limiter — does not burn a slot')
    assert.equal((await d.create({ serviceRequestId: 'sr-1' })).status, 200)
    const r = await d.create({ serviceRequestId: 'sr-1', replace: true })
    assert.equal(r.status, 429)
    assert.match(r.json.error.message, /Денний ліміт/)
  } finally { await d.close() }
})

// ---------- власник за email: як було ----------
test('create: the owner by email keeps the full path — any template, no center check, no limit', async () => {
  const t = await startApp({ staff: OWNER, createPerMinute: 1 })
  try {
    let r = await t.create({ serviceRequestId: 'sr-3', templateId: 'tpl-in', clientCityRef: 'city-3', clientWarehouseRef: 'wh-3', cost: 50000 })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.scenario, 'incoming')
    const mp = lastSave(t)
    assert.equal(mp.CitySender, 'city-3', 'incoming: the client ships from his branch')
    assert.equal(mp.PayerType, 'Sender')
    assert.equal(mp.Cost, '50000', 'owner is not clamped')
    const w = t.db.writes.find((x) => x.id === 'sr-3')
    assert.equal(w.patch.waybillNumber, '20450999999999')
    assert.equal(w.patch.returnTtn, undefined)
    assert.equal(w.patch.stage, undefined, 'incoming does not ship')
    // Другий виклик поспіль — без 429 і без 409 (повний шлях).
    r = await t.create({ serviceRequestId: 'sr-4', templateId: 'tpl-ret', codAmount: 0 })
    assert.equal(r.status, 200)
    assert.equal(lastSave(t).BackwardDeliveryData, undefined, 'explicit codAmount 0 = without COD')
    r = await t.create({ serviceRequestId: 'sr-1' })
    assert.equal(r.status, 200, 'without templateId the owner falls back to the center template (the app)')
    assert.equal(r.json.data.scenario, 'return')
  } finally { await t.close() }
})

test('create: the owner by email WITHOUT templateId (the app) takes the center-template path, any center', async () => {
  const t = await startApp({ staff: OWNER })
  try {
    let r = await t.create({ serviceRequestId: 'sr-1', cost: 400 })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.scenario, 'return', 'center template «з ремонту», not BAD_REQ')
    assert.equal(lastSave(t).Cost, '400')
    const w = t.db.writes.find((x) => x.id === 'sr-1')
    assert.equal(w.patch.returnTtn, '20450999999999')
    assert.equal(w.patch.stage, 'shipped')
    // Чужий центр для власника не існує; шаблон центру c2 — «на ремонт» → BAD_SCENARIO, не OTHER_CENTER.
    r = await t.create({ serviceRequestId: 'sr-2' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'BAD_SCENARIO')
    // Наявна ТТН → 409 і для власника на шляху центру.
    r = await t.create({ serviceRequestId: 'sr-4' })
    assert.equal(r.status, 409)
    assert.equal(r.json.error.code, 'TTN_EXISTS')
    // Замовлення кораблика без шаблону — як було: BAD_REQ.
    r = await t.create({ boatOrderId: 'bo-1' })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'BAD_REQ')
  } finally { await t.close() }
})

// ---------- превʼю ----------
test('preview: director sees the center template, FOP, COD, address and canCreate', async () => {
  const t = await startApp()
  try {
    const r = await t.preview('sr-1')
    assert.equal(r.status, 200, JSON.stringify(r.json))
    const d = r.json.data
    assert.equal(d.centerName, 'Київ')
    assert.equal(d.templateId, 'tpl-ret')
    assert.equal(d.templateName, 'З ремонту, великий')
    assert.equal(d.scenario, 'return')
    assert.equal(d.size, 'big')
    assert.equal(d.weight, 2)
    assert.equal(d.seatsAmount, 1)
    assert.equal(d.serviceType, 'WarehouseWarehouse')
    assert.equal(d.description, 'Прикормочний кораблик №000577')
    assert.equal(d.fopId, 'fop1')
    assert.equal(d.fopName, 'ФОП Тестовий')
    assert.equal(d.cod, true)
    assert.equal(d.codAmount, 12500)
    assert.equal(d.costDefault, 300)
    assert.equal(d.costMax, 20000)
    assert.deepEqual(d.clientAddress, { cityRef: 'city-1', cityName: 'Київ', warehouseRef: 'wh-1', warehouseName: 'Відділення №1' })
    assert.equal(d.existingTtn, null)
    assert.equal(d.stage, 'packed')
    assert.equal(d.canCreate, true)
    assert.equal(d.reasonCode, null)
    assert.equal(t.npCalls.length, 0, 'preview never calls Nova Poshta')
  } finally { await t.close() }
})

test('preview: obstacles come back as canCreate=false with a code, except missing request / other center', async () => {
  const t = await startApp()
  try {
    let r = await t.preview('sr-5')
    assert.equal(r.status, 200)
    assert.equal(r.json.data.canCreate, false)
    assert.equal(r.json.data.reasonCode, 'NO_CLIENT_ADDRESS')
    assert.equal(r.json.data.codAmount, 0, 'paid estimate')
    assert.equal(r.json.data.templateName, 'З ремонту, великий', 'template is still shown')
    r = await t.preview('sr-3')
    assert.equal(r.json.data.canCreate, false)
    assert.equal(r.json.data.reasonCode, 'NO_CENTER')
    r = await t.preview('sr-4')
    assert.equal(r.json.data.canCreate, true)
    assert.equal(r.json.data.existingTtn, '20450222222222')
    r = await t.preview('sr-2')
    assert.equal(r.status, 403)
    assert.equal(r.json.error.code, 'OTHER_CENTER')
    r = await t.preview('sr-missing')
    assert.equal(r.status, 404)
    r = await t.preview('')
    assert.equal(r.status, 400)
  } finally { await t.close() }
  const owner = await startApp({ staff: DELEGATED_OWNER })
  try {
    let r = await owner.preview('sr-6')
    assert.equal(r.json.data.reasonCode, 'NO_CENTER_TEMPLATE')
    r = await owner.preview('sr-2')
    assert.equal(r.status, 200, 'delegated owner sees every center')
    assert.equal(r.json.data.reasonCode, 'BAD_SCENARIO')
  } finally { await owner.close() }
  const master = await startApp({ staff: MASTER_C1 })
  try {
    assert.equal((await master.preview('sr-1')).status, 403)
  } finally { await master.close() }
})

test('preview: a FOP without an NP key is reported', async () => {
  const t = await startApp()
  t.db.data.npTemplates['tpl-ret'].fopId = 'fopNoKey'
  try {
    const r = await t.preview('sr-1')
    assert.equal(r.json.data.canCreate, false)
    assert.equal(r.json.data.reasonCode, 'NO_NP_KEY')
    assert.equal(r.json.data.fopName, null)
    assert.equal((await t.create({ serviceRequestId: 'sr-1' })).json.error.code, 'NO_NP_KEY')
  } finally { await t.close() }
})

test('preview: per-minute limit per uid', async () => {
  const t = await startApp({ previewPerMinute: 2 })
  try {
    assert.equal((await t.preview('sr-1')).status, 200)
    assert.equal((await t.preview('sr-1')).status, 200)
    const r = await t.preview('sr-1')
    assert.equal(r.status, 429)
    assert.equal(r.json.error.code, 'RATE_LIMITED')
  } finally { await t.close() }
})
