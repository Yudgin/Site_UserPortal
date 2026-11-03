// node --test: заказ магазина картой (server/shopOrders.js): создание, счёт, статус, новый счёт, отмена. Без сети и Firestore:
// настоящие payments.js, хуки shopPayments.js и loadFopFresh поверх фейковой базы, банк, касса, Новая Почта и Telegram подменены.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'

// payments.js и fops.js читают окружение при импорте и при регистрации, поэтому задаём его до импорта.
process.env.PAYMENTS_RECONCILE = 'false'
process.env.SHOP_CALLBACK_BASE_URL = 'https://portal.test'
for (const k of ['PUBLIC_BASE_URL', 'FOPS_CONFIG', 'OWNER_TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']) delete process.env[k]
const { registerPayments } = await import('./payments.js')
const { registerShopOrders } = await import('./shopOrders.js')
const { createShopPaymentHooks, KYIV_DAY } = await import('./shopPayments.js')
const realCheckbox = await import('./checkbox.js')

// Журнал сервера на весь файл идёт в этот список: часть проверок читает именно его.
const logs = []
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => logs.push(args.map(String).join(' '))

const TOKEN = 'shop-test-token-0123456789'
const CITY = '8d5a980d-391c-11dd-90d9-001a92567626'
const CITY2 = '8d5a980d-391c-11dd-90d9-001a92567627'
const WH = '1ec09d88-e1c2-11e3-8c4a-0050568002cf'
const WH2 = '7b422fc5-e1b8-11e3-8c4a-0050568002cf'
const POSTOMAT = '9a68df70-0267-11e6-b3ec-005056887b8d'
const POSTOMAT_TYPE = '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc'
const BASE = '/api/shop/orders'
const PHONE = '+380671234567'
const BANK_PAID = { status: 'success', amount: 80000, ccy: 980, finalAmount: 80000 }

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const SEC = 1000
const MIN = 60 * SEC

// ---------- фейковый Firestore: транзакции по очереди и с записью в конце, как настоящая изоляция ----------

