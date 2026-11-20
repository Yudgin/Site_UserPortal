// node --test: оплаты ремонтов, заказов лодок и магазина картой monobank (server/payments.js, server/shopPayments.js).
// Настоящие monoAcquire.js и checkbox.js поверх подменённого axios: закрепляем то, что реально уходит банку и в кассу. Без сети и Firebase.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { once } from 'events'
import axios from 'axios'
import express from 'express'

// fops.js, monoAcquire.js и checkbox.js читают env при импорте, поэтому задаём его до импорта.
const cashbox = (n, extra = {}) => ({ licenseKey: `LIC-${n}`, pinCode: `PIN-${n}`, cashierName: `Касир ${n}`, ...extra })
process.env.FOPS_CONFIG = JSON.stringify([
  { id: 'fop-a', name: 'ФОП А', monoAcquire: { token: 'MONO-A' }, checkbox: cashbox('A') },
  { id: 'fop-b', name: 'ФОП Б', monoAcquire: { token: 'MONO-B' }, checkbox: cashbox('B') },
  { id: 'fop-first', name: 'ФОП вхід', monoAcquire: { token: 'MONO-F' }, checkbox: cashbox('F') },
  { id: 'fop-401', name: 'ФОП 401', monoAcquire: { token: 'MONO-E' }, checkbox: cashbox('E') },
  { id: 'fop-stale', name: 'ФОП старий токен', monoAcquire: { token: 'MONO-S' }, checkbox: cashbox('S') },
  { id: 'fop-shift', name: 'ФОП зміна', monoAcquire: { token: 'MONO-Z' }, checkbox: cashbox('Z') },
  { id: 'fop-login', name: 'ФОП логін', monoAcquire: { token: 'MONO-L' }, checkbox: { licenseKey: 'LIC-L', login: 'cashier', password: 'pass' } },
  { id: 'fop-nock', name: 'ФОП без каси', monoAcquire: { token: 'MONO-N' } },
  { id: 'fop-nomono', name: 'ФОП без еквайрингу', checkbox: cashbox('M') },
  { id: 'fop-off', name: 'ФОП вимкнений', active: false, monoAcquire: { token: 'MONO-O' }, checkbox: cashbox('O') },
])
delete process.env.MONO_ACQUIRE_BASE_URL
delete process.env.CHECKBOX_BASE_URL
process.env.PAYMENTS_RECONCILE = 'false'
const { registerPayments } = await import('./payments.js')

// Журнал сервера на весь файл идёт в список текущего стенда: часть проверок читает именно его.
let logs = []
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => logs.push({ level, text: args.map(String).join(' ') })

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()

// ---------- фейковый Firestore: транзакции по очереди и с записью в конце, как настоящая изоляция ----------
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue // ignoreUndefinedProperties, как в index.js
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) {
    this.docs = {}
    this.reads = []
    this.ops = 0
    this.failRead = null
    this.txQueue = Promise.resolve()
    for (const [path, v] of Object.entries(seed)) this.docs[path] = clone(v)
  }
  get(path) { return clone(this.docs[path]) }
  put(path, v) { this.docs[path] = clone(v) }
  read(path) {
    this.ops++
    this.reads.push(path)
    if (this.failRead && this.failRead(path)) throw new Error('Firestore недоступний')
  }
  write(path, v, opts) {
    this.ops++
    if (opts && opts.merge && this.docs[path]) deepMerge(this.docs[path], v)
    else this.docs[path] = clone(v)
  }
  collection(name) {
    const db = this
    // Без orderBy Firestore отдаёт документы по id, поэтому limit() берёт первых по id, а не новейших.
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
        const path = `${name}/${id}`
        return {
          id, path,
          async get() { db.read(path); const d = db.docs[path]; return { id, exists: !!d, data: () => clone(d) } },
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
      const tx = {
        async get(ref) { if (writes.length) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
        set(ref, v, opts) { writes.push([ref.path, v, opts]) },
      }
      const out = await fn(tx)
      for (const [path, v, opts] of writes) this.write(path, v, opts)
      return out
    }
    const p = this.txQueue.then(run)
    this.txQueue = p.catch(() => {})
    return p
  }
}

// ---------- подмена сети: всё, что не описано здесь, считается ошибкой теста ----------
const MONO = 'https://api.monobank.ua/api/merchant'
const CBX = 'https://api.checkbox.in.ua/api/v1'
const KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
const pubkeyAnswer = (pem) => ({ key: Buffer.from(pem).toString('base64') })
const signBody = (raw, privateKey = KEY.privateKey) => crypto.createSign('SHA256').update(raw).end().sign(privateKey).toString('base64')
const httpErr = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } })

const net = {
  calls: [], unexpected: [], inflight: 0, on: {},
  reset() {
    let n = 0
    this.calls = []
    this.unexpected = []
    this.inflight = 0
    this.on = {
      invoice: () => { n++; return { invoiceId: `inv-${n}`, pageUrl: `https://pay.example/inv-${n}` } },
      invoiceStatus: (invoiceId) => ({ invoiceId, status: 'processing' }),
      pubkey: () => pubkeyAnswer(KEY.publicKey),
      invoiceRemove: () => ({}),
      signin: (license) => ({ access_token: `cashier-${license}` }),
      sell: (payload) => ({ id: payload.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' }),
      receipt: (id) => ({ id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' }),
      shift: () => ({ status: 'OPENED' }),
      openShift: () => ({ status: 'OPENING' }),
      telegram: () => ({ ok: true }),
    }
  },
  of(method, url) { return this.calls.filter((c) => c.method === method && c.url === url) },
}
const dispatch = async (method, url, body, cfg = {}) => {
  net.calls.push({ method, url, body: clone(body), headers: cfg.headers, params: cfg.params, timeout: cfg.timeout })
  net.inflight++
  try {
    const on = net.on
    if (method === 'POST' && url === `${MONO}/invoice/create`) return { data: await on.invoice(body) }
    if (method === 'GET' && url === `${MONO}/invoice/status`) return { data: await on.invoiceStatus(cfg.params.invoiceId) }
    if (method === 'POST' && url === `${MONO}/invoice/remove`) return { data: await on.invoiceRemove(body) }
    if (method === 'GET' && url === `${MONO}/pubkey`) return { data: await on.pubkey() }
    if (method === 'POST' && (url === `${CBX}/cashier/signinPinCode` || url === `${CBX}/cashier/signin`)) return { data: await on.signin(cfg.headers['X-License-Key']) }
    if (method === 'GET' && url === `${CBX}/cashier/shift`) return { data: await on.shift() }
    if (method === 'POST' && url === `${CBX}/shifts`) return { data: await on.openShift() }
    if (method === 'POST' && url === `${CBX}/receipts/sell`) return { data: await on.sell(body) }
    if (method === 'GET' && url.startsWith(`${CBX}/receipts/`)) return { data: await on.receipt(url.slice(`${CBX}/receipts/`.length)) }
    if (method === 'POST' && url.startsWith('https://api.telegram.org/')) return { data: await on.telegram(body) }
    net.unexpected.push(`${method} ${url}`)
    throw new Error(`Непередбачений мережевий виклик: ${method} ${url}`)
  } finally {
    net.inflight--
  }
}
axios.post = (url, body, cfg) => dispatch('POST', url, body, cfg)
axios.get = (url, cfg) => dispatch('GET', url, undefined, cfg)
for (const m of ['request', 'put', 'patch', 'delete', 'head']) axios[m] = (url) => dispatch(m.toUpperCase(), url)
afterEach(() => assert.deepEqual(net.unexpected, [], 'сервер пошёл в сеть не туда'))

const sells = () => net.of('POST', `${CBX}/receipts/sell`)
const invoices = () => net.of('POST', `${MONO}/invoice/create`)
const statusChecks = () => net.of('GET', `${MONO}/invoice/status`)

// ---------- стенд: Express как в index.js (rawBody для подписи), env только на регистрацию ----------
const ADMIN = { 'x-admin-token': 'ADMIN-TOKEN' }
const ENV_KEYS = ['PUBLIC_BASE_URL', 'PAYMENTS_SANDBOX', 'PAYMENTS_ADMIN_TOKEN', 'OWNER_TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']
const mount = async (t, seed = {}, { env = {}, deps = {}, db = new FakeDb(seed) } = {}) => {
  net.reset()
  const journal = []
  logs = journal
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, { PAYMENTS_ADMIN_TOKEN: ADMIN['x-admin-token'] }, env)
  const app = express()
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
  const api = registerPayments(app, { adminDb: db, ...deps })
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  // Только IPv4-петля: при listen(0) на всех адресах порт мог совпасть с чужим сервисом на 127.0.0.1, и запрос уходил к нему.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`

  const send = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* не JSON: sendStatus */ }
    return { status: r.status, json, text }
  }
  // Колбэк отвечает 200 сразу и работает дальше в фоне: ждём, пока база и сеть затихнут.
  const idle = async () => {
    let last = -1
    let calm = 0
    for (let i = 0; i < 400 && calm < 2; i++) {
      const cur = (db ? db.ops : 0) + net.calls.length
      calm = cur === last && !net.inflight ? calm + 1 : 0
      last = cur
      await sleep(5)
    }
    assert.ok(calm >= 2, 'фоновая обработка не закончилась')
  }
  const postHook = async (body, { privateKey, sign = true, xSign, raw = JSON.stringify(body) } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(sign ? { 'X-Sign': xSign ?? signBody(raw, privateKey) } : {}) }
    const r = await fetch(`${base}/api/mono/acquire/callback`, { method: 'POST', headers, body: raw })
    await r.text()
    assert.equal(r.status, 200, 'банку всегда отвечаем 200')
  }
  const hook = async (body, opts) => { await postHook(body, opts); await idle() }
  const logged = (level, part) => journal.some((l) => l.level === level && l.text.includes(part))
  return { db, api, send, idle, postHook, hook, logged }
}

// ---------- данные ----------
const GOODS = [
  { name: 'Діагностика', price: 500, qty: 1, code: 'WORK-1' },
  { name: 'Заміна кришки', price: 500.25, qty: 2 },
]
const SELL_GOODS = [
  { good: { code: 'WORK-1', name: 'Діагностика', price: 50000 }, quantity: 1000 },
  { good: { code: 'POS-2', name: 'Заміна кришки', price: 50025 }, quantity: 2000 },
]
const LABEL = 'Оплата карткою (monobank)'
const RESULT_URL = 'https://my.runferry.com/pay/result'
const estimate = (over = {}) => ({ id: 'est-1', kind: 'actual', status: 'approved', total: 1500.5, fopId: 'fop-a', receiptGoods: GOODS, serviceRequestId: 'sr-1', ...over })
const repairSeed = (over = {}) => ({ 'priceEstimates/est-1': estimate(over), 'serviceRequests/sr-1': { status: 'in_progress' } })
const payment = (over = {}) => ({
  orderId: 'pay-1', fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', provider: 'mono-acquire', providerOrderId: 'inv-1',
  status: 'pending', createdAt: ago(10), estimateId: 'est-1', serviceRequestId: 'sr-1', ...over,
})
const paySeed = (over = {}) => ({ ...repairSeed(), 'payments/pay-1': payment(over) })
const ok = (over = {}) => ({ invoiceId: 'inv-1', status: 'success', amount: 150050, ccy: 980, reference: 'pay-1', ...over })
// Формула id чека написана здесь заново: id уходит в Checkbox как защита от дубля, менять его нельзя.
const receiptUuid = (orderId) => {
  const h = crypto.createHash('sha256').update(`rcpt-${orderId}`).digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}
const sellBody = (orderId, label = LABEL, over = {}) => ({
  id: receiptUuid(orderId), cashier_name: 'Касир A', goods: SELL_GOODS,
  payments: [{ type: 'CASHLESS', value: 150050, label }], ...over,
})
const withoutTimes = ({ createdAt, updatedAt, ...rest }) => {
  assert.match(createdAt, ISO)
  assert.match(updatedAt, ISO)
  return rest
}

// ---------- создание счёта ----------

test('счёт ремонта: точное тело для банка, заголовки, документ оплаты, ответ маршрута', async (t) => {
  const a = await mount(t, repairSeed())
  const r = await a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', resultUrl: RESULT_URL })
  assert.equal(r.status, 200)
  const { orderId } = r.json.data
  assert.match(orderId, /^pay-[0-9a-f-]{18}$/)
  assert.deepEqual(r.json, { success: true, data: { orderId, provider: 'mono-acquire', pageUrl: 'https://pay.example/inv-1' } })

  assert.equal(invoices().length, 1)
  const [inv] = invoices()
  assert.deepEqual(inv.body, {
    amount: 150050,
    ccy: 980,
    merchantPaymInfo: {
      reference: orderId,
      destination: 'Оплата RunFerry (кошторис est-1)',
      basketOrder: [
        { name: 'Діагностика', qty: 1, sum: 50000, unit: 'шт.', code: 'WORK-1' },
        { name: 'Заміна кришки', qty: 2, sum: 100050, unit: 'шт.', code: 'Заміна кришки' },
      ],
    },
    redirectUrl: RESULT_URL,
    paymentType: 'debit',
  })
  assert.deepEqual(inv.headers, { 'X-Token': 'MONO-A', 'Content-Type': 'application/json' })
  assert.equal(inv.timeout, 20000)

  assert.deepEqual(withoutTimes(a.db.get(`payments/${orderId}`)), {
    orderId, fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', status: 'pending',
    estimateId: 'est-1', serviceRequestId: 'sr-1', provider: 'mono-acquire', providerOrderId: 'inv-1',
  })
  const est = a.db.get('priceEstimates/est-1')
  assert.match(est.payInitiatedAt, ISO)
  assert.equal(est.status, 'approved', 'смета становится оплаченной только после денег')
  assert.equal(est.paymentId, undefined)
  assert.equal(net.calls.length, 1, 'при создании счёта касса и Telegram не вызываются')
})

test('счёт: webHookUrl только при PUBLIC_BASE_URL, без него ни колбэка, ни срока, ни redirectUrl', async (t) => {
  const bare = await mount(t, repairSeed())
  await bare.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire' })
  const body = invoices()[0].body
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'ccy', 'merchantPaymInfo', 'paymentType'])

  const pub = await mount(t, repairSeed(), { env: { PUBLIC_BASE_URL: 'https://api.example/' } })
  await pub.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire' })
  assert.equal(invoices()[0].body.webHookUrl, 'https://api.example/api/mono/acquire/callback')
  assert.equal(invoices()[0].body.validity, undefined)
})

test('счёт: копейки построчно как в кассе, длинные поля обрезаются, код позиции из названия', async (t) => {
  const a = await mount(t)
  const long = 'Д'.repeat(300)
  const r = await a.send('POST', '/api/pay/create', {
    fopId: 'fop-a', method: 'mono-acquire', amount: 115.01, description: long,
    goods: [{ name: long, price: 33.33, qty: 3 }, { name: 'Мастило', price: 10.01, qty: 1.5, code: 'C'.repeat(60) }],
  }, ADMIN)
  assert.equal(r.status, 200)
  const body = invoices()[0].body
  assert.equal(body.amount, 11501)
  assert.equal(body.merchantPaymInfo.destination, 'Д'.repeat(280))
  assert.deepEqual(body.merchantPaymInfo.basketOrder, [
    { name: 'Д'.repeat(128), qty: 3, sum: 9999, unit: 'шт.', code: 'Д'.repeat(50) },
    { name: 'Мастило', qty: 1.5, sum: 1502, unit: 'шт.', code: 'C'.repeat(50) },
  ])
  assert.equal(a.db.get(`payments/${r.json.data.orderId}`).amount, 115.01)
})

test('/api/pay/create: только админ, назначение по умолчанию, лишние поля тела не доходят до банка и документа', async (t) => {
  const a = await mount(t)
  const payload = {
    fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', resultUrl: RESULT_URL,
    validitySec: 3600, webHookBase: 'https://evil.example', shopOrderId: 'so-1', paymentLabel: 'Чужа підпис', fopOverride: { id: 'x' },
  }
  const denied = await a.send('POST', '/api/pay/create', payload)
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'FORBIDDEN')
  assert.equal(invoices().length, 0)

  const r = await a.send('POST', '/api/pay/create', payload, ADMIN)
  assert.equal(r.status, 200)
  const { orderId } = r.json.data
  const body = invoices()[0].body
  assert.equal(body.merchantPaymInfo.destination, `Оплата RunFerry #${orderId}`)
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'ccy', 'merchantPaymInfo', 'paymentType', 'redirectUrl'])
  assert.deepEqual(withoutTimes(a.db.get(`payments/${orderId}`)), {
    orderId, fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', status: 'pending', provider: 'mono-acquire', providerOrderId: 'inv-1',
  })
})

test('createPayment: отказы без обращения к банку и без документа', async (t) => {
  const a = await mount(t)
  const base = { fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire' }
  const cases = [
    [{ fopId: 'nope' }, 'BAD_FOP'],
    [{ fopId: 'fop-off' }, 'FOP_INACTIVE'],
    [{ goods: [] }, 'BAD_GOODS'],
    [{ goods: [{ name: 'x', price: 0 }] }, 'BAD_GOODS'],
    [{ goods: [{ name: 'x', price: 1, qty: -1 }] }, 'BAD_GOODS'],
    [{ amount: 0 }, 'BAD_AMOUNT'],
    [{ amount: 'abc' }, 'BAD_AMOUNT'],
    [{ amount: 1500.49 }, 'AMOUNT_MISMATCH'],
    [{ fopId: 'fop-nomono' }, 'NO_MONO_ACQUIRE'],
    [{ method: 'cash' }, 'BAD_METHOD'],
  ]
  for (const [over, code] of cases) {
    const r = await a.send('POST', '/api/pay/create', { ...base, ...over }, ADMIN)
    assert.equal(r.status, 400, code)
    assert.equal(r.json.error.code, code)
  }
  assert.equal(net.calls.length, 0)
  assert.deepEqual(Object.keys(a.db.docs), [])
})

test('оплата сметы: отказы по состоянию и захват payInitiatedAt', async (t) => {
  const a = await mount(t, { 'serviceRequests/sr-1': {} })
  const pay = () => a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire' })
  const cases = [
    [{ kind: 'preliminary' }, 400, 'NOT_ACTUAL'],
    [{ paymentId: 'pay-0' }, 409, 'ALREADY_PAID'],
    [{ status: 'paid' }, 409, 'ALREADY_PAID'],
    [{ status: 'rejected' }, 409, 'REJECTED'],
    [{ status: 'pending_approval' }, 409, 'NEEDS_APPROVAL'],
    [{ status: 'draft' }, 409, 'NOT_APPROVED'],
    [{ receiptGoods: [] }, 400, 'NO_GOODS'],
    [{ fopId: null }, 400, 'NO_FOP'],
    [{ payInitiatedAt: ago(1) }, 409, 'PAY_IN_PROGRESS'],
  ]
  assert.equal((await pay()).status, 404)
  for (const [over, status, code] of cases) {
    a.db.put('priceEstimates/est-1', estimate(over))
    const r = await pay()
    assert.equal(r.status, status, code)
    assert.equal(r.json.error.code, code)
  }
  assert.equal(invoices().length, 0)

  a.db.put('priceEstimates/est-1', estimate({ payInitiatedAt: ago(4) }))
  assert.equal((await pay()).status, 200, 'захват старше 3 минут не мешает')
  assert.equal((await pay()).json.error.code, 'PAY_IN_PROGRESS', 'сразу после счёта второй не создаётся')
  assert.equal(invoices().length, 1)
})

test('оплата сметы: неудача снимает захват, ФОП берётся со сметы или из payOptions, а не из тела', async (t) => {
  const a = await mount(t)
  const pay = (body = {}) => a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', ...body })
  const claim = () => a.db.get('priceEstimates/est-1').payInitiatedAt

  a.db.put('priceEstimates/est-1', estimate({ total: 1000 }))
  assert.equal((await pay()).json.error.code, 'AMOUNT_MISMATCH')
  assert.equal(claim(), null)

  a.db.put('priceEstimates/est-1', estimate({ payOptions: [{ method: 'liqpayCard', fopId: 'fop-b' }] }))
  assert.equal((await pay()).json.error.code, 'METHOD_NOT_ALLOWED')
  assert.equal(claim(), null)

  a.db.put('priceEstimates/est-1', estimate())
  net.on.invoice = () => { throw httpErr(500, { errText: 'bank down' }) }
  const failed = await pay()
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error.code, 'PAY_FAILED')
  assert.equal(claim(), null)
  assert.equal(Object.keys(a.db.docs).some((p) => p.startsWith('payments/')), false, 'без счёта нет и документа')

  net.reset()
  a.db.put('priceEstimates/est-1', estimate({ payOptions: [{ method: 'monoAcquire', fopId: 'fop-b' }] }))
  const r = await pay({ fopId: 'fop-a' })
  assert.equal(r.status, 200)
  assert.equal(a.db.get(`payments/${r.json.data.orderId}`).fopId, 'fop-b')
  assert.equal(invoices()[0].headers['X-Token'], 'MONO-B')

  net.reset()
  a.db.put('priceEstimates/est-1', estimate())
  const own = await pay({ fopId: 'fop-b' })
  assert.equal(a.db.get(`payments/${own.json.data.orderId}`).fopId, 'fop-a')
})

