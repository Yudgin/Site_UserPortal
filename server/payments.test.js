// node --test: оплаты ремонтов и заказов лодок картой monobank (server/payments.js). Настоящие monoAcquire.js и
// checkbox.js поверх подменённого axios: закрепляем то, что реально уходит банку и в кассу. Без сети и Firebase.
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
    const query = (match, max = Infinity) => ({
      limit: (n) => query(match, n),
      async get() {
        db.read(name)
        const docs = Object.entries(db.docs)
          .filter(([path, d]) => path.startsWith(`${name}/`) && match(d)).slice(0, max)
          .map(([path, d]) => ({ id: path.slice(name.length + 1), data: () => clone(d) }))
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
      sell: (payload) => ({ id: payload.id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' }),
      receipt: (id) => ({ id, status: 'DONE', fiscal_code: 'FC-1', tax_url: 'https://check.example/1' }),
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
    if (method === 'GET' && url === `${MONO}/pubkey`) return { data: await on.pubkey() }
    if (method === 'POST' && (url === `${CBX}/cashier/signinPinCode` || url === `${CBX}/cashier/signin`)) return { data: { access_token: `cashier-${cfg.headers['X-License-Key']}` } }
    if (method === 'GET' && url === `${CBX}/cashier/shift`) return { data: { status: 'OPENED' } }
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

test('повторный чек /refiscalize: права, состояния, ответ; подпись mono-acquire пока «частинами»', async (t) => {
  const a = await mount(t, {
    ...repairSeed(),
    'payments/m': payment({ orderId: 'm', status: 'paid', receiptStatus: 'error' }),
    'payments/l': payment({ orderId: 'l', provider: 'liqpay', status: 'paid', receiptStatus: 'error' }),
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
  // Эту подпись исправит шаг P2 (D7): там тест меняется вместе с поведением.
  assert.equal(sells()[0].body.payments[0].label, 'Оплата частинами (monobank)')

  await a.send('POST', '/api/pay/l/refiscalize', {}, ADMIN)
  assert.equal(sells()[1].body.payments[0].label, 'Оплата частинами (LiqPay)')
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