const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) { this.docs = clone(seed); this.reads = []; this.writes = []; this.failRead = null; this.txQueue = Promise.resolve() }
  read(path) {
    this.reads.push(path)
    if (this.failRead && this.failRead(path)) throw new Error(`база: ${path} не читається`)
  }
  write(path, v, opts) {
    this.writes.push(path)
    if (opts && opts.merge && this.docs[path]) deepMerge(this.docs[path], v)
    else this.docs[path] = clone(v)
  }
  collection(name) {
    const db = this
    const query = (match, max = Infinity, after = null) => ({
      limit: (n) => query(match, n, after),
      startAfter: (doc) => query(match, max, doc.id),
      async get() {
        db.read(name)
        const docs = Object.entries(db.docs)
          .filter(([path, d]) => path.startsWith(`${name}/`) && match(d))
          .map(([path, d]) => ({ id: path.slice(name.length + 1), data: () => clone(d) }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((d) => after === null || d.id > after)
          .slice(0, max)
        return { docs, empty: !docs.length, size: docs.length }
      },
    })
    return {
      doc(id) {
        if (typeof id !== 'string' || !id) throw new Error('Firestore: document id must be a non-empty string')
        const path = `${name}/${id}`
        return {
          id, path,
          async get() { db.read(path); const d = db.docs[path]; return { id, exists: d !== undefined, data: () => clone(d) } },
          async set(v, opts) { db.write(path, v, opts) },
        }
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`fake where: ${op}`)
        return query((d) => d[field] === value)
      },
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

const seller = () => ({ displayName: 'Продавець', ipn: '1234567890', address: 'Адреса реєстрації', actualAddress: 'Фактична адреса', email: 'shop@example.com', phone: '+380670000001' })
const publicSeller = { name: 'Продавець', ipn: '1234567890', address: 'Адреса реєстрації', email: 'shop@example.com', phone: '+380670000001' }
const fopMeta = (over = {}) => ({
  name: 'ФОП', active: true, methods: { monoAcquire: true, cod: true }, seller: seller(),
  novaPoshta: { senderRef: 's', contactRef: 'c', senderPhone: '380670000001', cityRef: 'k', warehouseRef: 'w' }, ...over,
})
const fopSecret = (over = {}) => ({ monoAcquire: { token: 'SECRET-mono' }, checkbox: { licenseKey: 'SECRET-lic', pinCode: 'SECRET-pin' }, novaPoshta: { apiKey: 'SECRET-np' }, ...over })
const rule = (over = {}) => ({ enabled: true, inStock: true, stock: null, minUah: 600, maxUah: 1200, ...over })
const material = (code = 'V2-LID-R', over = {}) => ({
  id: `m-${code}`, code, active: true, price: 800, name: { uk: `Кришка ${code}` }, site: { status: 'published', slug: `slug-${code.toLowerCase()}` }, ...over,
})
const sales = (over = {}) => ({
  mode: 'live', methods: { card: true, cod: false }, fopId: 'fop-2', offerVersion: '2026-11-03', siteBaseUrl: 'https://runferry.test',
  codKind: 'control', codReceiptMode: 'ettn', skus: { 'V2-LID-R': rule(), 'V2-LID-H': rule() }, ...over,
})
const shopDocs = ({ cfg = sales(), materials = [material(), material('V2-LID-H')], meta = fopMeta(), secret = fopSecret() } = {}) => ({
  ...(cfg ? { 'system/shopSales': cfg } : {}),
  ...(materials ? { 'priceList/current': { materials } } : {}),
  ...(meta ? { 'fops/fop-2': meta } : {}),
  ...(secret ? { 'fopSecrets/fop-2': secret } : {}),
})

let keyNo = 0
const newKey = () => `key-${String(++keyNo).padStart(16, '0')}`
const orderBody = (over = {}) => ({
  idempotencyKey: newKey(), sku: 'V2-LID-R', qty: 1, method: 'card',
  lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', phone: PHONE, email: 'taras@example.com',
  cityRef: CITY, cityName: 'Київ', warehouseRef: WH, warehouseName: 'Відділення №1',
  offerVersion: '2026-11-03', consentOffer: true, consentPersonalData: true, expectedTotalUah: 800,
  ...over,
})
const npWarehouses = (...extra) => async () => ({
  success: true,
  data: [
    { Ref: WH, Description: 'Відділення №1', TypeOfWarehouse: 'x' },
    { Ref: WH2, Description: 'Відділення №2', TypeOfWarehouse: 'x' },
    { Ref: POSTOMAT, Description: 'Поштомат №7', TypeOfWarehouse: POSTOMAT_TYPE },
    ...extra,
  ],
})

// ---------- стенд ----------

const makeBank = () => {
  const bank = { created: [], removed: [], statusCalls: [], statuses: {}, onCreate: null, onStatus: null, onRemove: null }
  bank.mono = {
    createInvoice: async (fop, args) => {
      const n = bank.created.length + 1
      bank.created.push({ fopId: fop.id, ...args })
      if (bank.onCreate) await bank.onCreate(n, args)
      return { invoiceId: `inv-${n}`, pageUrl: `https://pay.test/page-${n}` }
    },
    invoiceStatus: async (_fop, id) => {
      bank.statusCalls.push(id)
      if (bank.onStatus) await bank.onStatus(id)
      return { invoiceId: id, status: 'created', ...bank.statuses[id] }
    },
    removeInvoice: async (_fop, id) => {
      bank.removed.push(id)
      if (bank.onRemove) await bank.onRemove(id)
      return {}
    },
    verifyWebhook: async () => true,
  }
  return bank
}

const stand = async (t, { docs = shopDocs(), db = new FakeDb(docs), np = npWarehouses(), notify = async () => true, sell, addressBudgetMs, bankReadBudgetMs, token = TOKEN } = {}) => {
  const bank = makeBank()
  const calls = { np: [], alerts: [], sells: [] }
  const cbx = {
    ...realCheckbox,
    sellReceipt: async (fop, args) => {
      calls.sells.push({ fopId: fop.id, ...args })
      if (sell) return sell(fop, args)
      return { receiptId: `rcpt-${calls.sells.length}`, fiscalCode: 'FC-1', taxUrl: 'https://check.test/1', status: 'DONE' }
    },
  }
  const was = process.env.SHOP_SITE_TOKEN
  if (token) process.env.SHOP_SITE_TOKEN = token
  else delete process.env.SHOP_SITE_TOKEN
  const app = express()
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
  const api = registerPayments(app, { adminDb: db, mono: bank.mono, cbx })
  const hooks = createShopPaymentHooks({
    adminDb: db,
    payments: { ...api, notifyOwner: async (text) => { calls.alerts.push(text); return notify(text) } },
    mono: bank.mono,
    siteUrl: 'https://portal.test',
  })
  api.setShopHooks(hooks)
  registerShopOrders(app, {
    adminDb: db, hooks, payments: api, mono: bank.mono, siteUrl: 'https://portal.test', addressBudgetMs, bankReadBudgetMs,
    npRequest: async (...args) => { calls.np.push(args); return np(...args) },
  })
  if (was === undefined) delete process.env.SHOP_SITE_TOKEN
  else process.env.SHOP_SITE_TOKEN = was
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  t.after(() => srv.close())
  const url = (path) => `http://127.0.0.1:${srv.address().port}${path}`
  const call = async (method, path, { body, headers = { 'x-shop-token': TOKEN } } = {}) => {
    const r = await fetch(url(path), {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    assert.match(r.headers.get('content-type') || '', /^application\/json/, `${method} ${path}: ${text}`)
    assert.ok(!text.includes('<'), `${method} ${path}: ${text}`)
    return { status: r.status, text, json: JSON.parse(text) }
  }
  const s = {
    db, bank, calls, call, api,
    create: (over = {}) => call('POST', BASE, { body: orderBody(over) }),
    status: (token_) => call('GET', `${BASE}/${token_}`),
    pay: (token_) => call('POST', `${BASE}/${token_}/pay`),
    cancel: (token_) => call('POST', `${BASE}/${token_}/cancel`),
    webhook: (invoiceId) => fetch(url('/api/mono/acquire/callback'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-sign': 'x' }, body: JSON.stringify({ invoiceId, status: 'success' }) }),
    order: (token_) => Object.entries(db.docs).filter(([p, d]) => p.startsWith('shopOrders/') && d.statusToken === token_).map(([path, d]) => ({ path, id: path.slice('shopOrders/'.length), ...clone(d) }))[0],
    orders: () => Object.entries(db.docs).filter(([p]) => p.startsWith('shopOrders/')).map(([, d]) => clone(d)),
    payments: () => Object.entries(db.docs).filter(([p]) => p.startsWith('payments/')).map(([, d]) => clone(d)),
    paymentOf: (order) => clone(db.docs[`payments/${order.payment.paymentId}`]),
    patchOrder(token_, patch) { deepMerge(db.docs[s.order(token_).path], patch) },
    cfg: (patch) => deepMerge(db.docs['system/shopSales'], patch),
    /** Создать заказ и получить его токен: проверка, что заказ действительно создан, уже здесь. */
    async created(over) {
      const r = await s.create(over)
      assert.equal(r.status, 201, r.text)
      return r.json.data
    },
  }
  return s
}

const until = async (fn, what = 'умова') => {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > 2000) throw new Error(`не дочекались: ${what}`)
    await sleep(2)
  }
}
const settle = () => sleep(30)
const errorOf = (r) => r.json.error.code
const today = () => KYIV_DAY.format(new Date())
const held = () => { let release; const gate = new Promise((ok) => { release = ok }); return { gate, release } }
// Держит запросы на проверке отделения, пока не придут все: иначе фейковая база отвечает так быстро, что запросы идут один за другим.
const npTogether = (n) => {
  let arrived = 0
  const all = held()
  const list = npWarehouses()
  return async (...args) => {
    arrived += 1
    if (arrived >= n) all.release()
    await all.gate
    return list(...args)
  }
}

// Банк отвечает «оплачено», страница статуса это замечает: поведение покупателя, вернувшегося с банка.
const payViaStatus = async (s, token) => {
  const order = s.order(token)
  s.bank.statuses[order.payment.invoiceId] = BANK_PAID
  s.patchOrder(token, { payment: { lastBankCheckAt: null } })
  assert.equal((await s.status(token)).status, 200)
  await until(() => s.order(token).state === 'paid', 'заказ оплачен')
}
// Счёт уже конечен у банка и в payments: так выглядит заказ, для которого доступен новый счёт.
const expireInvoice = async (s, token, status = 'expired') => {
  const order = s.order(token)
  s.bank.statuses[order.payment.invoiceId] = { status }
  s.patchOrder(token, { payment: { lastBankCheckAt: null } })
  await s.status(token)
  await until(() => s.paymentOf(s.order(token)).status === status, 'счёт закрыт')
}

// ---------- создание: счастливый путь ----------

test('создание: 201, токен, номер и переход на банк; заказ с данными покупателя и счёт с суммой из прайса', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const r = await s.call('POST', BASE, { body })
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.success, true)
  const { token, orderNo, state, next, ...rest } = r.json.data
  assert.deepEqual(rest, {})
  assert.match(token, /^[A-Za-z0-9_-]{22}$/)
  assert.match(orderNo, /^RF-[2-9A-HJ-NP-Z]{6}$/)
  assert.equal(state, 'awaiting_payment')
  assert.deepEqual(next, { type: 'redirect', url: 'https://pay.test/page-1' })

  const o = s.order(token)
  assert.match(o.id, /^so-[0-9a-f]{32}$/)
  assert.equal(o.orderNo, orderNo)
  assert.equal(o.idempotencyKey, body.idempotencyKey)
  assert.match(o.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(o.method, 'card')
  assert.equal(o.sku, 'V2-LID-R')
  assert.equal(o.titleUk, 'Кришка V2-LID-R')
  assert.equal(o.qty, 1)
  assert.equal(o.total, 800)
  assert.equal(o.fopId, 'fop-2')
  assert.equal(o.offerVersion, '2026-11-03')
  assert.deepEqual(o.seller, publicSeller)
  assert.equal(o.consent.offerVersion, '2026-11-03')
  assert.equal(o.consent.personalData, true)
  assert.ok(!Number.isNaN(Date.parse(o.consent.acceptedAt)))
  assert.equal(o.clientName, 'Шевченко Тарас Григорович')
  assert.equal(o.clientPhone, PHONE)
  assert.equal(o.email, 'taras@example.com')
  assert.equal(o.clientCityRef, CITY)
  assert.equal(o.clientWarehouseRef, WH)
  assert.equal(o.clientWarehouseName, 'Відділення №1')
  assert.equal(o.addressVerified, true)
  assert.equal(o.payAttempts, 1)
  assert.equal(o.payment.invoiceId, 'inv-1')
  assert.equal(o.payment.pageUrl, 'https://pay.test/page-1')
  assert.equal(o.payment.status, 'created')
  assert.equal(o.payment.initiatedAt, null)
  assert.deepEqual(o.paymentIds, [o.payment.paymentId])
  assert.equal(Date.parse(o.payment.expiresAt) - Date.parse(o.payment.createdAt), 3600 * SEC)
  assert.deepEqual(o.history.map((h) => [h.from, h.to, h.by]), [[null, 'awaiting_payment', 'site']])
  assert.ok(!Number.isNaN(Date.parse(o.createdAt)))

  const p = s.paymentOf(o)
  assert.equal(p.shopOrderId, o.id)
  assert.equal(p.amount, 800)
  assert.equal(p.fopId, 'fop-2')
  assert.equal(p.status, 'pending')
  assert.equal(p.provider, 'mono-acquire')
  assert.equal(p.providerOrderId, 'inv-1')
  assert.deepEqual(p.goods, [{ name: 'Кришка V2-LID-R', price: 800, qty: 1, code: 'V2-LID-R' }])

  assert.equal(s.bank.created.length, 1)
  const inv = s.bank.created[0]
  assert.equal(inv.amountKop, 80000)
  assert.equal(inv.reference, p.orderId)
  assert.equal(inv.fopId, 'fop-2')
  assert.equal(inv.validitySec, 3600)
  assert.equal(inv.redirectUrl, `https://runferry.test/uk/order/${token}`)
  assert.equal(inv.webHookUrl, 'https://portal.test/api/mono/acquire/callback')
  assert.equal(inv.destination, `Замовлення ${orderNo}`)
  assert.deepEqual(inv.goods.map((g) => [g.name, g.qty, g.sumKop, g.code]), [['Кришка V2-LID-R', 1, 80000, 'V2-LID-R']])
})

test('создание: цена, ФОП, адрес возврата, подпись и язык из тела ни на что не влияют', async (t) => {
  const s = await stand(t)
  const d = await s.created({
    price: 1, priceUah: 1, total: 1, amount: 1, fopId: 'other', fop: 'other', resultUrl: 'https://evil.test', redirectUrl: 'https://evil.test',
    paymentLabel: 'зламано', lang: 'en', goods: [{ name: 'x', price: 1, qty: 1 }], siteBaseUrl: 'https://evil.test', statusToken: 'A'.repeat(22),
    state: 'paid', paidAt: 'now', webHookBase: 'https://evil.test', validitySec: 99999,
  })
  const o = s.order(d.token)
  assert.equal(o.total, 800)
  assert.equal(o.fopId, 'fop-2')
  assert.equal(o.state, 'awaiting_payment')
  assert.notEqual(d.token, 'A'.repeat(22))
  assert.equal(o.paidAt, undefined)
  const inv = s.bank.created[0]
  assert.equal(inv.amountKop, 80000)
  assert.equal(inv.redirectUrl, `https://runferry.test/uk/order/${d.token}`)
  assert.equal(inv.webHookUrl, 'https://portal.test/api/mono/acquire/callback')
  assert.equal(inv.validitySec, 3600)
  assert.equal(s.paymentOf(o).paymentLabel, 'Інтернет еквайринг')
})

test('создание: подпись оплаты из настроек или умолчание, косая черта на конце адреса сайта не удваивается', async (t) => {
  const s = await stand(t, { docs: shopDocs({ cfg: sales({ cardReceiptLabel: ' Своя підпис ', siteBaseUrl: 'https://runferry.test//' }) }) })
  const d = await s.created()
  assert.equal(s.paymentOf(s.order(d.token)).paymentLabel, 'Своя підпис')
  assert.equal(s.bank.created[0].redirectUrl, `https://runferry.test/uk/order/${d.token}`)
  s.cfg({ cardReceiptLabel: '   ' })
  const d2 = await s.created({ sku: 'V2-LID-H' })
  assert.equal(s.paymentOf(s.order(d2.token)).paymentLabel, 'Інтернет еквайринг')
})

test('создание: персональных данных и токена нет ни в счёте, ни в оплате', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const payment = JSON.stringify(s.paymentOf(s.order(d.token)))
  for (const secret of ['Шевченко', 'Тарас', '380671234567', 'taras@example.com', d.token, CITY, WH]) assert.ok(!payment.includes(secret), secret)
  assert.ok(!JSON.stringify(s.bank.created[0]).includes('taras@example.com'))
  assert.ok(!JSON.stringify(s.bank.created[0]).includes('Шевченко'))
})

test('создание: счётчик дня и занятая пара телефон + артикул пишутся вместе с заказом', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const o = s.order(d.token)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 1)
  assert.equal(s.db.docs[`shopPhones/${o.phoneKey}`].openCard['V2-LID-R'], o.id)
  assert.match(o.phoneKey, /^[0-9a-f]{64}$/)
  assert.notEqual(o.phoneKey, PHONE)
})

// ---------- создание: вход ----------

test('вход: неверные поля: 400 BAD_INPUT со списком, ни чтений настроек, ни записи, ни банка', async (t) => {
  const s = await stand(t)
  const bad = {
    idempotencyKey: 'short', sku: 'нет', qty: 2, method: 'bank', lastName: 'Smith', firstName: 'A', middleName: '1', phone: '123',
    email: 'not-email', cityRef: 'x', cityName: '', warehouseRef: 'x', warehouseName: '', offerVersion: '', consentOffer: false, consentPersonalData: 'true', expectedTotalUah: '800',
  }
  for (const [field, value] of Object.entries(bad)) {
    const r = await s.create({ [field]: value })
    assert.equal(r.status, 400, field)
    assert.equal(errorOf(r), 'BAD_INPUT')
    assert.deepEqual(r.json.error.fields, [field])
  }
  assert.deepEqual(s.db.writes, [])
  assert.deepEqual(s.db.reads, [])
  assert.deepEqual(s.bank.created, [])
  const empty = await s.call('POST', BASE, { body: {} })
  assert.equal(empty.status, 400)
  assert.ok(empty.json.error.fields.includes('idempotencyKey'))
})

// ---------- создание: продажи, артикул, цена ----------

const assertNothingCreated = (s) => {
  assert.deepEqual(s.orders(), [])
  assert.deepEqual(s.payments(), [])
  assert.deepEqual(s.bank.created, [])
  assert.deepEqual(s.db.writes.filter((p) => p.startsWith('shopPhones/') || p.startsWith('shopOrders/')), [])
  assert.equal(s.db.docs[`shopDaily/${today()}`], undefined)
}

test('продажи: документа нет, off, prices или неизвестный режим: 409 SALES_OFF, ничего не создано', async (t) => {
  const configs = [null, sales({ mode: 'off' }), sales({ mode: 'prices' }), sales({ mode: 'LIVE' }), sales({ mode: undefined })]
  for (const cfg of configs) {
    const s = await stand(t, { docs: shopDocs({ cfg }) })
    const r = await s.create()
    assert.equal(r.status, 409, JSON.stringify(cfg))
    assert.equal(errorOf(r), 'SALES_OFF')
    assertNothingCreated(s)
  }
})

test('продажи: hidden и live принимают заказ', async (t) => {
  for (const mode of ['hidden', 'live']) {
    const s = await stand(t, { docs: shopDocs({ cfg: sales({ mode }) }) })
    assert.equal((await s.create()).status, 201, mode)
  }
})

test('артикул: нет в настройках, выключен, нет в наличии, пустой склад: 409 NOT_FOR_SALE', async (t) => {
  const skus = [
    {},
    { 'V2-LID-R': rule({ enabled: false }) },
    { 'V2-LID-R': rule({ enabled: 'true' }) },
    { 'V2-LID-R': rule({ inStock: false }) },
    { 'V2-LID-R': rule({ stock: 0 }) },
  ]
  for (const list of skus) {
    const s = await stand(t, { docs: shopDocs({ cfg: { ...sales(), skus: list } }) })
    const r = await s.create()
    assert.equal(r.status, 409, JSON.stringify(list))
    assert.equal(errorOf(r), 'NOT_FOR_SALE')
    assertNothingCreated(s)
  }
})

test('прайс: неактивная позиция, карточка не опубликована, дубль кода, нет позиции, цена вне границ: 409 NOT_FOR_SALE', async (t) => {
  const lists = {
    'неактивна': [material('V2-LID-R', { active: false })],
    'не опублікована': [material('V2-LID-R', { site: { status: 'draft', slug: 'x' } })],
    'дубль коду': [material(), material('V2-LID-R', { id: 'm-copy' })],
    'немає позиції': [material('V2-LID-H')],
    'порожній прайс': [],
    'нижче межі': [material('V2-LID-R', { price: 599 })],
    'вище межі': [material('V2-LID-R', { price: 1201 })],
    'ціна нуль': [material('V2-LID-R', { price: 0 })],
    'ціна рядком': [material('V2-LID-R', { price: '800' })],
  }
  for (const [name, materials] of Object.entries(lists)) {
    const s = await stand(t, { docs: shopDocs({ materials }) })
    const r = await s.create({ expectedTotalUah: 800 })
    assert.equal(r.status, 409, name)
    assert.equal(errorOf(r), 'NOT_FOR_SALE', name)
    assertNothingCreated(s)
  }
  const none = await stand(t, { docs: shopDocs({ materials: null }) })
  assert.equal(errorOf(await none.create()), 'NOT_FOR_SALE')
})

test('цена на границах: принимается', async (t) => {
  for (const price of [600, 1200]) {
    const s = await stand(t, { docs: shopDocs({ materials: [material('V2-LID-R', { price })] }) })
    assert.equal((await s.create({ expectedTotalUah: price })).status, 201, String(price))
  }
})

test('PRICE_CHANGED: заказ не создаётся, в ответе новая цена; с новой ценой тот же ключ проходит', async (t) => {
  const s = await stand(t, { docs: shopDocs({ materials: [material('V2-LID-R', { price: 900 })] }) })
  const body = orderBody({ expectedTotalUah: 800 })
  const r = await s.call('POST', BASE, { body })
  assert.equal(r.status, 409)
  assert.equal(errorOf(r), 'PRICE_CHANGED')
  assert.equal(r.json.error.priceUah, 900)
  assertNothingCreated(s)
  const again = await s.call('POST', BASE, { body: { ...body, expectedTotalUah: 900 } })
  assert.equal(again.status, 201, again.text)
  assert.equal(s.order(again.json.data.token).total, 900)
  assert.equal(s.bank.created[0].amountKop, 90000)
})

test('PRICE_CHANGED: копейки различаются, сумма счёта всегда из прайса', async (t) => {
  const s = await stand(t, { docs: shopDocs({ materials: [material('V2-LID-R', { price: 800.4 })] }) })
  assert.equal(errorOf(await s.create({ expectedTotalUah: 800 })), 'PRICE_CHANGED')
  const r = await s.create({ expectedTotalUah: 800.4 })
  assert.equal(r.status, 201, r.text)
  assert.equal(s.bank.created[0].amountKop, 80040)
})

test('OFFER_CHANGED: заказ не создаётся, в ответе действующая редакция', async (t) => {
  const s = await stand(t)
  const r = await s.create({ offerVersion: '2026-01-01' })
  assert.equal(r.status, 409)
  assert.equal(errorOf(r), 'OFFER_CHANGED')
  assert.equal(r.json.error.offerVersion, '2026-11-03')
  assertNothingCreated(s)
  const empty = await stand(t, { docs: shopDocs({ cfg: sales({ offerVersion: '' }) }) })
  assert.equal(errorOf(await empty.create()), 'OFFER_CHANGED')
})

// ---------- создание: способ и гейт ----------

test('способ: выключен в настройках или снята галочка у ФОП: 409 METHOD_OFF; наложка до второй волны тоже', async (t) => {
  const off = await stand(t, { docs: shopDocs({ cfg: sales({ methods: { card: false, cod: true } }) }) })
  assert.equal(errorOf(await off.create()), 'METHOD_OFF')
  assertNothingCreated(off)
  const missing = await stand(t, { docs: shopDocs({ cfg: { ...sales(), methods: undefined } }) })
  assert.equal(errorOf(await missing.create()), 'METHOD_OFF')
  const fop = await stand(t, { docs: shopDocs({ meta: fopMeta({ methods: { monoAcquire: false } }) }) })
  const r = await fop.create()
  assert.equal(r.status, 409)
  assert.equal(errorOf(r), 'METHOD_OFF')
  assertNothingCreated(fop)
  const fopAbsent = await stand(t, { docs: shopDocs({ meta: fopMeta({ methods: {} }) }) })
  assert.equal(errorOf(await fopAbsent.create()), 'METHOD_OFF')
  const cod = await stand(t, { docs: shopDocs({ cfg: sales({ methods: { card: true, cod: true } }) }) })
  const c = await cod.create({ method: 'cod' })
  assert.equal(c.status, 409)
  assert.equal(errorOf(c), 'METHOD_OFF')
  assertNothingCreated(cod)
})

test('гейт ФОП: не готов: 503 NOT_CONFIGURED, заказа и счёта нет, ФОП читается без кэша, причин наружу нет', async (t) => {
  const cases = {
    'немає в налаштуваннях': shopDocs({ cfg: sales({ fopId: '' }) }),
    'немає документа': shopDocs({ cfg: sales({ fopId: 'nobody' }) }),
    'неактивний': shopDocs({ meta: fopMeta({ active: false }) }),
    'без продавця': shopDocs({ meta: fopMeta({ seller: undefined }) }),
    'без токена банку': shopDocs({ secret: fopSecret({ monoAcquire: {} }) }),
    'без каси': shopDocs({ secret: fopSecret({ checkbox: {} }) }),
    'без касира': shopDocs({ secret: fopSecret({ checkbox: { licenseKey: 'x' } }) }),
    'без ключа НП': shopDocs({ secret: fopSecret({ novaPoshta: {} }) }),
    'без рефів НП': shopDocs({ meta: fopMeta({ novaPoshta: {} }) }),
    'без адреси сайту': shopDocs({ cfg: sales({ siteBaseUrl: '' }) }),
    'адреса сайту не https': shopDocs({ cfg: sales({ siteBaseUrl: 'http://runferry.test' }) }),
    'адреса сайту не рядок': shopDocs({ cfg: sales({ siteBaseUrl: 1 }) }),
  }
  for (const [name, docs] of Object.entries(cases)) {
    const s = await stand(t, { docs })
    const r = await s.create()
    assert.equal(r.status, 503, name)
    assert.equal(errorOf(r), 'NOT_CONFIGURED', name)
    assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'message'], name)
    assertNothingCreated(s)
  }
})