test('оплата заказа лодки: только админ, скидка в цене, тело без срока, ссылка на заказе', async (t) => {
  const boat = { status: 'new', total: 900, clientPhone: '+380000000000', lines: [{ label: 'Кораблик', price: 1000, qty: 1, extraOff: 10, extraOffKind: 'pct' }] }
  const a = await mount(t, { 'boatOrders/bo-1': boat })
  const body = { boatOrderId: 'bo-1', fopId: 'fop-a', method: 'mono-acquire' }
  assert.equal((await a.send('POST', '/api/boat-orders/pay', body)).status, 403)
  assert.equal(invoices().length, 0)

  const r = await a.send('POST', '/api/boat-orders/pay', body, ADMIN)
  assert.equal(r.status, 200)
  const { orderId } = r.json.data
  assert.deepEqual(invoices()[0].body, {
    amount: 90000,
    ccy: 980,
    merchantPaymInfo: {
      reference: orderId,
      destination: 'Оплата кораблика (замовлення bo-1)',
      basketOrder: [{ name: 'Кораблик', qty: 1, sum: 90000, unit: 'шт.', code: 'POS-1' }],
    },
    paymentType: 'debit',
  })
  assert.deepEqual(withoutTimes(a.db.get(`payments/${orderId}`)), {
    orderId, fopId: 'fop-a', amount: 900, goods: [{ name: 'Кораблик', price: 900, qty: 1, code: 'POS-1' }], method: 'mono-acquire', status: 'pending',
    boatOrderId: 'bo-1', provider: 'mono-acquire', providerOrderId: 'inv-1',
  })
  const after = a.db.get('boatOrders/bo-1')
  assert.equal(after.paymentId, orderId)
  assert.equal(after.payMethod, 'mono-acquire')
  assert.equal(after.payUrl, 'https://pay.example/inv-1')
  assert.equal(after.payInitiatedAt, null)
  assert.match(after.payCreatedAt, ISO)
  assert.equal(after.status, 'new')

  assert.equal((await a.send('POST', '/api/boat-orders/pay', body, ADMIN)).status, 200, 'неоплаченный счёт можно выставить заново')
  for (const [over, code] of [[{ paidAt: ago(1) }, 'ALREADY_PAID'], [{ status: 'cancelled' }, 'CANCELLED'], [{ payTo: 'dropshipper' }, 'DROPSHIP_PAY'], [{ payInitiatedAt: ago(1) }, 'PAY_IN_PROGRESS']]) {
    a.db.put('boatOrders/bo-1', { ...boat, ...over })
    const denied = await a.send('POST', '/api/boat-orders/pay', body, ADMIN)
    assert.equal(denied.status, 409, code)
    assert.equal(denied.json.error.code, code)
  }
})

// ---------- колбэк monobank ----------

test('колбэк успеха: paid, один чек с точным телом и подписью, смета и заявка закрыты', async (t) => {
  const a = await mount(t, repairSeed())
  const created = await a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire' })
  const { orderId } = created.json.data
  await a.hook({ invoiceId: 'inv-1', status: 'success', amount: 150050, ccy: 980, reference: orderId })

  assert.equal(sells().length, 1)
  assert.deepEqual(sells()[0].body, sellBody(orderId))
  assert.deepEqual(sells()[0].headers, { 'Content-Type': 'application/json', 'X-Client-Name': 'RunFerry-Backend', 'X-License-Key': 'LIC-A', Authorization: 'Bearer cashier-LIC-A' })
  assert.equal(sells()[0].timeout, 30000)

  const doc = a.db.get(`payments/${orderId}`)
  assert.equal(doc.status, 'paid')
  assert.equal(doc.paytype, 'mono-acquire')
  assert.equal(doc.receiptId, receiptUuid(orderId))
  assert.equal(doc.fiscalCode, 'FC-1')
  assert.equal(doc.taxUrl, 'https://check.example/1')
  assert.equal(doc.receiptStatus, 'DONE')
  assert.equal(doc.receiptError, null)
  assert.match(doc.receiptAt, ISO)
  assert.match(doc.fiscalizeClaimedAt, ISO)

  const est = a.db.get('priceEstimates/est-1')
  assert.equal(est.status, 'paid')
  assert.equal(est.paymentId, orderId)
  assert.equal(est.fopId, 'fop-a')
  assert.equal(est.taxUrl, 'https://check.example/1')
  assert.equal(est.fiscalCode, 'FC-1')
  assert.match(est.paidAt, ISO)

  const sr = a.db.get('serviceRequests/sr-1')
  assert.equal(sr.status, 'done')
  assert.equal(sr.paymentId, orderId)
  assert.match(sr.paidAt, ISO)
  assert.match(sr.doneAt, ISO)
  assert.match(sr.statusChangedAt, ISO)
})

test('колбэк успеха: e-mail из оплаты уходит в чек, отменённую заявку не воскрешает', async (t) => {
  const a = await mount(t, { ...paySeed({ deliveryEmail: 'client@example.com' }), 'serviceRequests/sr-1': { status: 'cancelled' } })
  await a.hook(ok())
  assert.deepEqual(sells()[0].body, sellBody('pay-1', LABEL, { delivery: { email: 'client@example.com' } }))
  const sr = a.db.get('serviceRequests/sr-1')
  assert.equal(sr.status, 'cancelled')
  assert.equal(sr.paymentId, 'pay-1')
  assert.match(sr.paidAt, ISO)
})

test('колбэк успеха: заказ лодки получает оплату и чек, его статус не трогается', async (t) => {
  const goods = [{ name: 'Кораблик', price: 900, qty: 1, code: 'POS-1' }]
  const a = await mount(t, {
    'boatOrders/bo-1': { status: 'new' },
    'payments/pay-1': payment({ goods, amount: 900, boatOrderId: 'bo-1', estimateId: undefined, serviceRequestId: undefined }),
  })
  await a.hook(ok({ amount: 90000 }))
  assert.deepEqual(sells()[0].body.payments, [{ type: 'CASHLESS', value: 90000, label: LABEL }])
  const bo = a.db.get('boatOrders/bo-1')
  assert.equal(bo.status, 'new')
  assert.equal(bo.paymentId, 'pay-1')
  assert.equal(bo.taxUrl, 'https://check.example/1')
  assert.equal(bo.fiscalCode, 'FC-1')
  assert.match(bo.paidAt, ISO)
})

test('колбэк: неверная подпись, чужой ключ и пустая подпись ничего не меняют', async (t) => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const a = await mount(t, paySeed())
  const before = a.db.get('payments/pay-1')
  await a.hook(ok(), { privateKey: other.privateKey })
  assert.ok(a.logged('warn', 'mono acquire callback: неверная подпись pay-1'))
  await a.hook(ok(), { xSign: 'AAAA' })
  await a.hook(ok(), { sign: false })
  assert.deepEqual(a.db.get('payments/pay-1'), before)
  assert.equal(sells().length, 0)
  assert.equal(a.db.get('priceEstimates/est-1').status, 'approved')
})

test('колбэк: подпись считается по сырому телу, ключ банка перечитывается после смены', async (t) => {
  const rotated = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const a = await mount(t, paySeed())
  await a.hook(ok({ status: 'processing' }), { raw: JSON.stringify(ok({ status: 'processing' }), null, 2) }) // тело с отступами: подпись по байтам, не по разбору
  assert.equal(a.logged('warn', 'неверная подпись'), false)
  net.on.pubkey = () => pubkeyAnswer(rotated.publicKey)
  await a.hook(ok(), { privateKey: rotated.privateKey })
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.equal(sells().length, 1)
  assert.deepEqual(net.of('GET', `${MONO}/pubkey`).at(-1).headers, { 'X-Token': 'MONO-A' })
})

test('колбэк: неизвестный счёт и тело без invoiceId ничего не делают', async (t) => {
  const a = await mount(t, paySeed())
  const before = clone(a.db.docs)
  await a.hook(ok({ invoiceId: 'inv-other' }))
  assert.ok(a.logged('warn', 'mono acquire callback: заказ не найден inv-other'))
  await a.hook({ status: 'success' })
  assert.deepEqual(a.db.docs, before)
  assert.equal(net.calls.length, 0, 'без документа подпись и касса не нужны')
})

test('колбэк: повтор после оплаты не даёт второго чека и не переписывает документ', async (t) => {
  const a = await mount(t, paySeed())
  await a.hook(ok())
  const after = a.db.get('payments/pay-1')
  await a.hook(ok())
  assert.equal(sells().length, 1)
  assert.deepEqual(a.db.get('payments/pay-1'), after)
})

test('захват: два параллельных колбэка успеха дают один чек', async (t) => {
  const a = await mount(t, paySeed())
  net.on.sell = async (p) => { await sleep(20); return { id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' } }
  await Promise.all([a.postHook(ok()), a.postHook(ok()), a.postHook(ok())])
  await a.idle()
  assert.equal(sells().length, 1)
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.receiptId, receiptUuid('pay-1'))
})

test('захват: живой чужой захват останавливает чек, захват пишется до обращения к кассе', async (t) => {
  const taken = await mount(t, paySeed({ status: 'paid', fiscalizeClaimedAt: ago(1) }))
  await taken.hook(ok())
  assert.equal(sells().length, 0)
  assert.equal(taken.db.get('payments/pay-1').receiptId, undefined)

  const a = await mount(t, paySeed())
  let claimAtSell = null
  net.on.sell = (p) => { claimAtSell = a.db.get('payments/pay-1').fiscalizeClaimedAt; return { id: p.id, status: 'DONE' } }
  await a.hook(ok())
  assert.match(claimAtSell, ISO)
})

test('колбэк: failure, expired и reversed по неоплаченному пишут статус и не бьют чек', async (t) => {
  for (const status of ['failure', 'expired', 'reversed']) {
    const a = await mount(t, paySeed())
    await a.hook(ok({ status }))
    assert.equal(a.db.get('payments/pay-1').status, status)
    assert.equal(sells().length, 0)
    assert.equal(a.db.get('priceEstimates/est-1').status, 'approved')
  }
})

test('колбэк: после оплаты статус не откатывается, reversed у ремонта игнорируется, промежуточные статусы не пишутся', async (t) => {
  const a = await mount(t, paySeed())
  await a.hook(ok())
  const paid = a.db.get('payments/pay-1')
  for (const status of ['failure', 'expired', 'reversed', 'processing']) await a.hook(ok({ status }))
  assert.deepEqual(a.db.get('payments/pay-1'), paid)
  assert.equal(a.db.get('priceEstimates/est-1').status, 'paid')
  assert.equal(sells().length, 1)

  const b = await mount(t, paySeed())
  const pending = b.db.get('payments/pay-1')
  for (const status of ['created', 'processing', 'hold']) await b.hook(ok({ status }))
  assert.deepEqual(b.db.get('payments/pay-1'), pending)
})

test('колбэк: сумма из тела у ремонта не проверяется и чек не отменяет', async (t) => {
  const a = await mount(t, paySeed())
  await a.hook(ok({ amount: 1, ccy: 840 }))
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.deepEqual(sells()[0].body, sellBody('pay-1'))
})

test('чек не вышел: деньги видны, захват снят, ошибка записана, повтор выбивает тот же id', async (t) => {
  const a = await mount(t, paySeed())
  net.on.sell = () => { throw httpErr(422, { message: 'Bad goods' }) }
  await a.hook(ok())
  let doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.receiptStatus, 'error')
  assert.equal(doc.receiptError, '{"message":"Bad goods"}')
  assert.equal(doc.fiscalizeClaimedAt, null)
  assert.equal(doc.receiptId, undefined)
  const est = a.db.get('priceEstimates/est-1')
  assert.equal(est.status, 'paid', 'деньги пришли')
  assert.equal(est.taxUrl, undefined)
  assert.ok(a.logged('error', 'ОШИБКА ЧЕКА'))

  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  assert.equal(a.db.get('payments/pay-1').receiptError, 'timeout')

  net.on.sell = (p) => ({ id: p.id, status: 'DONE', fiscal_code: 'FC-2', tax_url: 'https://check.example/2' })
  await a.hook(ok())
  doc = a.db.get('payments/pay-1')
  assert.equal(doc.receiptError, null)
  assert.equal(doc.receiptStatus, 'DONE')
  assert.equal(doc.taxUrl, 'https://check.example/2')
  assert.equal(a.db.get('priceEstimates/est-1').taxUrl, 'https://check.example/2')
  assert.equal(new Set(sells().map((c) => c.body.id)).size, 1, 'все попытки с одним id')
  assert.equal(sells().length, 3)
})

test('ФОП без кассы: деньги видны, чек не пытаемся выбить, захват не пишется', async (t) => {
  const a = await mount(t, paySeed({ fopId: 'fop-nock' }))
  await a.hook(ok())
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.receiptStatus, 'no-checkbox')
  assert.equal(doc.fiscalizeClaimedAt, undefined)
  assert.equal(a.db.get('priceEstimates/est-1').status, 'paid')
  assert.equal(a.db.get('priceEstimates/est-1').taxUrl, undefined)
  assert.equal(sells().length, 0)
  assert.ok(a.logged('warn', 'ГРОШІ Є, ЧЕК НЕ ВИБИТО'))

  // Кассу у ФОП сняли позже: повтор колбэка не должен затереть уже выбитый чек меткой «no-checkbox».
  const later = await mount(t, paySeed({ fopId: 'fop-nock', status: 'paid', receiptId: 'r-1', receiptStatus: 'DONE' }))
  const done = later.db.get('payments/pay-1')
  await later.hook(ok())
  assert.deepEqual(later.db.get('payments/pay-1'), done)
})

test('алерт владельцу: один раз на оплату, точный текст; без переменных Telegram не вызывается', async (t) => {
  const env = { OWNER_TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG' }
  const url = 'https://api.telegram.org/botTG/sendMessage'
  const a = await mount(t, paySeed(), { env })
  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  await a.hook(ok())
  assert.equal(sells().length, 2)
  assert.equal(net.of('POST', url).length, 1)
  assert.deepEqual(net.of('POST', url)[0].body, { chat_id: '42', text: '⚠️ RunFerry: оплата pay-1 на 1500.5 грн пройшла, але ЧЕК НЕ ВИБИТО (помилка Checkbox). ФОП fop-a. Перевірте в адмінці оплат.' })
  assert.equal(net.of('POST', url)[0].timeout, 8000)
  assert.equal(a.db.get('payments/pay-1').ownerNotified, true)

  const noCb = await mount(t, paySeed({ fopId: 'fop-nock' }), { env })
  await noCb.hook(ok())
  assert.match(net.of('POST', url)[0].body.text, /ЧЕК НЕ ВИБИТО \(ФОП без Checkbox\)\. ФОП fop-nock\./)

  assert.ok(net.of('POST', url).every((c) => !c.body.text.includes("Пам'ятка")), 'у ремонта строки памятки нет')

  const silent = await mount(t, paySeed())
  net.on.sell = () => { throw new Error('timeout') }
  await silent.hook(ok())
  assert.equal(net.calls.some((c) => c.url.includes('telegram')), false)

  const broken = await mount(t, paySeed(), { env })
  net.on.sell = () => { throw new Error('timeout') }
  net.on.telegram = () => { throw new Error('tg down') }
  await broken.hook(ok())
  assert.ok(broken.logged('error', 'notifyOwner: tg down'))
  assert.equal(broken.db.get('payments/pay-1').receiptStatus, 'error')
})

test('касса: вход кассира один раз, по коду или логину, cashier_name из имени ФОП', async (t) => {
  const a = await mount(t, paySeed({ fopId: 'fop-first' }))
  await a.hook(ok())
  const steps = net.calls.map((c) => c.url.replace(CBX, '')).filter((u) => !u.startsWith('https://api.monobank'))
  assert.deepEqual(steps, ['/cashier/signinPinCode', '/cashier/shift', '/receipts/sell'])
  assert.deepEqual(net.of('POST', `${CBX}/cashier/signinPinCode`)[0].body, { pin_code: 'PIN-F' })
  assert.equal(net.of('POST', `${CBX}/cashier/signinPinCode`)[0].headers.Authorization, undefined)

  const b = await mount(t, paySeed({ fopId: 'fop-first' }))
  await b.hook(ok())
  assert.equal(net.of('POST', `${CBX}/cashier/signinPinCode`).length, 0, 'токен кассира кэшируется')

  const c = await mount(t, paySeed({ fopId: 'fop-login' }))
  await c.hook(ok())
  assert.deepEqual(net.of('POST', `${CBX}/cashier/signin`)[0].body, { login: 'cashier', password: 'pass' })
  assert.equal(sells()[0].body.cashier_name, 'ФОП логін')
})

test('касса: 401 на чеке даёт один повторный вход и тот же id, ответ без id и статуса не теряет чек', async (t) => {
  const a = await mount(t, paySeed({ fopId: 'fop-401' }))
  let first = true
  net.on.sell = () => { if (first) { first = false; throw httpErr(401, {}) } return {} }
  await a.hook(ok())
  assert.equal(sells().length, 2)
  assert.equal(sells()[0].body.id, sells()[1].body.id)
  assert.equal(net.of('POST', `${CBX}/cashier/signinPinCode`).length, 2)
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.receiptId, receiptUuid('pay-1'), 'пустой ответ: остаётся наш id')
  assert.equal(doc.receiptStatus, 'done')
  assert.equal(doc.fiscalCode, null)
})

// ---------- сверка ----------

test('сверка: только по токену, success старше 5 минут закрывает оплату с той же подписью и id', async (t) => {
  const a = await mount(t, paySeed())
  assert.equal((await a.send('POST', '/api/pay/reconcile', {})).status, 403)
  assert.equal(net.calls.length, 0)

  net.on.invoiceStatus = (invoiceId) => ({ invoiceId, status: 'success', amount: 150050 })
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.deepEqual(r.json, { success: true, data: { checked: 1 } })
  assert.deepEqual(statusChecks()[0].params, { invoiceId: 'inv-1' })
  assert.deepEqual(statusChecks()[0].headers, { 'X-Token': 'MONO-A' })
  assert.equal(statusChecks()[0].timeout, 15000)
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.paytype, 'mono-acquire')
  assert.deepEqual(sells()[0].body, sellBody('pay-1'))
  assert.equal(a.db.get('priceEstimates/est-1').status, 'paid')

  await a.hook(ok())
  assert.equal(sells().length, 1, 'поздний колбэк после сверки второго чека не даёт')
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(statusChecks().length, 1, 'оплаченное больше не опрашивается')
})

test('сверка: сумма банка у ремонта не проверяется', async (t) => {
  const a = await mount(t, paySeed())
  net.on.invoiceStatus = (invoiceId) => ({ invoiceId, status: 'success', amount: 1, ccy: 840 })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.equal(sells().length, 1)
})

test('сверка: конечные статусы пишутся, промежуточные и свежие не трогаются, сбой банка не останавливает очередь', async (t) => {
  const answers = { 'inv-f': 'failure', 'inv-e': 'expired', 'inv-r': 'reversed', 'inv-c': 'created', 'inv-p': 'processing', 'inv-h': 'hold', 'inv-x': null, 'inv-n': 'failure' }
  const seed = {}
  for (const id of Object.keys(answers)) seed[`payments/${id}`] = payment({ orderId: id, providerOrderId: id, estimateId: undefined, serviceRequestId: undefined })
  seed['payments/fresh'] = payment({ orderId: 'fresh', providerOrderId: 'inv-fresh', createdAt: ago(4) })
  seed['payments/undated'] = payment({ orderId: 'undated', providerOrderId: 'inv-n', createdAt: null })
  seed['payments/noinv'] = payment({ orderId: 'noinv', providerOrderId: null })
  seed['payments/nofop'] = payment({ orderId: 'nofop', fopId: 'nope', providerOrderId: 'inv-nofop' })
  const a = await mount(t, seed)
  net.on.invoiceStatus = (id) => {
    if (id === 'inv-x') throw httpErr(500, {})
    return { invoiceId: id, status: answers[id] }
  }
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 9, 'опрошены все старые с ФОП и номером счёта, сбойный тоже считается')
  assert.equal(a.db.get('payments/inv-f').status, 'failure')
  assert.equal(a.db.get('payments/inv-e').status, 'expired')
  assert.equal(a.db.get('payments/inv-r').status, 'reversed')
  for (const id of ['inv-c', 'inv-p', 'inv-h', 'inv-x']) assert.equal(a.db.get(`payments/${id}`).status, 'pending', id)
  assert.equal(a.db.get('payments/inv-n').status, 'failure', 'очередь дошла до конца после сбоя')
  assert.equal(a.db.get('payments/undated').status, 'failure', 'без createdAt считается старым')
  for (const id of ['fresh', 'noinv', 'nofop']) assert.equal(a.db.get(`payments/${id}`).status, 'pending', id)
  const asked = statusChecks().map((c) => c.params.invoiceId)
  for (const id of ['inv-fresh', 'inv-nofop']) assert.equal(asked.includes(id), false, id)
  assert.ok(a.logged('error', 'reconcile mono-acquire inv-x'))
  assert.equal(sells().length, 0)
})

test('сверка: за проход не больше 50 документов pending', async (t) => {
  const seed = {}
  for (let i = 0; i < 53; i++) seed[`payments/p${i}`] = payment({ orderId: `p${i}`, providerOrderId: `i${i}` })
  const a = await mount(t, seed)
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 50)
  assert.equal(statusChecks().length, 50)
})

test('сверка: receiptStatus=error повторяет чек с подписью по провайдеру и тем же id, не трогает неоплаченные и выбитые', async (t) => {
  const failed = (id, provider) => payment({ orderId: id, provider, status: 'paid', receiptStatus: 'error', receiptError: 'x', fiscalizeClaimedAt: null, providerOrderId: `inv-${id}` })
  const a = await mount(t, {
    ...repairSeed(),
    'payments/m': failed('m', 'mono-acquire'),
    'payments/l': failed('l', 'liqpay'),
    'payments/c': failed('c', 'mono-chast'),
    'payments/np': { ...failed('np', 'mono-acquire'), status: 'failure' },
    'payments/hasrc': { ...failed('hasrc', 'mono-acquire'), receiptId: 'r-1' },
  })
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 3)
  const byId = Object.fromEntries(sells().map((c) => [c.body.id, c.body.payments[0].label]))
  assert.deepEqual(byId, {
    [receiptUuid('m')]: LABEL,
    [receiptUuid('l')]: 'Оплата частинами (LiqPay)',
    [receiptUuid('c')]: 'Оплата частинами (monobank)',
  })
  const doc = a.db.get('payments/m')
  assert.equal(doc.receiptStatus, 'DONE')
  assert.equal(doc.receiptError, null)
  assert.equal(a.db.get('priceEstimates/est-1').taxUrl, 'https://check.example/1')
  assert.equal(a.db.get('payments/np').receiptStatus, 'error')
})

