// node --test: страницы владельца магазина (server/shopAdmin.js) и то, что они добавили в сверку и хуки. Без сети и Firestore:
// настоящие payments.js, хуки и шаг сверки поверх фейковой базы; банк, касса, Новая Почта, Telegram и SMS подменены.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import axios from 'axios'

process.env.PAYMENTS_RECONCILE = 'false'
process.env.SHOP_CALLBACK_BASE_URL = 'https://portal.test'
for (const k of ['PUBLIC_BASE_URL', 'FOPS_CONFIG', 'OWNER_TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']) delete process.env[k]
const { registerPayments } = await import('./payments.js')
const { createShopPaymentHooks, KYIV_DAY, messageDue } = await import('./shopPayments.js')
const { createShopReconcile } = await import('./shopReconcile.js')
const { registerShopAdmin } = await import('./shopAdmin.js')
const { registerNotifications } = await import('./notifications.js')
const { ADMIN_EMAIL } = await import('./adminAuth.js')
const { npTemplateProblems, orderFlags, orderNeedsAction, orderPublicView, phoneKeyOf, salesSettingsNext, validateRecipient, transitionPatch, withGuideStep } = await import('./shopCore.js')
const realCheckbox = await import('./checkbox.js')

const logs = []
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => logs.push(args.map(String).join(' '))

const PHONE = '+380671234567'
const NEW_PHONE = '+380501112233'
const OWNER_PHONE = '+380670000009'
const STATUS_TOKEN = 'Abcdefghijklmnopqrstuv'
const SITE = 'https://runferry.test'
const TAX_URL = 'https://check.test/tax-1'
const TTN = '20450000000001'
const CITY = '11111111-1111-4111-8111-111111111111'
const WAREHOUSE = '22222222-2222-4222-8222-222222222222'
const POSTOMAT_TYPE = '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc'
const BANK_PAID = { status: 'success', amount: 80000, ccy: 980, finalAmount: 80000, reference: 'pay-1' }
const SECRET_MARKS = ['SECRET-mono', 'SECRET-lic', 'SECRET-pin', 'NP-KEY-2', STATUS_TOKEN.slice(1)]
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })
const timeoutErr = () => Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED', isAxiosError: true })
const held = () => { let release; const gate = new Promise((ok) => { release = ok }); return { gate, release } }
const until = async (fn, what = 'умова') => {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > 2000) throw new Error(`не дочекались: ${what}`)
    await sleep(2)
  }
}

// ---------- фейковый Firestore: транзакции по очереди и с записью в конце ----------

const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) { this.docs = clone(seed); this.writes = []; this.failWrite = null; this.txQueue = Promise.resolve() }
  write(path, v, opts) {
    if (this.failWrite && this.failWrite(path, v)) throw new Error(`база: ${path} не пишеться`)
    this.writes.push({ path, v: clone(v) })
    if (opts && opts.merge && this.docs[path]) deepMerge(this.docs[path], v)
    else this.docs[path] = clone(v)
  }
  collection(name) {
    const db = this
    const query = (match, { max = Infinity, order = null } = {}) => ({
      limit: (n) => query(match, { max: n, order }),
      orderBy: (field, dir) => query(match, { max, order: { field, dir } }),
      startAfter: () => query(() => false, { max, order }),
      async get() {
        let docs = Object.entries(db.docs)
          .filter(([path, d]) => path.startsWith(`${name}/`) && match(d))
          .map(([path, d]) => ({ id: path.slice(name.length + 1), data: () => clone(d), createdAt: d.createdAt }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
        if (order) docs = docs.sort((a, b) => (a[order.field] < b[order.field] ? 1 : -1) * (order.dir === 'desc' ? 1 : -1))
        docs = docs.slice(0, max)
        return { docs, empty: !docs.length, size: docs.length }
      },
    })
    return {
      doc(id) {
        const path = `${name}/${id}`
        return {
          id, path,
          async get() { const d = db.docs[path]; return { id, exists: d !== undefined, data: () => clone(d) } },
          async set(v, opts) { db.write(path, v, opts) },
        }
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`fake where: ${op}`)
        return query((d) => d[field] === value)
      },
      orderBy(field, dir) { return query(() => true, { order: { field, dir } }) },
    }
  }
  runTransaction(fn) {
    const run = async () => {
      const writes = []
      const out = await fn({
        async get(ref) { if (writes.length) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
        set(ref, v, opts) { writes.push([ref.path, v, opts]) },
      })
      for (const [path, v, opts] of writes) this.write(path, v, opts)
      return out
    }
    const p = this.txQueue.then(run)
    this.txQueue = p.catch(() => {})
    return p
  }
}

// ---------- данные ----------

const seller = () => ({ displayName: 'Продавець', ipn: '1234567890', address: 'Адреса', email: 'shop@example.com', phone: '+380670000001' })
const fopMeta = (over = {}) => ({
  name: 'ФОП', active: true, methods: { monoAcquire: true }, seller: seller(),
  novaPoshta: { senderRef: 'snd', contactRef: 'cnt', senderPhone: '380670000001', cityRef: 'city-fop', warehouseRef: 'wh-fop' }, ...over,
})
const fopSecret = (over = {}) => ({ monoAcquire: { token: 'SECRET-mono' }, checkbox: { licenseKey: 'SECRET-lic', pinCode: 'SECRET-pin' }, novaPoshta: { apiKey: 'NP-KEY-2' }, ...over })
const template = (over = {}) => ({ name: 'Кришка', scenario: 'parts', fopId: 'fop-2', description: 'Запчастина для кораблика', weight: 0.5, seatsAmount: 1, payerType: 'recipient', active: true, cod: false, ...over })
const skuRule = (over = {}) => ({ enabled: true, inStock: true, stock: null, minUah: 600, maxUah: 1200, ...over })
const sales = (over = {}) => ({
  mode: 'live', methods: { card: true, cod: false }, fopId: 'fop-2', npTemplateId: 'tpl-1', siteBaseUrl: SITE, offerVersion: '2026-11-03', ownerPhone: OWNER_PHONE,
  ownerTestOkAt: ago(DAY), codKind: 'control', codReceiptMode: 'ettn', cardReceiptLabel: 'Інтернет еквайринг', skus: { 'V2-LID-R': skuRule() }, ...over,
})
const priceList = () => ({ materials: [{ code: 'V2-LID-R', active: true, price: 800, name: { uk: 'Кришка' }, site: { status: 'published', slug: 'lid-r' } }] })

const paidOrder = (over = {}) => ({
  orderNo: 'RF-AAAAAA', statusToken: STATUS_TOKEN, idempotencyKey: 'key-1234567890abcd', fingerprint: 'fp-secret', state: 'paid', method: 'card', sku: 'V2-LID-R', titleUk: 'Кришка', qty: 1, total: 800, fopId: 'fop-2',
  lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', clientName: 'Шевченко Тарас Григорович', clientPhone: PHONE, phoneKey: 'pk-1', email: 'taras@example.com',
  clientCityRef: CITY, clientCityName: 'Умань', clientWarehouseRef: WAREHOUSE, clientWarehouseName: 'Відділення №77', offerVersion: '2026-11-03', addressVerified: true,
  paidPaymentId: 'pay-1', paidAt: ago(HOUR), paymentIds: ['pay-1'], payAttempts: 1,
  payment: { paymentId: 'pay-1', invoiceId: 'inv-1', pageUrl: null, status: 'success', initiatedAt: null, lastBankCheckAt: ago(MIN) },
  receipt: { status: 'ready', taxUrl: TAX_URL }, sms: { paid: { status: 'sent', at: ago(HOUR), tries: 1 } }, alerts: { 'new-paid': { at: ago(HOUR), sentAt: ago(HOUR), text: 'x' } },
  history: [{ at: ago(HOUR), from: 'awaiting_payment', to: 'paid', by: 'webhook' }], createdAt: ago(2 * HOUR), updatedAt: ago(HOUR),
  ...over,
})
const awaitingOrder = (over = {}) => paidOrder({
  state: 'awaiting_payment', paidPaymentId: null, paidAt: null, receipt: { status: 'none' }, sms: {}, alerts: {},
  payment: { paymentId: 'pay-1', invoiceId: 'inv-1', pageUrl: 'https://pay.test/1', status: 'created', initiatedAt: null, lastBankCheckAt: null, expiresAt: new Date(Date.now() + HOUR).toISOString() },
  history: [{ at: ago(HOUR), from: null, to: 'awaiting_payment', by: 'site' }], ...over,
})
const payment = (over = {}) => ({
  orderId: 'pay-1', fopId: 'fop-2', amount: 800, goods: [{ name: 'Кришка', price: 800, qty: 1, code: 'V2-LID-R' }], method: 'mono-acquire', provider: 'mono-acquire',
  providerOrderId: 'inv-1', status: 'paid', shopOrderId: 'so-1', paymentLabel: 'Інтернет еквайринг', receiptId: 'rcpt-1', receiptStatus: 'DONE', taxUrl: TAX_URL, createdAt: ago(2 * HOUR), updatedAt: ago(HOUR),
  ...over,
})
const docsOf = (order = paidOrder(), pay = payment(), extra = {}) => ({
  'system/shopSales': sales(), 'fops/fop-2': fopMeta(), 'fopSecrets/fop-2': fopSecret(), 'npTemplates/tpl-1': template(), 'priceList/current': priceList(),
  'shopOrders/so-1': order, ...(pay ? { 'payments/pay-1': pay } : {}), ...extra,
})

// ---------- стенд ----------

const OWNER = { uid: 'owner-uid', email: ADMIN_EMAIL, role: 'owner', centers: [] }
const DIRECTOR = { uid: 'dir-uid', email: 'deputy@example.com', role: 'director', centers: [] }

const fakeNp = (over = {}) => {
  const calls = []
  const np = async (apiKey, model, method, props) => {
    calls.push({ apiKey, model, method, props })
    if (over[model]) return over[model](props)
    if (model === 'Counterparty') return { success: true, data: [{ Ref: 'cp-1', ContactPerson: { data: [{ Ref: 'cont-1' }] } }] }
    if (model === 'InternetDocument') return { success: true, data: [{ IntDocNumber: TTN, Ref: 'doc-1', CostOnSite: 70, EstimatedDeliveryDate: '05.11.2026' }] }
    if (model === 'TrackingDocument') return { success: true, data: props.Documents.map((d) => ({ Number: d.DocumentNumber, StatusCode: '1', Status: 'Створено' })) }
    throw new Error(`unexpected ${model}`)
  }
  np.calls = calls
  np.saves = () => calls.filter((c) => c.model === 'InternetDocument')
  np.saved = () => np.saves()[0]?.props
  return np
}

const stand = async (t, docs = docsOf(), opts = {}) => {
  const { staff = OWNER, np = fakeNp(), notify = async () => true, client = async () => ({ status: 'sent', id: 'ntf-1' }), sms = async () => ({ ok: true }), npRequest = async () => ({ success: true, data: [] }), sell, getReceipt, cashier = {}, readinessBudgetMs, addressBudgetMs, notifications = false } = opts
  const db = new FakeDb(docs)
  const calls = { alerts: [], client: [], sms: [], sells: [], getReceipt: [], npRequest: [] }
  const bank = { statuses: { 'inv-1': BANK_PAID }, fail: {}, statusCalls: [], removed: [], removeFail: {} }
  bank.mono = {
    createInvoice: async () => { throw new Error('страницы владельца счета не создают') },
    invoiceStatus: async (fop, id) => {
      assert.equal(fop.monoAcquire.token, 'SECRET-mono', 'банк спрашиваем ключом ФОП')
      bank.statusCalls.push(id)
      if (bank.fail[id]) throw bank.fail[id]
      return { invoiceId: id, status: 'created', ...bank.statuses[id] }
    },
    removeInvoice: async (_fop, id) => {
      bank.removed.push(id)
      if (bank.removeFail[id]) throw bank.removeFail[id]
      return {}
    },
    verifyWebhook: async () => true,
    merchantDetails: opts.merchantDetails || (async () => ({ merchantName: 'Кабінет ФОП', edrpou: '1234567890' })),
  }
  const cbx = {
    ...realCheckbox,
    sellReceipt: async (fop, args) => {
      calls.sells.push({ fopId: fop.id, ...args })
      return sell ? sell(fop, args) : { receiptId: 'rcpt-new', fiscalCode: 'FC-1', taxUrl: TAX_URL, status: 'DONE' }
    },
    getReceipt: async (fop, id) => {
      calls.getReceipt.push(id)
      if (!getReceipt) throw new Error('getReceipt не ожидался')
      return getReceipt(fop, id)
    },
    cashierMe: cashier.me || (async () => ({ full_name: 'Касир', blocked: false, organization: { title: 'ФОП', edrpou: '1234567890', auto_close_shift_at: '23:30' } })),
    cashierShift: cashier.shift || (async () => ({ status: 'OPENED', opened_at: '2026-11-03T08:00:00Z' })),
    cashRegisterInfo: cashier.register || (async () => ({ title: 'Каса 1', address: 'Умань', fiscal_number: '400', ettn_acquiring_id: null })),
  }
  const api = registerPayments(express(), { adminDb: db, mono: bank.mono, cbx })
  const sendSms = async (phone, text) => { calls.sms.push({ phone, text }); return sms(phone, text) }
  const notifyClient = notifications
    ? registerNotifications(express(), { adminDb: db, senders: {}, sendSms, siteUrl: 'https://portal.test' }).notifyClient
    : async (args) => { calls.client.push(args); return client(args) }
  const payments = { ...api, notifyOwner: async (text) => { calls.alerts.push(text); return notify(text) } }
  const hooks = createShopPaymentHooks({ adminDb: db, payments, mono: bank.mono, siteUrl: 'https://portal.test', notifyClient, sendSms })
  api.setShopHooks(hooks)
  const who = { staff }
  const app = express()
  app.use(express.json())
  registerShopAdmin(app, {
    adminDb: db, hooks, payments, mono: bank.mono, cbx, np, siteUrl: 'https://portal.test', sendSms, readinessBudgetMs, addressBudgetMs,
    npRequest: async (...args) => { calls.npRequest.push(args); return npRequest(...args) },
    verifyStaff: async (_req, roles) => { who.roles = roles; return who.staff },
  })
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  t.after(() => srv.close())
  const call = async (method, path, { body, raw } = {}) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
      method,
      headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {},
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    assert.match(r.headers.get('content-type') || '', /^application\/json/, `${method} ${path}: ${text}`)
    const json = JSON.parse(text)
    assert.equal(json.success, r.status < 400, `${method} ${path}: ${text}`)
    return { status: r.status, text, json, data: json.data, error: json.error }
  }
  const { step } = createShopReconcile({ adminDb: db, payments, hooks, mono: bank.mono, cbx, npCall: np, siteUrl: 'https://portal.test', slowScanMs: 0, purgeEveryMs: DAY })
  return {
    db, bank, calls, np, who, call, step, hooks, api,
    post: (path, body = {}) => call('POST', `/api/shop/admin${path}`, { body }),
    get: (path) => call('GET', `/api/shop/admin${path}`),
    put: (path, body) => call('PUT', `/api/shop/admin${path}`, { body }),
    order: (id = 'so-1') => clone(db.docs[`shopOrders/${id}`]),
    pay: (id = 'pay-1') => clone(db.docs[`payments/${id}`]),
    settings: () => clone(db.docs['system/shopSales']),
    patch: (path, v) => deepMerge(db.docs[path], v),
  }
}
const historyTo = (s) => s.order().history.map((h) => h.to)
const noSecrets = (text) => { for (const m of SECRET_MARKS) assert.ok(!text.includes(m), `у відповіді ${m}: ${text}`) }

// ---------- вход ----------

test('вход: без сотрудника все маршруты 403, роли только owner и director', async (t) => {
  const s = await stand(t, docsOf(), { staff: null })
  for (const [method, path] of [
    ['GET', '/orders'], ['GET', '/orders/so-1'], ['POST', '/orders/so-1/ttn'], ['POST', '/orders/so-1/ttn/attach'], ['POST', '/orders/so-1/ttn/refresh'], ['POST', '/orders/so-1/cancel'],
    ['POST', '/orders/so-1/recipient'], ['POST', '/orders/so-1/mark'], ['POST', '/orders/so-1/receipt-retry'], ['POST', '/orders/so-1/resend'], ['GET', '/readiness'], ['GET', '/settings'], ['PUT', '/settings'],
    ['POST', '/test-alert'], ['POST', '/disable-and-remove-invoices'], ['POST', '/daily-reset'], ['POST', '/phones/unblock'],
  ]) {
    const r = await s.call(method, `/api/shop/admin${path}`, { body: method === 'GET' ? undefined : {} })
    assert.equal(r.status, 403, path)
    assert.equal(r.error.code, 'FORBIDDEN', path)
  }
  assert.deepEqual(s.who.roles, ['owner', 'director'])
  assert.equal(s.order().state, 'paid')
  assert.equal(s.np.calls.length, 0)
})