test('гейт ФОП: без адреса вебхука карта закрыта: иначе счёт ушёл бы без колбэка', async (t) => {
  const was = process.env.SHOP_CALLBACK_BASE_URL
  delete process.env.SHOP_CALLBACK_BASE_URL
  t.after(() => { process.env.SHOP_CALLBACK_BASE_URL = was })
  const s = await stand(t)
  assert.equal(errorOf(await s.create()), 'NOT_CONFIGURED')
  assertNothingCreated(s)
})

test('гейт ФОП: счёт создаётся с тем же ФОП, что прошёл гейт, и ключом из свежего документа', async (t) => {
  const s = await stand(t)
  let seenToken = null
  s.bank.mono.createInvoice = async (fop, args) => {
    seenToken = fop.monoAcquire.token
    s.bank.created.push({ fopId: fop.id, ...args })
    return { invoiceId: 'inv-1', pageUrl: 'https://pay.test/page-1' }
  }
  await s.created()
  assert.equal(seenToken, 'SECRET-mono')
  assert.ok(s.db.reads.includes('fopSecrets/fop-2'))
})

// ---------- создание: отделение ----------

test('отделение: чужое или поштомат: 422 BAD_WAREHOUSE; запрос к НП по городу заказа', async (t) => {
  const s = await stand(t)
  for (const warehouseRef of [POSTOMAT, 'aaaaaaaa-0000-0000-0000-000000000000']) {
    const r = await s.create({ warehouseRef })
    assert.equal(r.status, 422, warehouseRef)
    assert.equal(errorOf(r), 'BAD_WAREHOUSE')
  }
  assertNothingCreated(s)
  assert.equal(s.calls.np.length, 2)
  const [model, method, props] = s.calls.np[0]
  assert.deepEqual([model, method, props.CityRef], ['Address', 'getWarehouses', CITY])
})

test('отделение: в городе нет отделений: 422; регистр рефа приводится', async (t) => {
  const none = await stand(t, { np: async () => ({ success: true, data: [] }) })
  assert.equal((await none.create()).status, 422)
  const s = await stand(t)
  const d = await s.created({ warehouseRef: WH.toUpperCase(), cityRef: CITY.toUpperCase() })
  assert.equal(s.order(d.token).clientWarehouseRef, WH)
  assert.equal(s.order(d.token).addressVerified, true)
})

test('отделение: НП недоступна, отвечает неуспехом или не укладывается в бюджет: заказ создан, addressVerified:false', async (t) => {
  const answers = {
    'помилка': async () => { throw new Error('мережа') },
    'неуспіх': async () => ({ success: false, data: [], errors: ['x'] }),
    'не масив': async () => ({ success: true, data: null }),
    'повільна': () => new Promise(() => {}),
  }
  for (const [name, np] of Object.entries(answers)) {
    const s = await stand(t, { np, addressBudgetMs: 10 })
    const started = Date.now()
    const d = await s.created({ warehouseRef: POSTOMAT })
    assert.ok(Date.now() - started < 1500, `${name}: свой бюджет короче общего для поиска НП`)
    assert.equal(s.order(d.token).addressVerified, false, name)
    assert.equal(d.next.type, 'redirect', name)
  }
})

test('бюджет: проверка отделения и чтение статуса вместе со счётом укладываются в 25 с сайта', () => {
  const src = readFileSync(new URL('./shopOrders.js', import.meta.url), 'utf8')
  const budget = (name) => Number(src.match(new RegExp(`const ${name} = (\\d+)`))[1])
  const mono = readFileSync(new URL('./monoAcquire.js', import.meta.url), 'utf8')
  const invoiceMs = Number(mono.match(/invoice\/create[\s\S]*?timeout: (\d+)/)[1])
  assert.ok(budget('ADDRESS_BUDGET_MS') + invoiceMs < 25000)
  assert.ok(budget('BANK_READ_BUDGET_MS') + invoiceMs < 25000)
})

// ---------- идемпотентность и отпечаток ----------

test('идемпотентность: тот же ключ и те же данные: 200, тот же заказ и тот же счёт', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const first = await s.call('POST', BASE, { body })
  assert.equal(first.status, 201)
  const second = await s.call('POST', BASE, { body })
  assert.equal(second.status, 200, second.text)
  assert.deepEqual(second.json.data, first.json.data)
  assert.equal(s.orders().length, 1)
  assert.equal(s.payments().length, 1)
  assert.equal(s.bank.created.length, 1)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 1)
  assert.deepEqual(s.bank.removed, [])
})

test('идемпотентность: ключ работает и когда цена и редакция оферты уже другие: заказ не пересчитывается', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const first = await s.call('POST', BASE, { body })
  s.db.docs['priceList/current'].materials[0].price = 900
  s.cfg({ offerVersion: '2099-01-01' })
  const second = await s.call('POST', BASE, { body })
  assert.equal(second.status, 200)
  assert.deepEqual(second.json.data, first.json.data)
  const changed = await s.call('POST', BASE, { body: { ...body, expectedTotalUah: 123, offerVersion: 'x' } })
  assert.equal(changed.status, 200, 'ни ожидаемая цена, ни редакция не входят в отпечаток')
  assert.equal(s.order(first.json.data.token).total, 800)
})

test('отпечаток: другой набор данных с тем же ключом: 409 IDEMPOTENCY_CONFLICT, заказ не меняется', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const first = await s.call('POST', BASE, { body })
  const before = s.order(first.json.data.token)
  const changes = {
    sku: 'V2-LID-H', lastName: 'Франко', firstName: 'Іван', middleName: 'Якович', phone: '+380671234568', email: 'other@example.com', cityRef: CITY2, warehouseRef: WH2,
  }
  for (const [field, value] of Object.entries(changes)) {
    const r = await s.call('POST', BASE, { body: { ...body, [field]: value } })
    assert.equal(r.status, 409, field)
    assert.equal(errorOf(r), 'IDEMPOTENCY_CONFLICT', field)
    assert.ok(!r.text.includes(first.json.data.token), 'чужой токен не выдаётся')
  }
  const cleared = await s.call('POST', BASE, { body: { ...body, middleName: '' } })
  assert.equal(errorOf(cleared), 'IDEMPOTENCY_CONFLICT')
  assert.deepEqual(s.order(first.json.data.token), before)
  assert.equal(s.bank.created.length, 1)
})

test('отпечаток: разная запись телефона, почты и рефов это те же данные', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  await s.call('POST', BASE, { body })
  const same = { ...body, phone: '0671234567', email: 'TARAS@example.com', cityRef: CITY.toUpperCase(), warehouseRef: ` ${WH} `, cityName: 'Київ інакше', warehouseName: 'інакше' }
  const r = await s.call('POST', BASE, { body: same })
  assert.equal(r.status, 200, r.text)
  assert.equal(s.orders().length, 1)
})