test('сверка: живой захват при receiptStatus=error чек не дублирует', async (t) => {
  const a = await mount(t, { 'payments/m': payment({ orderId: 'm', status: 'paid', receiptStatus: 'error', fiscalizeClaimedAt: ago(1) }) })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(sells().length, 0)
})

test('сверка: чек CREATED дописывается из кассы, пока не готов остаётся как есть, смету не дописывает', async (t) => {
  const a = await mount(t, paySeed())
  net.on.invoiceStatus = (invoiceId) => ({ invoiceId, status: 'success' })
  net.on.sell = () => ({ id: 'rcpt-from-cbx', status: 'CREATED', fiscal_code: null, tax_url: null })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  let doc = a.db.get('payments/pay-1')
  assert.equal(doc.receiptId, 'rcpt-from-cbx')
  assert.equal(doc.receiptStatus, 'CREATED')
  assert.equal(net.of('GET', `${CBX}/receipts/rcpt-from-cbx`).length, 0, 'в проходе создания чек ещё не читается')

  net.on.receipt = (id) => ({ id, status: 'CREATED', fiscal_code: null, tax_url: null })
  const quiet = doc.updatedAt
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 1)
  assert.equal(a.db.get('payments/pay-1').updatedAt, quiet, 'не готов: документ не трогаем')

  net.on.receipt = (id) => ({ id, status: 'DONE', fiscal_code: 'FC-9', tax_url: 'https://check.example/9' })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  doc = a.db.get('payments/pay-1')
  assert.equal(doc.receiptStatus, 'DONE')
  assert.equal(doc.fiscalCode, 'FC-9')
  assert.equal(doc.taxUrl, 'https://check.example/9')
  assert.equal(doc.receiptError, null)
  assert.equal(a.db.get('priceEstimates/est-1').taxUrl, null, 'так сейчас: в смете остаётся null от первой записи')

  const reads = net.of('GET', `${CBX}/receipts/rcpt-from-cbx`).length
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(net.of('GET', `${CBX}/receipts/rcpt-from-cbx`).length, reads)
})

test('сверка: чек CREATED со статусом ERROR пишется, ошибка чтения кассы не ломает проход', async (t) => {
  const created = (id, over = {}) => payment({ orderId: id, status: 'paid', receiptStatus: 'CREATED', receiptId: `r-${id}`, providerOrderId: `inv-${id}`, ...over })
  const a = await mount(t, { 'payments/a': created('a'), 'payments/b': created('b'), 'payments/c': created('c', { taxUrl: 'https://check.example/c' }), 'payments/d': created('d', { fopId: 'nope' }) })
  net.on.receipt = (id) => {
    if (id === 'r-a') throw httpErr(500, {})
    return { id, status: 'ERROR', fiscal_code: null, tax_url: null }
  }
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 2)
  assert.equal(a.db.get('payments/a').receiptStatus, 'CREATED')
  assert.equal(a.db.get('payments/b').receiptStatus, 'ERROR')
  assert.ok(a.logged('error', 'reconcile receipt a 500'))
})

// ---------- остальные маршруты оплат ----------

test('повторный чек /refiscalize: права, состояния, ответ, подпись по провайдеру', async (t) => {
  const a = await mount(t, {
    ...repairSeed(),
    'payments/m': payment({ orderId: 'm', status: 'paid', receiptStatus: 'error' }),
    'payments/l': payment({ orderId: 'l', provider: 'liqpay', status: 'paid', receiptStatus: 'error' }),
    'payments/c': payment({ orderId: 'c', provider: 'mono-chast', status: 'paid', receiptStatus: 'error' }),
    'payments/old': payment({ orderId: 'old', provider: undefined, status: 'paid', receiptStatus: 'error' }),
    'payments/np': payment({ orderId: 'np' }),
    'payments/done': payment({ orderId: 'done', status: 'paid', receiptId: 'r-1' }),
  })
  assert.equal((await a.send('POST', '/api/pay/m/refiscalize', {})).status, 403)
  const missing = await a.send('POST', '/api/pay/none/refiscalize', {}, ADMIN)
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'NOT_FOUND')
  assert.equal((await a.send('POST', '/api/pay/np/refiscalize', {}, ADMIN)).json.error.code, 'NOT_PAID')
  assert.equal((await a.send('POST', '/api/pay/done/refiscalize', {}, ADMIN)).json.error.code, 'ALREADY_FISCAL')
  assert.equal(sells().length, 0)

  const r = await a.send('POST', '/api/pay/m/refiscalize', {}, ADMIN)
  assert.deepEqual(r.json, { success: true, data: { receiptStatus: 'DONE', taxUrl: 'https://check.example/1', receiptId: receiptUuid('m') } })
  assert.equal(sells()[0].body.payments[0].label, LABEL)

  await a.send('POST', '/api/pay/l/refiscalize', {}, ADMIN)
  assert.equal(sells()[1].body.payments[0].label, 'Оплата частинами (LiqPay)')
  await a.send('POST', '/api/pay/c/refiscalize', {}, ADMIN)
  assert.equal(sells()[2].body.payments[0].label, 'Оплата частинами (monobank)')
  await a.send('POST', '/api/pay/old/refiscalize', {}, ADMIN)
  assert.equal(sells()[3].body.payments[0].label, 'Оплата частинами (monobank)', 'документ без провайдера как раньше')
})

test('статус для опроса: только статус, чек и ссылка; 404 на неизвестный id', async (t) => {
  const a = await mount(t, paySeed({ status: 'paid', receiptStatus: 'DONE', taxUrl: 'https://check.example/1', fiscalCode: 'FC-1', receiptId: 'r' }))
  const r = await a.send('GET', '/api/pay/status?orderId=pay-1')
  assert.deepEqual(r.json, { success: true, data: { status: 'paid', receiptStatus: 'DONE', taxUrl: 'https://check.example/1' } })
  assert.equal((await a.send('GET', '/api/pay/status?orderId=none')).status, 404)
})

test('список «гроші є, чек ні»: только оплаченные без чека, только по токену', async (t) => {
  const a = await mount(t, {
    'payments/a': payment({ orderId: 'a', status: 'paid', receiptStatus: 'error', receiptError: 'x' }),
    'payments/b': payment({ orderId: 'b', status: 'paid', receiptId: 'r' }),
    'payments/c': payment({ orderId: 'c' }),
  })
  assert.equal((await a.send('GET', '/api/pay/unfiscalized')).status, 403)
  const r = await a.send('GET', '/api/pay/unfiscalized', undefined, ADMIN)
  assert.deepEqual(r.json.data.map((o) => [o.orderId, o.receiptStatus, o.receiptError, o.amount, o.fopId]), [['a', 'error', 'x', 1500.5, 'fop-a']])
})