test('вход: директор видит заказы, создаёт накладную и отмечает, но настройки, тест, сброс и разблокировка только у владельца', async (t) => {
  const s = await stand(t, docsOf(), { staff: DIRECTOR })
  assert.equal((await s.get('/orders')).status, 200)
  assert.equal((await s.get('/orders/so-1')).status, 200)
  assert.equal((await s.get('/readiness')).status, 200)
  for (const [method, path, body] of [['PUT', '/settings', { mode: 'off' }], ['POST', '/test-alert', {}], ['POST', '/daily-reset', {}], ['POST', '/phones/unblock', { phone: PHONE }]]) {
    const r = await s.call(method, `/api/shop/admin${path}`, { body })
    assert.equal(r.status, 403, path)
    assert.equal(r.error.code, 'OWNER_ONLY', path)
  }
  assert.equal(s.settings().mode, 'live')
  assert.equal(s.calls.alerts.length, 0)
  const ttn = await s.post('/orders/so-1/ttn')
  assert.equal(ttn.status, 200, ttn.text)
  const row = s.order().history.at(-1)
  assert.equal(row.by, DIRECTOR.email)
  assert.equal(s.order().state, 'shipped')
})

test('вход: роль owner в users без почты владельца не получает прав владельца', async (t) => {
  const s = await stand(t, docsOf(), { staff: { uid: 'u2', email: 'other@example.com', role: 'owner', centers: [] } })
  assert.equal((await s.put('/settings', { mode: 'off' })).error.code, 'OWNER_ONLY')
})

test('неизвестный адрес и битое тело отвечают JSON, а не страницей HTML; тело в журнал не попадает', async (t) => {
  const s = await stand(t)
  const missing = await s.get('/nothing')
  assert.equal(missing.status, 404)
  assert.equal(missing.error.code, 'NOT_FOUND')
  const broken = await s.call('POST', '/api/shop/admin/orders/so-1/ttn', { raw: '{"phone":"+380671234567"' })
  assert.equal(broken.status, 400)
  assert.equal(broken.error.code, 'BAD_INPUT')
  assert.ok(!logs.join('\n').includes('+380671234567'))
})

test('сбой базы: 500 в JSON, заказ не найден и кривой id: 404, без обращения к базе', async (t) => {
  const s = await stand(t)
  assert.equal((await s.get('/orders/so-nothing')).error.code, 'NOT_FOUND')
  assert.equal((await s.get('/orders/..%2Fsystem%2FshopSales')).status, 404)
  const realCollection = s.db.collection.bind(s.db)
  s.db.collection = () => { throw new Error('база лежить') }
  const r = await s.get('/orders/so-1')
  assert.equal(r.status, 500)
  assert.equal(r.error.code, 'INTERNAL')
  s.db.collection = realCollection
})