test('параллельные запросы с одним ключом: один заказ, один счёт, один 201; не получившие ссылку идут на статус', async (t) => {
  const s = await stand(t, { np: npTogether(6) })
  const body = orderBody()
  const rs = await Promise.all(Array.from({ length: 6 }, () => s.call('POST', BASE, { body })))
  assert.equal(s.calls.np.length, 6, 'все прошли первую проверку ключа до транзакции')
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201])
  assert.equal(s.orders().length, 1)
  assert.equal(s.payments().length, 1)
  assert.equal(s.bank.created.length, 1)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 1)
  const token = rs[0].json.data.token
  assert.ok(rs.every((r) => r.json.data.token === token))
  assert.deepEqual(rs.find((r) => r.status === 201).json.data.next, { type: 'redirect', url: 'https://pay.test/page-1' })
  for (const r of rs.filter((x) => x.status === 200)) assert.ok(r.json.data.next.type === 'status' || r.json.data.next.url === 'https://pay.test/page-1', r.text)
  assert.deepEqual((await s.call('POST', BASE, { body })).json.data.next, { type: 'redirect', url: 'https://pay.test/page-1' })
})

test('параллельные запросы с одним ключом и разными данными: заказ один, проигравшему 409, чужого токена он не видит', async (t) => {
  const s = await stand(t, { np: npTogether(2) })
  const body = orderBody()
  const rs = await Promise.all([s.call('POST', BASE, { body }), s.call('POST', BASE, { body: { ...body, warehouseRef: WH2 } })])
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409])
  const lost = rs.find((r) => r.status === 409)
  assert.equal(errorOf(lost), 'IDEMPOTENCY_CONFLICT')
  assert.ok(!lost.text.includes(rs.find((r) => r.status === 201).json.data.token))
  assert.equal(s.orders().length, 1)
  assert.equal(s.bank.created.length, 1)
})

test('параллельные запросы: второй пришёл, пока первый ждёт банк: статус без нового счёта; ссылка появляется на странице статуса', async (t) => {
  const s = await stand(t)
  const hold = held()
  s.bank.onCreate = () => hold.gate
  const body = orderBody()
  const firstP = s.call('POST', BASE, { body })
  await until(() => s.bank.created.length === 1, 'первый дошёл до банка')
  const second = await s.call('POST', BASE, { body })
  assert.equal(second.status, 200)
  assert.deepEqual(second.json.data.next, { type: 'status' })
  const during = await s.status(second.json.data.token)
  assert.deepEqual(during.json.data.payment, { payUrl: null, canRetry: false, checking: true })
  hold.release()
  assert.equal((await firstP).status, 201)
  assert.equal(s.bank.created.length, 1)
  const after = await s.status(second.json.data.token)
  assert.equal(after.json.data.payment.payUrl, 'https://pay.test/page-1')
})

// ---------- один живой заказ на телефон и артикул ----------

test('замена: новый заказ той же пары закрывает прежний как superseded и снимает его счёт', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const b = await s.created({ warehouseRef: WH2 })
  assert.notEqual(a.token, b.token)
  assert.equal(b.next.url, 'https://pay.test/page-2')
  const old = s.order(a.token)
  assert.equal(old.state, 'cancelled')
  assert.equal(old.cancelReason, 'superseded')
  assert.equal(old.payment.pageUrl, null)
  assert.deepEqual(old.history.at(-1).to, 'cancelled')
  assert.equal(old.history.at(-1).from, 'awaiting_payment')
  assert.equal(old.history.at(-1).by, 'superseded')
  await until(() => s.bank.removed.length === 1, 'счёт снят')
  assert.deepEqual(s.bank.removed, ['inv-1'])
  await until(() => s.paymentOf(s.order(a.token)).status === 'removed', 'статус removed')
  const fresh = s.order(b.token)
  assert.equal(fresh.state, 'awaiting_payment')
  assert.equal(s.db.docs[`shopPhones/${fresh.phoneKey}`].openCard['V2-LID-R'], fresh.id)
  // Заменённый заказ не платится и не отдаёт ссылку.
  assert.equal(errorOf(await s.pay(a.token)), 'NOT_PAYABLE')
  const view = await s.status(a.token)
  assert.equal(view.json.data.state, 'cancelled')
  assert.equal(view.json.data.cancelReason, 'superseded', 'сайт пишет «ви оформили нове»')
  assert.deepEqual(view.json.data.payment, { payUrl: null, canRetry: false, checking: false })
})

test('замена: разные телефоны и разные артикулы друг другу не мешают', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const otherSku = await s.created({ sku: 'V2-LID-H' })
  const otherPhone = await s.created({ phone: '+380671234568' })
  for (const d of [a, otherSku, otherPhone]) assert.equal(s.order(d.token).state, 'awaiting_payment')
  await settle()
  assert.deepEqual(s.bank.removed, [])
})

test('замена: новый заказ не трогает прежний, если тот уже оплачен, отменён или закрыт', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  await payViaStatus(s, a.token)
  const b = await s.created({ warehouseRef: WH2 })
  assert.equal(s.order(a.token).state, 'paid')
  assert.equal(s.order(a.token).cancelReason, null)
  await settle()
  assert.deepEqual(s.bank.removed, [])
  await s.cancel(b.token)
  const c = await s.created({ warehouseRef: WH })
  assert.equal(s.order(b.token).cancelReason, 'buyer')
  assert.equal(s.order(c.token).state, 'awaiting_payment')
  // Устаревшая запись в shopPhones о заказе, которого уже нет или который уже оплачен, новому заказу не мешает и заказ не трогает.
  s.db.docs[`shopPhones/${s.order(c.token).phoneKey}`].openCard['V2-LID-R'] = 'so-gone'
  const e = await s.created({ warehouseRef: WH2 })
  s.db.docs[`shopPhones/${s.order(e.token).phoneKey}`].openCard['V2-LID-R'] = s.order(a.token).id
  assert.equal((await s.create({ warehouseRef: WH })).status, 201)
  assert.equal(s.order(a.token).state, 'paid')
  assert.equal(s.order(e.token).state, 'awaiting_payment', 'запись указывала не на него')
})

test('замена: снятие старого счёта долгое или с ошибкой не задерживает новый заказ и не мешает ему', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const hold = held()
  s.bank.onRemove = () => hold.gate
  const started = Date.now()
  const b = await s.created({ warehouseRef: WH2 })
  assert.equal(b.next.type, 'redirect')
  assert.ok(Date.now() - started < 1500)
  assert.equal(s.paymentOf(s.order(a.token)).status, 'pending')
  hold.release()
  await until(() => s.paymentOf(s.order(a.token)).status === 'removed', 'снят после ответа банка')

  const s2 = await stand(t)
  const c = await s2.created()
  s2.bank.onRemove = async () => { throw Object.assign(new Error('відмова'), { response: { status: 400 } }) }
  const d = await s2.created({ warehouseRef: WH2 })
  assert.equal(d.next.type, 'redirect')
  await until(() => s2.bank.removed.length === 1, 'попытка снятия')
  await settle()
  assert.equal(s2.paymentOf(s2.order(c.token)).status, 'pending', 'банк отказал: счёт остаётся в опросе')
  assert.equal(s2.order(c.token).state, 'cancelled')
})

test('замена: старый счёт оплатили после замены: payment_review и алерт, чек вышел, новый заказ не тронут', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const b = await s.created({ warehouseRef: WH2 })
  await until(() => s.paymentOf(s.order(a.token)).status === 'removed', 'снят')
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.webhook('inv-1')
  await until(() => s.order(a.token).state === 'payment_review', 'заказ на проверке')
  assert.equal(s.paymentOf(s.order(a.token)).status, 'paid')
  await until(() => s.calls.sells.length === 1, 'чек')
  assert.ok(s.calls.alerts.some((x) => x.includes(s.order(a.token).orderNo) && x.includes('після закриття')))
  assert.equal(s.order(b.token).state, 'awaiting_payment')
  assert.equal(s.order(b.token).paidPaymentId, undefined)
})

test('замена: прежний заказ ещё ждёт банк, счёт приходит после замены: ссылка не выдаётся, счёт снимается и остаётся в заказе', async (t) => {
  const s = await stand(t)
  const hold = held()
  s.bank.onCreate = (n) => (n === 1 ? hold.gate : undefined)
  const firstBody = orderBody()
  const firstP = s.call('POST', BASE, { body: firstBody })
  await until(() => s.bank.created.length === 1, 'первый у банка')
  const b = await s.created({ warehouseRef: WH2 })
  assert.equal(b.next.type, 'redirect')
  assert.deepEqual(s.bank.removed, [], 'снимать пока нечего')
  hold.release()
  const first = await firstP
  assert.equal(first.status, 201)
  assert.deepEqual(first.json.data.next, { type: 'status' })
  await until(() => s.bank.removed.length === 1, 'снят опоздавший счёт')
  assert.deepEqual(s.bank.removed, ['inv-1'])
  const old = s.order(first.json.data.token)
  assert.equal(old.state, 'cancelled')
  assert.equal(old.payment.pageUrl, null)
  assert.equal(old.paymentIds.length, 1)
  assert.equal(s.paymentOf(s.order(b.token)).status, 'pending')
})

test('параллельная замена: при любом порядке живой один заказ и один счёт', async (t) => {
  const s = await stand(t, { np: npTogether(5) })
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => s.create({ warehouseRef: i % 2 ? WH : WH2 })))
  assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.text).join())
  const open = s.orders().filter((o) => o.state === 'awaiting_payment')
  assert.equal(open.length, 1)
  assert.equal(s.orders().filter((o) => o.cancelReason === 'superseded').length, 4)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 5)
  await until(() => s.payments().filter((p) => p.status === 'pending').length === 1, 'остался один живой счёт')
  assert.equal(s.paymentOf(open[0]).status, 'pending')
  const openId = Object.entries(s.db.docs).find(([, d]) => d.statusToken === open[0].statusToken)[0].slice('shopOrders/'.length)
  assert.equal(s.db.docs[`shopPhones/${open[0].phoneKey}`].openCard['V2-LID-R'], openId)
})

test('параллельные разные покупатели на пределе: заказов не больше предела', async (t) => {
  const s = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { unpaidPerDay: 2 } }) }), np: npTogether(5) })
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => s.create({ phone: `+38067123456${i}` })))
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 201, 429, 429, 429])
  assert.equal(s.orders().length, 2)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 2)
})

// ---------- сбой банка ----------

test('сбой банка при создании: 201 с токеном и payIssue, заказ есть, захват снят; повтор через /pay создаёт счёт', async (t) => {
  const s = await stand(t)
  s.bank.onCreate = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 500 } }) }
  const r = await s.create()
  assert.equal(r.status, 201, r.text)
  const d = r.json.data
  assert.deepEqual(d.next, { type: 'status', payIssue: 'BANK_UNAVAILABLE' })
  const o = s.order(d.token)
  assert.equal(o.state, 'awaiting_payment')
  assert.equal(o.payment.initiatedAt, null)
  assert.equal(o.payment.paymentId, null)
  assert.equal(o.payAttempts, 0)
  assert.deepEqual(s.payments(), [])
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: true, checking: false })
  s.bank.onCreate = null
  const pay = await s.pay(d.token)
  assert.equal(pay.status, 200, pay.text)
  assert.deepEqual(pay.json.data.next, { type: 'redirect', url: 'https://pay.test/page-2' })
  assert.equal(s.order(d.token).payAttempts, 1)
})

test('сбой банка: повтор POST с тем же ключом банк не зовёт и ведёт на статус', async (t) => {
  const s = await stand(t)
  s.bank.onCreate = async () => { throw new Error('таймаут') }
  const body = orderBody()
  await s.call('POST', BASE, { body })
  const calls = s.bank.created.length
  const r = await s.call('POST', BASE, { body })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data.next, { type: 'status' })
  assert.equal(s.bank.created.length, calls)
})

test('сбой банка: createPayment отказал (не сеть): то же поведение, счёта нет', async (t) => {
  const s = await stand(t, { docs: shopDocs({ materials: [material('V2-LID-R', { name: { uk: 'Кришка' }, price: 800 })] }) })
  const was = s.api.createPayment
  s.api.createPayment = async () => ({ ok: false, status: 400, code: 'NO_MONO_ACQUIRE', message: 'x' })
  t.after(() => { s.api.createPayment = was })
  const r = await s.create()
  assert.equal(r.status, 201, r.text)
  assert.equal(r.json.data.next.payIssue, 'BANK_UNAVAILABLE')
  assert.equal(s.order(r.json.data.token).payment.initiatedAt, null)
})