test('id чека детерминирован: одна и та же строка для одного заказа', async (t) => {
  // Буквальное значение: смена формулы дала бы второй чек на оплату, уже ушедшую в кассу со старым id.
  assert.equal(receiptUuid('pay-test'), '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
  const a = await mount(t, { 'payments/pay-test': payment({ orderId: 'pay-test', status: 'paid', receiptStatus: 'error' }) })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(sells()[0].body.id, '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
})

test('без базы маршруты отвечают 503, колбэк молчит, сервер не падает', async (t) => {
  const a = await mount(t, {}, { db: null })
  assert.equal((await a.send('POST', '/api/estimates/pay', { estimateId: 'x' })).status, 503)
  assert.equal((await a.send('POST', '/api/pay/create', {}, ADMIN)).status, 503)
  assert.equal((await a.send('GET', '/api/pay/status?orderId=x')).status, 503)
  assert.deepEqual((await a.send('POST', '/api/pay/reconcile', {}, ADMIN)).json, { success: true, data: { checked: 0 } })
  await a.postHook(ok())
  assert.equal(net.calls.length, 0)
})

// ---------- подпись оплаты на документе ----------

const SHOP_LABEL = 'Інтернет еквайринг'
const receiptLabels = () => sells().map((c) => c.body.payments[0].label)

test('подпись оплаты: createPayment пишет её на документ, банку она не уходит, без неё поля нет', async (t) => {
  const a = await mount(t)
  const args = { fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', description: 'Тест', resultUrl: RESULT_URL }
  const plain = await a.api.createPayment(args)
  const labelled = await a.api.createPayment({ ...args, paymentLabel: SHOP_LABEL })
  const empty = await a.api.createPayment({ ...args, paymentLabel: '' })
  const doc = (r) => a.db.get(`payments/${r.data.orderId}`)
  assert.equal(doc(labelled).paymentLabel, SHOP_LABEL)
  assert.equal('paymentLabel' in doc(plain), false)
  assert.equal('paymentLabel' in doc(empty), false)

  const [first, second] = invoices().map((c) => ({ ...c.body, merchantPaymInfo: { ...c.body.merchantPaymInfo, reference: 'x' } }))
  assert.deepEqual(second, first, 'тело счёта с подписью и без неё одно и то же')
  assert.deepEqual(labelled.data, { orderId: labelled.data.orderId, provider: 'mono-acquire', pageUrl: 'https://pay.example/inv-2' })
})

test('подпись оплаты: первый чек и все повторы магазина выходят с одной подписью и одним id', async (t) => {
  const a = await mount(t)
  const r = await a.api.createPayment({ fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', description: 'Тест', paymentLabel: SHOP_LABEL })
  const { orderId } = r.data
  const paid = ok({ invoiceId: a.db.get(`payments/${orderId}`).providerOrderId, reference: orderId })

  const sellDone = net.on.sell
  net.on.sell = () => { throw httpErr(422, { message: 'Bad goods' }) }
  await a.hook(paid)
  assert.equal(a.db.get(`payments/${orderId}`).receiptStatus, 'error')
  await a.hook(paid)
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(a.db.get(`payments/${orderId}`).receiptStatus, 'error')

  net.on.sell = sellDone
  const retried = await a.send('POST', `/api/pay/${orderId}/refiscalize`, {}, ADMIN)
  assert.equal(retried.json.data.receiptStatus, 'DONE')
  assert.deepEqual(receiptLabels(), [SHOP_LABEL, SHOP_LABEL, SHOP_LABEL, SHOP_LABEL])
  assert.deepEqual(sells().map((c) => c.body.id), Array(4).fill(receiptUuid(orderId)))
  assert.equal(a.db.get(`payments/${orderId}`).paymentLabel, SHOP_LABEL, 'подпись остаётся на документе')
})

test('подпись оплаты: чек из колбэка и из сверки по pending берёт подпись документа, остальное тело прежнее', async (t) => {
  const a = await mount(t, paySeed({ paymentLabel: SHOP_LABEL }))
  await a.hook(ok())
  assert.deepEqual(sells()[0].body, sellBody('pay-1', SHOP_LABEL))

  const b = await mount(t, paySeed({ paymentLabel: SHOP_LABEL }))
  net.on.invoiceStatus = (invoiceId) => ({ invoiceId, status: 'success', amount: 150050 })
  await b.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.deepEqual(sells()[0].body, sellBody('pay-1', SHOP_LABEL))
})

test('подпись оплаты: на документе важнее подписи по провайдеру, в сверке и в /refiscalize', async (t) => {
  const paid = (id, provider, over = {}) => payment({ orderId: id, provider, status: 'paid', paymentLabel: SHOP_LABEL, providerOrderId: `inv-${id}`, ...over })
  const a = await mount(t, {
    ...repairSeed(),
    'payments/m': paid('m', 'mono-acquire', { receiptStatus: 'error' }),
    'payments/l': paid('l', 'liqpay', { receiptStatus: 'error' }),
    'payments/c': paid('c', 'mono-chast', { receiptStatus: 'error' }),
    'payments/rm': paid('rm', 'mono-acquire'),
    'payments/rl': paid('rl', 'liqpay'),
    'payments/rc': paid('rc', 'mono-chast'),
  })
  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.deepEqual(receiptLabels(), [SHOP_LABEL, SHOP_LABEL, SHOP_LABEL])
  for (const id of ['rm', 'rl', 'rc']) await a.send('POST', `/api/pay/${id}/refiscalize`, {}, ADMIN)
  assert.deepEqual(receiptLabels(), Array(6).fill(SHOP_LABEL))
})

test('подпись оплаты: fiscalize берёт подпись документа, переданная нужна только без неё', async (t) => {
  const a = await mount(t, {
    ...repairSeed(),
    'payments/own': payment({ orderId: 'own', status: 'paid', paymentLabel: SHOP_LABEL }),
    'payments/none': payment({ orderId: 'none', status: 'paid' }),
  })
  await a.api.fiscalize(await a.api.loadOrder('own'), 'Підпис тесту')
  await a.api.fiscalize(await a.api.loadOrder('none'), 'Підпис тесту')
  assert.deepEqual(receiptLabels(), [SHOP_LABEL, 'Підпис тесту'])
})

test('подпись оплаты из тела запроса не принимается: /api/pay/create, смета, заказ лодки', async (t) => {
  const boat = { status: 'new', total: 900, clientPhone: '+380000000000', lines: [{ label: 'Кораблик', price: 900, qty: 1 }] }
  const a = await mount(t, { ...repairSeed(), 'boatOrders/bo-1': boat })
  const paymentLabel = 'Чужа підпис'
  const requests = [
    ['/api/pay/create', { fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', paymentLabel }, ADMIN],
    ['/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', paymentLabel }, {}],
    ['/api/boat-orders/pay', { boatOrderId: 'bo-1', fopId: 'fop-a', method: 'mono-acquire', paymentLabel }, ADMIN],
  ]
  for (const [path, body, headers] of requests) {
    const r = await a.send('POST', path, body, headers)
    assert.equal(r.status, 200, path)
    const { orderId } = r.json.data
    const doc = a.db.get(`payments/${orderId}`)
    assert.equal('paymentLabel' in doc, false, path)
    await a.hook(ok({ invoiceId: doc.providerOrderId, reference: orderId }))
    assert.equal(sells().at(-1).body.payments[0].label, LABEL, path)
    assert.equal(sells().at(-1).body.id, receiptUuid(orderId), path)
  }
  assert.equal(sells().length, 3)
})

// ---------- подмена модулей, помощники для магазина, ФОП мимо кэша ----------

const realCheckbox = await import('./checkbox.js')
const fakeMono = () => {
  const calls = []
  return {
    calls,
    createInvoice: async (fop, args) => { calls.push(['createInvoice', fop.id, args]); return { invoiceId: 'inv-1', pageUrl: 'https://pay.example/fake' } },
    invoiceStatus: async (fop, id) => { calls.push(['invoiceStatus', fop.id, id]); return { invoiceId: id, status: 'success' } },
    verifyWebhook: async (fop, rawBody, xSign) => { calls.push(['verifyWebhook', fop.id, xSign]); return xSign === 'good' },
  }
}
const fakeCbx = () => {
  const calls = []
  return {
    ...realCheckbox,
    calls,
    sellReceipt: async (fop, args) => { calls.push(['sellReceipt', fop.id, args]); return { receiptId: args.receiptId, fiscalCode: null, taxUrl: null, status: 'CREATED' } },
    getReceipt: async (fop, id) => { calls.push(['getReceipt', fop.id, id]); return { receiptId: id, fiscalCode: 'FC-F', taxUrl: 'https://check.example/f', status: 'DONE' } },
  }
}

test('deps.mono и deps.cbx заменяют банк и кассу на всём пути, сеть не трогается', async (t) => {
  const mono = fakeMono()
  const cbx = fakeCbx()
  const a = await mount(t, { ...repairSeed(), 'payments/old': payment({ orderId: 'old', providerOrderId: 'inv-old', estimateId: undefined, serviceRequestId: undefined }) }, { deps: { mono, cbx } })

  const r = await a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', resultUrl: RESULT_URL })
  assert.equal(r.json.data.pageUrl, 'https://pay.example/fake')
  const { orderId } = r.json.data
  assert.deepEqual(mono.calls[0], ['createInvoice', 'fop-a', {
    amountKop: 150050, reference: orderId, destination: 'Оплата RunFerry (кошторис est-1)', redirectUrl: RESULT_URL, webHookUrl: undefined,
    goods: [{ name: 'Діагностика', qty: 1, sumKop: 50000, code: 'WORK-1' }, { name: 'Заміна кришки', qty: 2, sumKop: 100050, code: undefined }],
  }])

  await a.hook(ok(), { xSign: 'bad' })
  assert.deepEqual(mono.calls.at(-1), ['verifyWebhook', 'fop-a', 'bad'])
  assert.equal(a.db.get(`payments/${orderId}`).status, 'pending')
  await a.hook(ok(), { xSign: 'good' })
  assert.deepEqual(cbx.calls[0], ['sellReceipt', 'fop-a', { goods: GOODS, paymentLabel: LABEL, receiptId: receiptUuid(orderId), deliveryEmail: undefined }])
  assert.equal(a.db.get(`payments/${orderId}`).status, 'paid')

  await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.ok(mono.calls.some((c) => c[0] === 'invoiceStatus' && c[2] === 'inv-old'), 'сверка спрашивает подменённый банк')
  assert.ok(cbx.calls.some((c) => c[0] === 'getReceipt' && c[2] === receiptUuid(orderId)), 'сверка читает чек в подменённой кассе')
  assert.equal(net.calls.length, 0)
})

test('registerPayments возвращает помощников, работающих с той же базой и теми же модулями', async (t) => {
  const a = await mount(t, paySeed(), { env: { OWNER_TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG' } })
  for (const name of ['createPayment', 'loadOrder', 'saveOrder', 'notifyOwner', 'fiscalize', 'receiptUuidFor']) assert.equal(typeof a.api[name], 'function', name)

  const r = await a.api.createPayment({ fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', description: 'Тест' })
  assert.equal(r.ok, true)
  assert.equal(invoices()[0].body.merchantPaymInfo.reference, r.data.orderId)
  assert.deepEqual(await a.api.createPayment({ fopId: 'nope', amount: 1, goods: GOODS }), { ok: false, status: 400, code: 'BAD_FOP', message: 'Невідомий ФОП' })

  assert.equal((await a.api.loadOrder(r.data.orderId)).providerOrderId, 'inv-1')
  assert.equal(await a.api.loadOrder('none'), null)
  await a.api.saveOrder({ orderId: 'pay-1', note: 'x' })
  assert.equal(a.db.get('payments/pay-1').note, 'x')
  assert.equal(a.db.get('payments/pay-1').fopId, 'fop-a', 'saveOrder дописывает, а не заменяет')
  assert.match(a.db.get('payments/pay-1').updatedAt, ISO)

  assert.equal(a.api.receiptUuidFor('pay-test'), '714b9622-c5b7-4b13-92bf-2f9ac84c9ef4')
  await a.api.fiscalize(await a.api.loadOrder('pay-1'), 'Підпис тесту')
  assert.equal(sells()[0].body.payments[0].label, 'Підпис тесту')
  assert.equal(sells()[0].body.id, a.api.receiptUuidFor('pay-1'))

  await a.api.notifyOwner('Текст')
  assert.deepEqual(net.of('POST', 'https://api.telegram.org/botTG/sendMessage')[0].body, { chat_id: '42', text: 'Текст' })
})

// Документы ФОП только в базе: кэш процесса засеян FOPS_CONFIG и о них не знает, как новый экземпляр до refreshFops.
const COLD_FOP = {
  'fops/fop-cold': { name: 'ФОП холодний' },
  'fopSecrets/fop-cold': { monoAcquire: { token: 'MONO-COLD' }, checkbox: { licenseKey: 'LIC-COLD', pinCode: 'PIN-COLD', cashierName: 'Касир холодний' } },
}

test('новый экземпляр: ФОП ещё не в кэше, колбэк читает его из базы, сверяет подпись и выбивает чек', async (t) => {
  const a = await mount(t, { ...paySeed({ fopId: 'fop-cold' }), ...COLD_FOP })
  await a.hook(ok())
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.receiptStatus, 'DONE')
  assert.deepEqual(sells()[0].body, sellBody('pay-1', LABEL, { cashier_name: 'Касир холодний' }))
  assert.equal(sells()[0].headers['X-License-Key'], 'LIC-COLD')
  assert.equal(net.of('GET', `${MONO}/pubkey`)[0].headers['X-Token'], 'MONO-COLD')
  assert.equal(a.logged('warn', 'неверная подпись'), false)
})

test('новый экземпляр: поддельная подпись остаётся неверной подписью, а не «ФОП не загружен»', async (t) => {
  const a = await mount(t, { ...paySeed({ fopId: 'fop-cold' }), ...COLD_FOP })
  await a.hook(ok(), { xSign: 'AAAA' })
  assert.ok(a.logged('warn', 'mono acquire callback: неверная подпись pay-1'))
  assert.equal(a.logged('warn', 'ФОП не загружен'), false)
  assert.equal(a.db.get('payments/pay-1').status, 'pending')
})

test('ФОП нет ни в кэше, ни в базе: журнал отличает это от неверной подписи, оплата не тронута, банк не вызываем', async (t) => {
  const a = await mount(t, paySeed({ fopId: 'fop-gone' }))
  const before = a.db.get('payments/pay-1')
  await a.hook(ok())
  assert.ok(a.logged('warn', 'mono acquire callback: ФОП не загружен fop-gone pay-1'))
  assert.equal(a.logged('warn', 'неверная подпись'), false)
  assert.deepEqual(a.db.get('payments/pay-1'), before)
  assert.equal(net.calls.length, 0)
})

test('база не ответила за ФОП: колбэк не падает, следующий колбэк проводит оплату', async (t) => {
  const a = await mount(t, { ...paySeed({ fopId: 'fop-cold' }), ...COLD_FOP })
  a.db.failRead = (path) => path.startsWith('fops/')
  await a.hook(ok())
  assert.ok(a.logged('error', 'ФОП fop-cold не прочитан'))
  assert.ok(a.logged('warn', 'mono acquire callback: ФОП не загружен fop-cold pay-1'))
  assert.equal(a.logged('warn', 'неверная подпись'), false)
  assert.equal(a.db.get('payments/pay-1').status, 'pending')

  a.db.failRead = null
  await a.hook(ok())
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.equal(sells().length, 1)
})

test('ФОП в кэше: база за ним не ходит', async (t) => {
  const a = await mount(t, paySeed())
  await a.hook(ok())
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.equal(a.db.reads.some((p) => p.startsWith('fops/') || p.startsWith('fopSecrets/')), false)
})

test('сверка: повтор чека берёт ФОП из базы; ФОП нет или база не ответила, очередь идёт дальше и захват не занят', async (t) => {
  const failed = (id, fopId) => payment({ orderId: id, fopId, status: 'paid', receiptStatus: 'error', fiscalizeClaimedAt: null, estimateId: undefined, serviceRequestId: undefined })
  const a = await mount(t, { 'payments/gone': failed('gone', 'fop-gone'), 'payments/cold': failed('cold', 'fop-cold'), 'payments/warm': failed('warm', 'fop-a'), ...COLD_FOP })
  const r = await a.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.equal(r.json.data.checked, 3)
  assert.deepEqual(sells().map((c) => c.headers['X-License-Key']).sort(), ['LIC-A', 'LIC-COLD'])
  assert.equal(a.db.get('payments/gone').receiptStatus, 'error')
  assert.equal(a.db.get('payments/gone').fiscalizeClaimedAt, null)
  assert.ok(a.logged('warn', 'ФОП fop-gone не загружен, чек не выбит для gone'))

  const b = await mount(t, { 'payments/cold': failed('cold', 'fop-cold'), 'payments/warm': failed('warm', 'fop-a'), ...COLD_FOP })
  b.db.failRead = (path) => path.startsWith('fops/')
  await b.send('POST', '/api/pay/reconcile', {}, ADMIN)
  assert.deepEqual(sells().map((c) => c.headers['X-License-Key']), ['LIC-A'], 'очередь дошла до ФОП из кэша')
  assert.equal(b.db.get('payments/cold').receiptStatus, 'error')
})

// ---------- параметры счёта магазина: только из кода, не из тела запроса ----------

const CALLBACK = '/api/mono/acquire/callback'
const SHOP_ARGS = { fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', description: 'Тест', resultUrl: RESULT_URL }
// Тело счёта без того, что у каждого счёта своё или что добавляет магазин.
const commonBody = ({ validity: _validity, webHookUrl: _hook, ...body }) => ({ ...body, merchantPaymInfo: { ...body.merchantPaymInfo, reference: 'x' } })

test('счёт магазина: срок, адрес колбэка и связь с заказом доходят куда нужно, остальное как у ремонта', async (t) => {
  const a = await mount(t)
  const plain = await a.api.createPayment(SHOP_ARGS)
  const shop = await a.api.createPayment({ ...SHOP_ARGS, validitySec: 3600, webHookBase: 'https://hook.example/', shopOrderId: 'so-1' })
  assert.equal(shop.ok, true)
  const [before, after] = invoices()
  assert.equal(after.body.validity, 3600)
  assert.equal(after.body.webHookUrl, `https://hook.example${CALLBACK}`)
  assert.deepEqual(commonBody(after.body), commonBody(before.body))
  assert.deepEqual(Object.keys(before.body).sort(), ['amount', 'ccy', 'merchantPaymInfo', 'paymentType', 'redirectUrl'])
  assert.deepEqual(after.headers, before.headers)

  const { orderId } = shop.data
  assert.deepEqual(withoutTimes(a.db.get(`payments/${orderId}`)), {
    orderId, fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire', status: 'pending', provider: 'mono-acquire', providerOrderId: 'inv-2', shopOrderId: 'so-1',
  })
  assert.equal('shopOrderId' in a.db.get(`payments/${plain.data.orderId}`), false)
  assert.deepEqual(shop.data, { orderId, provider: 'mono-acquire', pageUrl: 'https://pay.example/inv-2' }, 'ответ тот же, что у ремонта')
})

test('счёт магазина: каждый параметр работает сам по себе, пустые значения как их отсутствие', async (t) => {
  const a = await mount(t)
  const keys = async (over) => {
    await a.api.createPayment({ ...SHOP_ARGS, ...over })
    return Object.keys(invoices().at(-1).body).filter((k) => k === 'validity' || k === 'webHookUrl')
  }
  assert.deepEqual(await keys({ validitySec: 3600 }), ['validity'])
  assert.deepEqual(await keys({ webHookBase: 'https://hook.example' }), ['webHookUrl'])
  assert.equal(invoices().at(-1).body.webHookUrl, `https://hook.example${CALLBACK}`, 'адрес без косой черты на конце')
  assert.deepEqual(await keys({ shopOrderId: 'so-1' }), [])
  assert.deepEqual(await keys({ validitySec: 0, webHookBase: '', shopOrderId: '', fopOverride: null }), [])
  const r = await a.api.createPayment({ ...SHOP_ARGS, shopOrderId: '' })
  assert.equal('shopOrderId' in a.db.get(`payments/${r.data.orderId}`), false)
  const n = await a.api.createPayment({ ...SHOP_ARGS, shopOrderId: 123 })
  assert.equal(a.db.get(`payments/${n.data.orderId}`).shopOrderId, '123')
})

test('счёт магазина: свой адрес колбэка важнее PUBLIC_BASE_URL, ремонт остаётся на PUBLIC_BASE_URL', async (t) => {
  const a = await mount(t, repairSeed(), { env: { PUBLIC_BASE_URL: 'https://public.example/' } })
  await a.api.createPayment({ ...SHOP_ARGS, webHookBase: 'https://hook.example' })
  assert.equal(invoices().at(-1).body.webHookUrl, `https://hook.example${CALLBACK}`)
  await a.api.createPayment(SHOP_ARGS)
  assert.equal(invoices().at(-1).body.webHookUrl, `https://public.example${CALLBACK}`)
  await a.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', webHookBase: 'https://evil.example' })
  assert.equal(invoices().at(-1).body.webHookUrl, `https://public.example${CALLBACK}`)
})

test('fopOverride: счёт идёт по переданному ФОП, кэш не нужен и не важнее', async (t) => {
  const a = await mount(t)
  const cold = await a.api.createPayment({ ...SHOP_ARGS, fopId: 'fop-cold', fopOverride: { id: 'fop-cold', monoAcquire: { token: 'MONO-COLD' } } })
  assert.equal(cold.ok, true)
  assert.equal(invoices().at(-1).headers['X-Token'], 'MONO-COLD')
  const doc = a.db.get(`payments/${cold.data.orderId}`)
  assert.equal(doc.fopId, 'fop-cold')
  assert.equal('fopOverride' in doc, false, 'ключи ФОП не попадают в документ оплаты')
  assert.equal(JSON.stringify(doc).includes('MONO-COLD'), false)

  await a.api.createPayment({ ...SHOP_ARGS, fopOverride: { id: 'fop-a', monoAcquire: { token: 'MONO-NEW' } } })
  assert.equal(invoices().at(-1).headers['X-Token'], 'MONO-NEW', 'ключ только что сменили, в кэше ещё старый')

  const sent = invoices().length
  const refused = async (over, code) => {
    const r = await a.api.createPayment({ ...SHOP_ARGS, ...over })
    assert.equal(r.ok, false, code)
    assert.equal(r.code, code)
    assert.equal(r.status, 400)
  }
  const token = { monoAcquire: { token: 'MONO-X' } }
  await refused({ fopOverride: { id: 'fop-b', ...token } }, 'BAD_FOP')
  await refused({ fopOverride: { ...token } }, 'BAD_FOP')
  await refused({ fopId: 'fop-cold' }, 'BAD_FOP')
  await refused({ fopOverride: { id: 'fop-a', active: false, ...token } }, 'FOP_INACTIVE')
  await refused({ fopOverride: { id: 'fop-a' } }, 'NO_MONO_ACQUIRE')
  assert.equal(invoices().length, sent, 'при отказе банк не вызывается')
})

test('параметры магазина из тела запроса не действуют: /api/pay/create, смета, заказ лодки', async (t) => {
  const boat = { status: 'new', total: 900, clientPhone: '+380000000000', lines: [{ label: 'Кораблик', price: 900, qty: 1 }] }
  const a = await mount(t, { ...repairSeed(), 'boatOrders/bo-1': boat })
  const foreign = {
    validitySec: 60, webHookBase: 'https://evil.example', shopOrderId: 'so-evil', paymentLabel: 'Чужа підпис',
    fopOverride: { id: 'fop-a', monoAcquire: { token: 'EVIL' } },
  }
  const create = { fopId: 'fop-a', amount: 1500.5, goods: GOODS, method: 'mono-acquire' }
  const requests = [
    ['/api/pay/create', { ...create, ...foreign }, ADMIN],
    ['/api/pay/create', { ...create, ['__proto__']: foreign }, ADMIN],
    ['/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', ...foreign }, {}],
    ['/api/boat-orders/pay', { boatOrderId: 'bo-1', fopId: 'fop-a', method: 'mono-acquire', ...foreign }, ADMIN],
  ]
  for (const [path, body, headers] of requests) {
    const r = await a.send('POST', path, body, headers)
    assert.equal(r.status, 200, path)
    const { orderId } = r.json.data
    assert.deepEqual(Object.keys(r.json.data).sort(), ['orderId', 'pageUrl', 'provider'], path)
    const inv = invoices().at(-1)
    assert.equal(inv.headers['X-Token'], 'MONO-A', path)
    assert.deepEqual(Object.keys(inv.body).sort(), ['amount', 'ccy', 'merchantPaymInfo', 'paymentType'], path)
    const doc = a.db.get(`payments/${orderId}`)
    for (const k of Object.keys(foreign)) assert.equal(k in doc, false, `${path}: ${k}`)
    assert.equal(JSON.stringify(doc).includes('EVIL'), false, path)
  }

  const unknown = await a.send('POST', '/api/pay/create', { ...create, fopId: 'fop-cold', fopOverride: { id: 'fop-cold', monoAcquire: { token: 'EVIL' } } }, ADMIN)
  assert.equal(unknown.status, 400, 'ФОП вне кэша телом запроса не подставить')
  assert.equal(unknown.json.error.code, 'BAD_FOP')
  const sent = invoices().length
  const inactive = await a.send('POST', '/api/pay/create', { ...create, fopId: 'fop-off', fopOverride: { id: 'fop-off', active: true, monoAcquire: { token: 'EVIL' } } }, ADMIN)
  assert.equal(inactive.json.error.code, 'FOP_INACTIVE', 'выключенный ФОП телом запроса не включить')
  assert.equal(invoices().length, sent)
})

// ---------- алерт владельцу: результат отправки ----------

test('notifyOwner: true при отправке, false без переменных и при сбое, ошибку наружу не бросает', async (t) => {
  const env = { OWNER_TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG' }
  const a = await mount(t, {}, { env })
  assert.equal(await a.api.notifyOwner('Текст'), true)
  net.on.telegram = () => { throw httpErr(403, { ok: false }) }
  assert.equal(await a.api.notifyOwner('Текст'), false)
  assert.ok(a.logged('error', 'notifyOwner: Request failed with status code 403'))

  for (const partial of [{}, { OWNER_TELEGRAM_CHAT_ID: '42' }, { TELEGRAM_BOT_TOKEN: 'TG' }]) {
    const silent = await mount(t, {}, { env: partial })
    assert.equal(await silent.api.notifyOwner('Текст'), false)
    assert.equal(net.calls.length, 0, 'без обеих переменных Telegram не вызывается')
  }
})

test('notifyOwner: прежний алерт о чеке результат не читает, неудачная отправка не повторяется', async (t) => {
  const a = await mount(t, paySeed(), { env: { OWNER_TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG' } })
  net.on.sell = () => { throw new Error('timeout') }
  net.on.telegram = () => { throw new Error('tg down') }
  await a.hook(ok())
  await a.hook(ok())
  const doc = a.db.get('payments/pay-1')
  assert.equal(doc.status, 'paid')
  assert.equal(doc.receiptStatus, 'error')
  assert.equal(doc.ownerNotified, true)
  assert.equal(net.calls.filter((c) => c.url.includes('telegram')).length, 1)
})

// ---------- один исход счёта: ремонт как раньше, кроме журнала и алерта при расхождении ----------

const OWNER = { OWNER_TELEGRAM_CHAT_ID: '42', TELEGRAM_BOT_TOKEN: 'TG' }
const alertTexts = () => net.of('POST', 'https://api.telegram.org/botTG/sendMessage').map((c) => c.body.text)
// Даты заменены: сравниваем сами записи, а не момент записи.
const noDates = (v) => JSON.parse(JSON.stringify(v).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, 'ДАТА'))
const reconcileNow = (a) => a.send('POST', '/api/pay/reconcile', {}, ADMIN)
const bankSays = (over = {}) => { net.on.invoiceStatus = (invoiceId) => ok({ invoiceId, ...over }) }

test('ремонт: колбэк и сверка дают одни и те же записи и один и тот же чек', async (t) => {
  for (const status of ['success', 'failure', 'expired', 'reversed', 'created', 'processing', 'hold']) {
    const viaHook = await mount(t, paySeed())
    await viaHook.hook(ok({ status }))
    const hookSells = sells().map((c) => c.body)
    assert.equal(statusChecks().length, 0, 'колбэк ремонта банк не спрашивает')

    const viaPoll = await mount(t, paySeed())
    bankSays({ status })
    await reconcileNow(viaPoll)
    assert.deepEqual(noDates(viaPoll.db.docs), noDates(viaHook.db.docs), status)
    assert.deepEqual(sells().map((c) => c.body), hookSells, status)
  }
})

test('ремонт: расхождение с банком даёт журнал и один алерт, записи и чек те же', async (t) => {
  const clean = await mount(t, paySeed())
  await clean.hook(ok())
  const cleanDocs = noDates(clean.db.docs)

  const cases = [
    [{ amount: 150000 }, 'сума 150000 коп. замість 150050'],
    [{ amount: 1500.5 }, 'сума 1500.5 коп. замість 150050'],
    [{ ccy: 840 }, 'валюта 840 замість 980'],
    [{ reference: 'pay-other' }, 'reference pay-other'],
    [{ amount: 1, ccy: 840 }, 'сума 1 коп. замість 150050; валюта 840 замість 980'],
  ]
  for (const [over, part] of cases) {
    const text = `⚠️ RunFerry: оплата pay-1 на 1500.5 грн: дані банку не збігаються (${part}). Чек виписується як звичайно. Звірте суму в кабінеті monobank.`
    const a = await mount(t, paySeed(), { env: OWNER })
    await a.hook(ok(over))
    assert.deepEqual(noDates(a.db.docs), cleanDocs, part)
    assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
    assert.deepEqual(alertTexts(), [text])
    assert.ok(a.logged('warn', `mono acquire webhook: дані банку не збігаються pay-1: ${part}`))
    await a.hook(ok(over))
    assert.equal(alertTexts().length, 1, 'повтор колбэка не шлёт второй алерт')
    assert.equal(sells().length, 1)

    const b = await mount(t, paySeed(), { env: OWNER })
    bankSays(over)
    await reconcileNow(b)
    assert.deepEqual(noDates(b.db.docs), cleanDocs, part)
    assert.deepEqual(alertTexts(), [text])
    assert.ok(b.logged('warn', `mono acquire reconcile: дані банку не збігаються pay-1: ${part}`))
  }
})

test('ремонт: всё сошлось или поля нет: ни алерта, ни журнала; после оплаты сумму не смотрим', async (t) => {
  for (const over of [{}, { amount: undefined }, { ccy: undefined }, { reference: undefined }, { amount: undefined, ccy: undefined, reference: undefined }, { amount: '150050', ccy: '980' }]) {
    const a = await mount(t, paySeed(), { env: OWNER })
    await a.hook(ok(over))
    assert.equal(a.db.get('payments/pay-1').status, 'paid')
    assert.equal(sells().length, 1)
    assert.deepEqual(alertTexts(), [])
    assert.equal(a.logged('warn', 'дані банку'), false)
  }
  const paid = await mount(t, paySeed({ status: 'paid', receiptId: 'r-1', receiptStatus: 'DONE' }), { env: OWNER })
  await paid.hook(ok({ amount: 1 }))
  assert.deepEqual(alertTexts(), [])
  assert.equal(sells().length, 0)
})

test('ремонт: сбой Telegram при расхождении не мешает ни оплате, ни чеку', async (t) => {
  const a = await mount(t, paySeed(), { env: OWNER })
  net.on.telegram = () => { throw new Error('tg down') }
  await a.hook(ok({ amount: 1 }))
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.equal(a.db.get('payments/pay-1').receiptStatus, 'DONE')
  assert.equal(sells().length, 1)
})

test('ремонт: хуки магазина не вызываются ни на одном статусе, частичный возврат не замечается', async (t) => {
  const called = []
  const spy = (name) => async () => { called.push(name) }
  const hooks = { onShopPaid: spy('paid'), onShopReversed: spy('reversed'), onShopPartialRefund: spy('partial') }
  const a = await mount(t, paySeed())
  a.api.setShopHooks(hooks)
  await a.hook(ok({ finalAmount: 100 }))
  const paid = a.db.get('payments/pay-1')
  await a.hook(ok({ status: 'reversed' }))
  await a.hook(ok({ finalAmount: 100 }))
  assert.deepEqual(a.db.get('payments/pay-1'), paid)
  assert.equal(statusChecks().length, 0)
  assert.deepEqual(called, [])
})

test('settleMonoAcquire: тот же путь для следующих шагов, ответ без статуса ничего не делает', async (t) => {
  const a = await mount(t, paySeed())
  for (const st of [null, undefined, {}, { status: 'processing' }]) await a.api.settleMonoAcquire(a.db.get('payments/pay-1'), st, 'status')
  assert.equal(a.db.get('payments/pay-1').status, 'pending')
  await a.api.settleMonoAcquire(a.db.get('payments/pay-1'), ok(), 'status')
  assert.equal(a.db.get('payments/pay-1').status, 'paid')
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
  assert.deepEqual(a.api.amountAudit({ orderId: 'x', amount: 12.34 }, { amount: 1234, ccy: 980, reference: 'x' }), { mismatch: [], missing: [] })
  assert.deepEqual(a.api.amountAudit({ orderId: 'x', amount: 12.34 }, {}), { mismatch: [], missing: ['amount', 'ccy'] })
})

// ---------- счёт магазина: сверка суммы, заказ догоняет оплату, возврат ----------

const { createShopPaymentHooks } = await import('./shopPayments.js')
const { withGuideStep } = await import('./shopCore.js')
const realMono = await import('./monoAcquire.js')
const CARD_URL = 'https://portal.example/shop-orders/so-1'
const shopOrder = (over = {}) => ({
  orderNo: 'RF-100001', state: 'awaiting_payment', method: 'card', sku: 'V2-LID-R', qty: 1, total: 1500.5, phoneKey: 'ph-1',
  clientName: 'Петренко Іван', clientPhone: '+380000000001', clientWarehouseName: 'Відділення №7',
  createdAt: '2026-11-02T22:30:00.000Z', paymentIds: ['pay-1'], payment: { paymentId: 'pay-1', pageUrl: 'https://pay.example/inv-1' }, history: [], ...over,
})
const shopPayment = (over = {}) => payment({ shopOrderId: 'so-1', estimateId: undefined, serviceRequestId: undefined, ...over })
const shopSeed = (pay = {}, order = {}) => ({
  'payments/pay-1': shopPayment(pay),
  'shopOrders/so-1': shopOrder(order),
  'shopPhones/ph-1': { openCard: { 'V2-LID-R': 'so-1', OTHER: 'so-2' } },
  'shopDaily/2026-11-03': { unpaid: 3, sms: 1 }, // 22:30 UTC это уже 3 ноября по Киеву
  'system/shopSales': { mode: 'live', skus: { 'V2-LID-R': { enabled: true, inStock: true, stock: 5 } } },
})
const mountShop = async (t, seed, { removeInvoice = async () => ({}), env = OWNER } = {}) => {
  const removed = []
  const mono = { ...realMono, removeInvoice: async (fop, id) => { removed.push([fop.id, id]); return removeInvoice(fop, id) } }
  const a = await mount(t, seed, { env, deps: { mono } })
  a.api.setShopHooks(createShopPaymentHooks({ adminDb: a.db, payments: a.api, mono, siteUrl: 'https://portal.example' }))
  bankSays()
  return { ...a, removed }
}
const shopDoc = (a, id = 'so-1') => a.db.get(`shopOrders/${id}`)
const payDoc = (a, id = 'pay-1') => a.db.get(`payments/${id}`)
const stock = (a) => a.db.get('system/shopSales').skus['V2-LID-R'].stock
const unpaid = (a) => a.db.get('shopDaily/2026-11-03').unpaid

test('магазин: успех сверяется с банком, заказ оплачен до чека, записи полные и без алертов', async (t) => {
  const a = await mountShop(t, shopSeed())
  let atSell = null
  net.on.sell = (p) => { atSell = shopDoc(a); return { id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' } }
  await a.hook(ok())

  assert.deepEqual(statusChecks().map((c) => c.params), [{ invoiceId: 'inv-1' }])
  assert.deepEqual(statusChecks()[0].headers, { 'X-Token': 'MONO-A' })
  assert.equal(atSell.state, 'paid', 'заказ оплачен раньше обращения к кассе')
  assert.match(atSell.paidAt, ISO)

  const pay = payDoc(a)
  assert.equal(pay.status, 'paid')
  assert.equal(pay.paytype, 'mono-acquire')
  assert.equal(pay.receiptId, receiptUuid('pay-1'))
  assert.equal(pay.receiptStatus, 'DONE')
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])

  const shop = shopDoc(a)
  assert.equal(shop.state, 'paid')
  assert.equal(shop.paidPaymentId, 'pay-1')
  assert.equal(shop.paidSource, 'webhook')
  assert.match(shop.paidAt, ISO)
  assert.deepEqual(shop.payment, { paymentId: 'pay-1', pageUrl: null })
  assert.deepEqual(shop.history, [{ at: shop.paidAt, from: 'awaiting_payment', to: 'paid', by: 'webhook' }])
  assert.equal(shop.alerts, undefined)

  assert.deepEqual(a.db.get('shopPhones/ph-1').openCard, { 'V2-LID-R': null, OTHER: 'so-2' })
  assert.equal(stock(a), 4)
  assert.equal(a.db.get('system/shopSales').skus['V2-LID-R'].inStock, true)
  assert.equal(a.db.get('system/shopSales').mode, 'live')
  assert.deepEqual(a.db.get('shopDaily/2026-11-03'), { unpaid: 2, sms: 1 })
  assert.deepEqual(alertTexts(), [])
  assert.deepEqual(a.removed, [])
})

test('магазин: от создания счёта до чека: подпись и reference с документа, сумма сходится', async (t) => {
  const a = await mountShop(t, { 'shopOrders/so-1': shopOrder({ paymentIds: [] }) })
  const r = await a.api.createPayment({ ...SHOP_ARGS, shopOrderId: 'so-1', paymentLabel: 'Інтернет еквайринг', validitySec: 3600, webHookBase: 'https://hook.example' })
  const { orderId } = r.data
  const invoiceId = payDoc(a, orderId).providerOrderId
  bankSays({ reference: orderId })
  await a.hook({ invoiceId, status: 'success' })
  assert.equal(payDoc(a, orderId).status, 'paid')
  assert.equal(payDoc(a, orderId).receiptStatus, 'DONE')
  assert.deepEqual(sells()[0].body.payments, [{ type: 'CASHLESS', value: 150050, label: 'Інтернет еквайринг' }])
  assert.equal(shopDoc(a).paidPaymentId, orderId)
  assert.deepEqual(alertTexts(), [])
})

test('магазин: решает ответ банка, а не тело колбэка', async (t) => {
  const a = await mountShop(t, shopSeed())
  const pending = payDoc(a)
  bankSays({ status: 'processing' })
  await a.hook(ok())
  assert.deepEqual(payDoc(a), pending, 'колбэк сказал успех, банк нет')
  assert.equal(sells().length, 0)
  assert.equal(shopDoc(a).state, 'awaiting_payment')

  bankSays()
  await a.hook(ok({ status: 'failure', amount: 1, ccy: 840, reference: 'pay-x' }))
  assert.equal(payDoc(a).status, 'paid', 'колбэк сказал неудачу и неверную сумму, банк успех')
  assert.equal(payDoc(a).receiptStatus, 'DONE')
  assert.deepEqual(alertTexts(), [])
})

test('магазин: неверная подпись: банк не спрашиваем, ничего не меняем', async (t) => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const a = await mountShop(t, shopSeed())
  const before = clone(a.db.docs)
  await a.hook(ok(), { privateKey: other.privateKey })
  assert.deepEqual(a.db.docs, before)
  assert.equal(statusChecks().length, 0)
  assert.equal(sells().length, 0)
})

test('магазин: банк не ответил на чтение: документ pending, журнал, закрывает сверка', async (t) => {
  const a = await mountShop(t, shopSeed())
  const before = clone(a.db.docs)
  net.on.invoiceStatus = () => { throw httpErr(500, {}) }
  await a.hook(ok())
  assert.deepEqual(a.db.docs, before)
  assert.equal(sells().length, 0)
  assert.ok(a.logged('warn', 'mono acquire callback: статус не прочитано, чекаємо опитування pay-1'))

  bankSays()
  await reconcileNow(a)
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(shopDoc(a).paidSource, 'reconcile')
  assert.equal(sells().length, 1)
})

test('магазин: касса упала: общий алерт «ЧЕК НЕ ВИБИТО» ведёт на шаг памятки', async (t) => {
  const a = await mountShop(t, shopSeed())
  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  assert.deepEqual(alertTexts(), [withGuideStep('receipt-failed', '⚠️ RunFerry: оплата pay-1 на 1500.5 грн пройшла, але ЧЕК НЕ ВИБИТО (помилка Checkbox). ФОП fop-a. Перевірте в адмінці оплат.')])
  assert.ok(alertTexts()[0].endsWith("\nПам'ятка, крок 7"))
})

test('магазин: сумма не сошлась при первой записи: paid, чек не выходит, payment_review, один алерт', async (t) => {
  const cases = [
    [{ amount: 150000 }, 'сума 150000 коп. замість 150050'],
    [{ amount: 1500.5 }, 'сума 1500.5 коп. замість 150050'],
    [{ ccy: 840 }, 'валюта 840 замість 980'],
    [{ reference: 'pay-x' }, 'reference pay-x'],
  ]
  for (const [over, part] of cases) {
    const a = await mountShop(t, shopSeed())
    bankSays(over)
    await a.hook(ok())

    const pay = payDoc(a)
    assert.equal(pay.status, 'paid', part)
    assert.equal(pay.paytype, 'mono-acquire')
    assert.equal(pay.receiptStatus, 'amount-mismatch')
    assert.equal(pay.receiptError, part)
    assert.equal(pay.receiptId, undefined)
    assert.equal(pay.fiscalizeClaimedAt, undefined)
    assert.equal(sells().length, 0)
    assert.ok(a.logged('warn', `mono acquire webhook: сума не збіглася, чек НЕ вибито pay-1: ${part}`))

    const shop = shopDoc(a)
    assert.equal(shop.state, 'payment_review')
    assert.equal(shop.paidPaymentId, 'pay-1')
    assert.match(shop.paidAt, ISO)
    assert.equal(shop.payment.pageUrl, null)
    assert.equal(stock(a), 5, 'склад решает владелец вместе с заказом')
    assert.equal(a.db.get('shopPhones/ph-1').openCard['V2-LID-R'], null)
    assert.equal(unpaid(a), 2)
    const text = withGuideStep('amount-mismatch', `⚠️ Замовлення RF-100001: 1500.5 грн, дані банку не збігаються (${part}). Чек не виписано. Звірте суму в кабінеті monobank і вирішіть на картці замовлення: ${CARD_URL}`)
    assert.deepEqual(alertTexts(), [text])

    await a.hook(ok())
    await reconcileNow(a)
    assert.equal(sells().length, 0, 'повтор и сверка чек не выбивают')
    assert.equal(alertTexts().length, 1)
    assert.equal(payDoc(a).receiptStatus, 'amount-mismatch')
    assert.equal(shopDoc(a).history.length, 1)
  }
})

test('магазин: при уже записанной оплате другая сумма в ответе банка ничего не решает', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  const paid = payDoc(a)
  bankSays({ amount: 1 })
  await a.hook(ok())
  assert.deepEqual(payDoc(a), paid)
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(sells().length, 1)
})

test('магазин: сверка по pending идёт той же дорогой: неверная сумма и нет поля', async (t) => {
  const bad = await mountShop(t, shopSeed())
  bankSays({ amount: 1 })
  await reconcileNow(bad)
  assert.equal(payDoc(bad).receiptStatus, 'amount-mismatch')
  assert.equal(shopDoc(bad).state, 'payment_review')
  assert.equal(shopDoc(bad).paidSource, 'reconcile')
  assert.equal(sells().length, 0)

  const none = await mountShop(t, shopSeed())
  bankSays({ amount: undefined })
  await reconcileNow(none)
  assert.equal(shopDoc(none).state, 'paid')
  assert.equal(sells().length, 1)
  assert.equal(alertTexts().length, 1)
})

test('магазин: банк не прислал сумму или валюту: чек и один алерт; нет reference: просто чек', async (t) => {
  for (const [over, part] of [[{ amount: undefined }, 'amount'], [{ ccy: undefined }, 'ccy'], [{ amount: undefined, ccy: undefined }, 'amount, ccy']]) {
    const a = await mountShop(t, shopSeed())
    bankSays(over)
    await a.hook(ok())
    assert.equal(payDoc(a).status, 'paid')
    assert.equal(payDoc(a).receiptStatus, 'DONE')
    assert.equal(sells().length, 1)
    assert.equal(shopDoc(a).state, 'paid')
    assert.deepEqual(alertTexts(), [withGuideStep('amount-unverified', `⚠️ Замовлення RF-100001: 1500.5 грн оплачено, але банк не надіслав ${part}, суму не звірено. Звірте її в кабінеті monobank: ${CARD_URL}`)])
    await a.hook(ok())
    assert.equal(sells().length, 1)
    assert.equal(alertTexts().length, 1)
  }
  const a = await mountShop(t, shopSeed())
  bankSays({ reference: undefined })
  await a.hook(ok())
  assert.equal(sells().length, 1)
  assert.deepEqual(alertTexts(), [])
})

test('магазин: повтор и параллельные колбэки: один чек, один переход, склад один раз', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  const pay = payDoc(a)
  const shop = shopDoc(a)
  await a.hook(ok())
  await a.api.settleMonoAcquire(pay, ok(), 'status')
  await a.idle()
  assert.equal(sells().length, 1)
  assert.deepEqual(payDoc(a), pay)
  assert.deepEqual(shopDoc(a), shop)
  assert.equal(stock(a), 4)
  assert.equal(unpaid(a), 2)

  const b = await mountShop(t, shopSeed())
  net.on.sell = async (p) => { await sleep(20); return { id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' } }
  await Promise.all([b.postHook(ok()), b.postHook(ok()), b.postHook(ok())])
  await b.idle()
  assert.equal(sells().length, 1)
  assert.equal(stock(b), 4)
  assert.equal(shopDoc(b).history.length, 1)
})

test('магазин: частичный возврат: receiptStatus не трогаем, partialRefund, алерт, второго чека нет', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  const receipt = payDoc(a).receiptId

  bankSays({ finalAmount: 150050 })
  await a.hook(ok())
  assert.equal(payDoc(a).partialRefund, undefined, 'вся сумма на месте')
  bankSays({ finalAmount: null })
  await a.hook(ok())
  assert.equal(payDoc(a).partialRefund, undefined)
  assert.deepEqual(alertTexts(), [])

  bankSays({ finalAmount: 100050 })
  await a.hook(ok())
  let pay = payDoc(a)
  assert.equal(pay.receiptStatus, 'DONE')
  assert.equal(pay.receiptId, receipt)
  assert.equal(pay.status, 'paid')
  assert.equal(pay.partialRefund.amount, 500)
  assert.match(pay.partialRefund.at, ISO)
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(shopDoc(a).partialRefund.amount, 500)
  assert.equal(sells().length, 1, 'второй чек не выходит')
  const text500 = withGuideStep('partial-refund-50000', `⚠️ Замовлення RF-100001: банк повернув частину оплати, 500 грн. Оформіть чек повернення на різницю в Checkbox: ${CARD_URL}`)
  assert.deepEqual(alertTexts(), [text500])

  const at = pay.partialRefund.at
  await a.hook(ok())
  assert.equal(payDoc(a).partialRefund.at, at, 'повтор ничего не переписывает')
  assert.equal(alertTexts().length, 1)

  bankSays({ finalAmount: 80050 })
  await a.hook(ok())
  pay = payDoc(a)
  assert.equal(pay.partialRefund.amount, 700)
  assert.equal(shopDoc(a).partialRefund.amount, 700)
  assert.equal(alertTexts().at(-1), withGuideStep('partial-refund-70000', `⚠️ Замовлення RF-100001: банк повернув частину оплати, 700 грн. Оформіть чек повернення на різницю в Checkbox: ${CARD_URL}`))
  assert.equal(alertTexts().length, 2)
  assert.equal(sells().length, 1)
})

test('магазин: частичный возврат при неудачном чеке и до первой записи оплаты: чек один и на всю сумму', async (t) => {
  const a = await mountShop(t, shopSeed())
  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  assert.equal(payDoc(a).receiptStatus, 'error')
  net.on.sell = (p) => ({ id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' })
  bankSays({ finalAmount: 100050 })
  await a.hook(ok())
  assert.equal(payDoc(a).partialRefund.amount, 500)
  assert.equal(payDoc(a).receiptStatus, 'DONE', 'чек повторяется своим ходом')
  assert.equal(new Set(sells().map((c) => c.body.id)).size, 1)

  const b = await mountShop(t, shopSeed())
  bankSays({ finalAmount: 100050 })
  await b.hook(ok())
  assert.equal(shopDoc(b).state, 'paid')
  assert.equal(shopDoc(b).partialRefund.amount, 500)
  assert.equal(payDoc(b).partialRefund.amount, 500)
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
  assert.equal(alertTexts().length, 1)

  const c = await mountShop(t, shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptId: 'r-1', receiptStatus: 'DONE' }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(5) }))
  bankSays({ amount: undefined, finalAmount: 100050 })
  await c.hook(ok())
  assert.equal(payDoc(c).partialRefund.amount, 500, 'без amount в ответе считаем от суммы оплаты')

  const paidSeed = () => shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptId: 'r-1', receiptStatus: 'DONE' }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(5) })
  for (const over of [{ finalAmount: 200000 }, { finalAmount: 'нема' }, { amount: 100000, finalAmount: 100000 }]) {
    const d = await mountShop(t, paidSeed())
    bankSays(over)
    await d.hook(ok())
    assert.equal(payDoc(d).partialRefund, undefined, JSON.stringify(over))
    assert.deepEqual(alertTexts(), [], 'разница считается от суммы в ответе банка, больше суммы не возврат')
  }

  // Часть лишнего счёта вернули: алерт есть, а partialRefund заказа описывает только оплативший счёт.
  const e = await mountShop(t, { ...paidSeed(), 'payments/pay-2': shopPayment({ orderId: 'pay-2', providerOrderId: 'inv-2', status: 'paid', receiptId: 'r-2', receiptStatus: 'DONE' }) })
  bankSays({ reference: 'pay-2', finalAmount: 100050 })
  await e.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.equal(payDoc(e, 'pay-2').partialRefund.amount, 500)
  assert.equal(shopDoc(e).partialRefund, undefined)
  assert.equal(alertTexts().filter((x) => x.includes('повернув частину')).length, 1)
})

test('магазин: чек упал: заказ уже paid, повтор чека через сверку его не трогает', async (t) => {
  const a = await mountShop(t, shopSeed())
  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(payDoc(a).receiptStatus, 'error')
  const shop = shopDoc(a)

  net.on.sell = (p) => ({ id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' })
  await reconcileNow(a)
  assert.equal(payDoc(a).receiptStatus, 'DONE')
  assert.deepEqual(shopDoc(a), shop)
})

test('магазин: заказ не прочитался: чек всё равно выходит, повтор догоняет заказ один раз', async (t) => {
  const a = await mountShop(t, shopSeed())
  a.db.failRead = (path) => path === 'shopOrders/so-1'
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(sells().length, 1)
  assert.equal(shopDoc(a).state, 'awaiting_payment')
  assert.ok(a.logged('error', 'payments: onShopPaid pay-1, замовлення so-1: Firestore недоступний'))

  a.db.failRead = null
  await a.hook(ok())
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(stock(a), 4)
  assert.equal(sells().length, 1)
})

test('магазин: сервер упал между записью оплаты и хуком: повтор лечит и с суммой, и без', async (t) => {
  const a = await mountShop(t, shopSeed({ status: 'paid', paytype: 'mono-acquire' }))
  await a.hook(ok())
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(sells().length, 1)

  const b = await mountShop(t, shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptStatus: 'amount-mismatch', receiptError: 'сума 1 коп. замість 150050' }))
  bankSays({ amount: 150050 })
  await b.hook(ok())
  assert.equal(shopDoc(b).state, 'payment_review', 'причина берётся с документа оплаты')
  assert.equal(sells().length, 0)
  assert.ok(alertTexts()[0].includes('сума 1 коп. замість 150050'))
  assert.equal(payDoc(b).receiptStatus, 'amount-mismatch')

  const c = await mountShop(t, shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptStatus: 'amount-mismatch' }))
  await c.hook(ok())
  assert.equal(shopDoc(c).state, 'payment_review')
  assert.ok(alertTexts()[0].includes('сума не збіглася'))
})

test('магазин: заказа нет или хуки не подключены: деньги и чек не теряются', async (t) => {
  const { 'shopOrders/so-1': _gone, ...noOrder } = shopSeed()
  for (const status of ['success', 'reversed']) {
    const a = await mountShop(t, noOrder)
    await a.hook(ok())
    bankSays({ status, finalAmount: 100 })
    await a.hook(ok())
    assert.equal(sells().length, 1)
    assert.equal(a.db.get('shopOrders/so-1'), undefined, 'заказ не создаётся из воздуха')
    assert.ok(a.logged('error', 'shop: оплата pay-1 без замовлення so-1'))
    assert.ok(a.logged('error', status === 'reversed' ? 'shop: повернення pay-1 без замовлення so-1' : 'shop: часткове повернення pay-1 без замовлення so-1'))
  }

  const b = await mount(t, shopSeed())
  bankSays()
  await b.hook(ok())
  assert.equal(payDoc(b).status, 'paid')
  assert.equal(sells().length, 1)
  assert.ok(b.logged('error', 'payments: onShopPaid pay-1, замовлення so-1: хук не підключено'))
})

test('магазин: прочие живые счета снимаются в банке, остальные не трогаются, сбой не мешает чеку и лечится повтором', async (t) => {
  const seed = (removeOver = {}) => ({
    ...shopSeed({}, { paymentIds: ['pay-live', 'pay-failed', 'pay-removed', 'pay-paidx', 'pay-gone', 'pay-liq', 'pay-noinv', 'pay-1'] }),
    'payments/pay-live': shopPayment({ orderId: 'pay-live', providerOrderId: 'inv-live', fopId: 'fop-b', ...removeOver }),
    'payments/pay-failed': shopPayment({ orderId: 'pay-failed', providerOrderId: 'inv-failed', status: 'failure' }),
    'payments/pay-removed': shopPayment({ orderId: 'pay-removed', providerOrderId: 'inv-removed', status: 'removed' }),
    'payments/pay-paidx': shopPayment({ orderId: 'pay-paidx', providerOrderId: 'inv-paidx', status: 'paid' }),
    'payments/pay-liq': shopPayment({ orderId: 'pay-liq', provider: 'liqpay', providerOrderId: 'inv-liq' }),
    'payments/pay-noinv': shopPayment({ orderId: 'pay-noinv', providerOrderId: null }),
  })
  const a = await mountShop(t, seed())
  await a.hook(ok())
  assert.deepEqual(a.removed, [['fop-b', 'inv-live']])
  assert.equal(payDoc(a, 'pay-live').status, 'removed')
  assert.equal(payDoc(a, 'pay-failed').status, 'failure')
  assert.equal(payDoc(a, 'pay-removed').status, 'removed')
  assert.equal(payDoc(a, 'pay-paidx').status, 'paid')
  assert.equal(payDoc(a, 'pay-liq').status, 'pending')
  assert.equal(payDoc(a, 'pay-noinv').status, 'pending')
  assert.equal(shopDoc(a).payment.pageUrl, null)
  assert.equal(sells().length, 1)

  let down = true
  const b = await mountShop(t, seed(), { removeInvoice: async () => { if (down) throw httpErr(500, {}) } })
  await b.hook(ok())
  assert.equal(payDoc(b, 'pay-live').status, 'pending')
  assert.equal(sells().length, 1, 'банк не снял счёт, чек всё равно выходит')
  assert.equal(shopDoc(b).state, 'paid')
  assert.ok(b.logged('error', 'shop: рахунок pay-live не знято: Request failed with status code 500'))
  down = false
  await b.hook(ok())
  assert.equal(payDoc(b, 'pay-live').status, 'removed')

  const c = await mountShop(t, seed({ fopId: 'nope' }))
  await c.hook(ok())
  assert.deepEqual(c.removed, [])
  assert.ok(c.logged('error', 'shop: рахунок pay-live не знято: ФОП nope не завантажено'))
  assert.equal(sells().length, 1)

  // Хук сам по себе свой счёт не снимает, даже если документ ещё не успел стать paid.
  const d = await mountShop(t, shopSeed({}, { paymentIds: ['pay-1', 'pay-other'] }))
  const hooks = createShopPaymentHooks({ adminDb: d.db, payments: d.api, mono: { removeInvoice: async (fop, id) => { d.removed.push(id) } } })
  await hooks.onShopPaid(payDoc(d), { source: 'status' })
  assert.deepEqual(d.removed, [])
  assert.equal(await hooks.removeLiveInvoice('pay-1'), true, 'следующим шагам: снять счёт по id оплаты')
  assert.deepEqual(d.removed, ['inv-1'])
  assert.equal(payDoc(d).status, 'removed')
  assert.equal(await hooks.removeLiveInvoice('pay-1'), false)
  assert.equal(await hooks.removeLiveInvoice('none'), false)
})

test('магазин: второй успех: алерт «зайвий платіж», заказ на первом платеже, чек за пришедшие деньги', async (t) => {
  const seed = () => ({
    ...shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptId: 'r-1', receiptStatus: 'DONE' }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(30), paymentIds: ['pay-1', 'pay-2'] }),
    'payments/pay-2': shopPayment({ orderId: 'pay-2', providerOrderId: 'inv-2', status: 'removed' }),
  })
  const a = await mountShop(t, seed())
  const shop = shopDoc(a)
  bankSays({ reference: 'pay-2' })
  await a.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.equal(payDoc(a, 'pay-2').status, 'paid', 'снятый счёт всё равно проводит оплату')
  assert.equal(payDoc(a, 'pay-2').receiptStatus, 'DONE')
  assert.deepEqual(sells().map((c) => c.body.id), [receiptUuid('pay-2')])
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(shopDoc(a).paidPaymentId, 'pay-1')
  assert.equal(shopDoc(a).paidAt, shop.paidAt)
  assert.equal(stock(a), 5)
  assert.deepEqual(alertTexts(), [withGuideStep('extra-payment-pay-2', `⚠️ Замовлення RF-100001: зайвий платіж 1500.5 грн, замовлення вже оплачено іншим рахунком. Поверніть ці гроші в кабінеті monobank і оформіть чек повернення в Checkbox: ${CARD_URL}`)])
  assert.deepEqual(Object.keys(shopDoc(a).alerts), ['extra-payment-pay-2'])
  await a.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.equal(alertTexts().length, 1)
  assert.equal(sells().length, 1)

  // Счёт, который в первый раз снять не удалось, снимается и при втором успехе.
  const b = await mountShop(t, { ...seed(), 'payments/pay-3': shopPayment({ orderId: 'pay-3', providerOrderId: 'inv-3' }), 'shopOrders/so-1': { ...seed()['shopOrders/so-1'], paymentIds: ['pay-1', 'pay-2', 'pay-3'] } })
  bankSays({ reference: 'pay-2' })
  await b.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.deepEqual(b.removed, [['fop-a', 'inv-3']])
  assert.equal(payDoc(b, 'pay-1').status, 'paid')
})

test('магазин: оплата по cancelled и expired: payment_review, алерт, чек выходит, склад и счётчик не трогаем', async (t) => {
  for (const state of ['cancelled', 'expired']) {
    const a = await mountShop(t, shopSeed({ status: 'removed' }, { state, cancelReason: 'superseded' }))
    await a.hook(ok())
    const shop = shopDoc(a)
    assert.equal(shop.state, 'payment_review', state)
    assert.equal(shop.paidPaymentId, 'pay-1')
    assert.deepEqual(shop.history.map(({ from, to, by }) => ({ from, to, by })), [{ from: state, to: 'payment_review', by: 'webhook' }])
    assert.equal(payDoc(a).status, 'paid')
    assert.equal(payDoc(a).receiptStatus, 'DONE')
    assert.equal(sells().length, 1)
    assert.equal(stock(a), 5)
    assert.equal(unpaid(a), 3)
    assert.deepEqual(alertTexts(), [withGuideStep('late-payment', `⚠️ Замовлення RF-100001: 1500.5 грн оплачено вже після закриття замовлення. Вирішіть на картці замовлення: відправити чи повернути гроші: ${CARD_URL}`)])
  }
})

test('магазин: второй оплаченный заказ того же телефона за сутки: один алерт «можливий дубль»', async (t) => {
  const other = (over = {}) => ({ orderNo: 'RF-100000', phoneKey: 'ph-1', state: 'paid', paidAt: ago(60), ...over })
  const a = await mountShop(t, { ...shopSeed(), 'shopOrders/so-0': other() })
  await a.hook(ok())
  await a.hook(ok())
  assert.deepEqual(alertTexts(), [withGuideStep('possible-duplicate', `⚠️ Замовлення RF-100001: можливий дубль, той самий покупець за добу оплатив RF-100000. Перевірте обидва перед відправкою: ${CARD_URL}`)])
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(sells().length, 1)
  assert.match(shopDoc(a).alerts['possible-duplicate'].sentAt, ISO)

  const quiet = [
    other({ paidAt: ago(25 * 60) }),
    other({ phoneKey: 'ph-2' }),
    other({ state: 'reversed' }),
    other({ paidAt: undefined, state: 'awaiting_payment' }),
    other({ paidAt: new Date(Date.now() + 3600000).toISOString() }),
  ]
  for (const doc of quiet) {
    const b = await mountShop(t, { ...shopSeed(), 'shopOrders/so-0': doc })
    await b.hook(ok())
    assert.deepEqual(alertTexts(), [], JSON.stringify(doc))
  }

  const c = await mountShop(t, { ...shopSeed(), 'shopOrders/so-0': other() })
  net.on.sell = async (p) => { await sleep(10); return { id: p.id, status: 'DONE' } }
  await Promise.all([c.postHook(ok()), c.postHook(ok()), c.postHook(ok())])
  await c.idle()
  assert.equal(alertTexts().length, 1, 'параллельные колбэки шлют один алерт')

  // Оба вызова уже прошли проверку снимка: один алерт держится на транзакции. Поставленный алерт базу больше не спрашивает.
  const p = await mountShop(t, { ...shopSeed(), 'shopOrders/so-0': other() })
  const parallel = createShopPaymentHooks({ adminDb: p.db, payments: p.api })
  await Promise.all([parallel.onShopPaid(payDoc(p), { source: 'status' }), parallel.onShopPaid(payDoc(p), { source: 'status' })])
  assert.equal(alertTexts().length, 1)
  const queries = () => p.db.reads.filter((path) => path === 'shopOrders').length
  const before = queries()
  await parallel.onShopPaid(payDoc(p), { source: 'status' })
  assert.equal(queries(), before)

  const d = await mountShop(t, { ...shopSeed(), 'shopOrders/so-0': other() })
  const realCollection = d.db.collection.bind(d.db)
  d.db.collection = (name) => {
    const col = realCollection(name)
    return name === 'shopOrders' ? { ...col, where: () => { throw new Error('запит не пройшов') } } : col
  }
  await d.hook(ok())
  assert.equal(payDoc(d).receiptStatus, 'DONE', 'сбой проверки дубля чек не останавливает')
  assert.ok(d.logged('error', 'shop: перевірка дубля so-1: запит не пройшов'))
})

test('магазин: склад: 1 даёт 0 и выключение, 0 даёт алерт о перепродаже, null и нет настроек не считаем', async (t) => {
  const withStock = (skuOver) => ({ ...shopSeed(), 'system/shopSales': { skus: { 'V2-LID-R': { enabled: true, inStock: true, ...skuOver }, OTHER: { stock: 9 } } } })
  const a = await mountShop(t, withStock({ stock: 1 }))
  await a.hook(ok())
  assert.deepEqual(a.db.get('system/shopSales').skus, { 'V2-LID-R': { enabled: true, inStock: false, stock: 0 }, OTHER: { stock: 9 } })
  assert.deepEqual(alertTexts(), [withGuideStep('stock-out', `⚠️ Замовлення RF-100001: артикул V2-LID-R закінчився, продаж вимкнено. Поповніть залишок на сторінці замовлень: ${CARD_URL}`)])

  const b = await mountShop(t, withStock({ stock: 0 }))
  await b.hook(ok())
  assert.equal(stock(b), 0)
  assert.equal(b.db.get('system/shopSales').skus['V2-LID-R'].inStock, false)
  assert.deepEqual(alertTexts(), [withGuideStep('stock-oversold', `⚠️ Замовлення RF-100001: оплачено більше, ніж було на складі (V2-LID-R), продаж артикула вимкнено. Домовтеся з покупцем або поверніть гроші: ${CARD_URL}`)])
  assert.equal(shopDoc(b).state, 'paid')
  assert.equal(sells().length, 1, 'деньги пришли, чек выходит')

  const c = await mountShop(t, withStock({ stock: null }))
  await c.hook(ok())
  assert.equal(stock(c), null)
  assert.equal(c.db.get('system/shopSales').skus['V2-LID-R'].inStock, true)
  assert.deepEqual(alertTexts(), [])

  for (const seed of [{ ...shopSeed(), 'system/shopSales': { skus: {} } }, (({ 'system/shopSales': _s, ...rest }) => rest)(shopSeed())]) {
    const d = await mountShop(t, seed)
    await d.hook(ok())
    assert.equal(shopDoc(d).state, 'paid')
    assert.deepEqual(alertTexts(), [])
  }
})

test('магазин: телефон и суточный счётчик: чужой заказ остаётся, ноль не уходит в минус, пустых документов не создаём', async (t) => {
  const a = await mountShop(t, { ...shopSeed(), 'shopPhones/ph-1': { openCard: { 'V2-LID-R': 'so-newer' } }, 'shopDaily/2026-11-03': { unpaid: 0 } })
  await a.hook(ok())
  assert.deepEqual(a.db.get('shopPhones/ph-1').openCard, { 'V2-LID-R': 'so-newer' })
  assert.equal(unpaid(a), 0)

  const { 'shopPhones/ph-1': _p, 'shopDaily/2026-11-03': _d, ...bare } = shopSeed()
  const b = await mountShop(t, bare)
  await b.hook(ok())
  assert.equal(shopDoc(b).state, 'paid')
  assert.equal(b.db.get('shopPhones/ph-1'), undefined)
  assert.equal(b.db.get('shopDaily/2026-11-03'), undefined)

  const c = await mountShop(t, shopSeed({}, { phoneKey: undefined, createdAt: undefined, sku: undefined }))
  await c.hook(ok())
  assert.equal(shopDoc(c).state, 'paid', 'заказ без этих полей всё равно закрывается')
})

test('магазин: в алертах нет имени, телефона и отделения; sentAt только после отправки', async (t) => {
  const a = await mountShop(t, {
    ...shopSeed({}, { paymentIds: ['pay-1', 'pay-2'] }),
    'shopOrders/so-0': { orderNo: 'RF-100000', phoneKey: 'ph-1', state: 'paid', paidAt: ago(60) },
    'system/shopSales': { skus: { 'V2-LID-R': { stock: 1 } } },
  })
  bankSays({ amount: undefined, finalAmount: 100050 })
  await a.hook(ok())
  bankSays({ status: 'reversed' })
  await a.hook(ok())
  assert.equal(alertTexts().length, 5)
  for (const text of alertTexts()) {
    for (const secret of ['Петренко', 'Іван', '380000000001', 'Відділення', 'ph-1']) assert.equal(text.includes(secret), false, text)
    assert.ok(text.includes('RF-100001'), text)
    assert.ok(text.includes(CARD_URL), text)
  }
  for (const alert of Object.values(shopDoc(a).alerts)) assert.match(alert.sentAt, ISO)

  const b = await mountShop(t, shopSeed())
  net.on.telegram = () => { throw new Error('tg down') }
  bankSays({ amount: 1 })
  await b.hook(ok())
  const failed = shopDoc(b).alerts['amount-mismatch']
  assert.equal(failed.sentAt, null, 'не дошёл: повторит сверка')
  assert.match(failed.at, ISO)
  assert.ok(failed.text.includes('RF-100001'))

  const c = await mountShop(t, shopSeed(), { env: {} })
  bankSays({ amount: 1 })
  await c.hook(ok())
  assert.equal(shopDoc(c).alerts['amount-mismatch'].sentAt, null, 'Telegram не настроен')
  assert.equal(shopDoc(c).state, 'payment_review')
})

// ---------- возврат всей суммы ----------

const REVERSED_RECEIPT = withGuideStep('reversed', `⚠️ Замовлення RF-100001: банк повернув 1500.5 грн. Чек було виписано: оформіть чек повернення в Checkbox. Накладну не створюйте, а якщо посилка вже пішла, зупиніть її: ${CARD_URL}`)
const REVERSED_NO_RECEIPT = withGuideStep('reversed', `⚠️ Замовлення RF-100001: банк повернув 1500.5 грн. У нас чека немає: чек повернення потрібен, лише якщо чек є в кабінеті Checkbox. Накладну не створюйте, а якщо посилка вже пішла, зупиніть її: ${CARD_URL}`)

test('магазин: reversed по оплатившему счёту: документ, заказ, алерт про чек, повтор ничего не меняет', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  bankSays({ status: 'reversed' })
  await a.hook(ok())

  const pay = payDoc(a)
  assert.equal(pay.status, 'reversed')
  assert.equal(pay.reversedAfterPaid, true)
  assert.match(pay.reversedAt, ISO)
  assert.equal(pay.receiptStatus, 'DONE', 'выбитый чек остаётся в документе')
  const shop = shopDoc(a)
  assert.equal(shop.state, 'reversed')
  assert.match(shop.reversedAt, ISO)
  assert.equal(shop.paidPaymentId, 'pay-1')
  assert.deepEqual(shop.history.map(({ from, to, by }) => ({ from, to, by })), [{ from: 'awaiting_payment', to: 'paid', by: 'webhook' }, { from: 'paid', to: 'reversed', by: 'webhook' }])
  assert.deepEqual(alertTexts(), [REVERSED_RECEIPT])
  assert.equal(sells().length, 1)
  assert.equal(stock(a), 4, 'склад решает владелец: посылка могла уйти')

  await a.hook(ok())
  assert.deepEqual(payDoc(a), pay)
  assert.deepEqual(shopDoc(a), shop)
  assert.equal(alertTexts().length, 1)
})

test('магазин: чек с ошибкой, затем reversed: сверка и кнопка больше не выбивают чек', async (t) => {
  const a = await mountShop(t, shopSeed())
  net.on.sell = () => { throw new Error('timeout') }
  await a.hook(ok())
  assert.equal(payDoc(a).receiptStatus, 'error')
  const tries = sells().length
  net.on.sell = (p) => ({ id: p.id, status: 'DONE' })

  bankSays({ status: 'reversed' })
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(payDoc(a).receiptStatus, 'error')
  assert.equal(shopDoc(a).state, 'reversed')
  assert.ok(alertTexts().includes(REVERSED_NO_RECEIPT))

  await reconcileNow(a)
  assert.equal(sells().length, tries, 'сверка не зовёт Checkbox')
  const r = await a.send('POST', '/api/pay/pay-1/refiscalize', {}, ADMIN)
  assert.equal(r.status, 409)
  assert.equal(r.json.error.code, 'NOT_PAID')
  assert.equal(sells().length, tries)
  const list = await a.send('GET', '/api/pay/unfiscalized', undefined, ADMIN)
  assert.deepEqual(list.json.data, [], 'в «гроші є, чек ні» не показывается')
})

test('магазин: чек мог уйти в этот момент: живой захват считается чеком, поток у кассы новый чек не начнёт', async (t) => {
  const a = await mountShop(t, shopSeed({ status: 'paid', fiscalizeClaimedAt: ago(1) }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(2) }))
  bankSays({ status: 'reversed' })
  await a.hook(ok())
  assert.deepEqual(alertTexts(), [REVERSED_RECEIPT])

  const b = await mountShop(t, shopSeed({ status: 'paid' }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(2) }))
  const stale = payDoc(b)
  await b.api.saveOrder({ orderId: 'pay-1', status: 'reversed' })
  await b.api.fiscalize(stale, LABEL)
  assert.equal(sells().length, 0, 'снимок ещё paid, а документ уже reversed')
  assert.equal(payDoc(b).fiscalizeClaimedAt, undefined)

  const c = await mountShop(t, shopSeed({ status: 'paid' }, { state: 'payment_review', paidPaymentId: 'pay-1', paidAt: ago(2) }))
  const staleMismatch = payDoc(c)
  await c.api.saveOrder({ orderId: 'pay-1', receiptStatus: 'amount-mismatch' })
  await c.api.fiscalize(staleMismatch, LABEL)
  assert.equal(sells().length, 0)

  // Владелец подтвердил сумму и снял метку: тогда чек выходит, id тот же.
  await c.api.saveOrder({ orderId: 'pay-1', receiptStatus: null })
  await c.api.fiscalize(payDoc(c), LABEL)
  assert.deepEqual(sells().map((s) => s.body), [sellBody('pay-1')])
})