test('без базы маршруты отвечают 503', async (t) => {
  const app = express()
  const db = new FakeDb(docsOf())
  const api = registerPayments(express(), { adminDb: db, mono: {}, cbx: realCheckbox })
  const hooks = createShopPaymentHooks({ adminDb: db, payments: api, mono: {} })
  // Шаг сверки требует базу только в момент прохода, поэтому регистрация без неё не падает.
  registerShopAdmin(app, { adminDb: null, hooks, payments: api, verifyStaff: async () => OWNER })
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  t.after(() => srv.close())
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/shop/admin/orders`)
  assert.equal(r.status, 503)
  assert.equal((await r.json()).error.code, 'NO_DB')
})

// ---------- список и карточка ----------

test('список: по умолчанию новые сверху, данные покупателя есть, токена и отпечатка нет', async (t) => {
  const s = await stand(t, docsOf(paidOrder(), payment(), { 'shopOrders/so-2': paidOrder({ orderNo: 'RF-BBBBBB', createdAt: ago(MIN) }) }))
  const r = await s.get('/orders')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.items.map((i) => i.orderNo), ['RF-BBBBBB', 'RF-AAAAAA'])
  const row = r.data.items[1]
  assert.equal(row.id, 'so-1')
  assert.equal(row.clientPhone, PHONE)
  assert.equal(row.clientName, 'Шевченко Тарас Григорович')
  assert.equal(row.receiptStatus, 'ready')
  assert.equal(row.needsAction, true)
  assert.equal(row.clientCityName, 'Умань')
  assert.equal(row.clientWarehouseName, 'Відділення №77')
  assert.ok(row.paidAt)
  noSecrets(r.text)
  assert.ok(!r.text.includes('fp-secret'))
})

test('поиск: по телефону через хэш в любом написании, кривой телефон 400, по номеру заказа без учёта регистра', async (t) => {
  const key = phoneKeyOf(PHONE)
  const s = await stand(t, docsOf(paidOrder({ phoneKey: key }), payment(), { 'shopOrders/so-2': paidOrder({ phoneKey: 'other', orderNo: 'RF-BBBBBB' }) }))
  for (const phone of ['+380671234567', '0671234567', '380 67 123 45 67']) {
    const r = await s.get(`/orders?phone=${encodeURIComponent(phone)}`)
    assert.deepEqual(r.data.items.map((i) => i.id), ['so-1'], phone)
  }
  const bad = await s.get('/orders?phone=abc')
  assert.equal(bad.status, 400)
  assert.equal(bad.error.code, 'BAD_INPUT')
  assert.deepEqual((await s.get('/orders?orderNo=rf-bbbbbb')).data.items.map((i) => i.id), ['so-2'])
})

test('первый экран: только то, что требует действия, счётчики панели и живые счета', async (t) => {
  const today = KYIV_DAY.format(new Date())
  const shippedAt = ago(HOUR)
  const s = await stand(t, docsOf(paidOrder(), payment(), {
    'shopOrders/so-shipped': paidOrder({ state: 'shipped', ttn: TTN, shippedAt, receipt: { status: 'ready' } }),
    'shopOrders/so-cod': paidOrder({ state: 'cod_confirmed', method: 'cod', paidPaymentId: null }),
    'shopOrders/so-paid2': paidOrder(),
    'shopOrders/so-cod2': paidOrder({ state: 'cod_confirmed', method: 'cod', paidPaymentId: null }),
    'shopOrders/so-review': paidOrder({ state: 'payment_review', orderNo: 'RF-CCCCCC' }),
    'shopOrders/so-receipt': paidOrder({ state: 'shipped', ttn: TTN, receipt: { status: 'failed' } }),
    'shopOrders/so-closed': paidOrder({ state: 'reversed', ttn: TTN, ttnOnClosed: true }),
    'shopOrders/so-done': paidOrder({ state: 'delivered', ttn: TTN }),
    'shopOrders/so-wait': awaitingOrder(),
    [`shopDaily/${today}`]: { unpaid: 7 },
    'payments/pay-live': payment({ orderId: 'pay-live', status: 'pending', createdAt: ago(10 * MIN) }),
    'payments/pay-dead': payment({ orderId: 'pay-dead', status: 'pending', createdAt: ago(2 * HOUR) }),
    'payments/pay-repair': { orderId: 'pay-repair', status: 'pending', createdAt: ago(10 * MIN), provider: 'mono-acquire', providerOrderId: 'rep' },
  }))
  const r = await s.get('/orders?view=action')
  assert.deepEqual(r.data.items.map((i) => i.id).sort(), ['so-1', 'so-closed', 'so-cod', 'so-cod2', 'so-paid2', 'so-receipt', 'so-review'])
  assert.deepEqual(r.data.counters, { action: 7, noTtn: 4, liveInvoices: 1, unpaidToday: 7 })
  assert.equal(r.data.items.find((i) => i.id === 'so-receipt').ttn, TTN)
  assert.equal((await s.get('/orders')).data.items.find((i) => i.id === 'so-shipped').shippedAt, shippedAt)
  assert.deepEqual(r.data.items.find((i) => i.id === 'so-receipt').flags, ['receipt-failed'])
  assert.deepEqual(r.data.items.find((i) => i.id === 'so-review').flags, ['payment-review'])
  assert.deepEqual(r.data.items.find((i) => i.id === 'so-closed').flags, ['ttn-on-closed'])
})

test('карточка: ссылка на статус вместо токена, счета, ничего секретного', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ phoneCode: { hash: 'code-hash' }, npDelivery: { code: '1', text: 'Створено' } }), payment({ receiptEmailDropped: true, partialRefund: { amount: 100 } }), {
    'payments/pay-2': payment({ orderId: 'pay-2', status: 'failure', receiptId: null, taxUrl: null, receiptStatus: null }),
  }))
  s.patch('shopOrders/so-1', { paymentIds: ['pay-2', 'pay-1', 'pay-missing'] })
  const r = await s.get('/orders/so-1')
  assert.equal(r.status, 200)
  assert.equal(r.data.statusUrl, `${SITE}/uk/order/${STATUS_TOKEN}`)
  for (const k of ['statusToken', 'idempotencyKey', 'fingerprint', 'phoneKey', 'phoneCode']) assert.equal(k in r.data, false, k)
  assert.equal(r.data.clientPhone, PHONE)
  assert.equal(r.data.npDelivery.text, 'Створено')
  assert.equal(r.data.sms.paid.status, 'sent')
  assert.deepEqual(r.data.invoices.map((i) => [i.id, i.status, i.paying]), [['pay-2', 'failure', false], ['pay-1', 'paid', true]])
  assert.equal(r.data.invoices[1].receiptEmailDropped, true)
  assert.deepEqual(r.data.invoices[1].partialRefund, { amount: 100 })
  assert.ok(!r.text.includes('code-hash'))
  const noUrl = await stand(t, docsOf())
  noUrl.patch('system/shopSales', { siteBaseUrl: 'http://bad' })
  assert.equal((await noUrl.get('/orders/so-1')).data.statusUrl, null)
})

// ---------- накладная: счастливый путь ----------

test('накладная: стоимость, ФОП и получатель из заказа, тело ни на что не влияет, без наложки; заказ shipped, покупателю номер', async (t) => {
  const s = await stand(t)
  const r = await s.post('/orders/so-1/ttn', {
    total: 1, cost: 5, fopId: 'fop-1', codAmount: 999, cod: { amount: 999 }, clientCityRef: 'x', clientWarehouseRef: 'y', clientPhone: '+380000000000', clientName: 'Хтось', templateId: 'tpl-x', scenario: 'incoming',
  })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { ttn: TTN, state: 'shipped' })
  const saved = s.np.saved()
  assert.equal(saved.Cost, '800')
  assert.equal(saved.Description, 'Запчастина для кораблика V2-LID-R')
  assert.equal(saved.CityRecipient, CITY)
  assert.equal(saved.RecipientAddress, WAREHOUSE)
  assert.equal(saved.RecipientsPhone, '380671234567')
  assert.equal(saved.Sender, 'snd')
  assert.equal(saved.PayerType, 'Recipient')
  assert.equal('BackwardDeliveryData' in saved, false)
  assert.equal('AfterpaymentOnGoodsCost' in saved, false)
  const counterparty = s.np.calls.find((c) => c.model === 'Counterparty')
  assert.equal(counterparty.apiKey, 'NP-KEY-2')
  assert.deepEqual([counterparty.props.LastName, counterparty.props.FirstName, counterparty.props.MiddleName], ['Шевченко', 'Тарас', 'Григорович'])
  const o = s.order()
  assert.equal(o.state, 'shipped')
  assert.equal(o.ttn, TTN)
  assert.equal(o.npDocRef, 'doc-1')
  assert.equal(o.npCostOnSite, 70)
  assert.equal(o.npEstimatedDelivery, '05.11.2026')
  assert.equal(o.npFopId, 'fop-2')
  assert.equal(o.ttnCreatingAt, null)
  assert.equal(o.ttnError, null)
  assert.ok(o.shippedAt)
  assert.deepEqual(historyTo(s), ['paid', 'shipped'])
  assert.equal(o.history.at(-1).by, ADMIN_EMAIL)
  assert.equal('note' in o.history.at(-1), false)
  assert.equal(orderPublicView(o).delivery.stage, 'created')
  await until(() => s.calls.client.length === 1, 'повідомлення')
  const msg = s.calls.client[0]
  assert.equal(msg.text, `RunFerry: накладна створена, ТТН ${TTN}`)
  assert.equal(msg.clientKey, `so-1-ttn-${TTN}`)
  assert.equal(msg.phone, PHONE)
  assert.equal(msg.journal.text, msg.text)
  await until(() => s.order().sms[`ttn-${TTN}`]?.status === 'sent', 'запис статусу')
})

test('накладная: выключенный способ, выключенный ФОП, off и снятая галочка не мешают отправить оплаченное', async (t) => {
  const docs = docsOf(paidOrder(), payment(), { 'fops/fop-2': fopMeta({ active: false, methods: { monoAcquire: false } }) })
  docs['system/shopSales'] = sales({ mode: 'off', methods: { card: false, cod: false }, skus: {} })
  docs['fopSecrets/fop-2'] = fopSecret({ monoAcquire: { token: 'SECRET-mono' } })
  const s = await stand(t, docs)
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 200, r.text)
  assert.equal(s.order().state, 'shipped')
})

test('накладная: чека нет, 409 NO_RECEIPT; force:true не считается, отправка только явным кодом и с записью в истории', async (t) => {
  for (const paySet of [{ receiptId: null, receiptStatus: 'error', taxUrl: null }, { receiptStatus: 'CREATED', taxUrl: null }]) {
    const s = await stand(t, docsOf(paidOrder(), payment(paySet)))
    const first = await s.post('/orders/so-1/ttn')
    assert.equal(first.status, 409)
    assert.equal(first.error.code, 'NO_RECEIPT')
    assert.equal((await s.post('/orders/so-1/ttn', { force: true })).error.code, 'NO_RECEIPT')
    assert.equal((await s.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN'] })).error.code, 'NO_RECEIPT')
    assert.equal(s.np.calls.length, 0)
    assert.equal(s.order().ttnCreatingAt, undefined, 'отказ не занимает заказ')
    const forced = await s.post('/orders/so-1/ttn', { force: ['NO_RECEIPT'] })
    assert.equal(forced.status, 200, forced.text)
    assert.equal(s.order().history.at(-1).note, 'force: NO_RECEIPT')
    assert.equal(s.order().history.at(-1).by, ADMIN_EMAIL)
  }
})

test('накладная: чек есть по ссылке или DONE', async (t) => {
  for (const paySet of [{ receiptStatus: 'DONE', taxUrl: null }, { receiptStatus: 'CREATED', taxUrl: TAX_URL }]) {
    const s = await stand(t, docsOf(paidOrder(), payment(paySet)))
    assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
  }
})

// ---------- накладная: что не пускает ----------

test('накладная: не из того состояния и без наложки второй волны', async (t) => {
  for (const state of ['awaiting_payment', 'phone_pending', 'shipped', 'delivered', 'refused', 'returned', 'payment_review', 'reversed', 'cancelled', 'expired']) {
    const s = await stand(t, docsOf(paidOrder({ state, ...(state === 'shipped' ? { ttn: null } : {}) })))
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.status, 409, state)
    assert.equal(r.error.code, 'BAD_STATE', state)
    assert.equal(s.np.calls.length, 0)
    assert.equal(s.bank.statusCalls.length, 0)
  }
  const exists = await stand(t, docsOf(paidOrder({ ttn: TTN })))
  const r = await exists.post('/orders/so-1/ttn')
  assert.equal(r.error.code, 'TTN_EXISTS')
  assert.equal(r.error.ttn, TTN)
  const cod = await stand(t, docsOf(paidOrder({ state: 'cod_confirmed', method: 'cod', paidPaymentId: null, cod: { amount: 800, kind: 'control' } }), null))
  assert.equal((await cod.post('/orders/so-1/ttn')).error.code, 'METHOD_OFF')
  assert.equal(cod.np.calls.length, 0)
  // Заказ картой наложку не получает, даже если поле откуда-то взялось.
  const stray = await stand(t, docsOf(paidOrder({ cod: { amount: 500, kind: 'money' } }), payment(), { 'npTemplates/tpl-1': template({ cod: true }) }))
  assert.equal((await stray.post('/orders/so-1/ttn')).status, 200)
  assert.equal('BackwardDeliveryData' in stray.np.saved(), false)
  assert.equal('AfterpaymentOnGoodsCost' in stray.np.saved(), false)
})

test('накладная: шаблон не подходит, ни банка, ни НП', async (t) => {
  const cases = [
    [{}, 'missing', { 'npTemplates/tpl-1': undefined }],
    [{ active: false }, 'inactive'],
    [{ scenario: 'return' }, 'scenario'],
    [{ fopId: 'fop-1' }, 'fop'],
    [{ description: '   ' }, 'description'],
    [{ recipientTarget: 'service' }, 'recipient'],
    [{ recipientTarget: 'fixed' }, 'recipient'],
    [{ senderTarget: 'client' }, 'sender'],
    [{ serviceType: 'WarehouseDoors' }, 'service-type'],
  ]
  for (const [over, problem, extra] of cases) {
    const s = await stand(t, docsOf(paidOrder(), payment(), { 'npTemplates/tpl-1': template(over), ...extra }))
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.status, 409, problem)
    assert.equal(r.error.code, 'BAD_TEMPLATE', problem)
    assert.deepEqual(r.error.problems, [problem])
    assert.equal(s.np.calls.length, 0)
    assert.equal(s.bank.statusCalls.length, 0)
    assert.equal(s.order().state, 'paid')
    assert.equal(s.order().ttnCreatingAt, undefined)
  }
  const none = await stand(t, docsOf())
  none.patch('system/shopSales', { npTemplateId: '' })
  assert.deepEqual((await none.post('/orders/so-1/ttn')).error.problems, ['missing'])
})

test('накладная: нет адреса получателя, отказ вместо фиксированного получателя шаблона', async (t) => {
  for (const missing of ['clientCityRef', 'clientWarehouseRef', 'clientPhone', 'clientName']) {
    const s = await stand(t, docsOf(paidOrder({ [missing]: null })))
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.error.code, 'NO_CLIENT_ADDRESS', missing)
    assert.equal(s.np.calls.length, 0)
  }
})

test('накладная: у ФОП нет ключа или рефов НП, отказ с перечнем', async (t) => {
  const s = await stand(t, docsOf(paidOrder(), payment(), { 'fops/fop-2': fopMeta({ novaPoshta: { senderRef: 'snd' } }) }))
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.error.code, 'NP_NOT_CONFIGURED')
  assert.deepEqual(r.error.missing, ['novaPoshta.contactRef', 'novaPoshta.senderPhone', 'novaPoshta.cityRef', 'novaPoshta.warehouseRef'])
  assert.equal(s.bank.statusCalls.length, 0)
  noSecrets(r.text)
})

test('накладная: банк вернул деньги, блок, заказ reversed и алерт; накладной нет', async (t) => {
  const s = await stand(t)
  s.bank.statuses['inv-1'] = { status: 'reversed', amount: 80000, finalAmount: 0 }
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 409)
  assert.equal(r.error.code, 'PAYMENT_NOT_CONFIRMED')
  assert.equal(s.np.calls.length, 0)
  await until(() => s.order().state === 'reversed', 'повернення')
  await until(() => s.calls.alerts.some((a) => a.includes('накладну не створено')), 'алерт')
  assert.equal(s.pay().status, 'reversed')
  assert.ok(s.order().alerts['ttn-payment-blocked'].text.includes('RF-AAAAAA'))
  assert.ok(!JSON.stringify(s.order().alerts['ttn-payment-blocked']).includes('Шевченко'))
})

test('накладная: сумма не сошлась, частичный возврат, чужая валюта, банк без суммы: блок без накладной', async (t) => {
  const cases = [
    [{ ...BANK_PAID, amount: 800 }, 'сума 800 коп'],
    [{ ...BANK_PAID, ccy: 840 }, 'валюта 840'],
    [{ ...BANK_PAID, reference: 'pay-x' }, 'reference pay-x'],
    [{ ...BANK_PAID, finalAmount: 50000 }, 'лишилось 500 грн із 800 грн'],
    [{ ...BANK_PAID, finalAmount: 79999 }, 'лишилось 799.99 грн'],
    [{ status: 'success', ccy: 980 }, 'банк не показав суму'],
    [{ status: 'processing', amount: 80000 }, 'статус processing'],
  ]
  for (const [bank, reason] of cases) {
    const s = await stand(t)
    s.bank.statuses['inv-1'] = bank
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.status, 409, reason)
    assert.equal(r.error.code, 'PAYMENT_NOT_CONFIRMED', reason)
    assert.ok(r.error.reason.includes(reason), `${reason}: ${r.error.reason}`)
    assert.equal(s.np.calls.length, 0, reason)
    assert.equal(s.order().state, 'paid')
    await until(() => s.order().alerts['ttn-payment-blocked'], 'алерт')
  }
})

test('накладная: успех с нулём на счёте: это полный возврат, заказ reversed', async (t) => {
  const s = await stand(t)
  s.bank.statuses['inv-1'] = { status: 'success', amount: 80000, ccy: 980, finalAmount: 0 }
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
  await until(() => s.order().state === 'reversed', 'повернення')
})

test('накладная: finalAmount равен сумме или банк его не прислал, накладная идёт; валюта необязательна', async (t) => {
  for (const bank of [BANK_PAID, { status: 'success', amount: 80000, ccy: 980 }, { status: 'success', amount: 80000, finalAmount: 90000 }, { status: 'success', amount: 80000 }, { status: 'success', amount: 80000, finalAmount: '' }]) {
    const s = await stand(t)
    s.bank.statuses['inv-1'] = bank
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.status, 200, `${JSON.stringify(bank)}: ${r.text}`)
  }
})

test('накладная: подтверждённая владельцем сумма заменяет сверку, но возврат ниже неё всё равно блокирует', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ amountConfirmed: { by: 'x', at: ago(MIN), amount: 750 } })))
  s.bank.statuses['inv-1'] = { status: 'success', amount: 75000, finalAmount: 75000 }
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
  const low = await stand(t, docsOf(paidOrder({ amountConfirmed: { by: 'x', at: ago(MIN), amount: 750 } })))
  low.bank.statuses['inv-1'] = { status: 'success', amount: 75000, finalAmount: 70000 }
  assert.equal((await low.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
  const reversed = await stand(t, docsOf(paidOrder({ amountConfirmed: { by: 'x', at: ago(MIN), amount: 800 } })))
  reversed.bank.statuses['inv-1'] = { status: 'reversed' }
  assert.equal((await reversed.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
})

test('накладная: документа оплаты нет или он возвращён: блок без обращения к банку', async (t) => {
  const none = await stand(t, docsOf(paidOrder(), null))
  assert.equal((await none.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
  const back = await stand(t, docsOf(paidOrder(), payment({ status: 'reversed' })))
  assert.equal((await back.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
  assert.equal(back.bank.statusCalls.length, 0)
})

test('накладная: банк не ответил, 502, ничего не занято, можно повторить', async (t) => {
  const s = await stand(t)
  s.bank.fail['inv-1'] = httpErr(503)
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 502)
  assert.equal(r.error.code, 'BANK_UNAVAILABLE')
  assert.equal(s.np.calls.length, 0)
  assert.equal(s.order().ttnCreatingAt, undefined)
  delete s.bank.fail['inv-1']
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
})

// ---------- накладная: исход НП ----------

test('накладная: явный отказ НП снимает захват и показывает текст НП, повтор работает', async (t) => {
  const np = fakeNp({ InternetDocument: () => ({ success: false, errors: ['Вага перевищує норму'] }) })
  const s = await stand(t, docsOf(), { np })
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 502)
  assert.equal(r.error.code, 'NP_ERROR')
  assert.equal(r.error.message, 'Вага перевищує норму')
  const o = s.order()
  assert.equal(o.state, 'paid')
  assert.equal(o.ttnCreatingAt, null)
  assert.equal(o.ttnError, null)
  assert.equal((await s.post('/orders/so-1/ttn')).status, 502, 'захват не заважає новій спробі')
  assert.equal(np.saves().length, 2)
})

test('накладная: таймаут НП на самом документе не снимает захват и второй накладной не даёт', async (t) => {
  const np = fakeNp({ InternetDocument: () => { throw timeoutErr() } })
  const s = await stand(t, docsOf(), { np })
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 409)
  assert.equal(r.error.code, 'TTN_UNKNOWN')
  assert.deepEqual(r.error.actions, ['attach', 'force'])
  assert.ok(r.error.message.includes('кабінет НП'))
  const o = s.order()
  assert.equal(o.ttnError, 'unknown')
  assert.ok(o.ttnCreatingAt, 'захват на місці')
  assert.equal(o.state, 'paid')
  for (let i = 0; i < 3; i++) {
    const again = await s.post('/orders/so-1/ttn')
    assert.equal(again.status, 409)
    assert.equal(again.error.code, 'TTN_UNKNOWN')
  }
  // И спустя время: старый захват сам не отпускает.
  s.patch('shopOrders/so-1', { ttnCreatingAt: ago(HOUR) })
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
  // force:true и чужой код не считаются.
  assert.equal((await s.post('/orders/so-1/ttn', { force: true })).error.code, 'TTN_UNKNOWN')
  assert.equal((await s.post('/orders/so-1/ttn', { force: ['NO_RECEIPT'] })).error.code, 'TTN_UNKNOWN')
  assert.equal(np.saves().length, 1, 'другої накладної немає')
  assert.equal(s.calls.client.length, 0, 'покупцю нічого не пішло')
})

test('накладная: сеть, 5xx, странные ответы и успех без номера: исход неизвестен, захват на месте', async (t) => {
  const answers = [
    () => { throw httpErr(500) },
    () => { throw new Error('socket hang up') },
    () => null,
    () => ({ success: true, data: [] }),
    () => ({ success: true, data: [{ Ref: 'doc-1' }] }),
    () => ({ success: true, data: [{ IntDocNumber: '', Number: '', Ref: 'doc-1' }] }),
  ]
  for (const InternetDocument of answers) {
    const np = fakeNp({ InternetDocument })
    const s = await stand(t, docsOf(), { np })
    const r = await s.post('/orders/so-1/ttn')
    assert.equal(r.error.code, 'TTN_UNKNOWN', String(InternetDocument))
    assert.equal(s.order().ttnError, 'unknown')
    assert.ok(s.order().ttnCreatingAt)
    assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
    assert.equal(np.saves().length, 1)
  }
})

test('накладная: отказ и таймаут на шаге получателя: до документа не дошли, захват снят, но текст сбоя показан', async (t) => {
  const refused = fakeNp({ Counterparty: () => ({ success: false, errors: ['Невірне прізвище'] }) })
  const a = await stand(t, docsOf(), { np: refused })
  const r1 = await a.post('/orders/so-1/ttn')
  assert.equal(r1.status, 502)
  assert.equal(r1.error.code, 'NP_ERROR')
  assert.equal(r1.error.message, 'Невірне прізвище')
  assert.equal(a.order().ttnCreatingAt, null)
  assert.equal(a.order().ttnError, null)
  assert.equal(refused.saves().length, 0)

  const silent = fakeNp({ Counterparty: () => { throw timeoutErr() } })
  const b = await stand(t, docsOf(), { np: silent })
  const r2 = await b.post('/orders/so-1/ttn')
  assert.equal(r2.error.code, 'NP_ERROR')
  assert.ok(r2.error.message.includes('не відповіла'), r2.error.message)
  assert.ok(!r2.error.message.includes('timeout'))
  assert.equal(b.order().ttnCreatingAt, null)
  assert.equal(silent.saves().length, 0)
})

test('накладная: после неизвестного исхода force создаёт новую и пишет это в историю', async (t) => {
  let first = true
  const np = fakeNp({
    InternetDocument: () => {
      if (first) { first = false; throw timeoutErr() }
      return { success: true, data: [{ IntDocNumber: '20450000000002', Ref: 'doc-2' }] }
    },
  })
  const s = await stand(t, docsOf(), { np })
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
  const r = await s.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN'] })
  assert.equal(r.status, 200, r.text)
  const o = s.order()
  assert.equal(o.ttn, '20450000000002')
  assert.equal(o.ttnError, null)
  assert.equal(o.ttnCreatingAt, null)
  assert.equal(o.history.at(-1).note, 'force: TTN_UNKNOWN')
  assert.equal(np.saves().length, 2)
})

test('накладная: force при неизвестном исходе, но новый отказ НП: отметка снята, владелец уже проверил кабинет', async (t) => {
  const np = fakeNp({ InternetDocument: () => ({ success: false, errors: ['Ні'] }) })
  const s = await stand(t, docsOf(paidOrder({ ttnError: 'unknown', ttnCreatingAt: ago(MIN) })), { np })
  assert.equal((await s.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN'] })).error.code, 'NP_ERROR')
  assert.equal(s.order().ttnError, null)
  assert.equal(s.order().ttnCreatingAt, null)
})

test('накладная: проверки до захвата не стирают отметку неизвестного исхода', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ ttnError: 'unknown', ttnCreatingAt: ago(MIN) }), payment({ receiptStatus: 'CREATED', taxUrl: null })))
  assert.equal((await s.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN'] })).error.code, 'NO_RECEIPT')
  assert.equal(s.order().ttnError, 'unknown', 'захист лишився')
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
  const r = await s.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN', 'NO_RECEIPT'] })
  assert.equal(r.status, 200)
  assert.equal(s.order().history.at(-1).note, 'force: TTN_UNKNOWN, NO_RECEIPT')
})

test('накладная: захват: свежий даёт TTN_IN_PROGRESS, зависший старше 3 минут TTN_UNKNOWN', async (t) => {
  const fresh = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(MIN) })))
  const r = await fresh.post('/orders/so-1/ttn')
  assert.equal(r.error.code, 'TTN_IN_PROGRESS')
  assert.equal((await fresh.post('/orders/so-1/ttn', { force: ['TTN_UNKNOWN'] })).error.code, 'TTN_IN_PROGRESS')
  assert.equal(fresh.np.calls.length, 0)
  const stale = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(3 * MIN + SEC) })))
  assert.equal((await stale.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
  assert.equal(stale.np.calls.length, 0)
})

test('накладная: два запроса разом: документ один', async (t) => {
  const gate = held()
  const np = fakeNp({ InternetDocument: async () => { await gate.gate; return { success: true, data: [{ IntDocNumber: TTN, Ref: 'doc-1' }] } } })
  const s = await stand(t, docsOf(), { np })
  const both = Promise.all([s.post('/orders/so-1/ttn'), s.post('/orders/so-1/ttn')])
  await until(() => np.saves().length >= 1, 'документ')
  await sleep(20)
  gate.release()
  const results = await both
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(results.find((r) => r.status === 409).error.code, 'TTN_IN_PROGRESS')
  assert.equal(np.saves().length, 1)
})

test('накладная: пока создаётся, заказ могли закрыть: номер сохранён, состояние не тронуто, алерт, покупателю ничего', async (t) => {
  const s = await stand(t, docsOf(), {
    np: fakeNp({
      InternetDocument: async () => {
        s.patch('shopOrders/so-1', { state: 'reversed' })
        return { success: true, data: [{ IntDocNumber: TTN, Ref: 'doc-1' }] }
      },
    }),
  })
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 409)
  assert.equal(r.error.code, 'ORDER_CLOSED')
  assert.equal(r.error.ttn, TTN)
  const o = s.order()
  assert.equal(o.state, 'reversed')
  assert.equal(o.ttn, TTN)
  assert.equal(o.ttnOnClosed, true)
  assert.equal(o.ttnCreatingAt, null)
  await until(() => s.calls.alerts.some((a) => a.includes('вже закрите')), 'алерт')
  assert.ok(s.order().alerts[`ttn-on-closed-${TTN}`].text.includes(TTN))
  await sleep(10)
  assert.equal(s.calls.client.length, 0)
  assert.deepEqual((await s.get('/orders?view=action')).data.items.map((i) => i.id), ['so-1'])
  assert.deepEqual(orderPublicView(s.order()).delivery, { ttn: null, trackUrl: null, stage: 'none' }, 'покупцю номер не обіцяємо')
})

test('накладная: номер не записался: ответ его называет, захват остаётся', async (t) => {
  const s = await stand(t)
  s.db.failWrite = (path, v) => path === 'shopOrders/so-1' && v.ttn
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.status, 500)
  assert.equal(r.error.code, 'TTN_NOT_SAVED')
  assert.equal(r.error.ttn, TTN)
  assert.ok(r.error.message.includes(TTN))
  s.db.failWrite = null
  assert.ok(s.order().ttnCreatingAt)
  assert.equal(s.order().ttnError, 'unknown', 'привʼязати можна одразу')
  assert.equal(s.order().state, 'paid')
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'TTN_UNKNOWN')
  assert.equal(s.np.saves().length, 1)
  const a = await s.post('/orders/so-1/ttn/attach', { number: TTN })
  assert.equal(a.status, 200, a.text)
  assert.equal(s.order().state, 'shipped')
})

test('накладная: база лежит и после номера: ответ всё равно называет номер', async (t) => {
  const s = await stand(t)
  s.db.failWrite = (path, v) => path === 'shopOrders/so-1' && (v.ttn || v.ttnError)
  const r = await s.post('/orders/so-1/ttn')
  assert.equal(r.error.code, 'TTN_NOT_SAVED')
  assert.equal(r.error.ttn, TTN)
})

test('накладная: получателя исправили, пока банк отвечал: посылка уходит на новый адрес', async (t) => {
  const NEW_CITY = '33333333-3333-4333-8333-333333333333'
  const NEW_WH = '44444444-4444-4444-8444-444444444444'
  const s = await stand(t)
  const real = s.bank.mono.invoiceStatus
  s.bank.mono.invoiceStatus = async (...args) => {
    s.patch('shopOrders/so-1', { clientCityRef: NEW_CITY, clientWarehouseRef: NEW_WH, clientPhone: NEW_PHONE, clientName: 'Коваль Іван' })
    return real(...args)
  }
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
  const saved = s.np.saved()
  assert.equal(saved.CityRecipient, NEW_CITY)
  assert.equal(saved.RecipientAddress, NEW_WH)
  assert.equal(saved.RecipientsPhone, '380501112233')
  assert.equal(s.np.calls.find((c) => c.model === 'Counterparty').props.LastName, 'Коваль')
})

test('накладная: описание обрезается до 500 знаков, артикул не теряется', async (t) => {
  const s = await stand(t, docsOf(paidOrder(), payment(), { 'npTemplates/tpl-1': template({ description: 'я'.repeat(600) }) }))
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
  const d = s.np.saved().Description
  assert.ok(d.length <= 500, String(d.length))
  assert.ok(d.endsWith(' V2-LID-R'))
})

// ---------- привязка ----------

test('attach: номер приводится к цифрам, заказ shipped, захват снят, сообщение покупателю, банк и чек не спрашиваем', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ ttnError: 'unknown', ttnCreatingAt: ago(MIN) }), payment({ receiptStatus: 'CREATED', taxUrl: null })))
  const r = await s.post('/orders/so-1/ttn/attach', { number: ' 2045 0000 0000 01 ' })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { ttn: TTN, state: 'shipped' })
  const o = s.order()
  assert.equal(o.ttn, TTN)
  assert.equal(o.state, 'shipped')
  assert.equal(o.ttnCreatingAt, null)
  assert.equal(o.ttnError, null)
  assert.equal(o.npFopId, 'fop-2')
  assert.equal(o.history.at(-1).note, 'attach')
  assert.equal(s.bank.statusCalls.length, 0)
  assert.equal(s.np.saves().length, 0)
  assert.equal(s.np.calls[0].props.Documents[0].DocumentNumber, TTN)
  await until(() => s.calls.client.length === 1, 'повідомлення')
  assert.equal(s.calls.client[0].clientKey, `so-1-ttn-${TTN}`)
})

test('attach: кривой номер, неверное состояние, уже есть накладная, запрос идёт прямо сейчас', async (t) => {
  const s = await stand(t)
  for (const number of [undefined, '', '12345', 'abc', '1'.repeat(21)]) {
    const r = await s.post('/orders/so-1/ttn/attach', { number })
    assert.equal(r.status, 400, String(number))
    assert.deepEqual(r.error.fields, ['number'])
  }
  const state = await stand(t, docsOf(paidOrder({ state: 'reversed' })))
  assert.equal((await state.post('/orders/so-1/ttn/attach', { number: TTN })).error.code, 'BAD_STATE')
  const exists = await stand(t, docsOf(paidOrder({ ttn: '20450000000009' })))
  assert.equal((await exists.post('/orders/so-1/ttn/attach', { number: TTN })).error.code, 'TTN_EXISTS')
  assert.equal(exists.order().ttn, '20450000000009')
  const busy = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(MIN) })))
  assert.equal((await busy.post('/orders/so-1/ttn/attach', { number: TTN })).error.code, 'TTN_IN_PROGRESS')
  const stale = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(HOUR) })))
  assert.equal((await stale.post('/orders/so-1/ttn/attach', { number: TTN })).status, 200)
})

test('attach: пока шла проверка номера, заказ закрыли или привязали другую: отказ, номер не затёрт', async (t) => {
  let s
  s = await stand(t, docsOf(), {
    np: fakeNp({ TrackingDocument: () => { s.patch('shopOrders/so-1', { ttn: '20450000000009', state: 'shipped' }); return { success: true, data: [] } } }),
  })
  assert.equal((await s.post('/orders/so-1/ttn/attach', { number: TTN })).error.code, 'TTN_EXISTS')
  assert.equal(s.order().ttn, '20450000000009')
  assert.equal(s.order().ttnOnClosed, undefined)
})

test('attach: НП не знает номер: отказ с подтверждением; НП не отвечает или другой код: принимаем', async (t) => {
  for (const code of ['2', '3']) {
    const s = await stand(t, docsOf(), { np: fakeNp({ TrackingDocument: (p) => ({ success: true, data: [{ Number: p.Documents[0].DocumentNumber, StatusCode: code }] }) }) })
    const r = await s.post('/orders/so-1/ttn/attach', { number: TTN })
    assert.equal(r.status, 422, code)
    assert.equal(r.error.code, 'TTN_NOT_FOUND')
    assert.equal(s.order().ttn, undefined)
    assert.equal((await s.post('/orders/so-1/ttn/attach', { number: TTN, force: true })).error.code, 'TTN_NOT_FOUND')
    const ok = await s.post('/orders/so-1/ttn/attach', { number: TTN, force: ['TTN_NOT_FOUND'] })
    assert.equal(ok.status, 200)
  }
  for (const TrackingDocument of [() => { throw timeoutErr() }, () => ({ success: false, errors: ['x'] }), () => ({ success: true, data: [] }), () => ({ success: true, data: [{ Number: 'інший', StatusCode: '3' }] })]) {
    const s = await stand(t, docsOf(), { np: fakeNp({ TrackingDocument }) })
    assert.equal((await s.post('/orders/so-1/ttn/attach', { number: TTN })).status, 200, String(TrackingDocument))
  }
  const slow = await stand(t, docsOf(), { addressBudgetMs: 5, np: fakeNp({ TrackingDocument: () => new Promise(() => {}) }) })
  assert.equal((await slow.post('/orders/so-1/ttn/attach', { number: TTN })).status, 200, 'зависла НП не тримає кнопку')
})

// ---------- статус накладной ----------

test('ttn/refresh: код 2 возвращает заказ в paid, номер уходит в историю, новая накладная снова возможна', async (t) => {
  const np = fakeNp({ TrackingDocument: (p) => ({ success: true, data: [{ Number: p.Documents[0].DocumentNumber, StatusCode: '2', Status: 'Видалено' }] }) })
  const s = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: TTN, shippedAt: ago(HOUR), npFopId: 'fop-2' })), { np })
  const r = await s.post('/orders/so-1/ttn/refresh')
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { outcome: 'back', state: 'paid', ttn: null })
  const o = s.order()
  assert.equal(o.ttn, null)
  assert.equal(o.ttnHistory[0].ttn, TTN)
  assert.equal(o.ttnHistory[0].reason, 'np-2')
  const again = await s.post('/orders/so-1/ttn')
  assert.equal(again.status, 200, again.text)
})

test('ttn/refresh: получено, не забрали, движется; не отправлен 409; НП не ответила 502', async (t) => {
  for (const [code, outcome, state] of [['9', 'delivered', 'delivered'], ['102', 'refused', 'refused'], ['5', 'moving', 'shipped'], ['1', 'not-handed', 'shipped']]) {
    const s = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: TTN, shippedAt: ago(HOUR) })), {
      np: fakeNp({ TrackingDocument: (p) => ({ success: true, data: [{ Number: p.Documents[0].DocumentNumber, StatusCode: code, Status: 'x' }] }) }),
    })
    const r = await s.post('/orders/so-1/ttn/refresh')
    assert.deepEqual(r.data, { outcome, state, ttn: TTN }, code)
    assert.equal(s.np.calls[0].apiKey, 'NP-KEY-2')
  }
  const notShipped = await stand(t)
  assert.equal((await notShipped.post('/orders/so-1/ttn/refresh')).error.code, 'NOT_SHIPPED')
  assert.equal(notShipped.np.calls.length, 0)
  const delivered = await stand(t, docsOf(paidOrder({ state: 'delivered', ttn: TTN })))
  assert.equal((await delivered.post('/orders/so-1/ttn/refresh')).error.code, 'NOT_SHIPPED')
  const noNumber = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: null })))
  assert.equal((await noNumber.post('/orders/so-1/ttn/refresh')).error.code, 'NOT_SHIPPED')
  for (const TrackingDocument of [() => { throw timeoutErr() }, () => ({ success: false }), () => ({ success: true, data: [] })]) {
    const s = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: TTN, shippedAt: ago(HOUR) })), { np: fakeNp({ TrackingDocument }) })
    const r = await s.post('/orders/so-1/ttn/refresh')
    assert.equal(r.status, 502)
    assert.equal(r.error.code, 'NP_UNAVAILABLE')
    assert.equal(s.order().state, 'shipped')
  }
})

test('ttn/refresh: накладная на закрытом заказе: плашка гаснет только по коду 2, заказ остаётся закрытым', async (t) => {
  const closed = () => docsOf(paidOrder({ state: 'cancelled', ttn: TTN, ttnOnClosed: true, npFopId: 'fop-2', npDocRef: 'doc-1' }))
  const answering = (code) => fakeNp({ TrackingDocument: (p) => ({ success: true, data: [{ Number: p.Documents[0].DocumentNumber, StatusCode: code }] }) })

  const s = await stand(t, closed(), { np: answering('2') })
  const r = await s.post('/orders/so-1/ttn/refresh')
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { outcome: 'back', state: 'cancelled', ttn: null })
  const o = s.order()
  assert.equal(o.state, 'cancelled')
  assert.equal(o.ttn, null)
  assert.equal(o.ttnOnClosed, false)
  assert.equal(o.npDocRef, null)
  assert.equal(o.ttnHistory[0].ttn, TTN)
  assert.equal(o.ttnHistory[0].reason, 'np-2')
  assert.deepEqual(orderFlags(o), [])
  assert.deepEqual((await s.get('/orders?view=action')).data.items, [])
  assert.equal((await s.post('/orders/so-1/ttn/refresh')).error.code, 'NOT_SHIPPED', 'другий раз нема чого перевіряти')

  for (const code of ['1', '3', '5', '9', '102']) {
    const live = await stand(t, closed(), { np: answering(code) })
    const res = await live.post('/orders/so-1/ttn/refresh')
    assert.deepEqual(res.data, { outcome: 'none', state: 'cancelled', ttn: TTN }, code)
    assert.equal(live.order().ttnOnClosed, true, code)
    assert.equal(live.order().ttn, TTN, code)
    assert.deepEqual(orderFlags(live.order()), ['ttn-on-closed'], code)
  }

  for (const TrackingDocument of [() => { throw timeoutErr() }, () => ({ success: false }), () => null]) {
    const down = await stand(t, closed(), { np: fakeNp({ TrackingDocument }) })
    assert.equal((await down.post('/orders/so-1/ttn/refresh')).error.code, 'NP_UNAVAILABLE')
    assert.equal(down.order().ttnOnClosed, true)
  }
  const noKey = await stand(t, docsOf(paidOrder({ state: 'cancelled', ttn: TTN, ttnOnClosed: true }), payment(), { 'fopSecrets/fop-2': fopSecret({ novaPoshta: {} }) }))
  assert.equal((await noKey.post('/orders/so-1/ttn/refresh')).error.code, 'NP_UNAVAILABLE')
  assert.equal(noKey.np.calls.length, 0)

  // Пока шёл запрос, номер сменился: чужой номер не трогаем.
  let raced
  raced = await stand(t, closed(), {
    np: fakeNp({ TrackingDocument: (p) => { raced.patch('shopOrders/so-1', { ttn: '20450000000009' }); return { success: true, data: [{ Number: p.Documents[0].DocumentNumber, StatusCode: '2' }] } } }),
  })
  await raced.post('/orders/so-1/ttn/refresh')
  assert.equal(raced.order().ttn, '20450000000009')
  assert.equal(raced.order().ttnOnClosed, true)
})

// ---------- отмена ----------

test('cancel: неоплаченный закрывается владельцем, счёт снят, место пары освобождено, счётчик дня не тронут', async (t) => {
  const today = KYIV_DAY.format(new Date())
  const s = await stand(t, docsOf(awaitingOrder({ phoneKey: 'pk-1' }), payment({ status: 'pending', receiptId: null, taxUrl: null, receiptStatus: null }), {
    'shopPhones/pk-1': { openCard: { 'V2-LID-R': 'so-1', 'V2-LID-H': 'so-2' }, codBlocked: true }, [`shopDaily/${today}`]: { unpaid: 3 },
  }))
  const r = await s.post('/orders/so-1/cancel')
  assert.equal(r.status, 200, r.text)
  const o = s.order()
  assert.equal(o.state, 'cancelled')
  assert.equal(o.orderNo, 'RF-AAAAAA')
  assert.equal(s.db.docs['shopPhones/pk-1'].openCard['V2-LID-H'], 'so-2')
  assert.equal(s.db.docs['shopPhones/pk-1'].codBlocked, true)
  assert.equal(o.cancelReason, 'owner')
  assert.equal(o.payment.pageUrl, null)
  assert.equal(o.history.at(-1).by, ADMIN_EMAIL)
  assert.equal(s.db.docs['shopPhones/pk-1'].openCard['V2-LID-R'], null)
  assert.equal(s.db.docs[`shopDaily/${today}`].unpaid, 3)
  await until(() => s.bank.removed.includes('inv-1'), 'зняття')
  await until(() => s.pay().status === 'removed', 'статус')
})

test('cancel: оплаченное отменить нельзя, деньги через банк; неизвестная накладная не даёт отмены', async (t) => {
  for (const state of ['paid', 'shipped', 'delivered', 'reversed', 'payment_review', 'refused']) {
    const s = await stand(t, docsOf(paidOrder({ state })))
    const r = await s.post('/orders/so-1/cancel')
    assert.equal(r.status, 409, state)
    assert.equal(r.error.code, 'NOT_CANCELLABLE', state)
    assert.equal(s.order().state, state)
  }
  const unknown = await stand(t, docsOf(paidOrder({ state: 'cod_confirmed', method: 'cod', ttnError: 'unknown', ttnCreatingAt: ago(HOUR) })))
  assert.equal((await unknown.post('/orders/so-1/cancel')).error.code, 'TTN_UNKNOWN')
  const busy = await stand(t, docsOf(paidOrder({ state: 'cod_confirmed', method: 'cod', ttnCreatingAt: ago(MIN) })))
  assert.equal((await busy.post('/orders/so-1/cancel')).error.code, 'TTN_UNKNOWN')
  const stale = await stand(t, docsOf(paidOrder({ state: 'cod_confirmed', method: 'cod', ttnCreatingAt: ago(HOUR) })))
  assert.equal((await stale.post('/orders/so-1/cancel')).error.code, 'TTN_UNKNOWN', 'завислий захват: накладна могла зʼявитись')
  assert.equal(stale.order().state, 'cod_confirmed')
  const free = await stand(t, docsOf(paidOrder({ state: 'cod_confirmed', method: 'cod', ttnCreatingAt: null, ttnError: null })))
  assert.equal((await free.post('/orders/so-1/cancel')).status, 200)
})

test('cancel: банк отказал снять счёт: заказ всё равно закрыт, ошибка только в журнале', async (t) => {
  const s = await stand(t, docsOf(awaitingOrder(), payment({ status: 'pending', receiptId: null, taxUrl: null, receiptStatus: null })))
  s.bank.removeFail['inv-1'] = httpErr(400)
  assert.equal((await s.post('/orders/so-1/cancel')).status, 200)
  assert.equal(s.order().state, 'cancelled')
  await until(() => logs.some((l) => l.includes('рахунок pay-1 не знято')), 'журнал')
  assert.equal(s.pay().status, 'pending')
})

// ---------- получатель ----------

test('recipient: новый телефон: хэш, все сообщения заново и с новым ключом, отпечаток прежний, алерт снят', async (t) => {
  const s = await stand(t, docsOf(paidOrder({
    phoneKey: phoneKeyOf(PHONE),
    sms: { paid: { status: 'sent', at: ago(HOUR), tries: 1 }, rcpt: { status: 'failed', at: ago(HOUR), tries: 4 } },
    alerts: { 'new-paid': { at: ago(HOUR), sentAt: ago(HOUR), text: 'x' }, 'sms-rcpt': { at: ago(HOUR), sentAt: ago(HOUR), text: 'y' } },
  })))
  const r = await s.post('/orders/so-1/recipient', { phone: '0501112233' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.clientPhone, NEW_PHONE)
  const o = s.order()
  assert.equal(o.clientPhone, NEW_PHONE)
  assert.equal(o.phoneKey, phoneKeyOf(NEW_PHONE))
  assert.equal(o.fingerprint, 'fp-secret')
  assert.equal(o.alerts['sms-rcpt'], null)
  assert.ok(o.alerts['new-paid'])
  assert.deepEqual(o.sms.paid, { status: null, at: null, tries: 0, resends: 1 })
  assert.equal(o.sms.rcpt.resends, 1)
  assert.deepEqual(o.recipientEdits[0].fields, ['phone'])
  assert.equal(o.recipientEdits[0].by, ADMIN_EMAIL)
  assert.equal(JSON.stringify(o.recipientEdits).includes(NEW_PHONE), false)
  assert.equal(messageDue(o, 'paid'), true)
  // Сверка сама доведёт сообщения: новый ключ журнала, новый номер.
  await s.step()
  await until(() => s.calls.client.length === 2, 'повідомлення')
  assert.deepEqual(s.calls.client.map((c) => c.clientKey).sort(), ['so-1-paid-r1', 'so-1-rcpt-r1'])
  assert.ok(s.calls.client.every((c) => c.phone === NEW_PHONE))
  assert.equal(r.text.includes(STATUS_TOKEN), true, 'лише в посиланні')
  assert.equal('statusToken' in r.data, false)
})

test('recipient: тот же телефон ничего не сбрасывает', async (t) => {
  const s = await stand(t)
  await s.post('/orders/so-1/recipient', { phone: '+380 67 123 45 67' })
  assert.equal(s.order().sms.paid.status, 'sent')
  assert.equal(s.order().phoneKey, 'pk-1')
})

test('recipient: неоплаченный заказ переносит место пары на новый телефон; занятое место не трогает', async (t) => {
  const oldKey = phoneKeyOf(PHONE)
  const newKey = phoneKeyOf(NEW_PHONE)
  const s = await stand(t, docsOf(awaitingOrder({ phoneKey: oldKey }), null, { [`shopPhones/${oldKey}`]: { openCard: { 'V2-LID-R': 'so-1' }, codBlocked: true }, [`shopPhones/${newKey}`]: { refusals: 1 } }))
  await s.post('/orders/so-1/recipient', { phone: NEW_PHONE })
  assert.equal(s.db.docs[`shopPhones/${oldKey}`].openCard['V2-LID-R'], null)
  assert.equal(s.db.docs[`shopPhones/${oldKey}`].codBlocked, true)
  assert.equal(s.db.docs[`shopPhones/${newKey}`].openCard['V2-LID-R'], 'so-1')
  assert.equal(s.db.docs[`shopPhones/${newKey}`].refusals, 1)

  const busy = await stand(t, docsOf(awaitingOrder({ phoneKey: oldKey }), null, { [`shopPhones/${oldKey}`]: { openCard: { 'V2-LID-R': 'so-1' } }, [`shopPhones/${newKey}`]: { openCard: { 'V2-LID-R': 'so-other' } } }))
  await busy.post('/orders/so-1/recipient', { phone: NEW_PHONE })
  assert.equal(busy.db.docs[`shopPhones/${newKey}`].openCard['V2-LID-R'], 'so-other')
  assert.equal(busy.db.docs[`shopPhones/${oldKey}`].openCard['V2-LID-R'], null)

  const paid = await stand(t, docsOf(paidOrder({ phoneKey: oldKey })))
  await paid.post('/orders/so-1/recipient', { phone: NEW_PHONE })
  assert.equal(paid.db.docs[`shopPhones/${newKey}`], undefined, 'у оплаченого місця немає')

  const noKey = await stand(t, docsOf(awaitingOrder({ phoneKey: null }), null))
  assert.equal((await noKey.post('/orders/so-1/recipient', { phone: NEW_PHONE })).status, 200)
  assert.equal(noKey.db.docs[`shopPhones/${newKey}`].openCard['V2-LID-R'], 'so-1')
})

test('recipient: имя и адрес проверяются как в новом заказе, адрес целиком, поштомат и чужое отделение отвергаются', async (t) => {
  const NEW_CITY = '33333333-3333-4333-8333-333333333333'
  const NEW_WH = '44444444-4444-4444-8444-444444444444'
  const whs = { success: true, data: [{ Ref: NEW_WH, Description: 'Відділення №1' }] }
  const s = await stand(t, docsOf(), { npRequest: async () => whs })
  for (const body of [{}, { lastName: '--' }, { firstName: 'Ivan' }, { phone: '123' }, { email: 'a,b@c.d' }, { cityRef: NEW_CITY }, { cityRef: 'x', cityName: 'Київ', warehouseRef: NEW_WH, warehouseName: '№1' }]) {
    const r = await s.post('/orders/so-1/recipient', body)
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.error.code, 'BAD_INPUT')
  }
  const r = await s.post('/orders/so-1/recipient', { lastName: 'Коваль', middleName: '', email: 'New@Example.com', cityRef: NEW_CITY, cityName: 'Київ', warehouseRef: NEW_WH.toUpperCase(), warehouseName: '№1' })
  assert.equal(r.status, 200, r.text)
  const o = s.order()
  assert.equal(o.clientName, 'Коваль Тарас')
  assert.equal(o.middleName, '')
  assert.equal(o.email, 'new@example.com')
  assert.equal(o.clientCityRef, NEW_CITY)
  assert.equal(o.clientWarehouseRef, NEW_WH)
  assert.equal(o.addressVerified, true)
  assert.equal(s.calls.npRequest[0][2].CityRef, NEW_CITY)
  assert.equal((await s.post('/orders/so-1/recipient', { firstName: 'Іван' })).data.clientName, 'Коваль Іван')
  assert.equal((await s.post('/orders/so-1/recipient', { middleName: 'Петрович' })).data.clientName, 'Коваль Іван Петрович')
  assert.equal(s.calls.npRequest.length, 1, 'без адреси НП не питаємо')

  const addr = { cityRef: NEW_CITY, cityName: 'Київ', warehouseRef: NEW_WH, warehouseName: '№1' }
  const foreign = await stand(t, docsOf(), { npRequest: async () => ({ success: true, data: [{ Ref: WAREHOUSE, Description: 'Інше' }] }) })
  assert.equal((await foreign.post('/orders/so-1/recipient', addr)).error.code, 'BAD_WAREHOUSE')
  assert.equal(foreign.order().clientCityRef, CITY)
  const postomat = await stand(t, docsOf(), { npRequest: async () => ({ success: true, data: [{ Ref: NEW_WH, Description: 'Поштомат', TypeOfWarehouse: POSTOMAT_TYPE }] }) })
  assert.equal((await postomat.post('/orders/so-1/recipient', addr)).error.code, 'BAD_WAREHOUSE')
  const down = await stand(t, docsOf(), { npRequest: async () => { throw timeoutErr() } })
  assert.equal((await down.post('/orders/so-1/recipient', addr)).status, 200)
  assert.equal(down.order().addressVerified, false)
  const refused = await stand(t, docsOf(), { npRequest: async () => ({ success: false, data: [{ Ref: NEW_WH, Description: 'x' }] }) })
  assert.equal((await refused.post('/orders/so-1/recipient', addr)).status, 200)
  assert.equal(refused.order().addressVerified, false, 'неуспішна відповідь не перевірка')
  const slow = await stand(t, docsOf(), { addressBudgetMs: 5, npRequest: () => new Promise(() => {}) })
  assert.equal((await slow.post('/orders/so-1/recipient', addr)).status, 200)
  assert.equal(slow.order().addressVerified, false)
})

test('recipient: накладная уже есть: имя и адрес только в кабинете НП, телефон и почта можно; стёртые данные и живой захват не трогаем', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: TTN })))
  assert.equal((await s.post('/orders/so-1/recipient', { lastName: 'Коваль' })).error.code, 'TTN_EXISTS')
  assert.equal(s.order().lastName, 'Шевченко')
  assert.equal((await s.post('/orders/so-1/recipient', { phone: NEW_PHONE, email: 'n@example.com' })).status, 200)
  assert.equal(s.order().clientPhone, NEW_PHONE)
  const unknown = await stand(t, docsOf(paidOrder({ ttnError: 'unknown', ttnCreatingAt: ago(HOUR) })))
  assert.equal((await unknown.post('/orders/so-1/recipient', { lastName: 'Коваль' })).error.code, 'TTN_EXISTS')
  const stale = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(HOUR) })))
  assert.equal((await stale.post('/orders/so-1/recipient', { lastName: 'Коваль' })).error.code, 'TTN_EXISTS', 'завислий захват: накладна могла зʼявитись')
  assert.equal(stale.order().lastName, 'Шевченко')
  assert.equal((await stale.post('/orders/so-1/recipient', { phone: NEW_PHONE })).status, 200)
  const purged = await stand(t, docsOf(paidOrder({ piiPurgedAt: ago(MIN) })))
  assert.equal((await purged.post('/orders/so-1/recipient', { phone: NEW_PHONE })).error.code, 'PII_PURGED')
  const busy = await stand(t, docsOf(paidOrder({ ttnCreatingAt: ago(MIN) })))
  assert.equal((await busy.post('/orders/so-1/recipient', { phone: NEW_PHONE })).error.code, 'TTN_IN_PROGRESS')
})

// ---------- отметки ----------

test('mark: неизвестная отметка 400, служебное имя объекта тоже', async (t) => {
  const s = await stand(t)
  for (const action of [undefined, 'other', 'constructor', '__proto__', 'hasOwnProperty']) {
    const r = await s.post('/orders/so-1/mark', { action })
    assert.equal(r.status, 400, String(action))
    assert.deepEqual(r.error.fields, ['action'])
  }
})

test('mark returned: только из refused, в истории кто', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'refused', ttn: TTN })), { staff: DIRECTOR })
  const r = await s.post('/orders/so-1/mark', { action: 'returned' })
  assert.deepEqual(r.data, { state: 'returned' })
  assert.equal(s.order().history.at(-1).to, 'returned')
  assert.equal(s.order().history.at(-1).by, DIRECTOR.email)
  assert.equal(s.order().orderNo, 'RF-AAAAAA', 'решта замовлення на місці')
  const paid = await stand(t)
  assert.equal((await paid.post('/orders/so-1/mark', { action: 'returned' })).error.code, 'BAD_STATE')
  assert.equal(paid.order().state, 'paid')
})

test('mark refund-requested: первая дата остаётся, сверка напомнит на 20-й день; без оплаты нельзя', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'delivered', ttn: TTN })))
  const first = await s.post('/orders/so-1/mark', { action: 'refund-requested' })
  assert.equal(first.status, 200)
  const at = s.order().refundRequestedAt
  assert.ok(at)
  assert.equal(s.order().refundRequestedBy, ADMIN_EMAIL)
  await sleep(2)
  assert.equal((await s.post('/orders/so-1/mark', { action: 'refund-requested' })).data.refundRequestedAt, at)
  assert.equal(s.order().refundRequestedAt, at)
  s.patch('shopOrders/so-1', { refundRequestedAt: ago(21 * DAY) })
  await s.step()
  await until(() => s.calls.alerts.some((a) => a.includes('20 днів')), 'алерт')
  for (const order of [awaitingOrder(), paidOrder({ state: 'reversed' })]) {
    const no = await stand(t, docsOf(order))
    assert.equal((await no.post('/orders/so-1/mark', { action: 'refund-requested' })).error.code, 'BAD_STATE')
  }
})

test('mark confirm-payment: payment_review становится paid, склад уменьшен, метка снята и чек выбит ровно один', async (t) => {
  const docs = docsOf(paidOrder({ state: 'payment_review', alerts: {}, sms: {} }), payment({ receiptId: null, taxUrl: null, receiptStatus: 'amount-mismatch', receiptError: 'сума 800 коп.' }))
  docs['system/shopSales'] = sales({ skus: { 'V2-LID-R': skuRule({ stock: 1 }) } })
  const s = await stand(t, docs, { staff: DIRECTOR })
  s.bank.statuses['inv-1'] = { status: 'success', amount: 75000, finalAmount: 75000, ccy: 980 }
  const r = await s.post('/orders/so-1/mark', { action: 'confirm-payment' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.state, 'paid')
  assert.equal(r.data.amountConfirmed.amount, 750)
  assert.equal(r.data.amountConfirmed.by, DIRECTOR.email)
  const o = s.order()
  assert.equal(o.state, 'paid')
  assert.equal(o.history.at(-1).from, 'payment_review')
  const rule = s.settings().skus['V2-LID-R']
  assert.equal(rule.stock, 0)
  assert.equal(rule.inStock, false)
  assert.ok(o.alerts['stock-out'])
  assert.equal(s.calls.sells.length, 1)
  assert.equal(s.pay().receiptStatus, 'DONE')
  assert.equal(s.pay().receiptError, null)
  await until(() => s.calls.client.some((c) => c.clientKey === 'so-1-paid'), 'повідомлення покупцю')
  // Повтор кнопки не трогает склад и второго чека не даёт.
  const again = await s.post('/orders/so-1/mark', { action: 'confirm-payment' })
  assert.equal(again.status, 200)
  assert.equal(s.settings().skus['V2-LID-R'].stock, 0)
  assert.equal(s.calls.sells.length, 1)
  // Подтверждённая сумма разрешает накладную.
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
})

test('mark confirm-payment: поздняя оплата с уже выбитым чеком: только переход, чек не повторяется', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'payment_review', history: [{ at: ago(HOUR), from: 'cancelled', to: 'payment_review', by: 'webhook' }] })))
  const r = await s.post('/orders/so-1/mark', { action: 'confirm-payment' })
  assert.equal(r.data.state, 'paid')
  assert.equal(r.data.amountConfirmed.amount, 800)
  assert.equal(s.calls.sells.length, 0)
})

test('mark confirm-payment: заказ paid получает только отметку; банк без суммы берёт сумму оплаты', async (t) => {
  const s = await stand(t)
  s.bank.statuses['inv-1'] = { status: 'success', ccy: 980 }
  assert.equal((await s.post('/orders/so-1/ttn')).error.code, 'PAYMENT_NOT_CONFIRMED')
  const r = await s.post('/orders/so-1/mark', { action: 'confirm-payment' })
  assert.equal(r.data.state, 'paid')
  assert.equal(r.data.amountConfirmed.amount, 800)
  assert.equal(s.order().history.length, 1)
  assert.equal((await s.post('/orders/so-1/ttn')).status, 200)
})

test('mark confirm-payment и receipt-retry: успех с нулём на счёте: деньги вернули, подтвердить и выбить нельзя', async (t) => {
  const zero = { status: 'success', amount: 80000, ccy: 980, finalAmount: 0 }
  const s = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  s.bank.statuses['inv-1'] = zero
  assert.equal((await s.post('/orders/so-1/mark', { action: 'confirm-payment' })).error.code, 'PAYMENT_NOT_CONFIRMED')
  assert.equal(s.order().amountConfirmed, undefined)
  await until(() => s.order().state === 'reversed', 'повернення')
  const r = await stand(t, docsOf(paidOrder(), failedReceipt()), { getReceipt: async () => ({ status: 'ERROR' }) })
  r.bank.statuses['inv-1'] = zero
  assert.equal((await r.post('/orders/so-1/receipt-retry')).error.code, 'PAYMENT_NOT_CONFIRMED')
  await until(() => r.order().state === 'reversed', 'повернення')
  assert.equal(r.calls.sells.length, 0)
  const c = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  c.bank.statuses['inv-1'] = zero
  assert.deepEqual((await c.post('/orders/so-1/mark', { action: 'check-reversed' })).data, { state: 'reversed' })
})

test('mark confirm-payment: finalAmount важнее amount, а пустой не считается', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  s.bank.statuses['inv-1'] = { status: 'success', amount: 80000, ccy: 980, finalAmount: 60000 }
  assert.equal((await s.post('/orders/so-1/mark', { action: 'confirm-payment' })).data.amountConfirmed.amount, 600)
  const e = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  e.bank.statuses['inv-1'] = { status: 'success', amount: 70000, ccy: 980, finalAmount: '' }
  assert.equal((await e.post('/orders/so-1/mark', { action: 'confirm-payment' })).data.amountConfirmed.amount, 700)
})

test('mark confirm-payment: банк не подтверждает или молчит: заказ не меняется; не то состояние отказ', async (t) => {
  const reversed = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  reversed.bank.statuses['inv-1'] = { status: 'reversed' }
  const r = await reversed.post('/orders/so-1/mark', { action: 'confirm-payment' })
  assert.equal(r.status, 409)
  assert.equal(r.error.code, 'PAYMENT_NOT_CONFIRMED')
  assert.equal(reversed.order().amountConfirmed, undefined)
  await until(() => reversed.order().state === 'reversed', 'банк дійшов до замовлення')

  const down = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  down.bank.fail['inv-1'] = httpErr(503)
  assert.equal((await down.post('/orders/so-1/mark', { action: 'confirm-payment' })).error.code, 'BANK_UNAVAILABLE')
  assert.equal(down.order().state, 'payment_review')

  const gone = await stand(t, docsOf(paidOrder({ state: 'payment_review' }), payment({ status: 'reversed' })))
  assert.equal((await gone.post('/orders/so-1/mark', { action: 'confirm-payment' })).error.code, 'NOT_PAID')
  const noPay = await stand(t, docsOf(paidOrder({ state: 'payment_review', paidPaymentId: null })))
  assert.equal((await noPay.post('/orders/so-1/mark', { action: 'confirm-payment' })).error.code, 'NOT_PAID')

  for (const state of ['shipped', 'delivered', 'reversed', 'refused']) {
    const s = await stand(t, docsOf(paidOrder({ state })))
    assert.equal((await s.post('/orders/so-1/mark', { action: 'confirm-payment' })).error.code, 'BAD_STATE', state)
    assert.equal(s.bank.statusCalls.length, 0)
  }
})

test('onShopPaymentConfirmed: заказа нет: false, ничего не записано', async (t) => {
  const s = await stand(t)
  assert.equal(await s.hooks.onShopPaymentConfirmed('so-missing', { by: 'x', amount: 1 }), false)
  assert.equal(s.db.docs['shopOrders/so-missing'], undefined)
})

test('mark check-reversed: заказ reversed только по ответу банка', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'payment_review' })))
  assert.equal((await s.post('/orders/so-1/mark', { action: 'check-reversed' })).error.code, 'BANK_NOT_REVERSED')
  assert.equal(s.order().state, 'payment_review')
  s.bank.fail['inv-1'] = httpErr(500)
  assert.equal((await s.post('/orders/so-1/mark', { action: 'check-reversed' })).error.code, 'BANK_UNAVAILABLE')
  delete s.bank.fail['inv-1']
  s.bank.statuses['inv-1'] = { status: 'reversed', amount: 80000, finalAmount: 0 }
  const r = await s.post('/orders/so-1/mark', { action: 'check-reversed' })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { state: 'reversed' })
  assert.equal(s.pay().status, 'reversed')
  const none = await stand(t, docsOf(awaitingOrder({ paidPaymentId: null })))
  assert.equal((await none.post('/orders/so-1/mark', { action: 'check-reversed' })).error.code, 'NOT_PAID')
  const noFop = await stand(t, docsOf(paidOrder({ state: 'payment_review' }), payment({ fopId: 'fop-x' })))
  assert.equal((await noFop.post('/orders/so-1/mark', { action: 'check-reversed' })).error.code, 'BANK_UNAVAILABLE')
  assert.equal(noFop.bank.statusCalls.length, 0)
})

// ---------- повтор чека ----------

const failedReceipt = (over = {}) => payment({ receiptId: 'rcpt-old', taxUrl: null, receiptStatus: 'ERROR', fiscalizeClaimedAt: ago(HOUR), ...over })

test('receipt-retry: ERROR и CANCELLED: новый номер чека, новый id, прежний статус и алерты очищены, чек через банк', async (t) => {
  for (const status of ['ERROR', 'CANCELLED']) {
    const s = await stand(t, docsOf(
      paidOrder({ receipt: { status: 'failed' }, alerts: { 'receipt-failed': { at: ago(MIN), sentAt: ago(MIN), text: 'x' }, 'receipt-late': { at: ago(MIN), sentAt: ago(MIN), text: 'y' }, 'receipt-claim': { at: ago(MIN), sentAt: ago(MIN), text: 'z' }, 'new-paid': { at: ago(MIN), sentAt: ago(MIN), text: 'q' } } }),
      failedReceipt({ receiptStatus: status }),
    ), { getReceipt: async () => ({ receiptId: 'rcpt-old', status, taxUrl: null }) })
    const r = await s.post('/orders/so-1/receipt-retry')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.data, { receiptStatus: 'DONE', taxUrl: TAX_URL, receiptAttempt: 1 })
    assert.deepEqual(s.calls.getReceipt, [s.api.receiptUuidFor('pay-1')], 'спершу касса про прежній чек')
    assert.deepEqual(s.bank.statusCalls, ['inv-1'], 'через банк')
    assert.equal(s.calls.sells.length, 1)
    assert.equal(s.calls.sells[0].receiptId, s.api.receiptUuidFor('pay-1', 1))
    assert.notEqual(s.calls.sells[0].receiptId, s.api.receiptUuidFor('pay-1'))
    assert.equal(s.calls.sells[0].paymentLabel, 'Інтернет еквайринг')
    const o = s.order()
    assert.equal(o.receipt.status, 'none')
    for (const k of ['receipt-failed', 'receipt-late', 'receipt-claim']) assert.equal(o.alerts[k], null, k)
    assert.ok(o.alerts['new-paid'])
    assert.equal(s.pay().receiptAttempt, 1)
    assert.equal(s.pay().receiptId, 'rcpt-new')
    await s.step()
    assert.equal(s.order().receipt.status, 'ready')
    assert.equal(s.calls.sells.length, 1)
  }
})

test('receipt-retry: 404 при чтении: чека нет, можно; второй повтор берёт следующий номер', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ receipt: { status: 'failed' } }), payment({ receiptId: null, taxUrl: null, receiptStatus: 'error', fiscalizeClaimedAt: null })), {
    getReceipt: async () => { throw httpErr(404) },
    sell: async () => { throw httpErr(500) },
  })
  const r = await s.post('/orders/so-1/receipt-retry')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.receiptStatus, 'error')
  assert.equal(r.data.receiptAttempt, 1)
  const second = await s.post('/orders/so-1/receipt-retry')
  assert.equal(second.data.receiptAttempt, 2)
  assert.deepEqual(s.calls.getReceipt, [s.api.receiptUuidFor('pay-1'), s.api.receiptUuidFor('pay-1', 1)])
  assert.deepEqual(s.calls.sells.map((c) => c.receiptId), [s.api.receiptUuidFor('pay-1', 1), s.api.receiptUuidFor('pay-1', 2)])
})

test('receipt-retry: чек в кассе жив: новый не выбиваем; DONE дописывается в оплату', async (t) => {
  const done = await stand(t, docsOf(paidOrder(), payment({ receiptId: null, taxUrl: null, receiptStatus: 'error', fiscalizeClaimedAt: null })), {
    getReceipt: async () => ({ receiptId: 'rcpt-found', status: 'DONE', taxUrl: TAX_URL, fiscalCode: 'FC' }),
  })
  const r = await done.post('/orders/so-1/receipt-retry')
  assert.equal(r.status, 409)
  assert.equal(r.error.code, 'RECEIPT_EXISTS')
  assert.ok(r.error.message.includes('(DONE)'), r.error.message)
  assert.equal(done.pay().receiptId, 'rcpt-found')
  assert.equal(done.pay().taxUrl, TAX_URL)
  assert.equal(done.calls.sells.length, 0)

  const created = await stand(t, docsOf(paidOrder(), failedReceipt({ receiptStatus: 'CREATED' })), {
    getReceipt: async () => ({ receiptId: 'rcpt-old', status: 'CREATED', taxUrl: null }),
  })
  assert.equal((await created.post('/orders/so-1/receipt-retry')).error.code, 'RECEIPT_EXISTS')
  assert.equal(created.calls.sells.length, 0)
  assert.equal(created.pay().receiptId, 'rcpt-old')
})

test('receipt-retry: касса или банк не ответили, деньги вернули, сумма не сошлась, чек сейчас выбивается: нового чека нет', async (t) => {
  const down = await stand(t, docsOf(paidOrder(), failedReceipt()), { getReceipt: async () => { throw httpErr(503) } })
  assert.equal((await down.post('/orders/so-1/receipt-retry')).error.code, 'CHECKBOX_UNAVAILABLE')
  assert.equal(down.pay().receiptAttempt, undefined)

  const noBank = await stand(t, docsOf(paidOrder(), failedReceipt()), { getReceipt: async () => ({ status: 'ERROR' }) })
  noBank.bank.fail['inv-1'] = httpErr(500)
  assert.equal((await noBank.post('/orders/so-1/receipt-retry')).error.code, 'BANK_UNAVAILABLE')
  assert.equal(noBank.pay().receiptAttempt, undefined)
  assert.equal(noBank.calls.sells.length, 0)

  const reversed = await stand(t, docsOf(paidOrder(), failedReceipt()), { getReceipt: async () => ({ status: 'ERROR' }) })
  reversed.bank.statuses['inv-1'] = { status: 'reversed', amount: 80000 }
  assert.equal((await reversed.post('/orders/so-1/receipt-retry')).error.code, 'PAYMENT_NOT_CONFIRMED')
  await until(() => reversed.order().state === 'reversed', 'повернення дійшло')
  assert.equal(reversed.calls.sells.length, 0)

  const mismatch = await stand(t, docsOf(paidOrder(), payment({ receiptId: null, receiptStatus: 'amount-mismatch', taxUrl: null })))
  assert.equal((await mismatch.post('/orders/so-1/receipt-retry')).error.code, 'AMOUNT_REVIEW')
  assert.equal(mismatch.calls.getReceipt.length, 0)

  const back = await stand(t, docsOf(paidOrder(), payment({ status: 'reversed' })))
  assert.equal((await back.post('/orders/so-1/receipt-retry')).error.code, 'NOT_PAID')
  const unpaid = await stand(t, docsOf(awaitingOrder()))
  assert.equal((await unpaid.post('/orders/so-1/receipt-retry')).error.code, 'NOT_PAID')

  const claimed = await stand(t, docsOf(paidOrder(), payment({ receiptId: null, taxUrl: null, receiptStatus: null, fiscalizeClaimedAt: ago(MIN) })))
  assert.equal((await claimed.post('/orders/so-1/receipt-retry')).error.code, 'RECEIPT_IN_PROGRESS')
  assert.equal(claimed.calls.getReceipt.length, 0)
  const noFop = await stand(t, docsOf(paidOrder({ fopId: 'fop-x' }), failedReceipt({ fopId: 'fop-x' })))
  assert.equal((await noFop.post('/orders/so-1/receipt-retry')).error.code, 'NO_FOP')
})

test('receiptUuidFor: без попытки прежний id ремонтов, попытки дают разные', async (t) => {
  const s = await stand(t)
  assert.equal(s.api.receiptUuidFor('pay-test'), '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
  assert.equal(s.api.receiptUuidFor('pay-test', 0), '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
  assert.equal(s.api.receiptUuidFor('pay-test', undefined), '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
  assert.notEqual(s.api.receiptUuidFor('pay-test', 1), s.api.receiptUuidFor('pay-test'))
  assert.notEqual(s.api.receiptUuidFor('pay-test', 2), s.api.receiptUuidFor('pay-test', 1))
})

test('сверка: зависший захват чека проверяет id текущей попытки', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ receipt: { status: 'none' } }), payment({ receiptId: null, taxUrl: null, receiptStatus: null, receiptAttempt: 2, fiscalizeClaimedAt: ago(HOUR) })), {
    getReceipt: async () => ({ receiptId: 'rcpt-2', status: 'DONE', taxUrl: TAX_URL }),
  })
  await s.step()
  assert.deepEqual(s.calls.getReceipt, [s.api.receiptUuidFor('pay-1', 2)])
  assert.equal(s.pay().receiptId, 'rcpt-2')
})

// ---------- повтор сообщения ----------

test('resend: сбрасывает попытки и алерт, новый ключ журнала, ответ со статусом', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ state: 'shipped', ttn: TTN, sms: { paid: { status: 'failed', at: ago(HOUR), tries: 4 }, rcpt: { status: 'sent', at: ago(HOUR), tries: 1 }, [`ttn-${TTN}`]: { status: 'sent', at: ago(HOUR), tries: 1 } }, alerts: { 'sms-paid': { at: ago(HOUR), sentAt: ago(HOUR), text: 'x' } } })))
  const paid = await s.post('/orders/so-1/resend', { kind: 'paid' })
  assert.deepEqual(paid.data, { kind: 'paid', status: 'sent' })
  assert.equal(s.calls.client[0].clientKey, 'so-1-paid-r1')
  assert.ok(s.calls.client[0].text.includes(STATUS_TOKEN))
  assert.ok(!s.calls.client[0].journal.text.includes(STATUS_TOKEN), 'токен не в журналі')
  assert.equal(s.order().alerts['sms-paid'], null)
  assert.deepEqual([s.order().sms.paid.tries, s.order().sms.paid.resends], [1, 1])

  const rcpt = await s.post('/orders/so-1/resend', { kind: 'rcpt' })
  assert.deepEqual(rcpt.data, { kind: 'rcpt', status: 'sent' })
  assert.equal(s.calls.client[1].clientKey, 'so-1-rcpt-r1')
  assert.ok(s.calls.client[1].text.includes(TAX_URL))

  const ttn = await s.post('/orders/so-1/resend', { kind: 'ttn' })
  assert.deepEqual(ttn.data, { kind: `ttn-${TTN}`, status: 'sent' })
  assert.equal(s.calls.client[2].clientKey, `so-1-ttn-${TTN}-r1`)
})

test('resend: журнал настоящий: второе сообщение после смены номера не считается уже доставленным', async (t) => {
  const s = await stand(t, docsOf(), { notifications: true })
  await s.post('/orders/so-1/recipient', { phone: NEW_PHONE })
  assert.equal((await s.post('/orders/so-1/resend', { kind: 'paid' })).data.status, 'sent')
  assert.equal(s.calls.sms.at(-1).phone, NEW_PHONE)
  assert.ok(s.db.docs['notifications/ntf-na-shop-so-1-paid-r2'])
  assert.equal(JSON.stringify(s.db.docs['notifications/ntf-na-shop-so-1-paid-r2']).includes(STATUS_TOKEN), false)
  // Двойной клик не шлёт второй платный SMS.
  const count = s.calls.sms.length
  const again = await s.post('/orders/so-1/resend', { kind: 'paid' })
  assert.equal(again.status, 429)
  assert.equal(again.error.code, 'TOO_SOON')
  assert.equal(s.calls.sms.length, count)
})

test('resend: неизвестный вид и нечего слать: отказ; сбой отправки виден в ответе', async (t) => {
  const s = await stand(t, docsOf(paidOrder({ sms: {} }), payment({ taxUrl: null })))
  for (const kind of [undefined, 'other', 'constructor']) {
    const r = await s.post('/orders/so-1/resend', { kind })
    assert.equal(r.status, 400, String(kind))
    assert.equal(r.error.code, 'BAD_INPUT', String(kind))
  }
  assert.equal((await s.post('/orders/so-1/resend', { kind: 'rcpt' })).error.code, 'NOTHING_TO_SEND')
  assert.equal((await s.post('/orders/so-1/resend', { kind: 'ttn' })).error.code, 'NOTHING_TO_SEND')
  const unpaid = await stand(t, docsOf(awaitingOrder(), null))
  assert.equal((await unpaid.post('/orders/so-1/resend', { kind: 'paid' })).error.code, 'NOTHING_TO_SEND')
  const back = await stand(t, docsOf(paidOrder({ state: 'reversed' })))
  assert.equal((await back.post('/orders/so-1/resend', { kind: 'paid' })).error.code, 'NOTHING_TO_SEND')
  const purged = await stand(t, docsOf(paidOrder({ clientPhone: null })))
  assert.equal((await purged.post('/orders/so-1/resend', { kind: 'paid' })).error.code, 'NO_PHONE')
  const failing = await stand(t, docsOf(paidOrder({ sms: {} })), { client: async () => ({ status: 'failed', error: 'x' }) })
  assert.deepEqual((await failing.post('/orders/so-1/resend', { kind: 'paid' })).data, { kind: 'paid', status: 'failed' })
})

// ---------- настройки ----------

const VALID_SKUS = { 'V2-LID-R': skuRule(), 'V2-LID-H': skuRule({ stock: 3 }) }

test('settings GET: без документа null, директор не видит телефона владельца', async (t) => {
  const empty = await stand(t, { 'shopOrders/so-1': paidOrder() })
  assert.deepEqual((await empty.get('/settings')).data, { settings: null })
  const owner = await stand(t)
  assert.equal((await owner.get('/settings')).data.settings.ownerPhone, OWNER_PHONE)
  const deputy = await stand(t, docsOf(), { staff: DIRECTOR })
  const r = await deputy.get('/settings')
  assert.equal(r.data.settings.mode, 'live')
  assert.equal('ownerPhone' in r.data.settings, false)
  assert.ok(!r.text.includes(OWNER_PHONE))
})

test('settings PUT: создаёт документ, поля по белому списку; ownerTestOkAt и прочее из тела не записывается', async (t) => {
  const s = await stand(t, { 'shopOrders/so-1': paidOrder() })
  const r = await s.put('/settings', {
    mode: 'prices', fopId: 'fop-2', npTemplateId: 'tpl-1', siteBaseUrl: 'https://runferry.ua', offerVersion: '2026-11-03', methods: { card: false, cod: false },
    codKind: 'control', codReceiptMode: 'ettn', cardReceiptLabel: 'Інтернет еквайринг', ownerPhone: '0670000009', codTestPhones: ['0671234567'], skus: VALID_SKUS,
    limits: { unpaidPerDay: 40, piiPaidDays: 365 }, ownerTestOkAt: '2020-01-01', hacked: true, updatedBy: 'x',
  })
  assert.equal(r.status, 200, r.text)
  const d = s.settings()
  assert.equal(d.mode, 'prices')
  assert.equal(d.ownerPhone, '+380670000009')
  assert.deepEqual(d.codTestPhones, [PHONE])
  assert.deepEqual(d.skus, VALID_SKUS)
  assert.equal(d.limits.piiPaidDays, 365)
  assert.equal(d.ownerTestOkAt, undefined)
  assert.equal(d.hacked, undefined)
  assert.equal(d.updatedBy, ADMIN_EMAIL)
  assert.ok(d.updatedAt)
})

test('settings PUT: mode hidden и live без успешного теста алерта не проходят, с ним проходят', async (t) => {
  for (const mode of ['hidden', 'live']) {
    const s = await stand(t)
    s.patch('system/shopSales', { ownerTestOkAt: null, mode: 'off' })
    const r = await s.put('/settings', { mode })
    assert.equal(r.status, 400, mode)
    assert.equal(r.error.code, 'OWNER_TEST_REQUIRED', mode)
    assert.ok(r.error.message.includes('сповіщення'))
    assert.equal(s.settings().mode, 'off')
    const body = await s.put('/settings', { mode, ownerTestOkAt: new Date().toISOString() })
    assert.equal(body.error.code, 'OWNER_TEST_REQUIRED', 'тіло не підставляє тест')
    s.patch('system/shopSales', { ownerTestOkAt: ago(MIN) })
    assert.equal((await s.put('/settings', { mode })).status, 200)
    assert.equal(s.settings().mode, mode)
  }
})

test('settings PUT: продажи не включаются без адреса сайта, ФОП и редакции оферты', async (t) => {
  for (const [field, value] of [['siteBaseUrl', ''], ['siteBaseUrl', 'http://runferry.ua'], ['fopId', ''], ['offerVersion', '']]) {
    const s = await stand(t)
    s.patch('system/shopSales', { mode: 'off', [field]: value })
    const r = await s.put('/settings', { mode: 'live' })
    assert.equal(r.status, 400, `${field}=${value}`)
    assert.equal(r.error.code, 'BAD_SETTINGS')
    assert.deepEqual(r.error.fields, [field])
    assert.equal(s.settings().mode, 'off')
  }
  const s = await stand(t)
  const prices = await s.put('/settings', { mode: 'prices', siteBaseUrl: '' })
  assert.equal(prices.status, 200, 'для prices адрес не потрібен')
})

test('settings PUT: наложка только с разрешённой парой; money + ettn запрещена', async (t) => {
  const s = await stand(t)
  const r = await s.put('/settings', { methods: { cod: true }, codKind: 'money', codReceiptMode: 'ettn' })
  assert.equal(r.status, 400)
  assert.equal(r.error.code, 'COD_PAIR_FORBIDDEN')
  assert.equal(s.settings().methods.cod, false)
  assert.equal((await s.put('/settings', { methods: { cod: true }, codKind: 'money', codReceiptMode: 'manual' })).status, 200)
  assert.equal(s.settings().methods.cod, true)
  assert.equal(s.settings().methods.card, true, 'дополняются, а не заменяются')
  assert.equal((await s.put('/settings', { codReceiptMode: 'ettn' })).error.code, 'COD_PAIR_FORBIDDEN')
  assert.equal((await s.put('/settings', { methods: { cod: false }, codReceiptMode: 'ettn', codKind: 'money' })).status, 200, 'вимкнена наложка не заважає')
  const missing = await stand(t)
  missing.patch('system/shopSales', { codKind: undefined })
  delete missing.db.docs['system/shopSales'].codKind
  assert.equal((await missing.put('/settings', { methods: { cod: true } })).error.code, 'COD_PAIR_FORBIDDEN')
})

test('settings PUT: кривые значения 400 с перечнем полей и без записи', async (t) => {
  const cases = [
    { mode: 'on' }, { fopId: '../x' }, { npTemplateId: 'a b' }, { siteBaseUrl: 'http://a.b' }, { siteBaseUrl: 'https://a b' }, { siteBaseUrl: `https://${'a'.repeat(200)}` }, { offerVersion: 'x'.repeat(41) },
    { codKind: 'other' }, { codReceiptMode: 'other' }, { cardReceiptLabel: 'x'.repeat(129) }, { codReceiptLabel: 'x'.repeat(129) }, { ownerPhone: '123' }, { codTestPhones: 'x' }, { codTestPhones: ['123'] }, { codTestPhones: Array(21).fill(PHONE) },
    { methods: 'x' }, { methods: { card: 'yes' } }, { methods: { other: true } },
    { limits: 'x' }, { limits: { unpaidPerDay: -1 } }, { limits: { unpaidPerDay: 1.5 } }, { limits: { other: 1 } }, { limits: { piiPaidDays: 0 } },
    { skus: 'x' }, { skus: { 'плохой sku': skuRule() } }, { skus: { 'V2-LID-R': skuRule({ enabled: 'yes' }) } }, { skus: { 'V2-LID-R': skuRule({ inStock: 1 }) } }, { skus: { 'V2-LID-R': skuRule({ stock: -1 }) } }, { skus: { 'V2-LID-R': skuRule({ stock: 1.5 }) } },
    { skus: { 'V2-LID-R': skuRule({ minUah: 0 }) } }, { skus: { 'V2-LID-R': skuRule({ maxUah: 500 }) } }, { skus: { 'V2-LID-R': null } },
  ]
  for (const body of cases) {
    const s = await stand(t)
    const before = s.settings()
    const r = await s.put('/settings', body)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
    assert.equal(r.error.code, 'BAD_SETTINGS')
    assert.ok(r.error.message.includes('Перевірте поля'))
    assert.deepEqual(r.error.fields, Object.keys(body))
    assert.deepEqual(s.settings(), before)
  }
})