// ---------- суточный предел ----------

test('суточный предел: 429 DAY_LIMIT, ничего не создано, режим и лента не меняются, алерт один', async (t) => {
  const s = await stand(t, { docs: { ...shopDocs(), [`shopDaily/${today()}`]: { unpaid: 40 } } })
  const a = await s.create()
  assert.equal(a.status, 429, a.text)
  assert.equal(errorOf(a), 'DAY_LIMIT')
  assert.equal((await s.create({ warehouseRef: WH2 })).status, 429)
  assert.deepEqual(s.orders(), [])
  assert.deepEqual(s.bank.created, [])
  assert.equal(s.db.docs['system/shopSales'].mode, 'live', 'автоотключения нет')
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 40, 'отказ счётчик не двигает')
  const feed = await s.call('GET', '/api/shop/catalog')
  assert.equal(feed.json.data.items[0].orderable, true)
  assert.equal(feed.json.data.items[0].showBuyButton, true)
  await until(() => s.calls.alerts.length >= 1, 'алерт')
  await settle()
  assert.equal(s.calls.alerts.length, 1)
  assert.match(s.calls.alerts[0], /денний ліміт/)
  assert.match(s.calls.alerts[0], /shop-orders/)
  assert.match(s.calls.alerts[0], /продажі не вимкнено/)
  await until(() => s.db.docs[`shopDaily/${today()}`].alerts['day-limit'].sentAt, 'отметка об отправке')
})

test('суточный предел: Telegram молчит: отметка без sentAt, заказу не мешает; повтор за сверкой', async (t) => {
  const s = await stand(t, { docs: { ...shopDocs(), [`shopDaily/${today()}`]: { unpaid: 40 } }, notify: async () => false })
  assert.equal((await s.create()).status, 429)
  await until(() => s.calls.alerts.length === 1, 'попытка')
  await settle()
  assert.equal(s.db.docs[`shopDaily/${today()}`].alerts['day-limit'].sentAt, null)
  assert.equal((await s.create()).status, 429)
  await settle()
  assert.equal(s.calls.alerts.length, 1, 'та же метка: лента алертов не шлёт второй раз, повтор за сверкой')
})

test('суточный предел: свой предел из настроек; неверное значение даёт умолчание 40; вчерашний счётчик не считается', async (t) => {
  const two = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { unpaidPerDay: 2 } }) }) })
  await two.created()
  await two.created({ phone: '+380671234568' })
  assert.equal((await two.create({ phone: '+380671234569' })).status, 429)

  const zero = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { unpaidPerDay: 0 } }) }) })
  assert.equal((await zero.create()).status, 429)

  for (const value of ['2', -1, null, 1.5]) {
    const s = await stand(t, { docs: { ...shopDocs({ cfg: sales({ limits: { unpaidPerDay: value } }) }), [`shopDaily/${today()}`]: { unpaid: 39 } } })
    assert.equal((await s.create()).status, 201, String(value))
    assert.equal((await s.create({ phone: '+380671234568' })).status, 429, String(value))
  }

  const yesterday = await stand(t, { docs: { ...shopDocs(), 'shopDaily/2020-01-01': { unpaid: 40 } } })
  assert.equal((await yesterday.create()).status, 201)
  assert.equal(yesterday.db.docs[`shopDaily/${today()}`].unpaid, 1)
})

test('суточный предел: документ дня только с алертами ленты: неоплаченных ноль, алерты не трогаем', async (t) => {
  const s = await stand(t, { docs: { ...shopDocs(), [`shopDaily/${today()}`]: { alerts: { 'feed-V2-LID-H': { at: 'x', sentAt: null, text: 'y' } } } } })
  await s.created()
  const day = s.db.docs[`shopDaily/${today()}`]
  assert.equal(day.unpaid, 1)
  assert.ok(day.alerts['feed-V2-LID-H'])
})

test('суточный предел: заказ сверх предела не закрывает прежний той же пары; повтор уже созданного заказа работает', async (t) => {
  const s = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { unpaidPerDay: 1 } }) }) })
  const body = orderBody()
  const a = await s.call('POST', BASE, { body })
  assert.equal(a.status, 201)
  assert.equal((await s.create({ warehouseRef: WH2 })).status, 429)
  assert.equal(s.order(a.json.data.token).state, 'awaiting_payment')
  await settle()
  assert.deepEqual(s.bank.removed, [])
  const repeat = await s.call('POST', BASE, { body })
  assert.equal(repeat.status, 200)
  assert.equal(repeat.json.data.next.url, 'https://pay.test/page-1')
})

test('суточный предел: оплата освобождает место, отмена и замена нет', async (t) => {
  const s = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { unpaidPerDay: 1 } }) }) })
  const a = await s.created()
  await payViaStatus(s, a.token)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 0)
  const b = await s.created({ phone: '+380671234568' })
  await s.cancel(b.token)
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 1)
  assert.equal((await s.create({ phone: '+380671234569' })).status, 429)
})

// ---------- повтор POST и выключатели ----------

test('повтор POST: живой счёт отдаётся при открытых продажах; при off, prices, выключенной карте или снятом артикуле только статус', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const first = await s.call('POST', BASE, { body })
  const closes = [
    { mode: 'off' },
    { mode: 'prices' },
    { methods: { card: false } },
    { skus: { 'V2-LID-R': { inStock: false } } },
    { skus: { 'V2-LID-R': { inStock: true, enabled: false } } },
    { skus: { 'V2-LID-R': { enabled: true, stock: 0 } } },
  ]
  for (const close of closes) {
    s.cfg(close)
    const r = await s.call('POST', BASE, { body })
    assert.equal(r.status, 200, JSON.stringify(close))
    assert.deepEqual(r.json.data.next, { type: 'status' }, JSON.stringify(close))
    assert.ok(!r.text.includes('pay.test'), JSON.stringify(close))
    assert.equal((await s.status(first.json.data.token)).json.data.payment.payUrl, null, JSON.stringify(close))
    s.db.docs['system/shopSales'] = sales()
    assert.equal((await s.call('POST', BASE, { body })).json.data.next.url, 'https://pay.test/page-1', 'снова включили')
  }
  s.cfg({ mode: 'hidden' })
  assert.equal((await s.call('POST', BASE, { body })).json.data.next.url, 'https://pay.test/page-1')
  delete s.db.docs['system/shopSales']
  assert.deepEqual((await s.call('POST', BASE, { body })).json.data.next, { type: 'status' })
  assert.equal(s.bank.created.length, 1)
})

test('повтор POST: счёт истёк или срок вышел: банк не зовём, только статус; оплаченный заказ ведёт на статус', async (t) => {
  const s = await stand(t)
  const body = orderBody()
  const first = await s.call('POST', BASE, { body })
  const token = first.json.data.token
  s.patchOrder(token, { payment: { expiresAt: ago(SEC) } })
  assert.deepEqual((await s.call('POST', BASE, { body })).json.data.next, { type: 'status' })
  assert.equal(s.bank.created.length, 1)
  s.patchOrder(token, { payment: { expiresAt: new Date(Date.now() + 3600 * SEC).toISOString() } })
  s.patchOrder(token, { state: 'expired' })
  assert.deepEqual((await s.call('POST', BASE, { body })).json.data.next, { type: 'status' }, 'закрытый заказ ссылку не отдаёт, даже если она не стёрта')
  s.patchOrder(token, { state: 'awaiting_payment' })
  await payViaStatus(s, token)
  const paid = await s.call('POST', BASE, { body })
  assert.equal(paid.status, 200)
  assert.equal(paid.json.data.state, 'paid')
  assert.deepEqual(paid.json.data.next, { type: 'status' })
  assert.equal(s.bank.created.length, 1)
})

// ---------- статус: ответ ----------

const PII = (o) => [
  'Шевченко', 'Тарас', 'Григорович', '380671234567', 'taras@example.com', 'Київ', 'Відділення', CITY, WH, 'fop-2', 'Фактична адреса',
  o.statusToken, o.payment.paymentId, o.payment.invoiceId, o.fingerprint, o.phoneKey, o.idempotencyKey,
  'paymentId', 'invoiceId', 'fiscal', 'receiptError', 'history', 'alerts', 'consent', 'clientName', 'clientPhone', 'phoneKey', 'fopId', 'FC-1', 'rcpt-',
].filter(Boolean)
const assertClean = (text, o) => {
  for (const word of PII(o)) assert.ok(!text.includes(word), `${word} в ${text}`)
}

test('статус: ровно условленные поля, персональных данных нет; телефон только в маске', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const r = await s.status(d.token)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data, {
    orderNo: d.orderNo,
    state: 'awaiting_payment',
    cancelReason: null,
    method: 'card',
    item: { sku: 'V2-LID-R', titleUk: 'Кришка V2-LID-R', qty: 1, totalUah: 800 },
    seller: publicSeller,
    offerVersion: '2026-11-03',
    payment: { payUrl: 'https://pay.test/page-1', canRetry: false, checking: false },
    receipt: { status: 'none', url: null },
    delivery: { ttn: null, trackUrl: null, stage: 'none' },
    phoneConfirm: { required: false, phoneMasked: '+380•••••••67', resendInSec: 0, attemptsLeft: 0 },
  })
  assertClean(r.text, s.order(d.token))
})

test('статус и отмена: на всех этапах заказа без персональных данных', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const order = s.order(a.token)
  await payViaStatus(s, a.token)
  await until(() => s.paymentOf(s.order(a.token)).taxUrl, 'чек готов')
  const paid = await s.status(a.token)
  assert.equal(paid.json.data.state, 'paid')
  assertClean(paid.text, s.order(a.token))
  assert.deepEqual(paid.json.data.receipt, { status: 'ready', url: 'https://check.test/1' })

  s.patchOrder(a.token, { ttn: '20450000000000', state: 'shipped', npDelivery: { code: '4', rawText: 'Прибув у місто', changedAt: 'x' } })
  const shipped = await s.status(a.token)
  assert.deepEqual(shipped.json.data.delivery, { ttn: '20450000000000', trackUrl: 'https://novaposhta.ua/tracking/?cargo_number=20450000000000', stage: 'moving' })
  assert.ok(!shipped.text.includes('Прибув'), 'сырой текст НП не уходит')

  const b = await s.created({ sku: 'V2-LID-H' })
  const cancel = await s.cancel(b.token)
  assert.equal(cancel.status, 200)
  assert.equal(cancel.json.data.state, 'cancelled')
  assertClean(cancel.text, s.order(b.token))
  assert.ok(order.statusToken)
})

test('статус: реквизиты продавца заморожены в заказе и не читают ФОП на каждый опрос', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.docs['fops/fop-2'].seller = { displayName: 'Інший', ipn: '1', address: 'a', email: 'e', phone: 'p' }
  s.patchOrder(d.token, { payment: { lastBankCheckAt: new Date().toISOString() } }) // опрос банка читает ФОП, но раз в 10 секунд
  s.db.reads.length = 0
  const r = await s.status(d.token)
  assert.deepEqual(r.json.data.seller, publicSeller)
  await settle()
  assert.ok(!s.db.reads.includes('fopSecrets/fop-2'))
  assert.ok(!s.db.reads.includes('fops/fop-2'))
})

test('статус: настройки не прочитались: статус есть, ссылки на банк нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.failRead = (path) => path === 'system/shopSales'
  const r = await s.status(d.token)
  assert.equal(r.status, 200)
  assert.equal(r.json.data.payment.payUrl, null)
  assert.equal(r.json.data.payment.canRetry, false)
})

test('статус: сбой базы: 500 без подробностей, сайт покажет «временно недоступен», а не «не найден»', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.failRead = (path) => path === 'shopOrders'
  const r = await s.status(d.token)
  assert.equal(r.status, 500)
  assert.deepEqual(r.json, { success: false, error: { code: 'INTERNAL', message: 'Internal error' } })
})

// ---------- неперебираемый адрес ----------