test('магазин: захват кассы завис (процесс упал у кассы): при возврате чек не считается выписанным', async (t) => {
  const a = await mountShop(t, shopSeed({ status: 'paid', fiscalizeClaimedAt: ago(11) }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(12) }))
  bankSays({ status: 'reversed' })
  await a.hook(ok())
  assert.deepEqual(alertTexts(), [REVERSED_NO_RECEIPT])
})

test('магазин: заказ не прочитался при reversed: документ уже закрыт первой записью, повтор догоняет заказ', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  bankSays({ status: 'reversed' })
  a.db.failRead = (path) => path === 'shopOrders/so-1'
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(payDoc(a).reversedAfterPaid, true)
  assert.equal(shopDoc(a).state, 'paid')
  assert.ok(a.logged('error', 'payments: onShopReversed pay-1, замовлення so-1: Firestore недоступний'))

  a.db.failRead = null
  const at = payDoc(a).reversedAt
  await a.hook(ok())
  assert.equal(shopDoc(a).state, 'reversed')
  assert.equal(payDoc(a).reversedAt, at)
  assert.deepEqual(alertTexts(), [REVERSED_RECEIPT])
})

test('магазин: reversed лишнего счёта: заказ тот же, алерт «повернуто зайвий платіж» с разным текстом о чеке', async (t) => {
  const seed = (extra) => ({
    ...shopSeed({ status: 'paid', paytype: 'mono-acquire', receiptId: 'r-1', receiptStatus: 'DONE' }, { state: 'shipped', paidPaymentId: 'pay-1', paidAt: ago(30), paymentIds: ['pay-1', 'pay-2'] }),
    'payments/pay-2': shopPayment({ orderId: 'pay-2', providerOrderId: 'inv-2', status: 'paid', amount: 700, ...extra }),
  })
  const a = await mountShop(t, seed({ receiptId: 'r-2', receiptStatus: 'DONE' }))
  const shop = shopDoc(a)
  bankSays({ status: 'reversed', reference: 'pay-2' })
  await a.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.equal(payDoc(a, 'pay-2').status, 'reversed')
  assert.equal(payDoc(a).status, 'paid', 'оплативший счёт цел')
  assert.equal(shopDoc(a).state, 'shipped')
  assert.deepEqual(shopDoc(a).history, shop.history)
  assert.deepEqual(alertTexts(), [withGuideStep('extra-reversed-pay-2', `⚠️ Замовлення RF-100001: повернуто зайвий платіж 700 грн, замовлення лишається без змін. Чек було виписано: оформіть чек повернення в Checkbox. ${CARD_URL}`)])
  await a.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.equal(alertTexts().length, 1)

  const b = await mountShop(t, seed({ receiptStatus: 'error', fiscalizeClaimedAt: null }))
  bankSays({ status: 'reversed', reference: 'pay-2' })
  await b.hook(ok({ invoiceId: 'inv-2', reference: 'pay-2' }))
  assert.deepEqual(alertTexts(), [withGuideStep('extra-reversed-pay-2', `⚠️ Замовлення RF-100001: повернуто зайвий платіж 700 грн, замовлення лишається без змін. У нас чека немає: чек повернення потрібен, лише якщо чек є в кабінеті Checkbox. ${CARD_URL}`)])
})