test('settings PUT: mode off проходит всегда, какие бы настройки ни испортились; артикул можно убрать, limits дополняются', async (t) => {
  const s = await stand(t)
  s.patch('system/shopSales', { siteBaseUrl: 'garbage', offerVersion: '', ownerTestOkAt: null, fopId: '' })
  const off = await s.put('/settings', { mode: 'off' })
  assert.equal(off.status, 200, off.text)
  assert.equal(s.settings().mode, 'off')
  assert.equal(s.settings().siteBaseUrl, 'garbage')

  const pair = await stand(t)
  pair.patch('system/shopSales', { methods: { cod: true }, codKind: 'money', codReceiptMode: 'ettn' })
  const emergency = await pair.put('/settings', { mode: 'off' })
  assert.equal(emergency.status, 200, emergency.text)
  assert.equal(pair.settings().mode, 'off')
  assert.equal((await pair.put('/settings', { mode: 'prices' })).error.code, 'COD_PAIR_FORBIDDEN', 'увімкнути назад не можна')
  assert.equal(pair.settings().mode, 'off')
  assert.equal((await pair.put('/settings', { mode: 'off', codReceiptMode: 'ettn' })).error.code, 'COD_PAIR_FORBIDDEN', 'записати заборонену пару теж не можна')
  assert.equal((await pair.put('/settings', { mode: 'off', methods: { cod: false } })).status, 200)

  const r = await stand(t, docsOf())
  r.patch('system/shopSales', { limits: { unpaidPerDay: 40 } })
  await r.put('/settings', { skus: { 'V2-LID-H': skuRule() }, limits: { payAttemptsPerOrder: 3 } })
  assert.deepEqual(Object.keys(r.settings().skus), ['V2-LID-H'])
  assert.deepEqual(r.settings().limits, { unpaidPerDay: 40, payAttemptsPerOrder: 3 })
  await r.put('/settings', { limits: { piiPaidDays: null } })
  assert.equal(r.settings().limits.piiPaidDays, null)
})