test('адрес статуса: кривой формат даёт 404 без чтения базы; id заказа, номер и телефон не подходят; ответы одинаковые', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const o = s.order(d.token)
  const body = { success: false, error: { code: 'NOT_FOUND', message: 'No such order' } }
  s.db.reads.length = 0
  const bad = [o.id, d.orderNo, encodeURIComponent(PHONE), o.phoneKey, 'short', `${d.token}A`, d.token.slice(0, -1), '%20'.repeat(22), `${d.token}%00`]
  for (const token of bad) {
    for (const r of [await s.status(token), await s.pay(token), await s.cancel(token)]) {
      assert.equal(r.status, 404, token)
      assert.deepEqual(r.json, body, token)
    }
  }
  assert.deepEqual(s.db.reads, [], 'формат отсекается до базы')
  const unknown = 'A'.repeat(22)
  for (const r of [await s.status(unknown), await s.pay(unknown), await s.cancel(unknown)]) {
    assert.equal(r.status, 404)
    assert.deepEqual(r.json, body)
  }
  assert.equal(s.order(d.token).state, 'awaiting_payment')
})

test('адрес статуса: токен сверяется с учётом регистра; 128 случайных бит, не зависит от телефона, ключа и номера', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const flipped = d.token.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
  assert.equal((await s.status(flipped)).status, 404)
  const tokens = new Set([d.token])
  for (let i = 0; i < 20; i += 1) {
    const s2 = await stand(t)
    const body = orderBody({ idempotencyKey: 'same-key-000000000000' })
    const r = await s2.call('POST', BASE, { body })
    tokens.add(r.json.data.token)
    assert.equal(Buffer.from(r.json.data.token, 'base64url').length, 16)
  }
  assert.equal(tokens.size, 21, 'один и тот же ключ и телефон дают разные токены')
})

test('адрес статуса: токена нет в журнале, в алертах, в оплате и в журнале персональные данные не появляются, даже при сбоях', async (t) => {
  logs.length = 0
  const s = await stand(t, { np: async () => { throw new Error('НП лежить') }, addressBudgetMs: 10 })
  s.bank.onCreate = async () => { throw new Error('банк лежить') }
  const a = await s.created()
  s.bank.onCreate = null
  await s.pay(a.token)
  const o = s.order(a.token)
  s.bank.statuses[o.payment.invoiceId] = { status: 'success', amount: 100, ccy: 980 } // сумма не сошлась
  s.patchOrder(a.token, { payment: { lastBankCheckAt: null } })
  await s.status(a.token)
  await until(() => s.order(a.token).state === 'payment_review', 'проверка')
  const b = await s.created({ sku: 'V2-LID-H', warehouseRef: WH2 })
  const c = await s.created({ sku: 'V2-LID-H', warehouseRef: WH })
  await s.cancel(c.token)
  await settle()
  const noise = [...logs, ...s.calls.alerts, JSON.stringify(s.payments())].join('\n')
  for (const token of [a.token, b.token, c.token]) assert.ok(!noise.includes(token), token)
  for (const word of ['Шевченко', 'Тарас', '380671234567', 'taras@example.com', CITY, WH]) assert.ok(!noise.includes(word), word)
})

// ---------- статус: опрос банка ----------

test('опрос банка: страница статуса замечает оплату сама; paid и источник status; при возврате без вебхука деньги не теряются', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.status(d.token)
  await until(() => s.order(d.token).state === 'paid', 'оплата')
  const o = s.order(d.token)
  assert.equal(o.paidSource, 'status')
  assert.equal(o.paidPaymentId, o.payment.paymentId)
  assert.ok(o.paidAt)
  assert.equal(o.payment.pageUrl, null)
  assert.equal(s.db.docs[`shopPhones/${o.phoneKey}`].openCard['V2-LID-R'], null)
  await until(() => s.calls.sells.length === 1, 'чек')
  assert.equal(s.calls.sells[0].paymentLabel, 'Інтернет еквайринг')
  assert.equal(s.calls.sells[0].deliveryEmail, 'taras@example.com')
  await until(() => s.paymentOf(s.order(d.token)).taxUrl, 'чек записан')
  const view = await s.status(d.token)
  assert.equal(view.json.data.state, 'paid')
  assert.deepEqual(view.json.data.payment, { payUrl: null, canRetry: false, checking: false })
  assert.deepEqual(view.json.data.receipt, { status: 'ready', url: 'https://check.test/1' })
})

test('опрос банка: не чаще раза в 10 секунд, на параллельных запросах тоже', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await Promise.all([s.status(d.token), s.status(d.token), s.status(d.token), s.status(d.token)])
  await until(() => s.bank.statusCalls.length >= 1, 'первый опрос')
  await settle()
  assert.equal(s.bank.statusCalls.length, 1)
  await s.status(d.token)
  await settle()
  assert.equal(s.bank.statusCalls.length, 1)
  s.patchOrder(d.token, { payment: { lastBankCheckAt: ago(9 * SEC) } })
  await s.status(d.token)
  await settle()
  assert.equal(s.bank.statusCalls.length, 1, '9 секунд это ещё рано')
  s.patchOrder(d.token, { payment: { lastBankCheckAt: ago(11 * SEC) } })
  await s.status(d.token)
  await until(() => s.bank.statusCalls.length === 2, 'следующий опрос')
})

test('опрос банка: ФОП не прочитался: банк не спрашиваем, статус отвечает', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  delete s.db.docs['fops/fop-2']
  assert.equal((await s.status(d.token)).status, 200)
  await settle()
  assert.deepEqual(s.bank.statusCalls, [])
})

test('опрос банка: только для живого неоплаченного счёта', async (t) => {
  const s = await stand(t)
  const closed = await s.created({ sku: 'V2-LID-H' })
  await expireInvoice(s, closed.token)
  const before = s.bank.statusCalls.length
  s.patchOrder(closed.token, { payment: { lastBankCheckAt: null } })
  await s.status(closed.token)
  await settle()
  assert.equal(s.bank.statusCalls.length, before, 'конечный ответ банка уже есть')
  s.bank.statusCalls.length = 0
  const a = await s.created()
  await s.cancel(a.token)
  await settle()
  await s.status(a.token)
  await settle()
  assert.deepEqual(s.bank.statusCalls, [])
  const b = await s.created({ warehouseRef: WH2 })
  await payViaStatus(s, b.token)
  await settle()
  const calls = s.bank.statusCalls.length
  await s.status(b.token)
  await settle()
  assert.equal(s.bank.statusCalls.length, calls)
})