test('магазин: reversed из любого состояния после оплаты; payment_review тоже закрывается', async (t) => {
  for (const state of ['shipped', 'delivered', 'refused', 'returned', 'payment_review']) {
    const a = await mountShop(t, shopSeed({ status: 'paid', receiptId: 'r-1', receiptStatus: 'DONE' }, { state, paidPaymentId: 'pay-1', paidAt: ago(30) }))
    bankSays({ status: 'reversed' })
    await a.hook(ok())
    assert.equal(shopDoc(a).state, 'reversed', state)
    assert.equal(shopDoc(a).history.at(-1).from, state)
  }
  const done = await mountShop(t, shopSeed({ status: 'paid', receiptId: 'r-1' }, { state: 'reversed', paidPaymentId: 'pay-1', paidAt: ago(30), history: [{ at: ago(1), from: 'paid', to: 'reversed', by: 'owner' }] }))
  bankSays({ status: 'reversed' })
  await done.hook(ok())
  assert.equal(shopDoc(done).history.length, 1, 'владелец уже закрыл: второго перехода нет')
  assert.equal(alertTexts().length, 1, 'но сообщить о деньгах всё равно надо')
})

test('магазин: неоплаченный счёт и конечные статусы банка: только статус, ни хука, ни алерта', async (t) => {
  for (const status of ['failure', 'expired', 'reversed']) {
    const a = await mountShop(t, shopSeed())
    const order = shopDoc(a)
    bankSays({ status })
    await a.hook(ok())
    assert.equal(payDoc(a).status, status)
    assert.equal(payDoc(a).reversedAfterPaid, undefined)
    assert.deepEqual(shopDoc(a), order)
    assert.deepEqual(alertTexts(), [])
    assert.equal(sells().length, 0)

    const b = await mountShop(t, shopSeed())
    bankSays({ status })
    await reconcileNow(b)
    assert.equal(payDoc(b).status, status, 'сверка той же дорогой')
    assert.deepEqual(shopDoc(b), order)
  }
})

test('магазин: после оплаты failure и expired не откатывают; после возврата ничто не воскрешает платёж', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  const paid = payDoc(a)
  for (const status of ['failure', 'expired', 'processing', 'created', 'hold']) {
    bankSays({ status })
    await a.hook(ok())
    assert.deepEqual(payDoc(a), paid, status)
  }

  const b = await mountShop(t, shopSeed({ status: 'reversed', reversedAfterPaid: true, reversedAt: ago(5) }, { state: 'reversed', paidPaymentId: 'pay-1', paidAt: ago(30) }))
  const reversed = payDoc(b)
  const shop = shopDoc(b)
  for (const status of ['success', 'failure', 'expired', 'processing']) {
    bankSays({ status })
    await b.hook(ok())
    assert.deepEqual(payDoc(b), reversed, status)
    assert.deepEqual(shopDoc(b), shop, status)
  }
  assert.equal(sells().length, 0, 'чек после возврата не выходит')
  assert.deepEqual(alertTexts(), [])
})

test('ремонт: возврат и метка суммы чек не закрывают, как и раньше', async (t) => {
  const a = await mount(t, paySeed({ status: 'reversed' }))
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'paid', 'успех после reversed у ремонта по-прежнему проводит оплату')
  assert.equal(sells().length, 1)

  const b = await mount(t, paySeed({ status: 'paid' }))
  await b.api.saveOrder({ orderId: 'pay-1', receiptStatus: 'amount-mismatch' })
  await b.api.fiscalize(payDoc(b), LABEL)
  assert.equal(sells().length, 1, 'общий захват ограничен только магазином')
})