test('settings: чистые правила: документ без mode становится off, пустое тело не падает', () => {
  assert.equal(salesSettingsNext({}, {}).next.mode, 'off')
  assert.equal(salesSettingsNext(null, { mode: 'prices' }).next.mode, 'prices')
  assert.equal(salesSettingsNext('x').ok, true)
  assert.deepEqual(salesSettingsNext({ mode: 'bad' }).fields, ['mode'])
})

// ---------- тест алерта ----------

test('test-alert: Telegram дошёл: ownerTestOkAt и запасной SMS проверен; не дошёл: метки нет, код 502', async (t) => {
  const s = await stand(t)
  s.patch('system/shopSales', { ownerTestOkAt: null })
  const r = await s.post('/test-alert')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.sms, 'sent')
  assert.ok(r.data.ownerTestOkAt)
  assert.equal(s.settings().ownerTestOkAt, r.data.ownerTestOkAt)
  assert.equal(s.settings().fopId, 'fop-2')
  assert.equal(s.calls.alerts.length, 1)
  assert.ok(s.calls.alerts[0].includes('перевірка сповіщень'))
  assert.ok(s.calls.alerts[0].endsWith("\nПам'ятка, крок 13"), s.calls.alerts[0])
  assert.equal(s.calls.sms[0].phone, OWNER_PHONE)
  assert.equal(s.calls.sms[0].text, s.calls.alerts[0])

  const down = await stand(t, docsOf(), { notify: async () => false, sms: async () => ({ ok: false, error: 'x' }) })
  down.patch('system/shopSales', { ownerTestOkAt: null })
  const bad = await down.post('/test-alert')
  assert.equal(bad.status, 502)
  assert.equal(bad.error.code, 'ALERT_FAILED')
  assert.equal(bad.error.sms, 'failed')
  assert.equal(down.settings().ownerTestOkAt, null)

  const noPhone = await stand(t)
  noPhone.patch('system/shopSales', { ownerPhone: '' })
  assert.equal((await noPhone.post('/test-alert')).data.sms, 'no-phone')
  assert.equal(noPhone.calls.sms.length, 0)

  const throwing = await stand(t, docsOf(), { sms: async () => { throw new Error('turbosms') } })
  assert.equal((await throwing.post('/test-alert')).data.sms, 'failed')

  const noDb = await stand(t)
  noDb.db.failWrite = (path) => path === 'system/shopSales'
  assert.equal((await noDb.post('/test-alert')).status, 500, 'запис не вдався: тест не зараховано')
})