test('медленный Checkbox не задерживает GET: заказ уже оплачен, чек в ожидании', async (t) => {
  const hold = held()
  t.after(() => hold.release({ receiptId: 'r', fiscalCode: 'F', taxUrl: 'https://check.test/late', status: 'DONE' }))
  const s = await stand(t, { sell: () => hold.gate })
  const d = await s.created()
  s.bank.statuses['inv-1'] = BANK_PAID
  const started = Date.now()
  assert.equal((await s.status(d.token)).status, 200)
  await until(() => s.calls.sells.length === 1, 'чек ушёл в кассу')
  const r = await s.status(d.token)
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} мс`)
  assert.equal(r.json.data.state, 'paid')
  assert.deepEqual(r.json.data.receipt, { status: 'pending', url: null })
  hold.release({ receiptId: 'r', fiscalCode: 'F', taxUrl: 'https://check.test/late', status: 'DONE' })
  await until(() => s.paymentOf(s.order(d.token)).taxUrl, 'чек дописан')
  assert.deepEqual((await s.status(d.token)).json.data.receipt, { status: 'ready', url: 'https://check.test/late' })
})

test('медленный банк и Telegram не задерживают GET', async (t) => {
  const bankHold = held()
  t.after(() => bankHold.release())
  const s = await stand(t)
  const d = await s.created()
  s.bank.onStatus = () => bankHold.gate
  const started = Date.now()
  assert.equal((await s.status(d.token)).status, 200)
  s.patchOrder(d.token, { payment: { lastBankCheckAt: ago(MIN) } })
  assert.equal((await s.status(d.token)).status, 200)
  assert.ok(Date.now() - started < 1500)

  const tgHold = held()
  t.after(() => tgHold.release(true))
  const s2 = await stand(t, { notify: () => tgHold.gate })
  const d2 = await s2.created()
  s2.bank.statuses['inv-1'] = { status: 'success', amount: 100, ccy: 980 } // расхождение суммы даёт алерт
  const started2 = Date.now()
  await s2.status(d2.token)
  await until(() => s2.order(d2.token).state === 'payment_review', 'проверка')
  assert.equal((await s2.status(d2.token)).status, 200)
  assert.ok(Date.now() - started2 < 1500)
})

test('опрос банка: ошибка банка видна только в журнале, ответ страницы не меняется', async (t) => {
  logs.length = 0
  const s = await stand(t)
  const d = await s.created()
  s.bank.onStatus = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 500 } }) }
  const r = await s.status(d.token)
  assert.equal(r.status, 200)
  await until(() => logs.some((x) => x.includes('опитування банку')), 'журнал')
  assert.equal((await s.status(d.token)).json.data.payment.payUrl, 'https://pay.test/page-1')
})

test('опрос банка: опоздавший ответ по старому счёту не портит отметку нового', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  const hold = held()
  s.bank.onStatus = () => hold.gate
  s.patchOrder(d.token, { payment: { lastBankCheckAt: null } })
  // Документ старого счёта снова pending, чтобы страница начала его опрос: так выглядит гонка опроса и нового счёта.
  const oldId = s.order(d.token).payment.paymentId
  s.db.docs[`payments/${oldId}`].status = 'pending'
  await s.status(d.token)
  await until(() => s.bank.statusCalls.length >= 2, 'опрос старого счёта начат')
  s.db.docs[`payments/${oldId}`].status = 'expired'
  s.bank.statuses['inv-1'] = { status: 'processing' }
  s.bank.onStatus = null
  assert.equal((await s.pay(d.token)).status, 200)
  hold.release()
  await settle()
  assert.equal(s.order(d.token).payment.invoiceId, 'inv-2')
  assert.equal(s.order(d.token).payment.status, 'created')
  assert.equal((await s.status(d.token)).json.data.payment.payUrl, 'https://pay.test/page-2')
})

test('статус счёта: processing и hold: ссылки нет, идёт проверка; истёк срок без ответа банка: то же; failure и expired: новый счёт', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  for (const status of ['processing', 'hold']) {
    s.bank.statuses['inv-1'] = { status }
    s.patchOrder(d.token, { payment: { lastBankCheckAt: null } })
    await s.status(d.token)
    await until(() => s.order(d.token).payment.status === status, status)
    assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: true }, status)
  }
  s.bank.statuses['inv-1'] = { status: 'created' }
  s.patchOrder(d.token, { payment: { lastBankCheckAt: null } })
  await s.status(d.token)
  await until(() => s.order(d.token).payment.status === 'created', 'created')
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: 'https://pay.test/page-1', canRetry: false, checking: false })

  s.patchOrder(d.token, { payment: { expiresAt: ago(SEC) } })
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: true })
  await settle()
  for (const status of ['failure', 'expired']) {
    const s2 = await stand(t)
    const d2 = await s2.created()
    await expireInvoice(s2, d2.token, status)
    assert.deepEqual((await s2.status(d2.token)).json.data.payment, { payUrl: null, canRetry: true, checking: false }, status)
  }
})

test('статус счёта: документ оплаты уже paid, хук ещё не дошёл до заказа: проверка, нового счёта нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const o = s.order(d.token)
  s.db.docs[`payments/${o.payment.paymentId}`].status = 'paid'
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: true })
  assert.equal(errorOf(await s.pay(d.token)), 'NOT_PAYABLE')
  assert.equal(s.bank.created.length, 1)
})

// ---------- /pay ----------

const PAY_CLOSED = [
  ['off', { mode: 'off' }, 'SALES_OFF', 409],
  ['prices', { mode: 'prices' }, 'SALES_OFF', 409],
  ['карта выключена', { methods: { card: false } }, 'METHOD_OFF', 409],
  ['артикул снят', { skus: { 'V2-LID-R': { enabled: false } } }, 'NOT_FOR_SALE', 409],
  ['нет в наличии', { skus: { 'V2-LID-R': { inStock: false } } }, 'NOT_FOR_SALE', 409],
]

test('/pay: выключенные продажи, способ и артикул: 409, даже при живом счёте; ссылки в ответе нет, банк не вызван', async (t) => {
  for (const [name, patch, code, status] of PAY_CLOSED) {
    const s = await stand(t)
    const d = await s.created()
    s.cfg(patch)
    const r = await s.pay(d.token)
    assert.equal(r.status, status, name)
    assert.equal(errorOf(r), code, name)
    assert.ok(!r.text.includes('pay.test'), name)
    assert.equal(s.bank.created.length, 1, name)
    assert.deepEqual(s.bank.statusCalls.filter((x) => x !== 'inv-1'), [], name)
  }
  const none = await stand(t)
  const d = await none.created()
  delete none.db.docs['system/shopSales']
  assert.equal(errorOf(await none.pay(d.token)), 'SALES_OFF')
})

test('/pay: читает настройки без кэша: выключили и включили, ответ меняется сразу', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  assert.equal((await s.pay(d.token)).status, 200)
  s.cfg({ mode: 'off' })
  assert.equal(errorOf(await s.pay(d.token)), 'SALES_OFF')
  s.cfg({ mode: 'live' })
  assert.equal((await s.pay(d.token)).status, 200)
})

test('/pay: гейт по ФОП заказа: снята галочка, ФОП выключен, нет ключа; смена ФОП в настройках старый заказ не перевешивает', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.docs['fops/fop-2'].methods.monoAcquire = false
  assert.equal(errorOf(await s.pay(d.token)), 'METHOD_OFF')
  s.db.docs['fops/fop-2'].methods.monoAcquire = true
  s.db.docs['fops/fop-2'].active = false
  const off = await s.pay(d.token)
  assert.equal(off.status, 503)
  assert.equal(errorOf(off), 'NOT_CONFIGURED')
  s.db.docs['fops/fop-2'].active = true
  s.db.docs['fopSecrets/fop-2'].monoAcquire = {}
  assert.equal((await s.pay(d.token)).status, 503)
  s.db.docs['fopSecrets/fop-2'].monoAcquire = { token: 'SECRET-mono' }

  s.cfg({ fopId: 'fop-new' })
  await expireInvoice(s, d.token)
  const again = await s.pay(d.token)
  assert.equal(again.status, 200, again.text)
  assert.equal(s.bank.created.at(-1).fopId, 'fop-2')
  assert.equal(s.paymentOf(s.order(d.token)).fopId, 'fop-2')
})

test('/pay: живой счёт: та же ссылка, нового счёта нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const r = await s.pay(d.token)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { success: true, data: { next: { type: 'redirect', url: 'https://pay.test/page-1' } } })
  assert.equal(s.bank.created.length, 1)
  assert.equal(s.order(d.token).payAttempts, 1)
})

test('/pay: банк не отвечает: живой счёт показываем снова, просроченный нет; нового счёта при неизвестном исходе нет', async (t) => {
  const s = await stand(t, { bankReadBudgetMs: 10 })
  const d = await s.created()
  s.bank.onStatus = () => new Promise(() => {})
  const live = await s.pay(d.token)
  assert.equal(live.status, 200)
  assert.equal(live.json.data.next.url, 'https://pay.test/page-1')
  s.patchOrder(d.token, { payment: { expiresAt: ago(SEC) } })
  const dead = await s.pay(d.token)
  assert.equal(dead.status, 502)
  assert.equal(errorOf(dead), 'BANK_UNAVAILABLE')
  assert.equal(s.bank.created.length, 1)
  s.bank.onStatus = async () => { throw new Error('мережа') }
  assert.equal(errorOf(await s.pay(d.token)), 'BANK_UNAVAILABLE')
  assert.equal(s.bank.created.length, 1)
})

test('/pay: банк говорит «оплачено»: NOT_PAYABLE и заказ проводится, нового счёта нет; возврат так же', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.bank.statuses['inv-1'] = BANK_PAID
  const r = await s.pay(d.token)
  assert.equal(r.status, 409)
  assert.equal(errorOf(r), 'NOT_PAYABLE')
  await until(() => s.order(d.token).state === 'paid', 'оплата')
  assert.equal(s.order(d.token).paidSource, 'pay')
  assert.equal(s.bank.created.length, 1)

  const s2 = await stand(t)
  const d2 = await s2.created()
  s2.bank.statuses['inv-1'] = { status: 'reversed' }
  assert.equal(errorOf(await s2.pay(d2.token)), 'NOT_PAYABLE')
  assert.equal(s2.bank.created.length, 1)
  await until(() => s2.paymentOf(s2.order(d2.token)).status === 'reversed', 'записан возврат')
})

test('/pay: банк считает оплату идущей или срок вышел без конечного ответа: PAY_IN_PROGRESS, нового счёта нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  for (const status of ['processing', 'hold', 'незнайомий']) {
    s.bank.statuses['inv-1'] = { status }
    const r = await s.pay(d.token)
    assert.equal(r.status, 409, status)
    assert.equal(errorOf(r), 'PAY_IN_PROGRESS', status)
  }
  s.bank.statuses['inv-1'] = { status: 'created' }
  s.patchOrder(d.token, { payment: { expiresAt: ago(SEC) } })
  assert.equal(errorOf(await s.pay(d.token)), 'PAY_IN_PROGRESS')
  assert.equal(s.bank.created.length, 1)
})

test('/pay: повтор после expired и failure: новый счёт, прежний не снимается, оба в paymentIds, ссылка новая', async (t) => {
  for (const status of ['expired', 'failure']) {
    const s = await stand(t)
    const d = await s.created()
    s.bank.statuses['inv-1'] = { status }
    s.patchOrder(d.token, { payment: { lastBankCheckAt: new Date().toISOString() } })
    const r = await s.pay(d.token)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.next, { type: 'redirect', url: 'https://pay.test/page-2' })
    const o = s.order(d.token)
    assert.equal(o.paymentIds.length, 2)
    assert.equal(o.payAttempts, 2)
    assert.equal(o.payment.invoiceId, 'inv-2')
    assert.equal(o.payment.status, 'created')
    assert.equal(o.payment.lastBankCheckAt, null)
    assert.equal(s.db.docs[`payments/${o.paymentIds[0]}`].status, status)
    assert.equal(s.db.docs[`payments/${o.paymentIds[1]}`].status, 'pending')
    assert.deepEqual(s.bank.removed, [])
    assert.equal(s.bank.created[1].redirectUrl, `https://runferry.test/uk/order/${d.token}`)
    assert.equal(s.bank.created[1].amountKop, 80000)
    assert.equal(s.bank.created[1].validitySec, 3600)
    assert.equal(s.paymentOf(o).shopOrderId, o.id)
  }
})

test('/pay: заказ без счёта и счёт removed: новый счёт сразу, без вопроса банку', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.docs[`payments/${s.order(d.token).payment.paymentId}`].status = 'removed'
  const r = await s.pay(d.token)
  assert.equal(r.json.data.next.url, 'https://pay.test/page-2')
  assert.deepEqual(s.bank.statusCalls, [])
})

test('/pay: предел попыток: 5 счетов на заказ, 6-й 429; статус перестаёт предлагать повтор; свой предел из настроек', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  for (let i = 2; i <= 5; i += 1) {
    await expireInvoice(s, d.token)
    const r = await s.pay(d.token)
    assert.equal(r.status, 200, `${i}: ${r.text}`)
    assert.equal(r.json.data.next.url, `https://pay.test/page-${i}`)
  }
  assert.equal(s.order(d.token).payAttempts, 5)
  await expireInvoice(s, d.token)
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: false })
  const over = await s.pay(d.token)
  assert.equal(over.status, 429)
  assert.equal(errorOf(over), 'TOO_MANY_PAY_ATTEMPTS')
  assert.equal(s.bank.created.length, 5)
  assert.equal(s.order(d.token).payment.initiatedAt, null, 'захват не остаётся')

  const two = await stand(t, { docs: shopDocs({ cfg: sales({ limits: { payAttemptsPerOrder: 1 } }) }) })
  const d2 = await two.created()
  await expireInvoice(two, d2.token)
  assert.equal(errorOf(await two.pay(d2.token)), 'TOO_MANY_PAY_ATTEMPTS')
  assert.equal((await two.status(d2.token)).json.data.payment.canRetry, false)
})

test('/pay: сбой банка на новом счёте: 502, захват снят, попытка не считается', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  s.bank.onCreate = async () => { throw new Error('мережа') }
  for (let i = 0; i < 6; i += 1) {
    const r = await s.pay(d.token)
    assert.equal(r.status, 502, r.text)
    assert.equal(errorOf(r), 'BANK_UNAVAILABLE')
  }
  const o = s.order(d.token)
  assert.equal(o.payment.initiatedAt, null)
  assert.equal(o.payAttempts, 1)
  s.bank.onCreate = null
  assert.equal((await s.pay(d.token)).status, 200)
  assert.equal(s.order(d.token).payAttempts, 2)
})

test('/pay: параллельные запросы: новый счёт один, остальные получают его же или PAY_IN_PROGRESS', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  const rs = await Promise.all(Array.from({ length: 5 }, () => s.pay(d.token)))
  assert.equal(s.bank.created.length, 2)
  assert.equal(s.order(d.token).paymentIds.length, 2)
  assert.equal(s.order(d.token).payAttempts, 2)
  assert.ok(rs.some((r) => r.status === 200))
  for (const r of rs) {
    if (r.status === 200) assert.equal(r.json.data.next.url, 'https://pay.test/page-2')
    else assert.equal(errorOf(r), 'PAY_IN_PROGRESS', r.text)
  }
})

test('/pay: второй запрос, пока первый ждёт банк: PAY_IN_PROGRESS, счёт один', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  const hold = held()
  s.bank.onCreate = () => hold.gate
  const firstP = s.pay(d.token)
  await until(() => s.bank.created.length === 2, 'запрос у банка')
  const busy = await s.pay(d.token)
  assert.equal(busy.status, 409)
  assert.equal(errorOf(busy), 'PAY_IN_PROGRESS')
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: true })
  hold.release()
  assert.equal((await firstP).json.data.next.url, 'https://pay.test/page-2')
  assert.equal(s.bank.created.length, 2)
})

test('/pay: пока ждали ответ банка, другой запрос уже создал новый счёт: второго счёта нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.bank.statuses['inv-1'] = { status: 'expired' }
  const hold = held()
  let reads = 0
  s.bank.onStatus = () => { reads += 1; return reads === 1 ? hold.gate : undefined }
  const slowP = s.pay(d.token)
  await until(() => reads === 1, 'первый ждёт банк')
  const fast = await s.pay(d.token)
  assert.equal(fast.json.data.next.url, 'https://pay.test/page-2')
  hold.release()
  const slow = await slowP
  assert.equal(slow.status, 409, slow.text)
  assert.equal(errorOf(slow), 'PAY_IN_PROGRESS')
  assert.equal(s.bank.created.length, 2)
  assert.equal(s.order(d.token).payment.invoiceId, 'inv-2')
})

test('/pay: пока ждали ответ банка, заказ отменили: нового счёта нет', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.bank.statuses['inv-1'] = { status: 'expired' }
  const hold = held()
  s.bank.onStatus = () => hold.gate
  const payP = s.pay(d.token)
  await until(() => s.bank.statusCalls.length === 1, 'запрос ждёт банк')
  assert.equal((await s.cancel(d.token)).status, 200)
  hold.release()
  const r = await payP
  assert.equal(r.status, 409, r.text)
  assert.equal(errorOf(r), 'NOT_PAYABLE')
  assert.equal(s.bank.created.length, 1)
})

test('/pay: свежий захват: 409 PAY_IN_PROGRESS; старше 3 минут: новый счёт (процесс упал)', async (t) => {
  const s = await stand(t)
  s.bank.onCreate = async () => { throw new Error('мережа') }
  const d = await s.created()
  s.bank.onCreate = null
  s.patchOrder(d.token, { payment: { initiatedAt: ago(2 * MIN) } })
  const busy = await s.pay(d.token)
  assert.equal(busy.status, 409)
  assert.equal(errorOf(busy), 'PAY_IN_PROGRESS')
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: false, checking: true })
  s.patchOrder(d.token, { payment: { initiatedAt: ago(4 * MIN) } })
  assert.deepEqual((await s.status(d.token)).json.data.payment, { payUrl: null, canRetry: true, checking: false })
  assert.equal((await s.pay(d.token)).status, 200)
})