// ---------- повторный чек при расхождении суммы ----------

test('/refiscalize: магазин при amount-mismatch отвечает 409 и ведёт на заказ; ремонт и другие метки проходят', async (t) => {
  const a = await mountShop(t, {
    ...shopSeed({ status: 'paid', receiptStatus: 'amount-mismatch', receiptError: 'сума' }, { state: 'payment_review', paidPaymentId: 'pay-1' }),
    'payments/shop-error': shopPayment({ orderId: 'shop-error', status: 'paid', receiptStatus: 'error' }),
    'payments/repair': payment({ orderId: 'repair', status: 'paid', receiptStatus: 'amount-mismatch', estimateId: undefined, serviceRequestId: undefined }),
  })
  const r = await a.send('POST', '/api/pay/pay-1/refiscalize', {}, ADMIN)
  assert.equal(r.status, 409)
  assert.deepEqual(r.json, { success: false, error: { code: 'AMOUNT_REVIEW', message: 'Сума не збіглася з банком: рішення на сторінці замовлення', shopOrderId: 'so-1' } })
  assert.equal(sells().length, 0)
  assert.equal(payDoc(a).receiptStatus, 'amount-mismatch')
  assert.equal((await a.send('POST', '/api/pay/pay-1/refiscalize', {})).status, 403, 'права проверяются первыми')

  const repair = await a.send('POST', '/api/pay/repair/refiscalize', {}, ADMIN)
  assert.equal(repair.status, 200)
  assert.equal(repair.json.data.receiptId, receiptUuid('repair'))
  const shop = await a.send('POST', '/api/pay/shop-error/refiscalize', {}, ADMIN)
  assert.equal(shop.status, 200)
  assert.equal(shop.json.data.receiptId, receiptUuid('shop-error'))
  assert.equal(sells().length, 2)
})

// ---------- снятие счёта в банке: настоящий monoAcquire и хуки, как в index.js ----------

const removals = () => net.of('POST', `${MONO}/invoice/remove`)
const realHooks = (a) => createShopPaymentHooks({ adminDb: a.db, payments: a.api, siteUrl: 'https://portal.example' })

test('removeInvoice: точный запрос к банку с токеном ФОП, ответ банка как есть, есть и в default', async () => {
  net.reset()
  net.on.invoiceRemove = () => ({ answer: 'bank' })
  assert.deepEqual(await realMono.removeInvoice({ id: 'fop-x', monoAcquire: { token: 'MONO-X' } }, 'inv-7'), { answer: 'bank' })
  assert.equal(net.calls.length, 1)
  assert.deepEqual(removals()[0].body, { invoiceId: 'inv-7' })
  assert.deepEqual(removals()[0].headers, { 'X-Token': 'MONO-X', 'Content-Type': 'application/json' })
  assert.equal(removals()[0].timeout, 15000)
  assert.equal(realMono.default.removeInvoice, realMono.removeInvoice)
})

test('removeInvoice: без токена в сеть не идёт, отказ банка доходит до вызывающего', async () => {
  net.reset()
  await assert.rejects(realMono.removeInvoice({ id: 'fop-x' }, 'inv-7'), /ФОП fop-x: monobank еквайринг не налаштований/)
  assert.equal(net.calls.length, 0)
  net.on.invoiceRemove = () => { throw httpErr(400, { errCode: 'INVOICE_PAID' }) }
  await assert.rejects(realMono.removeInvoice({ id: 'fop-x', monoAcquire: { token: 'MONO-X' } }, 'inv-7'), (e) => e.response.status === 400)
})

test('снятие счёта: removed только после ответа банка, токен ФОП платежа, повтор банк не зовёт', async (t) => {
  const a = await mount(t, shopSeed({ fopId: 'fop-b' }))
  const before = payDoc(a)
  let atBank = null
  net.on.invoiceRemove = () => { atBank = payDoc(a).status; return {} }
  assert.equal(await realHooks(a).removeLiveInvoice('pay-1'), true)
  assert.equal(atBank, 'pending')
  assert.deepEqual(removals().map((c) => [c.body.invoiceId, c.headers['X-Token']]), [['inv-1', 'MONO-B']])
  const { status, updatedAt, ...rest } = payDoc(a)
  assert.equal(status, 'removed')
  assert.match(updatedAt, ISO)
  assert.deepEqual(rest, (({ status: _s, updatedAt: _u, ...other }) => other)(before), 'меняется только статус')

  assert.equal(await realHooks(a).removeLiveInvoice('pay-1'), false)
  assert.equal(removals().length, 1)
})

test('снятие счёта: банк отказал, документ не меняется и счёт остаётся в опросе', async (t) => {
  const a = await mount(t, shopSeed({ createdAt: ago(60) }))
  const before = payDoc(a)
  net.on.invoiceRemove = () => { throw httpErr(400, { errCode: 'INVOICE_PAID' }) }
  await assert.rejects(realHooks(a).removeLiveInvoice('pay-1'), (e) => e.response.status === 400)
  assert.deepEqual(payDoc(a), before)
  await reconcileNow(a)
  assert.deepEqual(statusChecks().map((c) => c.params.invoiceId), ['inv-1'])
})

test('снятие счёта: пока банк отвечал, колбэк записал оплату: её не затираем', async (t) => {
  const a = await mount(t, shopSeed())
  net.on.invoiceRemove = async () => { await a.api.saveOrder({ orderId: 'pay-1', status: 'paid', paytype: 'mono-acquire' }); return {} }
  assert.equal(await realHooks(a).removeLiveInvoice('pay-1'), false)
  assert.equal(payDoc(a).status, 'paid')
})

test('снятый счёт не занимает очередь сверки: 60 снятых не закрывают живой, а 60 висящих закрыли бы', async (t) => {
  const seed = (status) => {
    const out = {}
    for (let i = 0; i < 60; i++) out[`payments/a-${i}`] = shopPayment({ orderId: `a-${i}`, providerOrderId: `inv-a-${i}`, createdAt: ago(60), status })
    // Сверка берёт первые 50: живой счёт в конце выборки.
    out['payments/live'] = shopPayment({ orderId: 'live', providerOrderId: 'inv-live', createdAt: ago(60) })
    return out
  }
  const a = await mount(t, seed('removed'))
  await reconcileNow(a)
  assert.deepEqual(statusChecks().map((c) => c.params.invoiceId), ['inv-live'])

  const b = await mount(t, seed('pending'))
  await reconcileNow(b)
  assert.equal(statusChecks().length, 50)
  assert.ok(!statusChecks().some((c) => c.params.invoiceId === 'inv-live'))
})

test('поздний успех по снятому счёту проводит оплату: paid, чек, заказ на проверке', async (t) => {
  const a = await mount(t, shopSeed({}, { state: 'cancelled', cancelReason: 'superseded' }), { env: OWNER })
  a.api.setShopHooks(realHooks(a))
  await realHooks(a).removeLiveInvoice('pay-1')
  assert.equal(payDoc(a).status, 'removed')
  assert.equal(sells().length, 0)

  bankSays()
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(payDoc(a).receiptId, receiptUuid('pay-1'))
  assert.deepEqual(sells().map((c) => c.body.id), [receiptUuid('pay-1')])
  assert.equal(shopDoc(a).state, 'payment_review')
  assert.equal(shopDoc(a).paidPaymentId, 'pay-1')
  assert.equal(removals().length, 1, 'свой счёт второй раз не снимается')
})

test('оплата заказа снимает прочий живой счёт настоящим запросом к банку, с токеном его ФОП', async (t) => {
  const a = await mount(t, {
    ...shopSeed({}, { paymentIds: ['pay-1', 'pay-2'] }),
    'payments/pay-2': shopPayment({ orderId: 'pay-2', providerOrderId: 'inv-2', fopId: 'fop-b' }),
  })
  a.api.setShopHooks(realHooks(a))
  bankSays()
  await a.hook(ok())
  assert.deepEqual(removals().map((c) => [c.body.invoiceId, c.headers['X-Token']]), [['inv-2', 'MONO-B']])
  assert.equal(payDoc(a, 'pay-2').status, 'removed')
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(shopDoc(a).state, 'paid')
  assert.equal(sells().length, 1)
})

// ---------- чтение чека при просроченном токене кассира: настоящий checkbox.js ----------

const route = (c) => [c.method, c.url.replace(CBX, ''), c.headers.Authorization]
const tokenSeq = () => {
  let n = 0
  return () => ({ access_token: `tok-${++n}` })
}

test('getReceipt: 401 лечится одним входом и одним повтором со свежим токеном, дальше токен из кэша', async () => {
  net.reset()
  net.on.signin = tokenSeq()
  const fop = { id: 'read-401', checkbox: cashbox('R') }
  await realCheckbox.getReceipt(fop, 'r-1')
  assert.deepEqual(net.calls.map(route), [['POST', '/cashier/signinPinCode', undefined], ['GET', '/receipts/r-1', 'Bearer tok-1']])

  net.calls = []
  let expired = true
  net.on.receipt = (id) => {
    if (expired) { expired = false; throw httpErr(401, {}) }
    return { id, status: 'DONE', fiscal_code: 'FC-2', tax_url: 'https://check.example/2' }
  }
  assert.deepEqual(await realCheckbox.getReceipt(fop, 'r-2'), { receiptId: 'r-2', fiscalCode: 'FC-2', taxUrl: 'https://check.example/2', status: 'DONE' })
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/receipts/r-2', 'Bearer tok-1'],
    ['POST', '/cashier/signinPinCode', undefined],
    ['GET', '/receipts/r-2', 'Bearer tok-2'],
  ])
  assert.deepEqual(net.of('POST', `${CBX}/cashier/signinPinCode`)[0].body, { pin_code: 'PIN-R' })

  net.calls = []
  await realCheckbox.getReceipt(fop, 'r-3')
  assert.deepEqual(net.calls.map(route), [['GET', '/receipts/r-3', 'Bearer tok-2']])
})

test('getReceipt: второй 401 не зацикливается, ошибка доходит до вызывающего, новый токен остаётся', async () => {
  net.reset()
  net.on.signin = tokenSeq()
  const fop = { id: 'read-401-twice', checkbox: cashbox('T') }
  await realCheckbox.signin(fop)
  net.calls = []
  net.on.receipt = () => { throw httpErr(401, {}) }
  await assert.rejects(realCheckbox.getReceipt(fop, 'r-1'), (e) => e.response.status === 401)
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/receipts/r-1', 'Bearer tok-1'],
    ['POST', '/cashier/signinPinCode', undefined],
    ['GET', '/receipts/r-1', 'Bearer tok-2'],
  ])
})

test('getReceipt: другие ошибки входа не вызывают и токен не сбрасывают', async () => {
  net.reset()
  net.on.signin = tokenSeq()
  const fop = { id: 'read-other', checkbox: cashbox('O2') }
  await realCheckbox.signin(fop)
  for (const err of [httpErr(403, {}), httpErr(404, {}), httpErr(500, {}), new Error('socket hang up')]) {
    net.calls = []
    net.on.receipt = () => { throw err }
    await assert.rejects(realCheckbox.getReceipt(fop, 'r-1'), (e) => e === err)
    assert.deepEqual(net.calls.map(route), [['GET', '/receipts/r-1', 'Bearer tok-1']])
  }
})

test('getReceipt: вход при повторе не удался: ошибка входа наружу, старый токен забыт, следующий вызов входит заново', async () => {
  net.reset()
  const next = tokenSeq()
  net.on.signin = next
  const fop = { id: 'read-signin-down', checkbox: cashbox('D') }
  await realCheckbox.signin(fop)
  net.calls = []
  let expired = true
  net.on.receipt = (id) => {
    if (expired) { expired = false; throw httpErr(401, {}) }
    return { id, status: 'DONE' }
  }
  const down = httpErr(502, {})
  net.on.signin = () => { throw down }
  await assert.rejects(realCheckbox.getReceipt(fop, 'r-1'), (e) => e === down)
  assert.deepEqual(net.calls.map(route), [['GET', '/receipts/r-1', 'Bearer tok-1'], ['POST', '/cashier/signinPinCode', undefined]])

  net.calls = []
  net.on.signin = next
  assert.equal((await realCheckbox.getReceipt(fop, 'r-1')).status, 'DONE')
  assert.deepEqual(net.calls.map(route), [['POST', '/cashier/signinPinCode', undefined], ['GET', '/receipts/r-1', 'Bearer tok-2']])
})

test('сверка: просроченный токен кассира не мешает дописать код чека; если вход не помог, документ цел и очередь идёт дальше', async (t) => {
  const seed = {
    'payments/pay-1': payment({ fopId: 'fop-stale', status: 'paid', paytype: 'mono-acquire', receiptId: 'r-1', receiptStatus: 'CREATED' }),
    'payments/pay-2': payment({ orderId: 'pay-2', status: 'paid', paytype: 'mono-acquire', receiptId: 'r-2', receiptStatus: 'CREATED', estimateId: undefined, serviceRequestId: undefined }),
  }
  const a = await mount(t, seed)
  net.on.signin = () => ({ access_token: 'tok-old' })
  await realCheckbox.signin({ id: 'fop-stale', checkbox: cashbox('S') })

  // Касса признаёт только новый токен, как после истечения срока.
  net.on.signin = () => ({ access_token: 'tok-new' })
  const answer = (id) => ({ id, status: 'DONE', fiscal_code: `FC-${id}`, tax_url: `https://check.example/${id}` })
  net.on.receipt = (id) => {
    if (id === 'r-1' && net.calls.at(-1).headers.Authorization !== 'Bearer tok-new') throw httpErr(401, {})
    return answer(id)
  }
  await reconcileNow(a)
  assert.equal(payDoc(a).receiptStatus, 'DONE')
  assert.equal(payDoc(a).fiscalCode, 'FC-r-1')
  assert.equal(payDoc(a).taxUrl, 'https://check.example/r-1')
  assert.equal(payDoc(a, 'pay-2').fiscalCode, 'FC-r-2')
  assert.equal(a.logged('error', 'reconcile receipt'), false)

  const b = await mount(t, seed)
  net.on.receipt = (id) => { if (id === 'r-1') throw httpErr(401, {}); return answer(id) }
  await reconcileNow(b)
  assert.equal(payDoc(b).receiptStatus, 'CREATED')
  assert.equal(payDoc(b).fiscalCode, undefined)
  assert.ok(b.logged('error', 'reconcile receipt pay-1 401'))
  assert.equal(payDoc(b, 'pay-2').fiscalCode, 'FC-r-2')
  assert.equal(sells().length, 0)
})

// ---------- находки проверки: сверка и деньги, которые банк вернул после оплаты ----------

const pad = (i) => String(i).padStart(3, '0')
const shopAhead = (n, over = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`payments/a-${pad(i)}`, shopPayment({ orderId: `a-${pad(i)}`, providerOrderId: `inv-a-${pad(i)}`, ...over })]))
const paidShop = (pay = {}, order = {}) => shopSeed({ status: 'paid', paytype: 'mono-acquire', ...pay }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(5), ...order })
const bankDown = () => { net.on.invoiceStatus = () => { throw httpErr(500, {}) } }
const SIGNAL = withGuideStep('reversed-signal', `⚠️ Замовлення RF-100001: банк повідомив про повернення 1500.5 грн, але статус не вдалося перечитати. Чек не вийде, доки банк не відповість. Накладну не створюйте, звірте оплату в кабінеті monobank: ${CARD_URL}`)

test('сверка: счета магазина впереди по id не закрывают ремонт: свежие не занимают лимит, ремонты опрашиваются первыми', async (t) => {
  const repair = () => ({ ...repairSeed(), 'payments/z-repair': payment({ orderId: 'z-repair', providerOrderId: 'inv-repair' }) })
  const answer = (invoiceId) => (invoiceId === 'inv-repair' ? ok({ invoiceId, reference: 'z-repair' }) : { invoiceId, status: 'processing' })

  // Свежие: к банку за ними не идём. 250: больше одной страницы чтения.
  const fresh = await mount(t, { ...shopAhead(250, { createdAt: ago(1) }), ...repair() })
  net.on.invoiceStatus = answer
  const r = await reconcileNow(fresh)
  assert.deepEqual(r.json.data, { checked: 1 })
  assert.equal(fresh.db.get('payments/z-repair').status, 'paid')
  assert.equal(fresh.db.get('priceEstimates/est-1').status, 'paid')
  assert.deepEqual(sells().map((c) => c.body), [sellBody('z-repair')])

  // Старые: лимит обращений к банку остаётся, ремонт в нём первый.
  const old = await mount(t, { ...shopAhead(60), ...repair() })
  net.on.invoiceStatus = answer
  const o = await reconcileNow(old)
  assert.equal(o.json.data.checked, 50)
  assert.equal(statusChecks().length, 50)
  assert.equal(statusChecks()[0].params.invoiceId, 'inv-repair')
  assert.equal(old.db.get('payments/z-repair').status, 'paid')
})

test('ремонт: алерт о расхождении уходит после чека: зависший Telegram кассу не держит, сбой на чеке алерт не отменяет', async (t) => {
  const order = () => net.calls.filter((c) => c.url.includes('/receipts/sell') || c.url.includes('telegram')).map((c) => (c.url.includes('telegram') ? 'telegram' : 'sell'))
  const a = await mount(t, paySeed(), { env: OWNER })
  await a.hook(ok({ amount: 1 }))
  assert.deepEqual(order(), ['sell', 'telegram'])

  const b = await mount(t, paySeed(), { env: OWNER })
  b.db.failRead = (path) => path === 'payments/pay-1'
  await b.hook(ok({ amount: 1 }))
  assert.equal(sells().length, 0, 'захват чека упал вместе с базой')
  assert.equal(alertTexts().length, 1)
  assert.ok(b.logged('error', 'mono acquire callback error'))
})

test('магазин: reversed при сбое чтения и чеке с ошибкой: чек на возвращённые деньги не выходит, сверка доводит возврат', async (t) => {
  const a = await mountShop(t, shopSeed())
  net.on.sell = () => { throw new Error('checkbox down') }
  await a.hook(ok())
  assert.equal(payDoc(a).receiptStatus, 'error')
  const tries = sells().length
  net.on.sell = (p) => ({ id: p.id, status: 'DONE' })

  bankDown()
  await a.hook(ok({ status: 'reversed' }))
  assert.equal(payDoc(a).status, 'paid', 'одному телу колбэка статус не верим')
  assert.equal(payDoc(a).bankRecheck, true)
  assert.ok(alertTexts().includes(SIGNAL), 'подписанное тело: владелец узнаёт сразу')

  await reconcileNow(a)
  assert.equal(sells().length, tries, 'банк молчит: чека нет')
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(payDoc(a).receiptStatus, 'error')

  bankSays({ status: 'reversed' })
  const r = await reconcileNow(a)
  assert.equal(r.json.data.checked, 1, 'один опрос на документ, хотя он и в метке, и в ошибке чека')
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(payDoc(a).reversedAfterPaid, true)
  assert.equal(payDoc(a).bankRecheck, null)
  assert.equal(shopDoc(a).state, 'reversed')
  assert.equal(shopDoc(a).paidSource, 'webhook')
  assert.ok(alertTexts().includes(REVERSED_NO_RECEIPT))
  assert.equal(sells().length, tries)

  const polls = statusChecks().length
  await reconcileNow(a)
  assert.equal(statusChecks().length, polls, 'дальше банк не спрашиваем')
  assert.equal(alertTexts().filter((x) => x === SIGNAL).length, 1)
})

test('магазин: сбой чтения по оплаченному счёту с другим статусом в теле: только метка, алерта нет; повторный сбой метку не трогает', async (t) => {
  const a = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
  bankDown()
  await a.hook(ok())
  assert.equal(payDoc(a).bankRecheck, true)
  assert.deepEqual(alertTexts(), [])
  await a.hook(ok({ status: 'reversed' }))
  await a.hook(ok({ status: 'reversed' }))
  assert.deepEqual(alertTexts(), [SIGNAL], 'сигнал один')
  bankSays()
  await reconcileNow(a)
  assert.equal(payDoc(a).bankRecheck, null, 'банк подтвердил оплату')
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(sells().length, 0, 'чек уже есть')
})

test('магазин: повтор чека в сверке только через банк: колбэк потерян и деньги вернули; успех даёт чек; ожидание и сбой не дают', async (t) => {
  const seed = () => paidShop({ receiptStatus: 'error', fiscalizeClaimedAt: null })
  const lost = await mountShop(t, seed())
  bankSays({ status: 'reversed' })
  await reconcileNow(lost)
  assert.equal(sells().length, 0)
  assert.equal(payDoc(lost).status, 'reversed')
  assert.equal(shopDoc(lost).state, 'reversed')
  assert.deepEqual(alertTexts(), [REVERSED_NO_RECEIPT])

  const good = await mountShop(t, seed())
  bankSays()
  const r = await reconcileNow(good)
  assert.equal(r.json.data.checked, 1)
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
  assert.equal(payDoc(good).receiptStatus, 'DONE')
  assert.deepEqual(statusChecks().map((c) => c.params), [{ invoiceId: 'inv-1' }])

  for (const answer of [() => bankDown(), () => bankSays({ status: 'processing' }), () => bankSays({ status: 'hold' })]) {
    const c = await mountShop(t, seed())
    answer()
    await reconcileNow(c)
    assert.equal(sells().length, 0)
    assert.equal(payDoc(c).receiptStatus, 'error')
    assert.equal(payDoc(c).status, 'paid')
  }

  const nofop = await mountShop(t, paidShop({ receiptStatus: 'error', fopId: 'nope' }))
  await reconcileNow(nofop)
  assert.equal(statusChecks().length, 0)
  assert.equal(sells().length, 0)
})