// ---------- выключение ----------

test('disable-and-remove-invoices: mode off первым, снимает только живые счета магазина, в том числе закрытых заказов; ремонт не тронут', async (t) => {
  const s = await stand(t, docsOf(awaitingOrder(), payment({ status: 'pending', receiptId: null, taxUrl: null, receiptStatus: null, createdAt: ago(5 * MIN) }), {
    'payments/pay-2': payment({ orderId: 'pay-2', providerOrderId: 'inv-2', status: 'pending', shopOrderId: 'so-closed', createdAt: ago(5 * MIN), receiptId: null }),
    'payments/pay-old': payment({ orderId: 'pay-old', providerOrderId: 'inv-old', status: 'pending', createdAt: ago(2 * HOUR), receiptId: null }),
    'payments/pay-paid': payment({ orderId: 'pay-paid', providerOrderId: 'inv-paid', status: 'paid', createdAt: ago(5 * MIN) }),
    'payments/pay-repair': { orderId: 'pay-repair', status: 'pending', provider: 'mono-acquire', providerOrderId: 'inv-rep', fopId: 'fop-2', createdAt: ago(5 * MIN) },
  }), { staff: DIRECTOR })
  const r = await s.post('/disable-and-remove-invoices')
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.data, { mode: 'off', total: 2, failed: 0 })
  assert.equal(s.settings().mode, 'off')
  assert.equal(s.settings().fopId, 'fop-2')
  assert.equal(s.settings().updatedBy, DIRECTOR.email)
  assert.deepEqual(s.bank.removed.sort(), ['inv-1', 'inv-2'])
  assert.equal(s.pay('pay-1').status, 'removed')
  assert.equal(s.pay('pay-2').status, 'removed')
  assert.equal(s.pay('pay-repair').status, 'pending')
  assert.equal(s.order().state, 'awaiting_payment')
  const open = orderPublicView(s.order(), { payment: s.pay('pay-1'), open: true })
  assert.equal(open.payment.payUrl, null)
  assert.equal(open.payment.canRetry, true)
})