test('/pay: не из того состояния: NOT_PAYABLE, даже при включённых продажах', async (t) => {
  for (const state of ['paid', 'shipped', 'delivered', 'refused', 'returned', 'payment_review', 'reversed', 'cancelled', 'expired', 'phone_pending', 'cod_confirmed']) {
    const s = await stand(t)
    const d = await s.created()
    s.patchOrder(d.token, { state })
    const r = await s.pay(d.token)
    assert.equal(r.status, 409, state)
    assert.equal(errorOf(r), 'NOT_PAYABLE', state)
  }
  const s = await stand(t)
  const d = await s.created()
  s.patchOrder(d.token, { method: 'cod' })
  assert.equal(errorOf(await s.pay(d.token)), 'NOT_PAYABLE')
  s.patchOrder(d.token, { method: 'card', state: 'cancelled' })
  s.cfg({ mode: 'off' })
  assert.equal(errorOf(await s.pay(d.token)), 'NOT_PAYABLE', 'закрытый заказ важнее выключенных продаж')
})

test('/pay: заказ отменили, пока банк создавал счёт: ссылка не выдаётся, счёт снимается и записан в заказ', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  const hold = held()
  s.bank.onCreate = () => hold.gate
  const payP = s.pay(d.token)
  await until(() => s.bank.created.length === 2, 'запрос у банка')
  assert.equal((await s.cancel(d.token)).status, 200)
  hold.release()
  const r = await payP
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data.next, { type: 'status' })
  await until(() => s.bank.removed.includes('inv-2'), 'счёт снят')
  const o = s.order(d.token)
  assert.equal(o.state, 'cancelled')
  assert.equal(o.payment.pageUrl, null)
  assert.equal(o.paymentIds.length, 2)
  await until(() => s.paymentOf(s.order(d.token)).status === 'removed', 'removed')
})

test('оплата второго счёта лишняя: первый успел оплатиться, новый снимается хуком; заказ оплачен один раз', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await expireInvoice(s, d.token)
  await s.pay(d.token)
  // Банк всё же принял деньги по первому счёту (конечный ответ оказался неверным).
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.webhook('inv-1')
  await until(() => s.order(d.token).state === 'paid', 'оплата первым счётом')
  await until(() => s.bank.removed.includes('inv-2'), 'второй снят')
  s.bank.statuses['inv-2'] = BANK_PAID
  await s.webhook('inv-2')
  await until(() => s.calls.alerts.some((x) => x.includes('зайвий платіж')), 'алерт о лишнем платеже')
  assert.equal(s.order(d.token).paidPaymentId, s.order(d.token).paymentIds[0])
})

// ---------- отмена ----------

test('отмена: заказ закрыт, счёт снят в банке, пара свободна; новый заказ не считается заменой', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  const r = await s.cancel(d.token)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.data.state, 'cancelled')
  assert.equal(r.json.data.cancelReason, 'buyer')
  assert.deepEqual(r.json.data.payment, { payUrl: null, canRetry: false, checking: false })
  assert.equal(r.json.data.orderNo, d.orderNo)
  const o = s.order(d.token)
  assert.equal(o.state, 'cancelled')
  assert.equal(o.cancelReason, 'buyer')
  assert.equal(o.payment.pageUrl, null)
  assert.deepEqual(o.history.at(-1).to, 'cancelled')
  assert.equal(o.history.at(-1).by, 'buyer')
  await until(() => s.bank.removed.length === 1, 'снятие')
  assert.deepEqual(s.bank.removed, ['inv-1'])
  await until(() => s.paymentOf(s.order(d.token)).status === 'removed', 'removed')
  assert.equal(s.db.docs[`shopPhones/${o.phoneKey}`].openCard['V2-LID-R'], null)
  const again = await s.created()
  assert.equal(s.order(again.token).state, 'awaiting_payment')
  assert.equal(s.order(d.token).cancelReason, 'buyer', 'причина не заменилась на superseded')
})

test('отмена: повтор отвечает статусом, счёт второй раз не снимается; заменённый заказ тоже', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await s.cancel(d.token)
  await until(() => s.bank.removed.length === 1, 'снятие')
  const r = await s.cancel(d.token)
  assert.equal(r.status, 200)
  assert.equal(r.json.data.state, 'cancelled')
  await settle()
  assert.equal(s.bank.removed.length, 1)
  assert.equal(s.order(d.token).history.filter((h) => h.to === 'cancelled').length, 1)
})

test('отмена: оплаченный и прочие закрытые заказы: 409 NOT_CANCELLABLE, ничего не меняется', async (t) => {
  for (const state of ['paid', 'shipped', 'delivered', 'refused', 'returned', 'payment_review', 'reversed', 'expired']) {
    const s = await stand(t)
    const d = await s.created()
    s.patchOrder(d.token, { state })
    const before = s.order(d.token)
    const r = await s.cancel(d.token)
    assert.equal(r.status, 409, state)
    assert.equal(errorOf(r), 'NOT_CANCELLABLE', state)
    assert.deepEqual(s.order(d.token), before, state)
    await settle()
    assert.deepEqual(s.bank.removed, [], state)
  }
})

test('отмена: свежий захват накладной: 409; захват старше 3 минут не мешает', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.patchOrder(d.token, { state: 'cod_confirmed', method: 'cod', ttnCreatingAt: ago(MIN) })
  const busy = await s.cancel(d.token)
  assert.equal(busy.status, 409)
  assert.equal(errorOf(busy), 'NOT_CANCELLABLE')
  assert.equal(s.order(d.token).state, 'cod_confirmed')
  s.patchOrder(d.token, { ttnCreatingAt: ago(4 * MIN) })
  assert.equal((await s.cancel(d.token)).status, 200)
  assert.equal(s.order(d.token).state, 'cancelled')
})

test('отмена: при выключенных продажах работает; банк отказал в снятии или молчит: заказ всё равно закрыт и ответ сразу', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.cfg({ mode: 'off' })
  s.bank.onRemove = async () => { throw Object.assign(new Error('відмова'), { response: { status: 400 } }) }
  assert.equal((await s.cancel(d.token)).status, 200)
  await until(() => s.bank.removed.length === 1, 'попытка')
  await settle()
  assert.equal(s.paymentOf(s.order(d.token)).status, 'pending', 'счёт остаётся в опросе сверки')
  s.bank.onRemove = null
  assert.equal((await s.cancel(d.token)).status, 200)
  await until(() => s.paymentOf(s.order(d.token)).status === 'removed', 'повтор отмены снова снимает счёт')
  assert.equal(s.bank.removed.length, 2)

  const s2 = await stand(t)
  const d2 = await s2.created()
  s2.bank.onRemove = () => new Promise(() => {})
  const started = Date.now()
  assert.equal((await s2.cancel(d2.token)).status, 200)
  assert.ok(Date.now() - started < 1500)
})

test('отмена: счёт оплатили после отмены: payment_review и алерт; заказ без счёта отменяется без обращения к банку', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  await s.cancel(d.token)
  await until(() => s.paymentOf(s.order(d.token)).status === 'removed', 'снят')
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.webhook('inv-1')
  await until(() => s.order(d.token).state === 'payment_review', 'проверка')
  assert.ok(s.calls.alerts.some((x) => x.includes('після закриття')))

  const s2 = await stand(t)
  s2.bank.onCreate = async () => { throw new Error('мережа') }
  const d2 = await s2.created()
  assert.equal((await s2.cancel(d2.token)).status, 200)
  await settle()
  assert.deepEqual(s2.bank.removed, [])
})

test('отмена: заказ без phoneKey (данные стёрты): работает, чужой заказ пары не освобождает', async (t) => {
  const s = await stand(t)
  const a = await s.created()
  const key = s.order(a.token).phoneKey
  const b = await s.created({ warehouseRef: WH2 }) // занял пару
  s.patchOrder(a.token, { state: 'awaiting_payment' })
  assert.equal((await s.cancel(a.token)).status, 200)
  assert.equal(s.db.docs[`shopPhones/${key}`].openCard['V2-LID-R'], s.order(b.token).id, 'пара за новым заказом')
  const c = await s.created({ sku: 'V2-LID-H' })
  delete s.db.docs[s.order(c.token).path].phoneKey
  assert.equal((await s.cancel(c.token)).status, 200)
})

// ---------- токен сайта и формат ответов ----------

test('токен сайта: новые маршруты без него 403, не настроен 503; база и банк не тронуты', async (t) => {
  const routes = [
    ['POST', BASE, orderBody()],
    ['GET', `${BASE}/${'A'.repeat(22)}`],
    ['POST', `${BASE}/${'A'.repeat(22)}/pay`],
    ['POST', `${BASE}/${'A'.repeat(22)}/cancel`],
  ]
  const s = await stand(t)
  for (const headers of [{}, { 'x-shop-token': 'x'.repeat(TOKEN.length) }, { 'x-shop-token': `${TOKEN}0` }]) {
    for (const [method, path, body] of routes) {
      const r = await s.call(method, path, { body, headers })
      assert.equal(r.status, 403, `${method} ${path}`)
      assert.equal(errorOf(r), 'FORBIDDEN')
    }
  }
  assert.deepEqual(s.db.reads, [])
  assert.deepEqual(s.db.writes, [])
  const none = await stand(t, { token: '' })
  for (const [method, path, body] of routes) {
    const r = await none.call(method, path, { body })
    assert.equal(r.status, 503, path)
    assert.equal(errorOf(r), 'NOT_CONFIGURED')
  }
  assert.deepEqual(none.db.reads, [])
  assert.deepEqual(none.bank.created, [])
})

test('ошибки базы: 500 в JSON без подробностей на всех маршрутах заказа', async (t) => {
  const s = await stand(t)
  const d = await s.created()
  s.db.failRead = (path) => path === 'shopOrders' || path.startsWith('shopOrders/')
  for (const r of [await s.create(), await s.status(d.token), await s.pay(d.token), await s.cancel(d.token)]) {
    assert.equal(r.status, 500, r.text)
    assert.deepEqual(r.json, { success: false, error: { code: 'INTERNAL', message: 'Internal error' } })
  }
})

test('ошибки базы: сбой чтения настроек или прайса при создании: 500, а не «товара нет»; транзакция упала: 500, банк не вызван', async (t) => {
  for (const path of ['system/shopSales', 'priceList/current', 'fops/fop-2']) {
    const s = await stand(t)
    s.db.failRead = (p) => p === path
    const r = await s.create()
    assert.equal(r.status, 500, path)
    assertNothingCreated(s)
  }
  const s = await stand(t)
  const was = s.db.runTransaction.bind(s.db)
  s.db.runTransaction = async () => { throw new Error('ABORTED') }
  const r = await s.create()
  assert.equal(r.status, 500)
  assert.deepEqual(s.bank.created, [])
  s.db.runTransaction = was
})

test('адрес мимо маршрута под заказами: 404 в JSON от общего обработчика', async (t) => {
  const s = await stand(t)
  for (const [method, path] of [['GET', BASE], ['POST', `${BASE}/${'A'.repeat(22)}/refund`], ['DELETE', `${BASE}/${'A'.repeat(22)}`]]) {
    const r = await s.call(method, path)
    assert.equal(r.status, 404, path)
    assert.equal(errorOf(r), 'NOT_FOUND')
  }
})

// ---------- подключение ----------

test('index.js: магазин получает настоящие оплаты', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const register = src.indexOf('registerShopOrders(app, { adminDb, npRequest, hooks: shopHooks, payments: paymentsApi, siteUrl: SITE_URL })')
  assert.ok(register > 0)
  assert.ok(src.indexOf('const paymentsApi = registerPayments(') < register)
})

test('маршруты заказа стоят выше общего 404 магазина', () => {
  const src = readFileSync(new URL('./shopOrders.js', import.meta.url), 'utf8')
  const fence = src.indexOf('конец маршрутов сайта')
  for (const route of ["app.post('/api/shop/orders',", "app.get('/api/shop/orders/:token',", "app.post('/api/shop/orders/:token/pay',", "app.post('/api/shop/orders/:token/cancel',"]) {
    const at = src.indexOf(route)
    assert.ok(at > 0 && at < fence, route)
  }
})