test('ремонт и лодка: сверка повторяет чек без обращения к банку, метка не появляется ни на одном пути', async (t) => {
  const a = await mount(t, paySeed({ status: 'paid', paytype: 'mono-acquire', receiptStatus: 'error' }))
  await reconcileNow(a)
  assert.equal(statusChecks().length, 0)
  assert.equal(sells().length, 1)
  assert.ok(!('bankRecheck' in a.db.get('payments/pay-1')))

  const b = await mount(t, paySeed())
  await b.hook(ok())
  assert.ok(!('bankRecheck' in b.db.get('payments/pay-1')))
  await b.hook(ok({ status: 'reversed' }))
  assert.ok(!('bankRecheck' in b.db.get('payments/pay-1')))
})

test('магазин: заказ не прочитался при reversed: сверка сама доводит заказ, без второго колбэка', async (t) => {
  const a = await mountShop(t, shopSeed())
  await a.hook(ok())
  bankSays({ status: 'reversed' })
  a.db.failRead = (path) => path === 'shopOrders/so-1'
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(payDoc(a).bankRecheck, true)
  assert.equal(shopDoc(a).state, 'paid')

  await reconcileNow(a)
  assert.equal(shopDoc(a).state, 'paid', 'база ещё лежит: метка на месте')
  assert.equal(payDoc(a).bankRecheck, true)

  a.db.failRead = null
  await reconcileNow(a)
  assert.equal(shopDoc(a).state, 'reversed')
  assert.equal(payDoc(a).bankRecheck, null)
  assert.deepEqual(alertTexts(), [REVERSED_RECEIPT])
  assert.equal(sells().length, 1)

  const polls = statusChecks().length
  await reconcileNow(a)
  assert.equal(statusChecks().length, polls)

  // Банк в этот раз ответил не reversed: возврат конечен, а заказ всё равно надо довести.
  const b = await mountShop(t, shopSeed({ status: 'reversed', reversedAfterPaid: true, bankRecheck: true, receiptId: 'r-1', receiptStatus: 'DONE' }, { state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(5) }))
  bankSays()
  await reconcileNow(b)
  assert.equal(shopDoc(b).state, 'reversed')
  assert.equal(payDoc(b).status, 'reversed')
  assert.equal(payDoc(b).bankRecheck, null)
  assert.equal(sells().length, 0)
})

test('магазин: сервер упал сразу после записи оплаты: сверка доводит заказ и чек, метка ставится вместе со статусом', async (t) => {
  const a = await mountShop(t, shopSeed())
  let atHook = null
  const hooks = createShopPaymentHooks({ adminDb: a.db, payments: a.api, siteUrl: 'https://portal.example' })
  a.api.setShopHooks({ ...hooks, onShopPaid: async () => { atHook = payDoc(a); throw new Error('сервер упал') } })
  await a.hook(ok())
  assert.equal(atHook.status, 'paid')
  assert.equal(atHook.bankRecheck, true, 'метка уже в первой записи')

  const b = await mountShop(t, shopSeed({ status: 'paid', paytype: 'mono-acquire', bankRecheck: true }))
  await reconcileNow(b)
  assert.equal(shopDoc(b).state, 'paid')
  assert.equal(shopDoc(b).paidPaymentId, 'pay-1')
  assert.equal(shopDoc(b).paidSource, 'reconcile')
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
  assert.equal(payDoc(b).bankRecheck, null)
})

test('магазин: сбой хука на оплате закрытого заказа лечит сверка: payment_review, алерт, чек один', async (t) => {
  const a = await mountShop(t, shopSeed({ status: 'removed' }, { state: 'cancelled', cancelReason: 'superseded' }))
  a.db.failRead = (path) => path === 'shopOrders/so-1'
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(sells().length, 1)
  assert.equal(shopDoc(a).state, 'cancelled')
  assert.equal(payDoc(a).bankRecheck, true)

  a.db.failRead = null
  await reconcileNow(a)
  assert.equal(shopDoc(a).state, 'payment_review')
  assert.equal(shopDoc(a).paidPaymentId, 'pay-1')
  assert.equal(shopDoc(a).alerts['late-payment'].sentAt != null, true)
  assert.equal(payDoc(a).bankRecheck, null)
  assert.equal(sells().length, 1)
})

test('магазин: сбой чтения по снятому счёту: метка, сверка проводит поздний успех или закрывает ответом банка', async (t) => {
  const a = await mountShop(t, shopSeed({ status: 'removed' }, { state: 'cancelled', cancelReason: 'superseded' }))
  bankDown()
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'removed')
  assert.equal(payDoc(a).bankRecheck, true)
  bankSays()
  await reconcileNow(a)
  assert.equal(payDoc(a).status, 'paid')
  assert.equal(shopDoc(a).state, 'payment_review')
  assert.equal(payDoc(a).bankRecheck, null)

  for (const [status, expected] of [['expired', 'expired'], ['reversed', 'reversed'], ['created', 'removed']]) {
    const b = await mountShop(t, shopSeed({ status: 'removed', bankRecheck: true }, { state: 'cancelled' }))
    bankSays({ status })
    await reconcileNow(b)
    assert.equal(payDoc(b).status, expected, status)
    assert.equal(payDoc(b).bankRecheck, null, status)
    assert.deepEqual(alertTexts(), [])
  }
})

test('/refiscalize: счёт магазина идёт через банк: возврат не даёт чека, банк молчит 502, успех даёт чек', async (t) => {
  const seed = () => paidShop({ receiptStatus: 'error' })
  const a = await mountShop(t, seed())
  bankDown()
  const down = await a.send('POST', '/api/pay/pay-1/refiscalize', {}, ADMIN)
  assert.equal(down.status, 502)
  assert.equal(down.json.error.code, 'BANK_UNAVAILABLE')
  assert.equal(sells().length, 0)
  assert.equal(payDoc(a).status, 'paid')

  bankSays({ status: 'reversed' })
  const back = await a.send('POST', '/api/pay/pay-1/refiscalize', {}, ADMIN)
  assert.equal(back.status, 200)
  assert.equal(back.json.data.receiptId, null)
  assert.equal(sells().length, 0)
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(shopDoc(a).state, 'reversed')

  const b = await mountShop(t, seed())
  const r = await b.send('POST', '/api/pay/pay-1/refiscalize', {}, ADMIN)
  assert.equal(r.json.data.receiptId, receiptUuid('pay-1'))
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1')])
})

// ---------- статусы банка, которых нет в нашем списке ----------

test('магазин: незнакомый статус по оплаченному счёту: журнал, один алерт на статус, чека нет, оплата не меняется', async (t) => {
  const a = await mountShop(t, paidShop({ receiptStatus: 'error' }))
  const pay = payDoc(a)
  bankSays({ status: 'chargeback' })
  await a.hook(ok())
  assert.deepEqual(payDoc(a), pay)
  assert.equal(sells().length, 0)
  assert.equal(shopDoc(a).state, 'paid')
  assert.ok(a.logged('warn', 'mono acquire webhook: статус chargeback за оплаченим рахунком pay-1'))
  const stored = (s) => `⚠️ Замовлення RF-100001: банк показує статус «${s}» за оплатою 1500.5 грн. Чек і накладну не робіть, доки не звірите оплату в кабінеті monobank: ${CARD_URL}`
  const text = (s) => withGuideStep(`unknown-status-${s}`, stored(s))
  assert.deepEqual(alertTexts(), [text('chargeback')])

  await a.hook(ok())
  await reconcileNow(a)
  assert.equal(alertTexts().length, 1, 'повтор и сверка второго алерта не шлют')
  assert.equal(sells().length, 0, 'сверка чек не выбивает')

  bankSays({ status: 'a.b c' })
  await a.hook(ok())
  assert.equal(alertTexts().at(-1), text('a.b c'))
  assert.equal(shopDoc(a).alerts['unknown-status-a_b_c'].text, stored('a.b c'))

  for (const status of ['failure', 'expired']) {
    const b = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
    const before = payDoc(b)
    bankSays({ status })
    await b.hook(ok())
    assert.deepEqual(payDoc(b), before, status)
    assert.deepEqual(alertTexts(), [text(status)], 'оплаченный счёт, а банк пишет неудачу')
  }

  for (const status of ['processing', 'hold', 'created', undefined]) {
    const c = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
    bankSays({ status })
    await c.hook(ok())
    assert.deepEqual(alertTexts(), [], String(status))
    assert.equal(c.logged('warn', 'за оплаченим рахунком'), false, String(status))
  }

  // Незнакомый статус по неоплаченному счёту: документ остаётся в опросе, алерта нет.
  const d = await mountShop(t, shopSeed())
  bankSays({ status: 'chargeback' })
  await d.hook(ok())
  assert.equal(payDoc(d).status, 'pending')
  assert.deepEqual(alertTexts(), [])
})

// ---------- finalAmount ----------

test('магазин: success с finalAmount=0: полный возврат, а не частичный; первая запись оплаты чека не даёт', async (t) => {
  for (const finalAmount of [0, -5, '0']) {
    const a = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
    bankSays({ finalAmount })
    await a.hook(ok())
    assert.equal(payDoc(a).status, 'reversed', String(finalAmount))
    assert.equal(payDoc(a).partialRefund, undefined)
    assert.equal(shopDoc(a).state, 'reversed')
    assert.deepEqual(alertTexts(), [REVERSED_RECEIPT])
  }

  const first = await mountShop(t, shopSeed())
  const order = shopDoc(first)
  bankSays({ finalAmount: 0 })
  await first.hook(ok())
  assert.equal(payDoc(first).status, 'reversed')
  assert.equal(payDoc(first).reversedAfterPaid, undefined)
  assert.equal(sells().length, 0, 'денег нет: чека нет')
  assert.deepEqual(shopDoc(first), order)

  // Пустая строка и мусор не ноль: как будто поля нет.
  for (const finalAmount of ['', 'нема', null]) {
    const b = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
    bankSays({ finalAmount })
    await b.hook(ok())
    assert.equal(payDoc(b).status, 'paid', JSON.stringify(finalAmount))
    assert.equal(payDoc(b).partialRefund, undefined, JSON.stringify(finalAmount))
    assert.deepEqual(alertTexts(), [])
  }
})

test('магазин: reversed с остатком денег: заказ закрыт, в алерте и документах фактическая сумма возврата', async (t) => {
  const a = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
  bankSays({ status: 'reversed', amount: 150050, finalAmount: 100000 })
  await a.hook(ok())
  assert.equal(payDoc(a).status, 'reversed')
  assert.equal(payDoc(a).partialRefund.amount, 500.5)
  assert.equal(shopDoc(a).state, 'reversed')
  assert.equal(shopDoc(a).partialRefund.amount, 500.5)
  assert.deepEqual(alertTexts(), [withGuideStep('reversed', `⚠️ Замовлення RF-100001: банк повернув 500.5 грн із 1500.5 грн. Чек було виписано: оформіть чек повернення в Checkbox. На рахунку лишилась решта: звірте суму в кабінеті monobank. Накладну не створюйте, а якщо посилка вже пішла, зупиніть її: ${CARD_URL}`)])

  for (const finalAmount of [0, null, 150050, 200000]) {
    const b = await mountShop(t, paidShop({ receiptId: 'r-1', receiptStatus: 'DONE' }))
    bankSays({ status: 'reversed', amount: 150050, finalAmount })
    await b.hook(ok())
    assert.equal(payDoc(b).partialRefund, undefined, String(finalAmount))
    assert.deepEqual(alertTexts(), [REVERSED_RECEIPT], String(finalAmount))
  }
})

// ---------- почта покупателя ----------

const withEmail = (order = {}) => shopSeed({}, { email: 'buyer@example.com', ...order })

test('магазин: почта покупателя не лежит в payments, в чек она идёт из заказа; заказ не прочитался: чек без почты', async (t) => {
  const a = await mountShop(t, { 'shopOrders/so-1': shopOrder({ paymentIds: [], email: 'buyer@example.com' }) })
  const r = await a.api.createPayment({ ...SHOP_ARGS, shopOrderId: 'so-1', deliveryEmail: 'buyer@example.com' })
  const { orderId } = r.data
  assert.equal('deliveryEmail' in payDoc(a, orderId), false)
  assert.ok(!JSON.stringify(invoices()[0].body).includes('buyer@example.com'))
  bankSays({ reference: orderId })
  await a.hook({ invoiceId: payDoc(a, orderId).providerOrderId, status: 'success' })
  assert.deepEqual(sells()[0].body.delivery, { email: 'buyer@example.com' })

  const noMail = await mountShop(t, shopSeed())
  await noMail.hook(ok())
  assert.equal(sells()[0].body.delivery, undefined)

  const down = await mountShop(t, withEmail())
  down.db.failRead = (path) => path === 'shopOrders/so-1'
  await down.hook(ok())
  assert.equal(payDoc(down).receiptStatus, 'DONE')
  assert.equal(sells().length, 1)
  assert.equal(sells()[0].body.delivery, undefined)
  assert.ok(!down.logged('error', 'buyer@example.com'))

  const repair = await mount(t, repairSeed())
  await repair.send('POST', '/api/estimates/pay', { estimateId: 'est-1', method: 'mono-acquire', deliveryEmail: 'client@example.com' })
  const id = Object.keys(repair.db.docs).find((k) => k.startsWith('payments/'))
  assert.equal(repair.db.get(id).deliveryEmail, 'client@example.com', 'у ремонта почта на месте')
})

test('магазин: касса отвергла чек с почтой (4xx): один повтор без почты с тем же id, метка на оплате; 5xx и ремонты не повторяют', async (t) => {
  const rejectMail = (p) => {
    if (p.delivery) throw httpErr(422, { message: 'bad email' })
    return { id: p.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' }
  }
  const a = await mountShop(t, withEmail())
  net.on.sell = rejectMail
  await a.hook(ok())
  assert.equal(sells().length, 2)
  assert.deepEqual(sells()[0].body.delivery, { email: 'buyer@example.com' })
  assert.equal(sells()[1].body.delivery, undefined)
  assert.equal(sells()[0].body.id, sells()[1].body.id)
  assert.equal(payDoc(a).receiptStatus, 'DONE')
  assert.equal(payDoc(a).receiptEmailDropped, true)
  assert.ok(a.logged('warn', 'без пошти'))
  assert.ok(!JSON.stringify(a.db.get('payments/pay-1')).includes('buyer@example.com'))

  const noMail = await mountShop(t, shopSeed())
  net.on.sell = () => { throw httpErr(422, {}) }
  await noMail.hook(ok())
  assert.equal(sells().length, 1, 'без почты повторять нечего')
  assert.equal(payDoc(noMail).receiptStatus, 'error')

  const down = await mountShop(t, withEmail())
  net.on.sell = () => { throw httpErr(500, {}) }
  await down.hook(ok())
  assert.equal(sells().length, 1, '5xx: исход неизвестен, повторяет сверка')
  assert.equal(payDoc(down).receiptStatus, 'error')

  const both = await mountShop(t, withEmail())
  net.on.sell = () => { throw httpErr(422, {}) }
  await both.hook(ok())
  assert.equal(sells().length, 2)
  assert.equal(payDoc(both).receiptStatus, 'error')
  assert.equal(payDoc(both).receiptEmailDropped, undefined)

  const repair = await mount(t, paySeed({ deliveryEmail: 'client@example.com' }))
  net.on.sell = rejectMail
  await repair.hook(ok())
  assert.equal(sells().length, 1, 'ремонт как раньше')
  assert.equal(repair.db.get('payments/pay-1').receiptStatus, 'error')
})

// ---------- «гроші є, чек ні» не зависит от того, сколько оплат впереди ----------

test('список «гроші є, чек ні»: оплаты с чеком впереди по id не вытесняют оплату без чека; поля для страницы оплат', async (t) => {
  const seed = shopAhead(250, { status: 'paid', receiptId: 'r' })
  seed['payments/z-repair'] = payment({ orderId: 'z-repair', status: 'paid' })
  seed['payments/z-shop'] = shopPayment({ orderId: 'z-shop', status: 'paid', receiptStatus: 'amount-mismatch' })
  const a = await mount(t, seed)
  const r = await a.send('GET', '/api/pay/unfiscalized', undefined, ADMIN)
  assert.deepEqual(r.json.data.map((o) => [o.orderId, o.status, o.provider, o.estimateId || null, o.shopOrderId || null]), [
    ['z-repair', 'paid', 'mono-acquire', 'est-1', null],
    ['z-shop', 'paid', 'mono-acquire', null, 'so-1'],
  ])
})

// ---------- просроченный токен кассира на открытии смены: настоящий checkbox.js ----------

const liveToken = () => net.calls.at(-1).headers.Authorization === 'Bearer tok-2'
const staleShiftFop = async (id) => {
  net.reset()
  net.on.signin = tokenSeq()
  const fop = { id, checkbox: cashbox('Z') }
  await realCheckbox.signin(fop)
  net.calls = []
  return fop
}
const SELL_ARGS = { goods: GOODS, paymentLabel: LABEL, receiptId: 'r-shift' }

test('касса: токен кассира истёк: чтение смены 401 лечится одним входом, чек выходит', async () => {
  const fop = await staleShiftFop('shift-get-401')
  net.on.shift = () => { if (!liveToken()) throw httpErr(401, {}); return { status: 'OPENED' } }
  net.on.openShift = () => { throw httpErr(401, {}) }
  const r = await realCheckbox.sellReceipt(fop, SELL_ARGS)
  assert.equal(r.status, 'DONE')
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/cashier/shift', 'Bearer tok-1'],
    ['POST', '/cashier/signinPinCode', undefined],
    ['GET', '/cashier/shift', 'Bearer tok-2'],
    ['POST', '/receipts/sell', 'Bearer tok-2'],
  ])
})

test('касса: смена закрыта, а её открытие отвечает 401: один вход и повтор', async () => {
  const fop = await staleShiftFop('shift-post-401')
  net.on.shift = () => (liveToken() ? { status: 'OPENED' } : { status: 'CLOSED' })
  net.on.openShift = () => { throw httpErr(401, {}) }
  await realCheckbox.sellReceipt(fop, SELL_ARGS)
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/cashier/shift', 'Bearer tok-1'],
    ['POST', '/shifts', 'Bearer tok-1'],
    ['POST', '/cashier/signinPinCode', undefined],
    ['GET', '/cashier/shift', 'Bearer tok-2'],
    ['POST', '/receipts/sell', 'Bearer tok-2'],
  ])
})

test('касса: 401 и после входа: без цикла, ошибка наружу; другие ошибки чтения смены входа не вызывают', async () => {
  const fop = await staleShiftFop('shift-401-twice')
  net.on.shift = () => { throw httpErr(401, {}) }
  await assert.rejects(realCheckbox.sellReceipt(fop, SELL_ARGS), (e) => e.response.status === 401)
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/cashier/shift', 'Bearer tok-1'],
    ['POST', '/cashier/signinPinCode', undefined],
    ['GET', '/cashier/shift', 'Bearer tok-2'],
  ])

  const other = await staleShiftFop('shift-500')
  net.on.shift = () => { throw httpErr(500, {}) }
  net.on.openShift = () => { throw httpErr(503, {}) }
  await assert.rejects(realCheckbox.sellReceipt(other, SELL_ARGS), (e) => e.response.status === 503)
  assert.deepEqual(net.calls.map(route), [
    ['GET', '/cashier/shift', 'Bearer tok-1'],
    ['POST', '/shifts', 'Bearer tok-1'],
  ])
})

test('сверка: чек ремонта с просроченным токеном кассира: один вход, тело чека прежнее', async (t) => {
  const a = await mount(t, paySeed({ fopId: 'fop-shift', status: 'paid', paytype: 'mono-acquire', receiptStatus: 'error' }))
  net.on.signin = tokenSeq()
  await realCheckbox.signin({ id: 'fop-shift', checkbox: cashbox('Z') })
  net.calls = []
  net.on.shift = () => { if (!liveToken()) throw httpErr(401, {}); return { status: 'OPENED' } }
  net.on.openShift = () => { throw httpErr(401, {}) }
  await reconcileNow(a)
  assert.equal(payDoc(a).receiptStatus, 'DONE')
  assert.equal(net.of('POST', `${CBX}/cashier/signinPinCode`).length, 1)
  assert.deepEqual(sells().map((c) => c.body), [sellBody('pay-1', LABEL, { cashier_name: 'Касир Z' })])
})

// ---------- шаги других модулей в сверке ----------

test('сверка: шаг другого модуля идёт в конце прохода, его обращения входят в ответ', async (t) => {
  const a = await mount(t, paySeed())
  bankSays({ status: 'success' })
  const order = []
  a.api.addReconcileStep(async () => {
    order.push(payDoc(a).status)
    return { checked: 2 }
  })
  a.api.addReconcileStep(async () => { order.push('другий') })
  const r = await reconcileNow(a)
  assert.deepEqual(order, ['paid', 'другий'], 'шаг видит уже сверенные оплаты')
  assert.equal(r.json.data.checked, 3)
})

test('сверка: падение шага не ломает сверку и следующий шаг', async (t) => {
  const a = await mount(t, paySeed())
  bankSays({ status: 'success' })
  let next = 0
  a.api.addReconcileStep(async () => { throw Object.assign(new Error('крок упав'), { response: { status: 503 } }) })
  a.api.addReconcileStep(() => { throw new Error('синхронно') })
  a.api.addReconcileStep(async () => { next += 1; return { checked: 1 } })
  const r = await reconcileNow(a)
  assert.equal(r.status, 200)
  assert.equal(r.json.data.checked, 2)
  assert.equal(next, 1)
  assert.equal(payDoc(a).status, 'paid')
  assert.ok(a.logged('error', 'reconcile step: 503'))
  assert.ok(a.logged('error', 'reconcile step: синхронно'))
})

test('сверка: ремонты без шагов отвечают как раньше', async (t) => {
  const a = await mount(t, paySeed())
  bankSays({ status: 'success' })
  const r = await reconcileNow(a)
  assert.deepEqual(r.json.data, { checked: 1 })
})