test('disable-and-remove-invoices: выключить не вышло: 500 и счета не трогаем', async (t) => {
  const s = await stand(t, docsOf(awaitingOrder(), payment({ status: 'pending', receiptId: null, createdAt: ago(5 * MIN) })))
  s.db.failWrite = (path) => path === 'system/shopSales'
  const r = await s.post('/disable-and-remove-invoices')
  assert.equal(r.status, 500)
  assert.equal(s.bank.removed.length, 0)
})

test('disable-and-remove-invoices: банк отказал: число отказов в ответе, продажи всё равно выключены', async (t) => {
  const s = await stand(t, docsOf(awaitingOrder(), payment({ status: 'pending', receiptId: null, createdAt: ago(5 * MIN) })))
  s.bank.removeFail['inv-1'] = httpErr(500)
  const r = await s.post('/disable-and-remove-invoices')
  assert.deepEqual(r.data, { mode: 'off', total: 1, failed: 1 })
  assert.equal(s.settings().mode, 'off')
  assert.equal(s.pay().status, 'pending')
  assert.ok(logs.some((l) => l.includes('рахунок pay-1 не знято')))
})

// ---------- счётчик и номер ----------

test('daily-reset: обнуляет счётчик и стирает метку алерта, второй алерт в этот день снова возможен', async (t) => {
  const today = KYIV_DAY.format(new Date())
  const s = await stand(t, docsOf(paidOrder(), payment(), { [`shopDaily/${today}`]: { unpaid: 40, alerts: { 'day-limit': { at: ago(MIN), sentAt: ago(MIN), text: 'x' }, 'feed-V2-LID-R': { at: ago(MIN), text: 'y' } } } }))
  const r = await s.post('/daily-reset')
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { day: today, unpaid: 0 })
  const d = s.db.docs[`shopDaily/${today}`]
  assert.equal(d.unpaid, 0)
  assert.equal(d.alerts['day-limit'], null)
  assert.ok(d.alerts['feed-V2-LID-R'], 'чужа мітка лишилась')
  s.db.failWrite = (path) => path.startsWith('shopDaily/')
  assert.equal((await s.post('/daily-reset')).status, 500)
})

test('phones/unblock: снимает запрет наложки у номера, кривой номер 400', async (t) => {
  const key = phoneKeyOf(PHONE)
  const s = await stand(t, docsOf(paidOrder(), payment(), { [`shopPhones/${key}`]: { codBlocked: true, refusals: 2 } }))
  const bad = await s.post('/phones/unblock', { phone: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.error.code, 'BAD_INPUT')
  assert.equal(s.db.docs[`shopPhones/${key}`].codBlocked, true)
  s.db.failWrite = (path) => path.startsWith('shopPhones/')
  assert.equal((await s.post('/phones/unblock', { phone: PHONE })).status, 500)
  s.db.failWrite = null
  assert.deepEqual((await s.post('/phones/unblock', { phone: '0671234567' })).data, { codBlocked: false })
  assert.equal(s.db.docs[`shopPhones/${key}`].codBlocked, false)
  assert.equal(s.db.docs[`shopPhones/${key}`].refusals, 2)
})

// ---------- готовность ----------

test('readiness: всё на месте: кабинет банка, продавец, шаблон, касса, смена, автозакрытие, тест; ни одного секрета', async (t) => {
  const s = await stand(t)
  const r = await s.get('/readiness')
  assert.equal(r.status, 200, r.text)
  const d = r.data
  assert.equal(d.ready, true, JSON.stringify(d.problems))
  assert.deepEqual(d.problems, [])
  assert.equal(d.mode, 'live')
  assert.equal(d.monoAcquire.status, 'ok')
  assert.equal(d.monoAcquire.merchantName, 'Кабінет ФОП')
  assert.equal(d.monoAcquire.edrpou, '1234567890')
  assert.equal(d.seller.name, 'Продавець')
  assert.deepEqual(d.sellable.card, { ok: true })
  assert.deepEqual(d.methods, { card: true, cod: false })
  assert.equal(d.siteBaseUrl, SITE)
  assert.equal(d.offerVersion, '2026-11-03')
  assert.deepEqual(d.npTemplate, { id: 'tpl-1', name: 'Кришка', problems: [], problemTexts: [], description: 'Запчастина для кораблика', weight: 0.5, payerType: 'recipient' })
  assert.equal(d.checkbox.status, 'ok')
  assert.equal(d.checkbox.cashier.name, 'Касир')
  assert.equal(d.checkbox.shift.status, 'OPENED')
  assert.equal(d.checkbox.autoCloseShiftAt, '23:30')
  assert.deepEqual(d.checkbox.cashRegister, { title: 'Каса 1', address: 'Умань', fiscalNumber: '400', ettnAcquiring: false })
  assert.equal(d.ownerTestOkAt, s.settings().ownerTestOkAt)
  assert.equal(d.ownerPhoneSet, true)
  assert.equal(d.callbackBaseUrlSet, true)
  assert.deepEqual(d.items, [{ sku: 'V2-LID-R', enabled: true, inStock: true, stock: null, priceUah: 800, problem: null }])
  assert.deepEqual(d.today, { unpaid: 0, limit: 40 })
  noSecrets(r.text)
  assert.ok(!r.text.includes(OWNER_PHONE), 'телефон власника не показуємо')
})

test('readiness: без настроек и ФОП отвечает, а не падает, и всё перечисляет', async (t) => {
  const s = await stand(t, { 'shopOrders/so-1': paidOrder() })
  const r = await s.get('/readiness')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.ready, false)
  assert.deepEqual(r.data.problems, ['siteBaseUrl', 'offerVersion', 'ownerTest', 'ownerPhone', 'fopGate', 'monoAcquire', 'checkbox', 'autoCloseShift', 'npTemplate'])
  assert.equal(r.data.mode, 'off')
  assert.equal(r.data.seller, null)
  assert.equal(r.data.monoAcquire.status, 'none')
  assert.equal(r.data.checkbox.status, 'none')
  assert.deepEqual(r.data.npTemplate.problems, ['missing'])
})

test('readiness: что не так, то и показано: шаблон, цена вне границ, нет автозакрытия, не прошёл гейт', async (t) => {
  const docs = docsOf(paidOrder(), payment(), { 'npTemplates/tpl-1': template({ fopId: 'fop-1' }), 'fops/fop-2': fopMeta({ seller: {} }) })
  docs['system/shopSales'] = sales({ skus: { 'V2-LID-R': skuRule({ minUah: 900, maxUah: 950 }), 'V2-LID-X': skuRule({ enabled: false }) } })
  const s = await stand(t, docs, { cashier: { me: async () => ({ full_name: 'К', organization: {} }) } })
  const d = (await s.get('/readiness')).data
  assert.deepEqual(d.problems, ['fopGate', 'autoCloseShift', 'npTemplate', 'items'])
  assert.deepEqual(d.sellable.card.missing, ['seller'])
  assert.deepEqual(d.npTemplate.problemTexts, ['шаблон іншого ФОП'])
  assert.deepEqual(d.items.map((i) => [i.sku, i.problem]), [['V2-LID-R', 'price-out-of-range'], ['V2-LID-X', 'no-material']])
})

test('readiness: касса и банк не отвечают или отказывают: unknown и bad, блок всё равно приходит', async (t) => {
  const s = await stand(t, docsOf(), {
    merchantDetails: async () => { throw httpErr(403) },
    cashier: { me: async () => { throw httpErr(401) }, shift: async () => { throw httpErr(500) }, register: async () => { throw httpErr(403) } },
  })
  const d = (await s.get('/readiness')).data
  assert.equal(d.monoAcquire.status, 'bad')
  assert.equal(d.checkbox.status, 'bad')
  assert.deepEqual(d.checkbox.shift, { status: 'unknown' })
  assert.deepEqual(d.checkbox.cashRegister, { status: 'bad' })
  assert.ok(d.problems.includes('checkbox'))
  assert.ok(d.problems.includes('monoAcquire'))
  const u = await stand(t, docsOf(), { cashier: { me: async () => { throw httpErr(503) } } })
  assert.equal((await u.get('/readiness')).data.checkbox.status, 'unknown')
  const noLicense = await stand(t, docsOf(paidOrder(), payment(), { 'fopSecrets/fop-2': fopSecret({ checkbox: {} }) }))
  assert.equal((await noLicense.get('/readiness')).data.checkbox.status, 'none')
})

test('readiness: зависший сервис не держит страницу', async (t) => {
  const never = () => new Promise(() => {})
  const s = await stand(t, docsOf(), { readinessBudgetMs: 10, merchantDetails: never, cashier: { me: never, shift: never, register: never } })
  const d = (await s.get('/readiness')).data
  assert.equal(d.monoAcquire.status, 'unknown')
  assert.equal(d.checkbox.status, 'unknown')
})

// ---------- чтение кассы ----------

test('checkbox: чтение для готовности: токен кассира, один повтор при 401, смену и чек не трогает', async () => {
  const fop = { id: 'fop-read', checkbox: { licenseKey: 'SECRET-lic', pinCode: 'SECRET-pin' } }
  const was = { get: axios.get, post: axios.post }
  const seen = []
  let meCalls = 0
  axios.post = async (url) => { seen.push(`POST ${url}`); return { data: { access_token: `tok-${seen.length}` } } }
  axios.get = async (url, cfg) => {
    seen.push(`GET ${url}`)
    if (url.endsWith('/cashier/me') && meCalls++ === 0) throw httpErr(401)
    return { data: { url, auth: cfg.headers.Authorization || null } }
  }
  try {
    const me = await realCheckbox.cashierMe(fop)
    assert.ok(me.url.endsWith('/api/v1/cashier/me'))
    assert.match(me.auth, /^Bearer tok-/)
    assert.deepEqual(seen.map((x) => x.replace(/https?:\/\/[^/]+/, '')), ['POST /api/v1/cashier/signinPinCode', 'GET /api/v1/cashier/me', 'POST /api/v1/cashier/signinPinCode', 'GET /api/v1/cashier/me'])
    const shift = await realCheckbox.cashierShift(fop)
    assert.ok(shift.url.endsWith('/api/v1/cashier/shift'))
    const reg = await realCheckbox.cashRegisterInfo(fop)
    assert.ok(reg.url.endsWith('/api/v1/cash-registers/info'))
    assert.equal(reg.auth, null, 'лише ключ ліцензії')
    assert.ok(!seen.some((x) => x.includes('/shifts') || x.includes('/receipts')))
    // Новый кассир: первый же запрос идёт уже с токеном.
    const fresh = await realCheckbox.cashierShift({ ...fop, id: 'fop-read-2' })
    assert.match(fresh.auth, /^Bearer tok-/)
    // Другая ошибка: входа заново нет, сбой уходит наверх.
    const before = seen.length
    axios.get = async () => { throw httpErr(500) }
    await assert.rejects(realCheckbox.cashierMe(fop), /HTTP 500/)
    assert.equal(seen.length, before)
  } finally {
    Object.assign(axios, was)
  }
})

// ---------- сверка: что добавил этот шаг ----------

test('сверка: сообщение о накладной не ушло: повтор; доставленное не повторяется; три неудачи дают алерт', async (t) => {
  const delivered = { paid: { status: 'sent', at: ago(HOUR) }, rcpt: { status: 'sent', at: ago(HOUR) } }
  const order = paidOrder({ state: 'shipped', ttn: TTN, shippedAt: ago(HOUR), npCheckedAt: ago(MIN), npFopId: 'fop-2', sms: delivered })
  const s = await stand(t, docsOf(order), { client: async () => ({ status: 'failed', error: 'x' }) })
  await s.step()
  assert.equal(s.calls.client.length, 1)
  assert.equal(s.calls.client[0].clientKey, `so-1-ttn-${TTN}`)
  assert.equal(s.order().sms[`ttn-${TTN}`].status, 'failed')
  await s.step()
  assert.equal(s.calls.client.length, 1, 'свіжа спроба')
  for (let i = 2; i <= 4; i++) {
    s.patch('shopOrders/so-1', { sms: { [`ttn-${TTN}`]: { at: ago(11 * MIN) } } })
    await s.step()
    assert.equal(s.calls.client.length, i)
  }
  await until(() => s.order().alerts[`sms-ttn-${TTN}`], 'алерт')
  assert.ok(s.order().alerts[`sms-ttn-${TTN}`].text.includes('із номером накладної'))

  const sent = await stand(t, docsOf(paidOrder({ ...order, sms: { ...delivered, [`ttn-${TTN}`]: { status: 'sent', at: ago(HOUR), tries: 1 } } })))
  await sent.step()
  assert.equal(sent.calls.client.length, 0)
  const cod = await stand(t, docsOf(paidOrder({ ...order, method: 'cod' })))
  await cod.step()
  assert.equal(cod.calls.client.length, 0, 'наложка чекає заготовку чека')
})

test('сверка: алерт о накладной на закрытом заказе не потерян, Telegram лежал: повтор и в cancelled', async (t) => {
  let down = true
  const order = paidOrder({
    state: 'cancelled', ttn: TTN, ttnOnClosed: true,
    alerts: { [`ttn-on-closed-${TTN}`]: { at: ago(10 * MIN), sentAt: null, text: 'накладна на закритому' } },
  })
  const s = await stand(t, docsOf(order), { notify: async () => !down })
  await s.step()
  assert.equal(s.calls.alerts.filter((a) => a === withGuideStep(`ttn-on-closed-${TTN}`, 'накладна на закритому')).length, 1)
  assert.equal(s.order().alerts[`ttn-on-closed-${TTN}`].sentAt, null)
  down = false
  s.patch('shopOrders/so-1', { alerts: { [`ttn-on-closed-${TTN}`]: { triedAt: ago(10 * MIN) } } })
  await s.step()
  assert.ok(s.order().alerts[`ttn-on-closed-${TTN}`].sentAt)
  const count = s.calls.alerts.length
  await s.step()
  assert.equal(s.calls.alerts.length, count, 'дійшов, більше не шлемо')
})

test('сверка: сбой чтения закрытых заказов не ломает проход', async (t) => {
  const s = await stand(t, docsOf())
  const realWhere = s.db.collection.bind(s.db)
  s.db.collection = (name) => {
    const c = realWhere(name)
    if (name !== 'shopOrders') return c
    return { ...c, where: (field, op, value) => { if (field === 'ttnOnClosed') throw new Error('база'); return c.where(field, op, value) } }
  }
  await s.step()
  assert.ok(logs.some((l) => l.includes('алерти закритих')))
})

// ---------- чистые правила ----------

test('npTemplateProblems: пустой список только у годного шаблона, цели по умолчанию годятся', () => {
  assert.deepEqual(npTemplateProblems(template(), 'fop-2'), [])
  assert.deepEqual(npTemplateProblems(template({ senderTarget: 'service', recipientTarget: 'client', serviceType: 'DoorsWarehouse' }), 'fop-2'), [])
  assert.deepEqual(npTemplateProblems(null, 'fop-2'), ['missing'])
  assert.deepEqual(npTemplateProblems(template({ active: false, scenario: 'incoming', fopId: 'x', description: '' }), 'fop-2'), ['inactive', 'scenario', 'fop', 'description'])
})

test('orderFlags: плашки гаснут вместе с причиной', () => {
  assert.deepEqual(orderFlags(paidOrder()), [])
  assert.deepEqual(orderFlags(paidOrder({ state: 'refused' })), ['refund-due'])
  assert.deepEqual(orderFlags(paidOrder({ state: 'returned' })), ['refund-due'])
  assert.deepEqual(orderFlags(paidOrder({ state: 'reversed', receipt: { status: 'failed' } })), [])
  assert.deepEqual(orderFlags(paidOrder({ receipt: { status: 'failed' } })), ['receipt-failed'])
  assert.deepEqual(orderFlags(paidOrder({ ttnError: 'unknown' })), ['ttn-unknown'])
  assert.deepEqual(orderFlags(paidOrder({ ttnCreatingAt: ago(MIN) })), [])
  assert.deepEqual(orderFlags(paidOrder({ ttnCreatingAt: ago(HOUR) })), ['ttn-unknown'])
  assert.deepEqual(orderFlags(paidOrder({ ttn: TTN, ttnError: 'unknown' })), [])
  assert.deepEqual(orderFlags(paidOrder({ state: 'reversed', ttnError: 'unknown' })), [], 'гроші повернуто: накладна вже не потрібна')
  assert.deepEqual(orderFlags(paidOrder({ state: 'cod_confirmed', method: 'cod', ttnCreatingAt: ago(HOUR) })), ['ttn-unknown'])
  assert.deepEqual(orderFlags(paidOrder({ state: 'cancelled', ttn: TTN, ttnOnClosed: true })), ['ttn-on-closed'])
  assert.deepEqual(orderFlags(paidOrder({ alerts: { 'sms-paid': { at: 'x' } } })), ['sms-failed'])
  assert.deepEqual(orderFlags(paidOrder({ alerts: { 'sms-paid': null } })), [])
  const handed = { state: 'shipped', ttn: TTN, alerts: { [`np-not-handed-${TTN}`]: { at: 'x' } } }
  assert.deepEqual(orderFlags(paidOrder({ ...handed, npDelivery: { code: '1' } })), ['not-handed'])
  assert.deepEqual(orderFlags(paidOrder({ ...handed, npDelivery: { code: '5' } })), [])
  assert.equal(orderNeedsAction(paidOrder()), true)
  assert.equal(orderNeedsAction(paidOrder({ ttn: TTN })), false)
  assert.equal(orderNeedsAction(paidOrder({ state: 'cod_confirmed', method: 'cod' })), true)
  assert.equal(orderNeedsAction(paidOrder({ state: 'shipped', ttn: TTN })), false)
})

test('validateRecipient: пустое тело и нули не проходят; middleName и почту можно очистить', () => {
  assert.deepEqual(validateRecipient(null), { ok: false, fields: ['empty'] })
  assert.deepEqual(validateRecipient({ other: 1 }), { ok: false, fields: ['empty'] })
  assert.deepEqual(validateRecipient({ middleName: '', email: '' }), { ok: true, value: { middleName: '', email: '' } })
  assert.deepEqual(validateRecipient({ cityRef: CITY, warehouseRef: WAREHOUSE }).fields, ['cityName', 'warehouseName'])
})

test('transitionPatch: note попадает в строку истории, без него строка прежняя', () => {
  const o = { state: 'paid', method: 'card', history: [] }
  assert.deepEqual(transitionPatch(o, 'shipped', { at: 'x', by: 'y', note: 'attach' }).history[0], { at: 'x', from: 'paid', to: 'shipped', by: 'y', note: 'attach' })
  assert.deepEqual(transitionPatch(o, 'shipped', { at: 'x', by: 'y' }).history[0], { at: 'x', from: 'paid', to: 'shipped', by: 'y' })
})

// ---------- подключение ----------

test('index.js: маршруты до json-server, с настоящими зависимостями', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const register = src.indexOf('registerShopAdmin(app, { adminDb, hooks: shopHooks, payments: paymentsApi, npRequest, sendSms, verifyStaff: verifyFirebaseStaff, siteUrl: SITE_URL })')
  assert.ok(register > 0)
  assert.ok(register < src.indexOf('jsonServer.router('))
  assert.ok(src.indexOf('const shopHooks = createShopPaymentHooks(') < register)
  assert.ok(src.indexOf('const npRequest = ') < register)
  assert.ok(src.indexOf('const sendSms = ') < register)
})
