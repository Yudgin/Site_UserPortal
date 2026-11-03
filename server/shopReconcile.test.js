// node --test: шаг магазина в сверке (server/shopReconcile.js), алерт владельцу и сообщение покупателю (shopPayments.js). Без сети и Firestore:
// настоящие payments.js и хуки поверх фейковой базы, банк, касса, Новая Почта, Telegram и SMS подменены.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'

process.env.PAYMENTS_RECONCILE = 'false'
process.env.SHOP_CALLBACK_BASE_URL = 'https://portal.test'
for (const k of ['PUBLIC_BASE_URL', 'FOPS_CONFIG', 'OWNER_TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN']) delete process.env[k]
const { registerPayments } = await import('./payments.js')
const { createShopPaymentHooks, KYIV_DAY } = await import('./shopPayments.js')
const { createShopReconcile } = await import('./shopReconcile.js')
const { registerNotifications } = await import('./notifications.js')
const { orderPublicView, withGuideStep } = await import('./shopCore.js')
const realCheckbox = await import('./checkbox.js')

const logs = []
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => logs.push(args.map(String).join(' '))

const PHONE = '+380671234567'
const OWNER_PHONE = '+380670000009'
const STATUS_TOKEN = 'Abcdefghijklmnopqrstuv'
const SITE = 'https://runferry.test'
const TAX_URL = 'https://check.test/tax-1'
const BANK_PAID = { status: 'success', amount: 80000, ccy: 980, finalAmount: 80000 }
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })
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
    const query = (match, max = Infinity) => ({
      limit: (n) => query(match, n),
      startAfter: () => query(() => false, max),
      async get() {
        db.read(`${name}?${match.label || ''}`)
        const docs = Object.entries(db.docs)
          .filter(([path, d]) => path.startsWith(`${name}/`) && match(d))
          .map(([path, d]) => ({ id: path.slice(name.length + 1), data: () => clone(d) }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, max)
        return { docs, empty: !docs.length, size: docs.length }
      },
    })
    return {
      doc(id) {
        const path = `${name}/${id}`
        return {
          id, path,
          async get() { db.read(path); const d = db.docs[path]; return { id, exists: d !== undefined, data: () => clone(d) } },
          async set(v, opts) { db.write(path, v, opts) },
        }
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`fake where: ${op}`)
        const match = (d) => d[field] === value
        match.label = `${field}=${value}`
        return query(match)
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

const seller = () => ({ displayName: 'Продавець', ipn: '1234567890', address: 'Адреса', email: 'shop@example.com', phone: '+380670000001' })
const fopMeta = (over = {}) => ({
  name: 'ФОП', active: true, methods: { monoAcquire: true }, seller: seller(),
  novaPoshta: { senderRef: 's', contactRef: 'c', senderPhone: '380670000001', cityRef: 'k', warehouseRef: 'w' }, ...over,
})
const fopSecret = (over = {}) => ({ monoAcquire: { token: 'SECRET-mono' }, checkbox: { licenseKey: 'SECRET-lic', pinCode: 'SECRET-pin' }, novaPoshta: { apiKey: 'NP-KEY-2' }, ...over })
const sales = (over = {}) => ({ mode: 'live', methods: { card: true, cod: false }, fopId: 'fop-2', siteBaseUrl: SITE, ownerPhone: OWNER_PHONE, skus: {}, ...over })

// Заказ по умолчанию открыт, старше 2 минут и без счетов.
const awaiting = (over = {}) => ({
  orderNo: 'RF-AAAAAA', statusToken: STATUS_TOKEN, state: 'awaiting_payment', method: 'card', sku: 'V2-LID-R', titleUk: 'Кришка', qty: 1, total: 800, fopId: 'fop-2',
  lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', clientName: 'Шевченко Тарас Григорович', clientPhone: PHONE, phoneKey: 'pk-1', email: 'taras@example.com', fingerprint: 'fp',
  clientCityRef: 'city-ref', clientCityName: 'Умань', clientWarehouseRef: 'wh-ref', clientWarehouseName: 'Відділення №77', offerVersion: '2026-11-03',
  payment: { paymentId: null, invoiceId: null, pageUrl: null, status: null, initiatedAt: null, lastBankCheckAt: null },
  paymentIds: [], payAttempts: 0, receipt: { status: 'none' }, sms: {}, alerts: {},
  history: [{ at: ago(2 * DAY), from: null, to: 'awaiting_payment', by: 'site' }], createdAt: ago(HOUR), updatedAt: ago(HOUR),
  ...over,
})
// Оплачен минуту назад, все объявления уже ушли, банк только что спрашивали: тест включает ровно то, что проверяет.
const paidOrder = (over = {}) => awaiting({
  state: 'paid', paidPaymentId: 'pay-1', paidAt: ago(MIN), paymentIds: ['pay-1'],
  payment: { paymentId: 'pay-1', invoiceId: 'inv-1', pageUrl: null, status: 'success', initiatedAt: null, lastBankCheckAt: ago(MIN) },
  sms: { paid: { status: 'sent', at: ago(MIN), tries: 1 } },
  alerts: { 'new-paid': { at: ago(MIN), sentAt: ago(MIN), text: 'x' } },
  history: [{ at: ago(MIN), from: 'awaiting_payment', to: 'paid', by: 'webhook' }],
  ...over,
})
const shippedOrder = (over = {}) => paidOrder({
  state: 'shipped', ttn: '20450000000001', shippedAt: ago(5 * HOUR), npCheckedAt: ago(MIN), npFopId: 'fop-2',
  history: [{ at: ago(5 * HOUR), from: 'paid', to: 'shipped', by: 'owner' }],
  ...over,
})
const invoice = (over = {}) => ({
  orderId: 'pay-1', fopId: 'fop-2', amount: 800, goods: [{ name: 'Кришка', price: 800, qty: 1, code: 'V2-LID-R' }], method: 'mono-acquire', provider: 'mono-acquire',
  providerOrderId: 'inv-1', status: 'pending', shopOrderId: 'so-1', paymentLabel: 'Інтернет еквайринг', createdAt: ago(HOUR), updatedAt: ago(HOUR),
  ...over,
})
const paidInvoice = (over = {}) => invoice({ status: 'paid', receiptId: 'rcpt-1', receiptStatus: 'DONE', taxUrl: TAX_URL, ...over })
const baseDocs = (extra = {}) => ({ 'system/shopSales': sales(), 'fops/fop-2': fopMeta(), 'fopSecrets/fop-2': fopSecret(), ...extra })
// Заказ со счётом pay-1: самый частый стенд.
const docsOf = (order, pay = invoice(), extra = {}) => baseDocs({ 'shopOrders/so-1': order, ...(pay ? { 'payments/pay-1': pay } : {}), ...extra })

// ---------- стенд ----------

const stand = async (docs, opts = {}) => {
  const { notify = async () => true, client = async () => ({ status: 'sent', id: 'ntf-1' }), sms = async () => ({ ok: true }), np = async () => ({ success: true, data: [] }), sell, getReceipt, slowScanMs = 0, purgeEveryMs = 0, bankCallsPerPass, passBudgetMs, notifications = false } = opts
  const db = new FakeDb(docs)
  const calls = { alerts: [], client: [], sms: [], np: [], sells: [], getReceipt: [] }
  const bank = { statuses: {}, fail: {}, onStatus: null, statusCalls: [], removed: [] }
  bank.mono = {
    createInvoice: async () => { throw new Error('сверка счета не создаёт') },
    invoiceStatus: async (_fop, id) => {
      bank.statusCalls.push(id)
      if (bank.onStatus) await bank.onStatus(id)
      if (bank.fail[id]) throw bank.fail[id]
      return { invoiceId: id, status: 'created', ...bank.statuses[id] }
    },
    removeInvoice: async (_fop, id) => { bank.removed.push(id); return {} },
    verifyWebhook: async () => true,
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
  }
  const api = registerPayments(express(), { adminDb: db, mono: bank.mono, cbx })
  const sendSms = async (phone, text) => { calls.sms.push({ phone, text }); return sms(phone, text) }
  const notifyClient = notifications
    ? registerNotifications(express(), { adminDb: db, senders: {}, sendSms, siteUrl: 'https://portal.test' }).notifyClient
    : async (args) => { calls.client.push(args); return client(args) }
  const payments = { ...api, notifyOwner: async (text) => { calls.alerts.push(text); return notify(text) } }
  const hooks = createShopPaymentHooks({ adminDb: db, payments, mono: bank.mono, siteUrl: 'https://portal.test', notifyClient, sendSms })
  api.setShopHooks(hooks)
  const { step } = createShopReconcile({
    adminDb: db, payments, hooks, mono: bank.mono, cbx, siteUrl: 'https://portal.test', slowScanMs, purgeEveryMs, bankCallsPerPass, passBudgetMs,
    npCall: async (apiKey, model, method, props) => { calls.np.push({ apiKey, model, method, numbers: props.Documents.map((d) => d.DocumentNumber) }); return np(apiKey, props) },
  })
  const s = {
    db, bank, calls, api, step, hooks,
    order: (id = 'so-1') => clone(db.docs[`shopOrders/${id}`]),
    pay: (id = 'pay-1') => clone(db.docs[`payments/${id}`]),
    patch: (path, v) => deepMerge(db.docs[path], v),
    patchOrder: (v, id = 'so-1') => deepMerge(db.docs[`shopOrders/${id}`], v),
  }
  return s
}
const npSays = (byNumber) => async () => ({ success: true, data: Object.entries(byNumber).map(([Number, d]) => ({ Number, ...d })) })
const alertKinds = (s, id) => Object.keys(s.order(id).alerts).filter((k) => k !== 'new-paid').sort()
const historyTo = (s, id) => s.order(id).history.map((h) => h.to)
const today = () => KYIV_DAY.format(new Date())

// ---------- п. 1: опрос всех счетов ----------

test('п. 1: заказ моложе 2 минут банк не спрашивает, старше спрашивает', async () => {
  const s = await stand(docsOf(awaiting({ createdAt: ago(MIN), paymentIds: ['pay-1'] })))
  await s.step()
  assert.deepEqual(s.bank.statusCalls, [])
  s.patchOrder({ createdAt: ago(2 * MIN + SEC) })
  assert.deepEqual(await s.step(), { checked: 1 })
  assert.deepEqual(s.bank.statusCalls, ['inv-1'])
})

test('п. 1: опрашиваются все счета, и failure, и снятый; поздний успех по старому счёту закрывает оплату, чек и снимает живой', async () => {
  for (const oldStatus of ['failure', 'removed', 'expired']) {
    const s = await stand(baseDocs({
      'shopOrders/so-1': awaiting({ paymentIds: ['pay-1', 'pay-2'], payment: { paymentId: 'pay-2', status: 'created' } }),
      'payments/pay-1': invoice({ status: oldStatus }),
      'payments/pay-2': invoice({ orderId: 'pay-2', providerOrderId: 'inv-2' }),
    }))
    s.bank.statuses['inv-1'] = BANK_PAID
    assert.deepEqual(await s.step(), { checked: 2 }, oldStatus)
    assert.deepEqual(s.bank.statusCalls, ['inv-1', 'inv-2'])
    const o = s.order()
    assert.equal(o.state, 'paid')
    assert.equal(o.paidPaymentId, 'pay-1')
    assert.equal(o.paidSource, 'reconcile')
    assert.equal(s.pay('pay-1').status, 'paid')
    assert.equal(s.calls.sells.length, 1)
    assert.deepEqual(s.bank.removed, ['inv-2'])
  }
})

test('п. 1: возвращённый счёт не опрашивается, счёт без номера в банке и пропавший документ не ломают проход', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': awaiting({ paymentIds: ['pay-1', 'pay-2', 'pay-3'] }),
    'payments/pay-1': invoice({ status: 'reversed' }),
    'payments/pay-2': invoice({ orderId: 'pay-2', providerOrderId: null, status: 'failure' }),
  }))
  assert.deepEqual(await s.step(), { checked: 0 })
  assert.deepEqual(s.bank.statusCalls, [])
  assert.ok(s.order().invoicesFinalAt)
})

test('п. 1: прежний конечный ответ оплату не переписывает, новый ответ по текущему счёту видит страница статуса', async () => {
  const s = await stand(docsOf(awaiting({ paymentIds: ['pay-1'], payment: { paymentId: 'pay-1', status: 'created' } }), invoice({ status: 'failure' })))
  s.bank.statuses['inv-1'] = { status: 'failure' }
  const before = s.pay().updatedAt
  await s.step()
  assert.equal(s.pay().updatedAt, before)
  assert.equal(s.order().payment.status, 'failure')

  s.patchOrder({ invoicesCheckedAt: ago(16 * MIN), payment: { paymentId: 'other', status: 'created' } })
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  assert.equal(s.pay().status, 'expired', 'другой ответ записан')
  assert.equal(s.order().payment.status, 'created', 'это уже не текущий счёт')
})

test('п. 1: живой счёт на каждом проходе сверки, закрытые раз в 15 минут', async () => {
  const s = await stand(docsOf(awaiting({ paymentIds: ['pay-1'] })))
  await s.step()
  await s.step()
  assert.equal(s.bank.statusCalls.length, 1, 'сразу второй раз не спрашиваем')
  s.patchOrder({ invoicesCheckedAt: ago(2 * MIN + SEC) })
  await s.step()
  assert.equal(s.bank.statusCalls.length, 2)

  s.patch('payments/pay-1', { status: 'failure' })
  s.bank.statuses['inv-1'] = { status: 'failure' }
  s.patchOrder({ invoicesCheckedAt: ago(14 * MIN) })
  await s.step()
  assert.equal(s.bank.statusCalls.length, 2)
  s.patchOrder({ invoicesCheckedAt: ago(15 * MIN + SEC) })
  await s.step()
  assert.equal(s.bank.statusCalls.length, 3)
})

test('п. 1: не больше заданного числа обращений к банку за проход, остальные на следующем', async () => {
  const extra = {}
  for (const n of [1, 2, 3]) {
    extra[`shopOrders/so-${n}`] = awaiting({ paymentIds: [`pay-${n}`] })
    extra[`payments/pay-${n}`] = invoice({ orderId: `pay-${n}`, providerOrderId: `inv-${n}`, shopOrderId: `so-${n}` })
  }
  const s = await stand(baseDocs(extra), { bankCallsPerPass: 2 })
  assert.deepEqual(await s.step(), { checked: 2 })
  assert.deepEqual(s.bank.statusCalls, ['inv-1', 'inv-2'])
  assert.equal(s.order('so-3').invoicesCheckedAt, undefined)
  await s.step()
  assert.ok(s.bank.statusCalls.includes('inv-3'))
})

test('п. 1: кончилось время прохода: банк больше не спрашиваем', async () => {
  const s = await stand(docsOf(awaiting({ paymentIds: ['pay-1'] })), { passBudgetMs: -1 })
  assert.deepEqual(await s.step(), { checked: 0 })
  assert.deepEqual(s.bank.statusCalls, [])
})

// ---------- п. 1: закрытие через 24 часа ----------

const closedDocs = (over = {}, pay = invoice({ status: 'expired' }), extra = {}) => docsOf(
  awaiting({ paymentIds: ['pay-1'], payment: { paymentId: 'pay-1', status: 'expired', pageUrl: 'https://pay.test/old' }, ...over }),
  pay,
  { 'shopPhones/pk-1': { openCard: { 'V2-LID-R': 'so-1' } }, ...extra },
)

test('п. 1: срок считается с первого прохода, когда все счета закрыты; через 24 часа последний опрос и expired', async () => {
  const s = await stand(closedDocs())
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  const marked = s.order().invoicesFinalAt
  assert.ok(marked)
  assert.equal(s.order().state, 'awaiting_payment')

  // Опрос не сдвигает отсчёт.
  s.patchOrder({ invoicesCheckedAt: ago(16 * MIN) })
  await s.step()
  assert.equal(s.order().invoicesFinalAt, marked)

  s.patchOrder({ invoicesFinalAt: ago(DAY - MIN), invoicesCheckedAt: ago(16 * MIN) })
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')

  // Опрос только что был, но перед закрытием банк всё равно спрашиваем.
  s.patchOrder({ invoicesFinalAt: ago(DAY + MIN), invoicesCheckedAt: ago(SEC) })
  const calls = s.bank.statusCalls.length
  await s.step()
  assert.equal(s.bank.statusCalls.length, calls + 1)
  const o = s.order()
  assert.equal(o.state, 'expired')
  assert.equal(o.orderNo, 'RF-AAAAAA')
  assert.equal(o.payment.paymentId, 'pay-1')
  assert.equal(o.payment.pageUrl, null)
  assert.deepEqual(o.history.at(-1).by, 'reconcile')
  assert.equal(o.history.at(-1).from, 'awaiting_payment')
  assert.equal(s.db.docs['shopPhones/pk-1'].openCard['V2-LID-R'], null)
})

test('п. 1: последний опрос нашёл деньги: заказ оплачен, а не закрыт', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }))
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.step()
  assert.equal(s.order().state, 'paid')
  assert.ok(!historyTo(s).includes('expired'))
})

test('п. 1: последний опрос не удался: заказ не закрываем; банк не знает закрытый счёт: закрываем', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }))
  s.bank.fail['inv-1'] = httpErr(500)
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')
  assert.ok(s.order().invoicesFinalAt, 'отсчёт не сбрасываем')
  assert.ok(logs.some((l) => l.includes('рахунок pay-1')))

  s.bank.fail['inv-1'] = httpErr(403)
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment', '403 это проблема ключа, а не забытый счёт')

  for (const status of [404, 400]) {
    const b = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice({ status: 'removed' })))
    b.bank.fail['inv-1'] = httpErr(status)
    await b.step()
    assert.equal(b.order().state, 'expired', String(status))
  }
})

test('п. 1: 404 по живому счёту не считается закрытием', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice()))
  s.bank.fail['inv-1'] = httpErr(404)
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')
})

test('п. 1: ФОП не загружается: заказ не закрываем', async () => {
  const docs = closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice({ fopId: 'fop-x', status: 'expired' }))
  const s = await stand(docs)
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')
  assert.deepEqual(s.bank.statusCalls, [])
})

test('п. 1: идёт создание счёта: не закрываем и не считаем заказ брошенным', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY), payment: { paymentId: 'pay-1', initiatedAt: ago(MIN) } }))
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')
  assert.equal(s.order().invoicesFinalAt, null)
})

test('п. 1: появился живой счёт: отсчёт снимается', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice()))
  await s.step()
  assert.equal(s.order().state, 'awaiting_payment')
  assert.equal(s.order().invoicesFinalAt, null)
})

test('п. 1: заказ изменился, пока шёл последний опрос: не закрываем', async () => {
  const a = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }))
  a.bank.statuses['inv-1'] = { status: 'expired' }
  a.bank.onStatus = () => a.patchOrder({ state: 'cancelled', cancelReason: 'buyer' })
  await a.step()
  assert.equal(a.order().state, 'cancelled')
  assert.ok(!historyTo(a).includes('expired'))

  const b = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }))
  b.bank.statuses['inv-1'] = { status: 'expired' }
  b.bank.onStatus = () => b.patchOrder({ paymentIds: ['pay-1', 'pay-2'] })
  await b.step()
  assert.equal(b.order().state, 'awaiting_payment', 'появился новый счёт')

  const c = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }))
  c.bank.statuses['inv-1'] = { status: 'expired' }
  c.bank.onStatus = () => c.patchOrder({ payment: { initiatedAt: new Date().toISOString() } })
  await c.step()
  assert.equal(c.order().state, 'awaiting_payment', 'началось создание счёта')
})

test('п. 1: закрытие не трогает занятую пару другого заказа и суточный счётчик; покупатель без телефона не мешает', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice({ status: 'expired' }), {
    'shopPhones/pk-1': { openCard: { 'V2-LID-R': 'so-new', 'V2-LID-H': 'so-other' } },
    [`shopDaily/${today()}`]: { unpaid: 3 },
  }))
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  assert.equal(s.order().state, 'expired')
  assert.deepEqual(s.db.docs['shopPhones/pk-1'].openCard, { 'V2-LID-R': 'so-new', 'V2-LID-H': 'so-other' })
  assert.equal(s.db.docs[`shopDaily/${today()}`].unpaid, 3)

  const noPhone = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY), phoneKey: null }))
  noPhone.bank.statuses['inv-1'] = { status: 'expired' }
  await noPhone.step()
  assert.equal(noPhone.order().state, 'expired')
})

test('п. 1: закрытие освобождает только свою пару: другой артикул того же телефона на месте', async () => {
  const s = await stand(closedDocs({ invoicesFinalAt: ago(2 * DAY) }, invoice({ status: 'expired' }), { 'shopPhones/pk-1': { openCard: { 'V2-LID-R': 'so-1', 'V2-LID-H': 'so-other' }, sms: 2 } }))
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  assert.deepEqual(s.db.docs['shopPhones/pk-1'], { openCard: { 'V2-LID-R': null, 'V2-LID-H': 'so-other' }, sms: 2 })
})

test('п. 1: на последний опрос не хватило обращений к банку: не закрываем', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': awaiting({ paymentIds: ['pay-1', 'pay-2'], invoicesFinalAt: ago(2 * DAY) }),
    'payments/pay-1': invoice({ status: 'expired' }),
    'payments/pay-2': invoice({ orderId: 'pay-2', providerOrderId: 'inv-2', status: 'expired' }),
  }), { bankCallsPerPass: 1 })
  s.bank.statuses['inv-1'] = { status: 'expired' }
  await s.step()
  assert.deepEqual(s.bank.statusCalls, ['inv-1'])
  assert.equal(s.order().state, 'awaiting_payment')
})

test('п. 1: заказ закрылся между чтением и захватом опроса: банк не спрашиваем', async () => {
  const s = await stand(docsOf(awaiting({ paymentIds: ['pay-1'] })))
  const realRun = s.db.runTransaction.bind(s.db)
  s.db.runTransaction = (fn) => {
    s.patchOrder({ state: 'cancelled' })
    return realRun(fn)
  }
  await s.step()
  assert.deepEqual(s.bank.statusCalls, [])
  assert.equal(s.order().invoicesCheckedAt, undefined)
})

test('п. 1: заказ без единого счёта (банк лежал при создании) тоже закрывается через 24 часа', async () => {
  const s = await stand(docsOf(awaiting(), null))
  assert.deepEqual(await s.step(), { checked: 0 })
  assert.ok(s.order().invoicesFinalAt)
  assert.equal(s.order().state, 'awaiting_payment')
  s.patchOrder({ invoicesFinalAt: ago(DAY + MIN) })
  await s.step()
  assert.equal(s.order().state, 'expired')
})

// ---------- п. 2: чек нет дольше 10 минут и чек с ошибкой ----------

test('п. 2: каса ответила ERROR, CANCELLED или ФОП без каси: алерт один раз, красная плашка, страница показывает ошибку', async () => {
  for (const status of ['ERROR', 'CANCELLED', 'no-checkbox']) {
    const s = await stand(docsOf(paidOrder(), paidInvoice({ receiptStatus: status, taxUrl: null, receiptId: status === 'no-checkbox' ? undefined : 'rcpt-1' })))
    await s.step()
    await s.step()
    const o = s.order()
    assert.equal(o.receipt.status, 'failed', status)
    assert.ok(o.receipt.checkedAt)
    assert.deepEqual(alertKinds(s), ['receipt-failed'])
    assert.equal(s.calls.alerts.length, 1)
    assert.match(s.calls.alerts[0], new RegExp(`RF-AAAAAA: 800 грн оплачено, чек не вийшов \\(${status}\\)`))
    assert.match(s.calls.alerts[0], /Checkbox/)
    assert.match(s.calls.alerts[0], /https:\/\/portal\.test\/shop-orders\/so-1/)
    assert.equal(orderPublicView(o, { paidPayment: s.pay() }).receipt.status, 'failed')
  }
})

test('п. 2: чек со статусом CREATED и receiptId дольше 10 минут: алерт, receiptId здесь не признак готовности', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(10 * MIN + SEC) }), paidInvoice({ receiptStatus: 'CREATED', taxUrl: null })))
  await s.step()
  await s.step()
  assert.deepEqual(alertKinds(s), ['receipt-late'])
  assert.equal(s.calls.alerts.length, 1)
  assert.match(s.calls.alerts[0], /чека немає понад 10 хвилин/)
  assert.equal(s.order().receipt.status, 'none')
})

test('п. 2: срок ещё не вышел: алерта нет; при любом состоянии после оплаты: есть', async () => {
  const young = await stand(docsOf(paidOrder({ paidAt: ago(9 * MIN) }), paidInvoice({ receiptStatus: 'CREATED', taxUrl: null })))
  await young.step()
  assert.deepEqual(alertKinds(young), [])

  for (const state of ['shipped', 'delivered', 'refused', 'returned', 'payment_review']) {
    const s = await stand(docsOf(shippedOrder({ state, paidAt: ago(HOUR), npCheckedAt: ago(MIN) }), paidInvoice({ receiptStatus: 'CREATED', taxUrl: null })))
    await s.step()
    assert.ok(alertKinds(s).includes('receipt-late'), state)
  }
})

test('п. 2: деньги вернули или сумма не сошлась: о чеке не напоминаем', async () => {
  for (const pay of [paidInvoice({ status: 'reversed', taxUrl: null, receiptId: null, receiptStatus: null }), paidInvoice({ receiptStatus: 'amount-mismatch', taxUrl: null, receiptId: null })]) {
    const s = await stand(docsOf(paidOrder({ state: 'payment_review', paidAt: ago(HOUR) }), pay))
    await s.step()
    assert.deepEqual(alertKinds(s), [], JSON.stringify(pay.status))
    assert.equal(s.order().receipt.status, 'none')
  }
})

// ---------- п. 3: чек без попытки ----------

test('п. 3: оплата есть, чека и захвата нет: сначала банк, потом чек с подписью документа', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(3 * MIN) }), invoice({ status: 'paid', paytype: 'mono-acquire' })))
  s.bank.statuses['inv-1'] = BANK_PAID
  assert.deepEqual(await s.step(), { checked: 1 })
  assert.deepEqual(s.bank.statusCalls, ['inv-1'])
  assert.equal(s.calls.sells.length, 1)
  assert.equal(s.calls.sells[0].paymentLabel, 'Інтернет еквайринг')
  assert.equal(s.pay().receiptStatus, 'DONE')
  assert.equal(s.pay().taxUrl, TAX_URL)
  assert.equal(s.order().receipt.status, 'ready')
})

test('п. 3: банк сказал «возврат»: чек не выходит, заказ reversed; банк молчит: чек не выходит', async () => {
  const a = await stand(docsOf(paidOrder({ paidAt: ago(3 * MIN) }), invoice({ status: 'paid' })))
  a.bank.statuses['inv-1'] = { status: 'reversed', amount: 80000, ccy: 980 }
  await a.step()
  assert.equal(a.calls.sells.length, 0)
  assert.equal(a.pay().status, 'reversed')
  assert.equal(a.order().state, 'reversed')

  const b = await stand(docsOf(paidOrder({ paidAt: ago(3 * MIN) }), invoice({ status: 'paid' })))
  b.bank.fail['inv-1'] = httpErr(500)
  await b.step()
  assert.equal(b.calls.sells.length, 0)
  assert.equal(b.pay().receiptStatus, undefined)
  assert.ok(logs.some((l) => l.includes('чек RF-AAAAAA')))
})

test('п. 3: чек и опрос счёта на одном проходе банк дважды не спрашивают', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(2 * HOUR), payment: { lastBankCheckAt: ago(2 * HOUR) } }), invoice({ status: 'paid' })))
  s.bank.statuses['inv-1'] = BANK_PAID
  assert.deepEqual(await s.step(), { checked: 1 })
  assert.deepEqual(s.bank.statusCalls, ['inv-1'])
})

test('п. 3: свежий захват и свежая оплата опросу счёта не мешают, когда он подошёл', async () => {
  const claimed = await stand(docsOf(paidOrder({ paidAt: ago(2 * HOUR), payment: { lastBankCheckAt: ago(2 * HOUR) } }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(MIN) })))
  claimed.bank.statuses['inv-1'] = BANK_PAID
  await claimed.step()
  assert.deepEqual(claimed.bank.statusCalls, ['inv-1'])
  assert.deepEqual(claimed.calls.getReceipt, [])

  const young = await stand(docsOf(paidOrder({ paidAt: ago(MIN), payment: { lastBankCheckAt: ago(2 * HOUR) } }), invoice({ status: 'paid' })))
  young.bank.statuses['inv-1'] = BANK_PAID
  await young.step()
  assert.deepEqual(young.bank.statusCalls, ['inv-1'])
})

test('п. 3: только что оплачено: сверка не лезет вперёд колбэка', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(MIN) }), invoice({ status: 'paid' })))
  await s.step()
  assert.deepEqual(s.bank.statusCalls, [])
  assert.equal(s.calls.sells.length, 0)
})

test('п. 3: amount-mismatch, error и no-checkbox прямой чек не получают; метка суммы остаётся и после опроса', async () => {
  for (const receiptStatus of ['amount-mismatch', 'error', 'no-checkbox']) {
    const s = await stand(docsOf(paidOrder({ paidAt: ago(3 * MIN), state: receiptStatus === 'amount-mismatch' ? 'payment_review' : 'paid' }), invoice({ status: 'paid', receiptStatus, receiptError: 'x' })))
    await s.step()
    assert.deepEqual(s.bank.statusCalls, [], receiptStatus)
    assert.equal(s.calls.sells.length, 0)
    assert.equal(s.pay().receiptStatus, receiptStatus)
  }
  const s = await stand(docsOf(paidOrder({ state: 'payment_review', paidAt: ago(3 * MIN), payment: { lastBankCheckAt: ago(2 * HOUR) } }), invoice({ status: 'paid', receiptStatus: 'amount-mismatch', receiptError: 'x' })))
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.step()
  assert.deepEqual(s.bank.statusCalls, ['inv-1'])
  assert.equal(s.calls.sells.length, 0)
  assert.equal(s.pay().receiptStatus, 'amount-mismatch')
})

test('п. 3: захват старше 10 минут, чек нашёлся: записываем, новый не выбиваем', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(2 * HOUR), payment: { lastBankCheckAt: ago(2 * HOUR) } }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(10 * MIN + SEC) })), {
    getReceipt: async (_f, id) => ({ receiptId: id, fiscalCode: 'FC-9', taxUrl: TAX_URL, status: 'DONE' }),
  })
  await s.step()
  assert.deepEqual(s.calls.getReceipt, [s.api.receiptUuidFor('pay-1')])
  assert.equal(s.calls.sells.length, 0)
  assert.deepEqual(s.bank.statusCalls, [], 'занялись чеком, отдельный опрос не нужен')
  const p = s.pay()
  assert.equal(p.receiptId, s.api.receiptUuidFor('pay-1'))
  assert.equal(p.fiscalCode, 'FC-9')
  assert.equal(p.taxUrl, TAX_URL)
  assert.equal(p.receiptStatus, 'DONE')
  assert.ok(p.receiptAt)
  assert.equal(s.order().receipt.status, 'ready', 'и тут же виден покупателю')
  assert.ok(s.calls.client.some((c) => c.clientKey === 'so-1-rcpt'))
})

test('п. 3: чек нашёлся без статуса: метка done, как у обычного чека', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(HOUR) })), {
    getReceipt: async (_f, id) => ({ receiptId: id, fiscalCode: null, taxUrl: null, status: null }),
  })
  await s.step()
  assert.equal(s.pay().receiptStatus, 'done')
})

test('п. 3: захват старше 10 минут, чека нет (404): снимаем захват и выбиваем через банк', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(HOUR) })), { getReceipt: async () => { throw httpErr(404) } })
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.step()
  assert.deepEqual(s.bank.statusCalls, ['inv-1'], 'опрос счёта на этом проходе не дублируется')
  assert.equal(s.calls.sells.length, 1)
  assert.equal(s.pay().receiptStatus, 'DONE')
  assert.equal(s.pay().shopOrderId, 'so-1', 'документ оплаты цел')
})

test('п. 3: захват сменился, пока шла проверка: чужой захват не снимаем и чек не выбиваем', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(HOUR) })), {
    getReceipt: async () => { s.patch('payments/pay-1', { fiscalizeClaimedAt: new Date().toISOString() }); throw httpErr(404) },
  })
  const claim = () => s.pay().fiscalizeClaimedAt
  await s.step()
  assert.ok(claim())
  assert.equal(s.calls.sells.length, 0)
  assert.deepEqual(s.bank.statusCalls, [])
})

test('п. 3: за время проверки чек появился: захват не снимаем', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(HOUR) })), {
    getReceipt: async () => { s.patch('payments/pay-1', { receiptId: 'rcpt-other' }); throw httpErr(404) },
  })
  await s.step()
  assert.ok(s.pay().fiscalizeClaimedAt)
  assert.equal(s.calls.sells.length, 0)
  assert.deepEqual(s.bank.statusCalls, [])
})

test('п. 3: касса ответила иначе: один алерт, чек не выбиваем, захват остаётся', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(HOUR) })), { getReceipt: async () => { throw httpErr(500) } })
  await s.step()
  await s.step()
  assert.ok(alertKinds(s).includes('receipt-claim'))
  assert.equal(s.calls.alerts.filter((x) => x.includes('чек завис')).length, 1)
  assert.equal(s.calls.sells.length, 0)
  assert.ok(s.pay().fiscalizeClaimedAt)
})

test('п. 3: захват свежий: кассу не трогаем, ФОП не загружен: ждём', async () => {
  const fresh = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ status: 'paid', fiscalizeClaimedAt: ago(9 * MIN) })))
  await fresh.step()
  assert.deepEqual(fresh.calls.getReceipt, [])
  assert.deepEqual(fresh.bank.statusCalls, [])

  const noFop = await stand(docsOf(paidOrder({ paidAt: ago(HOUR) }), invoice({ fopId: 'fop-x', status: 'paid', fiscalizeClaimedAt: ago(HOUR) })))
  await noFop.step()
  assert.deepEqual(noFop.calls.getReceipt, [])
  assert.ok(logs.some((l) => l.includes('ФОП fop-x не завантажено, чек pay-1')))
})

test('п. 3: нет бюджета на банк: чек ждёт следующего прохода', async () => {
  const s = await stand(docsOf(paidOrder({ paidAt: ago(3 * MIN) }), invoice({ status: 'paid' })), { bankCallsPerPass: 0 })
  await s.step()
  assert.deepEqual(s.bank.statusCalls, [])
  assert.equal(s.calls.sells.length, 0)
})

// ---------- п. 4: сообщение с чеком ----------

test('п. 4: появился taxUrl: чек виден на заказе, покупателю одно сообщение; ссылка не попадает в журнал', async () => {
  const s = await stand(docsOf(paidOrder(), paidInvoice()))
  await s.step()
  await s.step()
  assert.deepEqual(s.calls.client.map((c) => c.clientKey), ['so-1-rcpt'])
  const m = s.calls.client[0]
  assert.equal(m.event, 'shop')
  assert.equal(m.phone, PHONE)
  assert.equal(m.text, `RunFerry: ваш чек: ${TAX_URL}`)
  assert.equal(m.journal.text, 'RunFerry: ваш чек: …')
  assert.equal(m.serviceRequestId, undefined)
  assert.equal(m.sessionId, undefined)
  const o = s.order()
  assert.equal(o.receipt.status, 'ready')
  assert.equal(o.receipt.taxUrl, TAX_URL)
  assert.ok(o.receipt.checkedAt)
  assert.equal(o.sms.rcpt.status, 'sent')
  assert.equal(o.sms.rcpt.tries, 1)
  assert.deepEqual(alertKinds(s), [])
})

test('п. 4: сообщение не дошло: первая попытка и 3 повтора не чаще раза в 10 минут, затем один алерт', async () => {
  for (const client of [async () => ({ status: 'failed', error: 'x' }), async () => { throw new Error('sms down') }, async () => undefined]) {
    const s = await stand(docsOf(paidOrder(), paidInvoice()), { client })
    await s.step()
    assert.equal(s.calls.client.length, 1)
    assert.equal(s.order().sms.rcpt.status, 'failed')
    assert.equal(s.order().sms.rcpt.tries, 1)
    await s.step()
    assert.equal(s.calls.client.length, 1, 'рано повторять')
    for (const n of [2, 3, 4]) {
      s.patchOrder({ sms: { rcpt: { at: ago(10 * MIN + SEC) } } })
      await s.step()
      assert.equal(s.calls.client.length, n)
      assert.equal(s.order().sms.rcpt.tries, n)
    }
    assert.deepEqual(alertKinds(s), ['sms-rcpt'])
    assert.equal(s.calls.alerts.length, 1)
    assert.match(s.calls.alerts[0], /покупець не отримав повідомлення із чеком/)
    assert.match(s.calls.alerts[0], /https:\/\/portal\.test\/shop-orders\/so-1/)
    s.patchOrder({ sms: { rcpt: { at: ago(HOUR) } } })
    await s.step()
    assert.equal(s.calls.client.length, 4, 'попытки кончились')
    assert.equal(s.calls.alerts.length, 1)
  }
})

test('п. 4: процесс упал на последней попытке: алерт всё равно будет; без телефона (стёрт) сообщение не шлём', async () => {
  const s = await stand(docsOf(paidOrder({ sms: { paid: { status: 'sent' }, rcpt: { status: 'pending', tries: 4, at: ago(HOUR) } } }), paidInvoice()))
  await s.step()
  assert.equal(s.calls.client.length, 0)
  assert.deepEqual(alertKinds(s), ['sms-rcpt'])

  const purged = await stand(docsOf(paidOrder({ clientPhone: null }), paidInvoice()))
  await purged.step()
  assert.equal(purged.calls.client.length, 0)
  assert.equal(purged.order().sms.rcpt, undefined)
})

test('п. 4: другой экземпляр сейчас шлёт (pending): это не неудача, алерта нет', async () => {
  const s = await stand(docsOf(paidOrder(), paidInvoice()), { client: async () => ({ status: 'pending', skipped: true }) })
  await s.step()
  assert.equal(s.order().sms.rcpt.status, 'pending')
  assert.deepEqual(alertKinds(s), [])
})

test('п. 4: чек со ссылкой уже записан: заказ не переписываем; ссылка другая или была ошибка: обновляем', async () => {
  const ready = { sms: { paid: { status: 'sent' }, rcpt: { status: 'sent', at: ago(HOUR) } }, payment: { lastBankCheckAt: ago(2 * HOUR) } }
  const same = await stand(docsOf(paidOrder({ ...ready, receipt: { status: 'ready', taxUrl: TAX_URL, checkedAt: 'раньше' } }), paidInvoice()))
  same.bank.statuses['inv-1'] = BANK_PAID
  await same.step()
  assert.deepEqual(same.bank.statusCalls, ['inv-1'], 'до записи дошло')
  assert.equal(same.order().receipt.checkedAt, 'раньше')
  assert.equal(same.calls.client.length, 0)

  const other = await stand(docsOf(paidOrder({ ...ready, receipt: { status: 'ready', taxUrl: 'https://check.test/old', checkedAt: 'раньше' } }), paidInvoice()))
  other.bank.statuses['inv-1'] = BANK_PAID
  await other.step()
  assert.equal(other.order().receipt.taxUrl, TAX_URL)

  const failed = await stand(docsOf(paidOrder({ ...ready, receipt: { status: 'failed', checkedAt: 'раньше' } }), paidInvoice()))
  failed.bank.statuses['inv-1'] = BANK_PAID
  await failed.step()
  assert.equal(failed.order().receipt.status, 'ready')
})

test('сообщение покупателю: доставленное не шлётся повторно, сколько бы времени ни прошло', async () => {
  const s = await stand(docsOf(paidOrder({ sms: { paid: { status: 'sent', at: ago(DAY), tries: 1 } } }), paidInvoice()))
  await s.hooks.sendPaidMessage(s.db.collection('shopOrders').doc('so-1'))
  assert.equal(s.calls.client.length, 0)
})

// ---------- сообщение об оплате и новый заказ владельцу ----------

const SETTLE_DOCS = (over = {}) => docsOf(awaiting({ paymentIds: ['pay-1'], createdAt: ago(MIN), ...over }))

test('оплата: владельцу алерт, покупателю ссылка на статус; повтор колбэка второго не шлёт', async () => {
  const s = await stand(SETTLE_DOCS())
  await s.api.settleMonoAcquire(s.pay(), BANK_PAID, 'webhook')
  await until(() => s.order().sms?.paid?.status === 'sent' && s.order().alerts['new-paid']?.sentAt, 'объявление об оплате')
  assert.deepEqual(s.calls.alerts, [withGuideStep('new-paid', `✅ Замовлення RF-AAAAAA: оплачено 800 грн, V2-LID-R. Створіть накладну: https://portal.test/shop-orders/so-1`)])
  assert.deepEqual(s.calls.client.map((c) => c.clientKey), ['so-1-paid'])
  const link = `${SITE}/uk/order/${STATUS_TOKEN}`
  assert.equal(s.calls.client[0].text, `RunFerry: оплату 800 грн отримано. Замовлення і умови: ${link}`)
  assert.equal(s.calls.client[0].journal.text, 'RunFerry: оплату 800 грн отримано. Замовлення і умови: …')
  assert.equal(s.calls.client[0].phone, PHONE)

  await s.api.settleMonoAcquire(s.pay(), BANK_PAID, 'webhook')
  await sleep(20)
  assert.equal(s.calls.alerts.length, 1)
  assert.equal(s.calls.client.length, 1)
})

test('оплата: чек не ждёт зависшие Telegram и SMS', async () => {
  const telegram = held()
  const sms = held()
  const s = await stand(SETTLE_DOCS(), { notify: () => telegram.gate.then(() => true), client: () => sms.gate.then(() => ({ status: 'sent' })) })
  await s.api.settleMonoAcquire(s.pay(), BANK_PAID, 'webhook')
  assert.equal(s.calls.sells.length, 1)
  assert.equal(s.pay().receiptStatus, 'DONE')
  telegram.release()
  sms.release()
  await until(() => s.order().sms?.paid?.status === 'sent', 'сообщение ушло после чека')
})

test('оплата по закрытому заказу или с расхождением суммы: «оплачено» не шлём, решает владелец', async () => {
  const late = await stand(docsOf(awaiting({ state: 'cancelled', paymentIds: ['pay-1'] })))
  await late.api.settleMonoAcquire(late.pay(), BANK_PAID, 'webhook')
  await sleep(20)
  assert.equal(late.order().state, 'payment_review')
  assert.ok(!late.order().alerts['new-paid'])
  assert.equal(late.calls.client.filter((c) => c.clientKey === 'so-1-paid').length, 0)

  const wrong = await stand(SETTLE_DOCS())
  await wrong.api.settleMonoAcquire(wrong.pay(), { ...BANK_PAID, amount: 100 }, 'webhook')
  await sleep(20)
  assert.equal(wrong.order().state, 'payment_review')
  assert.ok(!wrong.order().alerts['new-paid'])
  assert.equal(wrong.calls.client.length, 0)
})

test('оплата: процесс упал до объявления: сверка догоняет и алерт, и сообщение', async () => {
  const s = await stand(docsOf(paidOrder({ sms: {}, alerts: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })))
  await s.step()
  assert.ok(s.order().alerts['new-paid'].sentAt)
  assert.equal(s.order().sms.paid.status, 'sent')
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  assert.equal(s.calls.client.length, 1)
})

test('оплата: посылку уже отправили, а сообщение не дошло: шлём; нового заказа владельцу уже не показываем', async () => {
  const s = await stand(docsOf(shippedOrder({ sms: { paid: { status: 'failed', tries: 1, at: ago(HOUR) } }, alerts: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })))
  await s.step()
  assert.equal(s.order().sms.paid.status, 'sent')
  assert.ok(!s.order().alerts['new-paid'])
})

test('оплата: наложка «оплачено» не получает ни в каком состоянии', async () => {
  for (const state of ['shipped', 'cod_confirmed']) {
    const s = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ method: 'cod', state, ttn: state === 'shipped' ? '204' : null, shippedAt: ago(HOUR), npCheckedAt: ago(MIN), paymentIds: [], createdAt: ago(HOUR) }) }))
    await s.step()
    assert.equal(s.calls.client.length, 0, state)
    assert.ok(!s.order().alerts['new-paid'])
  }
})

test('оплата: в других состояниях сверка «оплачено» не шлёт', async () => {
  for (const state of ['payment_review', 'delivered', 'refused', 'returned']) {
    const s = await stand(docsOf(paidOrder({ state, ttn: '204', sms: {}, alerts: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })))
    await s.step()
    assert.equal(s.calls.client.length, 0, state)
    assert.ok(!s.order().alerts['new-paid'])
  }
})

test('оплата: адреса сайта нет: сообщение считается неудачным, номер не уходит, проход не падает', async () => {
  for (const siteBaseUrl of ['', 'http://runferry.test', '   ']) {
    const s = await stand({ ...docsOf(paidOrder({ sms: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })), 'system/shopSales': sales({ siteBaseUrl }) })
    await s.step()
    assert.equal(s.calls.client.length, 0)
    assert.equal(s.order().sms.paid.status, 'failed', siteBaseUrl)
  }
})

test('оплата: косая черта в конце адреса сайта не удваивается', async () => {
  const s = await stand({ ...docsOf(paidOrder({ sms: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })), 'system/shopSales': sales({ siteBaseUrl: `${SITE}/` }) })
  await s.step()
  assert.ok(s.calls.client[0].text.endsWith(`${SITE}/uk/order/${STATUS_TOKEN}`))
})

test('сообщения идут через настоящий журнал: ключ принят, в журнале нет телефона, токена и ссылки на чек', async () => {
  const s = await stand(docsOf(paidOrder({ sms: {} }), paidInvoice()), { notifications: true })
  await s.step()
  assert.equal(s.order().sms.paid.status, 'sent')
  assert.equal(s.order().sms.rcpt.status, 'sent')
  assert.deepEqual(s.calls.sms.map((c) => c.phone), [PHONE, PHONE])
  const journal = Object.entries(s.db.docs).filter(([p]) => p.startsWith('notifications/'))
  assert.deepEqual(journal.map(([p]) => p).sort(), ['notifications/ntf-na-shop-so-1-paid', 'notifications/ntf-na-shop-so-1-rcpt'])
  const text = JSON.stringify(journal)
  for (const bad of [PHONE, STATUS_TOKEN, TAX_URL]) assert.ok(!text.includes(bad), bad)
})

// ---------- п. 5: нет накладной ----------

test('п. 5: оплачено больше суток назад, накладной нет: алерт раз в сутки', async () => {
  const s = await stand(docsOf(paidOrder({ history: [{ at: ago(DAY + MIN), from: 'awaiting_payment', to: 'paid', by: 'webhook' }], paidAt: ago(DAY + MIN) }), paidInvoice()))
  await s.step()
  await s.step()
  assert.deepEqual(alertKinds(s), ['no-ttn-1'])
  assert.equal(s.calls.alerts.length, 1)
  assert.match(s.calls.alerts[0], /RF-AAAAAA: 800 грн, уже 1 дн\. без накладної/)
  s.patchOrder({ history: [{ at: ago(2 * DAY + MIN), to: 'paid' }] })
  await s.step()
  assert.deepEqual(alertKinds(s), ['no-ttn-1', 'no-ttn-2'])
})

test('п. 5: меньше суток, есть накладная или другое состояние: алерта нет', async () => {
  const fresh = await stand(docsOf(paidOrder({ history: [{ at: ago(DAY - MIN), to: 'paid' }] }), paidInvoice()))
  await fresh.step()
  assert.deepEqual(alertKinds(fresh), [])
  const withTtn = await stand(docsOf(paidOrder({ ttn: '204', history: [{ at: ago(3 * DAY), to: 'paid' }] }), paidInvoice()))
  await withTtn.step()
  assert.deepEqual(alertKinds(withTtn), [])
  const review = await stand(docsOf(paidOrder({ state: 'payment_review', history: [{ at: ago(3 * DAY), to: 'payment_review' }], payment: { lastBankCheckAt: ago(MIN) } }), paidInvoice()))
  await review.step()
  assert.deepEqual(alertKinds(review), [])
})

test('п. 5: срок считается от входа в состояние, а не от оплаты; нет истории: от оплаты; наложка тоже считается', async () => {
  const back = await stand(docsOf(paidOrder({ paidAt: ago(10 * DAY), history: [{ at: ago(10 * DAY), to: 'paid' }, { at: ago(HOUR), from: 'shipped', to: 'paid', by: 'np' }] }), paidInvoice()))
  await back.step()
  assert.deepEqual(alertKinds(back), [])

  const noHistory = await stand(docsOf(paidOrder({ paidAt: ago(DAY + MIN), history: [] }), paidInvoice()))
  await noHistory.step()
  assert.deepEqual(alertKinds(noHistory), ['no-ttn-1'])

  const cod = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ method: 'cod', state: 'cod_confirmed', history: [{ at: ago(DAY + MIN), to: 'cod_confirmed' }] }) }))
  await cod.step()
  assert.deepEqual(alertKinds(cod), ['no-ttn-1'])
})

// ---------- п. 6: посылки ----------

const TTN = '20450000000001'
const parcel = (over = {}) => docsOf(shippedOrder({ npCheckedAt: ago(31 * MIN), ...over }), paidInvoice())

test('п. 6: опрос раз в 30 минут; ключ ФОП; номер и код в заказе; покупатель видит только свою стадию', async () => {
  const s = await stand(docsOf(shippedOrder({ npCheckedAt: ago(29 * MIN) }), paidInvoice()), { np: npSays({ [TTN]: { StatusCode: 5, Status: 'Прямує до міста Умань, адреса покупця' } }) })
  await s.step()
  assert.deepEqual(s.calls.np, [])
  s.patchOrder({ npCheckedAt: ago(31 * MIN) })
  await s.step()
  assert.deepEqual(s.calls.np, [{ apiKey: 'NP-KEY-2', model: 'TrackingDocument', method: 'getStatusDocuments', numbers: [TTN] }])
  const o = s.order()
  assert.equal(o.state, 'shipped')
  assert.equal(o.npDelivery.code, '5')
  assert.equal(o.npDelivery.text, 'Прямує до міста Умань, адреса покупця')
  assert.equal(o.npDelivery.final, false)
  assert.ok(Date.now() - Date.parse(o.npCheckedAt) < MIN)
  const view = orderPublicView(o, { paidPayment: s.pay() })
  assert.equal(view.delivery.stage, 'moving')
  assert.ok(!JSON.stringify(view).includes('Прямує'))
})

test('п. 6: дата смены кода живёт, пока код тот же, и меняется с кодом', async () => {
  const s = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: '5' } }) })
  await s.step()
  const first = s.order().npDelivery.changedAt
  s.patchOrder({ npCheckedAt: ago(31 * MIN), npDelivery: { changedAt: 'раньше' } })
  await s.step()
  assert.equal(s.order().npDelivery.changedAt, 'раньше')
  assert.ok(first)
})

test('п. 6: длинный текст статуса НП обрезается', async () => {
  const s = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: '5', Status: 'я'.repeat(500) } }) })
  await s.step()
  assert.equal(s.order().npDelivery.text.length, 120)
})

test('п. 6: код другого номера не применяется, номера нет в ответе: заказ как был', async () => {
  const s = await stand(parcel(), { np: npSays({ 999: { StatusCode: '9' } }) })
  const before = s.order().npCheckedAt
  await s.step()
  assert.equal(s.order().state, 'shipped')
  assert.equal(s.order().npCheckedAt, before)
})

test('п. 6: партии по ключу ФОП и по 100 номеров; npFopId важнее ФОП заказа', async () => {
  const extra = { 'fops/fop-3': fopMeta(), 'fopSecrets/fop-3': fopSecret({ novaPoshta: { apiKey: 'NP-KEY-3' } }) }
  for (let n = 0; n < 101; n++) extra[`shopOrders/so-a${String(n).padStart(3, '0')}`] = shippedOrder({ ttn: `1${String(n).padStart(13, '0')}`, npCheckedAt: ago(HOUR) })
  extra['shopOrders/so-b'] = shippedOrder({ ttn: '30000000000000', npCheckedAt: ago(HOUR), npFopId: 'fop-3' })
  extra['shopOrders/so-c'] = shippedOrder({ ttn: '30000000000001', npCheckedAt: ago(HOUR), fopId: 'fop-3', npFopId: null })
  extra['payments/pay-1'] = paidInvoice()
  const s = await stand(baseDocs(extra))
  await s.step()
  const byKey = s.calls.np.map((c) => [c.apiKey, c.numbers.length])
  assert.deepEqual(byKey, [['NP-KEY-2', 100], ['NP-KEY-2', 1], ['NP-KEY-3', 2]])
})

test('п. 6: коды 9, 10, 11, 106: delivered, дата получения от НП, покупатель видит «получено»', async () => {
  for (const code of ['9', '10', '11', '106']) {
    const s = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: code, Status: 'Відправлення отримано', RecipientDateTime: '21.05.2026 13:53:47' } }) })
    await s.step()
    const o = s.order()
    assert.equal(o.state, 'delivered', code)
    assert.equal(o.npDelivery.final, true)
    assert.equal(o.npDelivery.deliveredAt, '2026-05-21T10:53:47.000Z')
    assert.equal(o.history.at(-1).by, 'np')
    assert.equal(o.history.at(-1).from, 'shipped')
    assert.equal(orderPublicView(o, { paidPayment: s.pay() }).delivery.stage, 'received')
    assert.deepEqual(alertKinds(s), [])
  }
})

test('п. 6: дата получения: ActualDeliveryDate, если нет RecipientDateTime; нет обеих: сейчас', async () => {
  const a = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: '9', ActualDeliveryDate: '2026-05-21 13:53:47' } }) })
  await a.step()
  assert.equal(a.order().npDelivery.deliveredAt, '2026-05-21T10:53:47.000Z')
  const b = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: '9' } }) })
  await b.step()
  assert.ok(Date.now() - Date.parse(b.order().npDelivery.deliveredAt) < MIN)
})

test('п. 6: коды 102, 103, 108, 105: refused, один алерт о возврате денег', async () => {
  for (const code of ['102', '103', '108', '105']) {
    const s = await stand(parcel(), { np: npSays({ [TTN]: { StatusCode: code, Status: 'Відмова' } }) })
    await s.step()
    const o = s.order()
    assert.equal(o.state, 'refused', code)
    assert.ok(o.refusedAt)
    assert.equal(o.npDelivery.final, true)
    assert.equal(o.history.at(-1).by, 'np')
    assert.deepEqual(alertKinds(s), [`refused-${TTN}`])
    assert.equal(s.calls.alerts.length, 1)
    assert.match(s.calls.alerts[0], /посилку 20450000000001 не отримано/)
    assert.match(s.calls.alerts[0], /повернення коштів/)
    assert.equal(orderPublicView(o, { paidPayment: s.pay() }).delivery.stage, 'refused')
    await s.step()
    assert.equal(s.calls.alerts.length, 1)
  }
})

test('п. 6: код 2: заказ снова ждёт накладную, номер в истории, алерт называет старый номер', async () => {
  const s = await stand(parcel({ ttnHistory: [{ ttn: 'старий', at: 'x', reason: 'np-3' }], npDocRef: 'doc-ref' }), { np: npSays({ [TTN]: { StatusCode: 2, Status: 'Видалено' } }) })
  await s.step()
  const o = s.order()
  assert.equal(o.state, 'paid')
  for (const k of ['ttn', 'npDocRef', 'shippedAt', 'npDelivery', 'npCheckedAt', 'npFopId']) assert.equal(o[k], null, k)
  assert.equal(o.ttnHistory.length, 2)
  assert.equal(o.ttnHistory[1].ttn, TTN)
  assert.equal(o.ttnHistory[1].reason, 'np-2')
  assert.equal(o.history.at(-1).to, 'paid')
  assert.equal(o.history.at(-1).from, 'shipped')
  assert.equal(o.history.at(-1).by, 'np')
  assert.deepEqual(alertKinds(s), [`ttn-gone-${TTN}`])
  assert.match(s.calls.alerts[0], /НП більше не знає накладну 20450000000001 \(код 2\)/)
  assert.equal(orderPublicView(o, { paidPayment: s.pay() }).delivery.stage, 'none')
})

test('п. 6: код 3: свежая накладная ждёт, старше 3 дней возвращается; наложка возвращается в cod_confirmed', async () => {
  const young = await stand(parcel({ shippedAt: ago(3 * DAY - HOUR) }), { np: npSays({ [TTN]: { StatusCode: '3', Status: 'Номер не знайдено' } }) })
  await young.step()
  assert.equal(young.order().state, 'shipped')
  assert.equal(young.order().ttn, TTN)
  assert.deepEqual(alertKinds(young), [])
  assert.equal(orderPublicView(young.order(), { paidPayment: young.pay() }).delivery.stage, 'created')

  const old = await stand(parcel({ shippedAt: ago(3 * DAY + HOUR) }), { np: npSays({ [TTN]: { StatusCode: '3' } }) })
  await old.step()
  assert.equal(old.order().state, 'paid')
  assert.equal(old.order().ttnHistory[0].reason, 'np-3')

  const cod = await stand(baseDocs({ 'shopOrders/so-1': shippedOrder({ method: 'cod', paidPaymentId: null, paidAt: null, npCheckedAt: ago(HOUR) }) }), { np: npSays({ [TTN]: { StatusCode: '2' } }) })
  await cod.step()
  assert.equal(cod.order().state, 'cod_confirmed')
})

test('п. 6: код 1 дольше 48 часов: один алерт «посилку не здано», раньше молчим, стадия «создана»', async () => {
  const young = await stand(parcel({ shippedAt: ago(47 * HOUR) }), { np: npSays({ [TTN]: { StatusCode: '1' } }) })
  await young.step()
  assert.deepEqual(alertKinds(young), [])
  assert.equal(orderPublicView(young.order(), { paidPayment: young.pay() }).delivery.stage, 'created')

  const old = await stand(parcel({ shippedAt: ago(49 * HOUR) }), { np: npSays({ [TTN]: { StatusCode: '1' } }) })
  await old.step()
  old.patchOrder({ npCheckedAt: ago(31 * MIN) })
  await old.step()
  assert.deepEqual(alertKinds(old), [`np-not-handed-${TTN}`])
  assert.equal(old.calls.alerts.length, 1)
  assert.match(old.calls.alerts[0], /посилку не здано/)
})

test('п. 6: заказ изменился, пока шёл запрос к НП: чужой номер не применяем и алертов нет', async () => {
  const s = await stand(parcel(), {
    np: async () => {
      s.patchOrder({ ttn: 'новий' })
      return { success: true, data: [{ Number: TTN, StatusCode: '2' }] }
    },
  })
  await s.step()
  assert.equal(s.order().state, 'shipped')
  assert.equal(s.order().ttn, 'новий')
  assert.equal(s.order().npDelivery, undefined)
  assert.deepEqual(alertKinds(s), [])

  const moved = await stand(parcel(), {
    np: async () => {
      moved.patchOrder({ state: 'reversed' })
      return { success: true, data: [{ Number: TTN, StatusCode: '9' }] }
    },
  })
  await moved.step()
  assert.equal(moved.order().state, 'reversed')
})

test('п. 6: опрашиваются только отправленные с номером', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': shippedOrder({ ttn: null, npCheckedAt: ago(HOUR) }),
    'shopOrders/so-2': shippedOrder({ state: 'refused', npCheckedAt: ago(HOUR) }),
    'payments/pay-1': paidInvoice(),
  }))
  await s.step()
  assert.deepEqual(s.calls.np, [])
})

test('п. 6: ФОП накладной не загружается: посылка ждёт, проход идёт дальше', async () => {
  const s = await stand(parcel({ npFopId: 'fop-x' }))
  await s.step()
  assert.deepEqual(s.calls.np, [])
  assert.ok(logs.some((l) => l.includes('у ФОП fop-x немає ключа НП')))
})

test('п. 6: НП не отвечает или отвечает отказом: заказ не меняется, ключ и номер не в журнале', async () => {
  const before = logs.length
  for (const np of [async () => { throw new Error('timeout') }, async () => ({ success: false, errors: ['x'] }), async () => ({ success: true }), async () => ({ success: false, data: [{ Number: TTN, StatusCode: '9' }] })]) {
    const s = await stand(parcel(), { np })
    const at = s.order().npCheckedAt
    await s.step()
    assert.equal(s.order().npCheckedAt, at)
    assert.equal(s.order().state, 'shipped')
  }
  const text = logs.slice(before).join('\n')
  assert.ok(text.includes('посилки ФОП fop-2'))
  assert.ok(!text.includes('NP-KEY-2'))
})

test('п. 6: статус не обновлялся больше суток: алерт раз в сутки; если НП только что ответила: нет', async () => {
  const silent = await stand(parcel({ npCheckedAt: ago(DAY + MIN) }), { np: async () => { throw new Error('down') } })
  await silent.step()
  await silent.step()
  assert.deepEqual(alertKinds(silent), [`np-stale-${TTN}-1`])
  assert.equal(silent.calls.alerts.length, 1)
  assert.match(silent.calls.alerts[0], /не оновлюється вже 1 дн/)
  silent.patchOrder({ npCheckedAt: ago(2 * DAY + MIN) })
  await silent.step()
  assert.deepEqual(alertKinds(silent), [`np-stale-${TTN}-1`, `np-stale-${TTN}-2`])

  const answered = await stand(parcel({ npCheckedAt: ago(3 * DAY) }), { np: npSays({ [TTN]: { StatusCode: '5' } }) })
  await answered.step()
  assert.deepEqual(alertKinds(answered), [])

  const neverChecked = await stand(parcel({ npCheckedAt: null, shippedAt: ago(DAY + HOUR) }), { np: npSays({}) })
  await neverChecked.step()
  assert.deepEqual(alertKinds(neverChecked), [`np-stale-${TTN}-1`], 'отсчёт от отправки, номера нет в ответе')
})

test('п. 6: у ФОП нет ключа НП: посылки ждут, через сутки алерт', async () => {
  const s = await stand({ ...parcel({ npCheckedAt: ago(DAY + MIN) }), 'fopSecrets/fop-2': fopSecret({ novaPoshta: {} }) })
  await s.step()
  assert.deepEqual(s.calls.np, [])
  assert.deepEqual(alertKinds(s), [`np-stale-${TTN}-1`])
  assert.ok(logs.some((l) => l.includes('у ФОП fop-2 немає ключа НП')))
})

test('п. 6: 45 дней без финала: один алерт; посылка получена на этом проходе: нет', async () => {
  const old = await stand(parcel({ shippedAt: ago(45 * DAY + HOUR) }), { np: npSays({ [TTN]: { StatusCode: '5' } }) })
  await old.step()
  old.patchOrder({ npCheckedAt: ago(31 * MIN) })
  await old.step()
  assert.deepEqual(alertKinds(old), [`np-no-final-${TTN}`])
  assert.equal(old.calls.alerts.length, 1)
  assert.match(old.calls.alerts[0], /45 днів/)

  const young = await stand(parcel({ shippedAt: ago(44 * DAY) }), { np: npSays({ [TTN]: { StatusCode: '5' } }) })
  await young.step()
  assert.deepEqual(alertKinds(young), [])

  const done = await stand(parcel({ shippedAt: ago(50 * DAY) }), { np: npSays({ [TTN]: { StatusCode: '9' } }) })
  await done.step()
  assert.equal(done.order().state, 'delivered')
  assert.deepEqual(alertKinds(done), [])

  const refused = await stand(parcel({ shippedAt: ago(50 * DAY) }), { np: npSays({ [TTN]: { StatusCode: '102' } }) })
  await refused.step()
  assert.deepEqual(alertKinds(refused), [`refused-${TTN}`])

  const back = await stand(parcel({ shippedAt: ago(50 * DAY) }), { np: npSays({ [TTN]: { StatusCode: '2' } }) })
  await back.step()
  assert.deepEqual(alertKinds(back), [`ttn-gone-${TTN}`])
})

test('п. 6: кончилось время прохода: НП не спрашиваем', async () => {
  const s = await stand(parcel(), { passBudgetMs: -1, np: npSays({ [TTN]: { StatusCode: '9' } }) })
  await s.step()
  assert.deepEqual(s.calls.np, [])
})

test('п. 6: отказ по посылке не затрагивает соседний заказ той же партии', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': shippedOrder({ ttn: '1', npCheckedAt: ago(HOUR) }),
    'shopOrders/so-2': shippedOrder({ ttn: '2', npCheckedAt: ago(HOUR) }),
    'payments/pay-1': paidInvoice(),
  }), { np: npSays({ 1: { StatusCode: '9', RecipientDateTime: 'x' }, 2: { StatusCode: '102' } }) })
  await s.step()
  assert.equal(s.order('so-1').state, 'delivered')
  assert.equal(s.order('so-2').state, 'refused')
})

// ---------- п. 7: 20-й день ----------

test('п. 7: 20-й день после отказа, возврата посылки или заявления: один алерт', async () => {
  const cases = [
    { state: 'refused', history: [{ at: ago(20 * DAY + HOUR), to: 'refused' }] },
    { state: 'returned', history: [{ at: ago(25 * DAY), to: 'refused' }, { at: ago(HOUR), to: 'returned' }] },
    { state: 'returned', history: [{ at: ago(20 * DAY + HOUR), to: 'returned' }] },
    { state: 'paid', refundRequestedAt: ago(20 * DAY + HOUR), ttn: '204' },
    { state: 'delivered', refundRequestedAt: ago(20 * DAY + HOUR), ttn: '204' },
  ]
  for (const over of cases) {
    const s = await stand(docsOf(paidOrder({ payment: { lastBankCheckAt: ago(MIN) }, ...over }), paidInvoice()))
    await s.step()
    await s.step()
    assert.deepEqual(alertKinds(s), ['refund-day-20'], JSON.stringify(over))
    assert.equal(s.calls.alerts.length, 1)
    assert.match(s.calls.alerts[0], /30-го дня/)
    assert.match(s.calls.alerts[0], /800 грн/)
  }
})

test('п. 7: раньше 20-го дня, наложка, возврат уже сделан, посылка не отказана: алерта нет', async () => {
  const cases = [
    paidOrder({ state: 'refused', history: [{ at: ago(19 * DAY), to: 'refused' }] }),
    paidOrder({ state: 'refused', method: 'cod', history: [{ at: ago(30 * DAY), to: 'refused' }] }),
    paidOrder({ state: 'reversed', history: [{ at: ago(30 * DAY), to: 'refused' }, { at: ago(DAY), to: 'reversed' }] }),
    paidOrder({ state: 'paid', ttn: '204', paidAt: ago(40 * DAY), history: [{ at: ago(40 * DAY), to: 'paid' }] }),
    paidOrder({ state: 'refused', paidPaymentId: null, history: [{ at: ago(30 * DAY), to: 'refused' }] }),
  ]
  for (const order of cases) {
    const s = await stand(docsOf(order, paidInvoice()))
    await s.step()
    assert.deepEqual(alertKinds(s), [], JSON.stringify(order.history))
  }
})

// ---------- п. 8: что не дошло ----------

const unsent = (over = {}) => ({ at: ago(5 * MIN), sentAt: null, text: 'текст алерта', ...over })

test('п. 8: непосланные алерты повторяются, в том числе reversed-signal и unknown-status; доставленные и свежие нет', async () => {
  const s = await stand(docsOf(paidOrder({
    alerts: {
      'new-paid': { at: ago(HOUR), sentAt: ago(HOUR), text: 'уже дошёл' },
      cleared: null,
      'reversed-signal': unsent({ text: 'сигнал' }),
      'unknown-status-chargeback': unsent({ text: 'чарджбек' }),
      fresh: unsent({ at: ago(MIN), text: 'свежий' }),
    },
  }), paidInvoice()))
  await s.step()
  assert.deepEqual(s.calls.alerts.sort(), [withGuideStep('reversed-signal', 'сигнал'), withGuideStep('unknown-status-chargeback', 'чарджбек')])
  const { alerts } = s.order()
  assert.ok(alerts['reversed-signal'].sentAt)
  assert.ok(alerts['unknown-status-chargeback'].sentAt)
  assert.equal(alerts.fresh.sentAt, null)
  await s.step()
  assert.equal(s.calls.alerts.length, 2)
})

test('п. 8: Telegram не отвечает: повтор не чаще раза в 2 минуты; дошло: метка', async () => {
  let up = false
  const s = await stand(docsOf(paidOrder({ alerts: { 'new-paid': unsent() } }), paidInvoice()), { notify: async () => up })
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  assert.equal(s.order().alerts['new-paid'].sentAt, null)
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  s.patchOrder({ alerts: { 'new-paid': { triedAt: ago(2 * MIN + SEC) } } })
  up = true
  await s.step()
  assert.equal(s.calls.alerts.length, 2)
  assert.ok(s.order().alerts['new-paid'].sentAt)
})

test('п. 8: другой экземпляр уже взял или отправил повтор, пока шло чтение: не дублируем', async () => {
  for (const patch of [{ triedAt: new Date().toISOString() }, { sentAt: new Date().toISOString() }]) {
    const s = await stand(docsOf(paidOrder({ alerts: { 'new-paid': { at: ago(MIN), sentAt: ago(MIN), text: 'x' }, x: unsent() } }), paidInvoice()))
    const realRun = s.db.runTransaction.bind(s.db)
    let done = false
    s.db.runTransaction = (fn) => {
      if (!done) {
        done = true
        s.patchOrder({ alerts: { x: patch } })
      }
      return realRun(fn)
    }
    await s.step()
    assert.equal(s.calls.alerts.length, 0, JSON.stringify(patch))
  }
})

test('п. 8: алерт у заказа в конечном состоянии повторяется реже; заказ «delivered» и «returned» тоже', async () => {
  for (const state of ['reversed', 'delivered', 'returned']) {
    const s = await stand(docsOf(paidOrder({ state, alerts: { reversed: unsent({ text: 'повернули' }) } }), paidInvoice({ status: state === 'reversed' ? 'reversed' : 'paid' })), { slowScanMs: HOUR })
    await s.step()
    assert.deepEqual(s.calls.alerts, [withGuideStep('reversed', 'повернули')], state)
    s.patchOrder({ alerts: { reversed: { sentAt: null, triedAt: ago(10 * MIN) } } })
    await s.step()
    assert.equal(s.calls.alerts.length, 1, 'до следующего часового прохода не читаем')
  }
})

test('п. 8: алерты дня за сегодня и вчера: лимит заказов и выпавшие артикулы; позавчера и доставленные нет', async () => {
  const yesterday = KYIV_DAY.format(new Date(Date.now() - DAY))
  const old = KYIV_DAY.format(new Date(Date.now() - 2 * DAY))
  const s = await stand(baseDocs({
    [`shopDaily/${today()}`]: { unpaid: 40, alerts: { 'day-limit': unsent({ text: 'ліміт' }), 'feed-V2-LID-R': unsent({ text: 'done', sentAt: ago(MIN) }) } },
    [`shopDaily/${yesterday}`]: { alerts: { 'feed-V2-LID-H': unsent({ text: 'вчора' }) } },
    [`shopDaily/${old}`]: { alerts: { x: unsent({ text: 'позавчора' }) } },
  }))
  await s.step()
  assert.deepEqual(s.calls.alerts.sort(), [withGuideStep('feed-V2-LID-H', 'вчора'), withGuideStep('day-limit', 'ліміт')])
  assert.ok(s.db.docs[`shopDaily/${today()}`].alerts['day-limit'].sentAt)
  assert.ok(s.db.docs[`shopDaily/${yesterday}`].alerts['feed-V2-LID-H'].sentAt)
})

// ---------- запасной канал: SMS владельцу ----------

const alertDocs = (extra = {}) => docsOf(paidOrder(), paidInvoice(), extra)

test('алерт: Telegram не ответил: SMS на телефон владельца с тем же текстом, метка smsAt, sentAt пуст', async () => {
  const s = await stand(alertDocs(), { notify: async () => false })
  await s.hooks.shopAlert('so-1', 'test-kind', (o, url) => `Замовлення ${o.orderNo}: ${url}`)
  assert.deepEqual(s.calls.sms, [{ phone: OWNER_PHONE, text: withGuideStep('test-kind', 'Замовлення RF-AAAAAA: https://portal.test/shop-orders/so-1') }])
  const a = s.order().alerts['test-kind']
  assert.equal(a.sentAt, null)
  assert.ok(a.smsAt)
})

test('алерт: SMS не чаще раза в час на все заказы и экземпляры; через час следующая', async () => {
  const s = await stand(alertDocs(), { notify: async () => false })
  await s.hooks.shopAlert('so-1', 'a', () => 'перший')
  await s.hooks.shopAlert('so-1', 'b', () => 'другий')
  assert.deepEqual(s.calls.sms.map((c) => c.text), [withGuideStep('a', 'перший')])
  s.patch('system/shopOwnerSms', { at: ago(HOUR + SEC) })
  s.patchOrder({ alerts: { b: { at: ago(5 * MIN) } } })
  await s.step()
  assert.deepEqual(s.calls.sms.map((c) => c.text).sort(), [withGuideStep('b', 'другий'), withGuideStep('a', 'перший')])
  assert.ok(s.order().alerts.b.smsAt)
})

test('алерт: тот же алерт вторую SMS не получает, пока Telegram молчит', async () => {
  const s = await stand(docsOf(paidOrder({ alerts: { 'new-paid': unsent({ smsAt: ago(HOUR) }) } }), paidInvoice()), { notify: async () => false })
  await s.step()
  assert.equal(s.calls.alerts.length, 1, 'Telegram пробуем')
  assert.equal(s.calls.sms.length, 0)
})

test('алерт: дошёл через Telegram: SMS нет; телефона владельца нет: SMS нет и ошибки нет', async () => {
  const ok = await stand(alertDocs())
  await ok.hooks.shopAlert('so-1', 'a', () => 'x')
  assert.equal(ok.calls.sms.length, 0)

  const none = await stand({ ...alertDocs(), 'system/shopSales': sales({ ownerPhone: '' }) }, { notify: async () => false })
  await none.hooks.shopAlert('so-1', 'a', () => 'x')
  assert.equal(none.calls.sms.length, 0)
  assert.equal(none.db.docs['system/shopOwnerSms'], undefined, 'час не занят')

  const noDoc = await stand(alertDocs(), { notify: async () => false })
  delete noDoc.db.docs['system/shopSales']
  await noDoc.hooks.shopAlert('so-1', 'a', () => 'x')
  assert.equal(noDoc.calls.sms.length, 0)
})

test('алерт: SMS тоже не дошла: без метки, ошибка только в журнале; без sendSms ничего не читаем', async () => {
  const s = await stand(alertDocs(), { notify: async () => false, sms: async () => ({ ok: false, error: 'баланс' }) })
  await s.hooks.shopAlert('so-1', 'a', () => 'x')
  assert.equal(s.order().alerts.a.smsAt, undefined)
  assert.ok(logs.some((l) => l.includes('SMS власнику a so-1') && l.includes('баланс')))

  const db = new FakeDb(alertDocs())
  const hooks = createShopPaymentHooks({ adminDb: db, payments: { notifyOwner: async () => false }, siteUrl: 'https://portal.test' })
  await hooks.shopAlert('so-1', 'a', () => 'x')
  assert.ok(!db.reads.includes('system/shopSales'))
})

test('алерт: нет заказа: не падает; один алерт на заказ и вид', async () => {
  const s = await stand(alertDocs())
  await s.hooks.shopAlert('so-x', 'a', () => 'x')
  assert.ok(logs.some((l) => l.includes('алерт a без замовлення so-x')))
  await s.hooks.shopAlert('so-1', 'a', () => 'перший')
  await s.hooks.shopAlert('so-1', 'a', () => 'другий')
  assert.deepEqual(s.calls.alerts, [withGuideStep('a', 'перший')])
})

test('сообщение покупателю: нет notifyClient или заказа: ничего не происходит', async () => {
  const db = new FakeDb(alertDocs())
  const hooks = createShopPaymentHooks({ adminDb: db, payments: { notifyOwner: async () => true }, siteUrl: 'https://portal.test' })
  await hooks.sendPaidMessage(db.collection('shopOrders').doc('so-1'))
  assert.equal(db.docs['shopOrders/so-1'].sms.paid.status, 'sent', 'запись прежняя')

  const s = await stand(alertDocs())
  await s.hooks.sendPaidMessage(s.db.collection('shopOrders').doc('so-x'))
  assert.equal(s.calls.client.length, 0)
})

// ---------- п. 9: стирание ----------

const PII = ['lastName', 'firstName', 'middleName', 'clientName', 'clientPhone', 'phoneKey', 'email', 'fingerprint', 'clientCityRef', 'clientCityName', 'clientWarehouseRef', 'clientWarehouseName']

test('п. 9: неоплаченный старше 30 дней: данные стёрты, заказ и страница статуса живы; 2 прохода не пишут дважды', async () => {
  for (const state of ['cancelled', 'expired']) {
    const s = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ state, createdAt: ago(30 * DAY + HOUR) }) }))
    await s.step()
    const o = s.order()
    for (const k of PII) assert.equal(o[k], null, k)
    assert.ok(o.piiPurgedAt)
    assert.equal(o.orderNo, 'RF-AAAAAA')
    assert.equal(o.total, 800)
    assert.equal(o.statusToken, STATUS_TOKEN)
    const text = JSON.stringify(o)
    for (const bad of [PHONE, 'Шевченко', 'Тарас', 'taras@example.com', 'Умань', 'Відділення №77', 'pk-1', 'fp']) assert.ok(!text.includes(`"${bad}"`), bad)
    const view = orderPublicView(o)
    assert.equal(view.orderNo, 'RF-AAAAAA')
    assert.equal(view.phoneConfirm.phoneMasked, '')

    const stamp = o.piiPurgedAt
    await sleep(2)
    await s.step()
    assert.equal(s.order().piiPurgedAt, stamp)
  }
})

test('п. 9: моложе 30 дней, в другом состоянии или с оплатой: не трогаем', async () => {
  const keep = [
    awaiting({ state: 'cancelled', createdAt: ago(29 * DAY) }),
    awaiting({ state: 'awaiting_payment', createdAt: ago(60 * DAY) }),
    awaiting({ state: 'cancelled', createdAt: ago(60 * DAY), paidPaymentId: 'pay-1' }),
    paidOrder({ state: 'payment_review', createdAt: ago(60 * DAY) }),
    awaiting({ state: 'cancelled', createdAt: 'не дата' }),
  ]
  for (const order of keep) {
    const s = await stand(docsOf(order, paidInvoice()))
    await s.step()
    assert.equal(s.order().clientPhone, PHONE, JSON.stringify(order.state))
    assert.equal(s.order().piiPurgedAt, undefined)
  }
})

test('п. 9: оплаченные без срока от бухгалтера не стираются; со сроком стираются конечные и только старше него', async () => {
  const old = () => paidOrder({ state: 'delivered', createdAt: ago(400 * DAY), ttn: '1', paidAt: ago(400 * DAY) })
  for (const limits of [{}, { piiPaidDays: null }, { piiPaidDays: 0 }, { piiPaidDays: -1 }, { piiPaidDays: 1.5 }, { piiPaidDays: '365' }]) {
    const s = await stand({ ...docsOf(old(), paidInvoice()), 'system/shopSales': sales({ limits }) })
    await s.step()
    assert.equal(s.order().clientPhone, PHONE, JSON.stringify(limits))
  }
  for (const state of ['delivered', 'returned', 'reversed']) {
    const s = await stand({ ...docsOf({ ...old(), state }, paidInvoice({ status: state === 'reversed' ? 'reversed' : 'paid' })), 'system/shopSales': sales({ limits: { piiPaidDays: 365 } }) })
    await s.step()
    assert.equal(s.order().clientPhone, null, state)
  }
  const young = await stand({ ...docsOf({ ...old(), createdAt: ago(300 * DAY) }, paidInvoice()), 'system/shopSales': sales({ limits: { piiPaidDays: 365 } }) })
  await young.step()
  assert.equal(young.order().clientPhone, PHONE)
  const notFinal = await stand({ ...docsOf({ ...old(), state: 'shipped' }, paidInvoice()), 'system/shopSales': sales({ limits: { piiPaidDays: 365 } }) })
  await notFinal.step()
  assert.equal(notFinal.order().clientPhone, PHONE)
})

test('п. 9: настройки не прочитались: неоплаченные стираются, оплаченные нет; заказ изменился за время чтения: не трогаем', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': awaiting({ state: 'cancelled', createdAt: ago(60 * DAY) }),
    'shopOrders/so-2': paidOrder({ state: 'delivered', createdAt: ago(900 * DAY), paidAt: ago(900 * DAY), ttn: '1' }),
    'payments/pay-1': paidInvoice(),
  }))
  s.db.failRead = (path) => path === 'system/shopSales'
  await s.step()
  assert.equal(s.order('so-1').clientPhone, null)
  assert.equal(s.order('so-2').clientPhone, PHONE)

  const moved = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ state: 'cancelled', createdAt: ago(60 * DAY) }) }))
  const realRun = moved.db.runTransaction.bind(moved.db)
  moved.db.runTransaction = (fn) => {
    moved.patchOrder({ state: 'payment_review', paidPaymentId: 'pay-late' })
    return realRun(fn)
  }
  await moved.step()
  assert.equal(moved.order().clientPhone, PHONE)
})

test('п. 9: другой экземпляр уже стёр, пока шло чтение: отметку не переписываем', async () => {
  const s = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ state: 'cancelled', createdAt: ago(60 * DAY) }) }))
  const realRun = s.db.runTransaction.bind(s.db)
  s.db.runTransaction = (fn) => {
    s.patchOrder({ piiPurgedAt: 'раньше' })
    return realRun(fn)
  }
  await s.step()
  assert.equal(s.order().piiPurgedAt, 'раньше')
})

test('п. 9: стирание раз в заданный срок, а не на каждом проходе', async () => {
  const s = await stand(baseDocs({ 'shopOrders/so-1': awaiting({ state: 'cancelled', createdAt: ago(29 * DAY) }) }), { purgeEveryMs: DAY })
  await s.step()
  s.patchOrder({ createdAt: ago(60 * DAY) })
  await s.step()
  assert.equal(s.order().clientPhone, PHONE)
})

// ---------- поправка: опрос оплатившего счёта ----------

const REVERSED = { status: 'reversed', amount: 80000, ccy: 980, finalAmount: 0 }
const POLL_DUE = { payment: { lastBankCheckAt: ago(25 * HOUR) } }

test('опрос оплатившего счёта: возврат после отправки и в любом незакрытом состоянии замечен без метки и колбэка', async () => {
  for (const state of ['paid', 'shipped', 'delivered', 'refused', 'returned', 'payment_review']) {
    const s = await stand(docsOf(paidOrder({ state, ttn: state === 'paid' ? null : '204', ...POLL_DUE }), paidInvoice()))
    s.bank.statuses['inv-1'] = REVERSED
    assert.deepEqual(await s.step(), { checked: 1 }, state)
    assert.deepEqual(s.bank.statusCalls, ['inv-1'])
    assert.equal(s.pay().status, 'reversed')
    assert.equal(s.order().state, 'reversed')
    assert.equal(s.order().history.at(-1).by, 'reconcile')
    assert.ok(s.calls.alerts.some((x) => x.includes('банк повернув 800 грн')))
    assert.equal(s.calls.sells.length, 0)
  }
})

test('опрос оплатившего счёта: без номера в банке и по уже возвращённому не спрашиваем; нет бюджета: метку не ставим', async () => {
  for (const pay of [paidInvoice({ providerOrderId: null }), paidInvoice({ status: 'reversed' })]) {
    const s = await stand(docsOf(paidOrder(POLL_DUE), pay))
    await s.step()
    assert.deepEqual(s.bank.statusCalls, [], JSON.stringify(pay.status))
  }
  const s = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()), { bankCallsPerPass: 0 })
  const stamp = s.order().payment.lastBankCheckAt
  await s.step()
  assert.equal(s.order().payment.lastBankCheckAt, stamp)
})

test('опрос оплатившего счёта: первый раз через час после оплаты, а не сразу', async () => {
  const young = await stand(docsOf(paidOrder({ paidAt: ago(50 * MIN), payment: { lastBankCheckAt: null } }), paidInvoice()))
  await young.step()
  assert.deepEqual(young.bank.statusCalls, [])
  const due = await stand(docsOf(paidOrder({ paidAt: ago(HOUR + MIN), payment: { lastBankCheckAt: null } }), paidInvoice()))
  await due.step()
  assert.deepEqual(due.bank.statusCalls, ['inv-1'])
})

test('опрос оплатившего счёта: всё в порядке: заказ и чек без изменений, метка времени стоит; чарджбэк и частичный возврат дают алерт', async () => {
  const s = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()))
  s.bank.statuses['inv-1'] = BANK_PAID
  await s.step()
  assert.equal(s.order().state, 'paid')
  assert.equal(s.calls.sells.length, 0)
  assert.ok(Date.now() - Date.parse(s.order().payment.lastBankCheckAt) < MIN)
  assert.equal(s.calls.alerts.length, 0)

  const unknown = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()))
  unknown.bank.statuses['inv-1'] = { status: 'chargeback' }
  await unknown.step()
  assert.ok(unknown.calls.alerts.some((x) => x.includes('статус «chargeback»')))

  const part = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()))
  part.bank.statuses['inv-1'] = { ...BANK_PAID, finalAmount: 50000 }
  await part.step()
  assert.ok(part.calls.alerts.some((x) => x.includes('повернув частину оплати, 300 грн')))
})

test('опрос оплатившего счёта: раз в час до получения посылки, раз в сутки после, ни разу через 120 дней', async () => {
  for (const [state, every] of [['paid', HOUR], ['shipped', HOUR], ['refused', HOUR], ['payment_review', HOUR], ['delivered', DAY], ['returned', DAY]]) {
    const early = await stand(docsOf(paidOrder({ state, ttn: '204', payment: { lastBankCheckAt: ago(every - MIN) } }), paidInvoice()))
    await early.step()
    assert.deepEqual(early.bank.statusCalls, [], `${state}: рано`)
    const due = await stand(docsOf(paidOrder({ state, ttn: '204', payment: { lastBankCheckAt: ago(every + MIN) } }), paidInvoice()))
    await due.step()
    assert.deepEqual(due.bank.statusCalls, ['inv-1'], `${state}: пора`)
  }
  const old = await stand(docsOf(paidOrder({ state: 'delivered', ttn: '204', paidAt: ago(121 * DAY), ...POLL_DUE }), paidInvoice()))
  await old.step()
  assert.deepEqual(old.bank.statusCalls, [])
  const stillHot = await stand(docsOf(paidOrder({ state: 'shipped', ttn: '204', paidAt: ago(121 * DAY), ...POLL_DUE }), paidInvoice()))
  await stillHot.step()
  assert.deepEqual(stillHot.bank.statusCalls, ['inv-1'], 'посылка ещё не получена: следим дальше')
})

test('опрос оплатившего счёта: reversed и закрытые не спрашиваем; другой экземпляр только что спросил; банк не ответил: без изменений', async () => {
  for (const order of [paidOrder({ state: 'reversed', ...POLL_DUE }), awaiting({ state: 'cancelled' })]) {
    const s = await stand(docsOf(order, paidInvoice()))
    await s.step()
    assert.deepEqual(s.bank.statusCalls, [], order.state)
  }
  const raced = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()))
  const realRun = raced.db.runTransaction.bind(raced.db)
  let first = true
  raced.db.runTransaction = (fn) => {
    if (first) {
      first = false
      raced.patchOrder({ payment: { lastBankCheckAt: new Date().toISOString() } })
    }
    return realRun(fn)
  }
  await raced.step()
  assert.deepEqual(raced.bank.statusCalls, [])

  const down = await stand(docsOf(paidOrder(POLL_DUE), paidInvoice()))
  down.bank.fail['inv-1'] = httpErr(503)
  await down.step()
  assert.equal(down.order().state, 'paid')
  assert.ok(logs.some((l) => l.includes('опитування RF-AAAAAA')))
})

test('опрос оплатившего счёта: чек дошёл и банк спрашивали недавно: документ оплаты не читаем', async () => {
  const s = await stand(docsOf(paidOrder({ receipt: { status: 'ready', taxUrl: TAX_URL }, sms: { paid: { status: 'sent' }, rcpt: { status: 'sent' } } }), paidInvoice()), { slowScanMs: HOUR, purgeEveryMs: DAY })
  await s.step()
  assert.ok(!s.db.reads.includes('payments/pay-1'))
  s.patchOrder({ sms: { rcpt: { status: 'failed', tries: 1, at: ago(HOUR) } } })
  await s.step()
  assert.ok(s.db.reads.includes('payments/pay-1'), 'сообщение не дошло: без документа ссылки нет')
})

test('опрос оплатившего счёта: документа оплаты нет: заказ не ломает проход', async () => {
  const s = await stand(docsOf(paidOrder(POLL_DUE), null))
  assert.deepEqual(await s.step(), { checked: 0 })
})

// ---------- гейт ФОП ----------

test('гейт: ФОП перестал проходить: алерт раз в сутки с названием, что не так; секретов в тексте нет', async () => {
  const s = await stand({ ...baseDocs(), 'fopSecrets/fop-2': fopSecret({ monoAcquire: {} }) })
  await s.step()
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  assert.match(s.calls.alerts[0], /monoAcquire\.token/)
  assert.match(s.calls.alerts[0], /https:\/\/portal\.test\/shop-orders/)
  assert.ok(!s.calls.alerts[0].includes('SECRET'))
  assert.ok(s.db.docs[`shopDaily/${today()}`].alerts['gate-card'].sentAt)
})

test('гейт: всё готово, продажи выключены, карта выключена: алерта нет; нет ФОП в настройках: алерт', async () => {
  const broken = { 'fopSecrets/fop-2': fopSecret({ monoAcquire: {} }) }
  const docsList = [
    baseDocs(),
    { ...baseDocs(broken), 'system/shopSales': sales({ mode: 'off' }) },
    { ...baseDocs(broken), 'system/shopSales': sales({ mode: 'prices' }) },
    { ...baseDocs(broken), 'system/shopSales': sales({ methods: { card: false } }) },
    { 'fops/fop-2': fopMeta() },
  ]
  for (const docs of docsList) {
    const s = await stand(docs)
    await s.step()
    assert.deepEqual(s.calls.alerts, [], JSON.stringify(docs['system/shopSales']))
  }
  const s = await stand({ 'system/shopSales': sales({ fopId: '' }) })
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  assert.match(s.calls.alerts[0], /fop/)
})

test('гейт: метка стоит и без доставки, счётчики дня целы', async () => {
  const s = await stand(baseDocs({ 'fopSecrets/fop-2': fopSecret({ monoAcquire: {} }), [`shopDaily/${today()}`]: { unpaid: 3 } }), { notify: async () => false })
  await s.step()
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  const day = s.db.docs[`shopDaily/${today()}`]
  assert.equal(day.unpaid, 3)
  assert.match(day.alerts['gate-card'].text, /monoAcquire\.token/)
  assert.equal(day.alerts['gate-card'].sentAt, null)
})

test('гейт: проверяется в часовом проходе, а не каждые 3 минуты', async () => {
  const s = await stand({ ...baseDocs(), 'fopSecrets/fop-2': fopSecret({ monoAcquire: {} }) }, { slowScanMs: HOUR })
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
  delete s.db.docs[`shopDaily/${today()}`]
  await s.step()
  assert.equal(s.calls.alerts.length, 1)
})

// ---------- проход целиком ----------

test('проход: сбой одного заказа не мешает другому; сбой чтения состояния не мешает остальным', async () => {
  const s = await stand(baseDocs({
    'shopOrders/so-1': awaiting({ paymentIds: ['pay-1'] }),
    'shopOrders/so-2': awaiting({ paymentIds: ['pay-2'] }),
    'payments/pay-1': invoice({ shopOrderId: 'so-1' }),
    'payments/pay-2': invoice({ orderId: 'pay-2', providerOrderId: 'inv-2', shopOrderId: 'so-2' }),
    'shopOrders/so-3': paidOrder({ state: 'refused', paidPaymentId: 'pay-x', history: [{ at: ago(21 * DAY), to: 'refused' }] }),
  }))
  s.db.failRead = (path) => path === 'payments/pay-1' || path === 'payments/pay-x'
  await s.step()
  assert.deepEqual(s.bank.statusCalls, ['inv-2'])
  assert.deepEqual(alertKinds(s, 'so-3'), ['refund-day-20'], 'следующие части того же заказа тоже идут')

  const q = await stand(docsOf(paidOrder({ alerts: {}, sms: {} }), paidInvoice({ taxUrl: null, receiptStatus: 'CREATED' })))
  q.db.failRead = (path) => path === 'shopOrders?state=awaiting_payment'
  await q.step()
  assert.ok(q.order().alerts['new-paid'], 'оплаченные всё равно обработаны')
  assert.ok(logs.some((l) => l.includes('читання awaiting_payment')))
})

test('проход: второй одновременный проход на экземпляре сразу выходит; после ошибки следующий идёт', async () => {
  const gate = held()
  const s = await stand(docsOf(awaiting({ paymentIds: ['pay-1'] })))
  s.bank.onStatus = () => gate.gate
  const first = s.step()
  await until(() => s.bank.statusCalls.length === 1, 'первый проход у банка')
  const reads = s.db.reads.length
  assert.deepEqual(await s.step(), { checked: 0 })
  assert.equal(s.db.reads.length, reads, 'второй проход даже базу не читает')
  assert.equal(s.bank.statusCalls.length, 1)
  gate.release()
  assert.deepEqual(await first, { checked: 1 })
  s.bank.onStatus = null
  s.patchOrder({ invoicesCheckedAt: ago(3 * MIN) })
  assert.deepEqual(await s.step(), { checked: 1 })
})

test('проход: конечные состояния читаются раз в заданный срок, горячие на каждом проходе', async () => {
  const s = await stand(baseDocs(), { slowScanMs: HOUR })
  await s.step()
  const slowReads = () => s.db.reads.filter((r) => r === 'shopOrders?state=delivered').length
  const hotReads = () => s.db.reads.filter((r) => r === 'shopOrders?state=paid').length
  assert.equal(slowReads(), 1)
  await s.step()
  assert.equal(slowReads(), 1)
  assert.equal(hotReads(), 2)
})

test('журнал и алерты: нет данных покупателя и токена статуса ни на каких путях', async () => {
  const before = logs.length
  const client = []
  const docs = baseDocs({
    'shopOrders/so-1': paidOrder({ sms: {}, alerts: {}, paidAt: ago(HOUR), history: [{ at: ago(3 * DAY), to: 'paid' }] }),
    'shopOrders/so-2': shippedOrder({ paidPaymentId: 'pay-2', npCheckedAt: ago(DAY + HOUR), shippedAt: ago(46 * DAY) }),
    'shopOrders/so-3': shippedOrder({ ttn: '3', paidPaymentId: 'pay-3', npCheckedAt: ago(HOUR) }),
    'payments/pay-1': paidInvoice({ receiptStatus: 'ERROR', taxUrl: null, shopOrderId: 'so-1' }),
    'payments/pay-2': paidInvoice({ orderId: 'pay-2', taxUrl: null, receiptStatus: 'CREATED', providerOrderId: 'inv-2', shopOrderId: 'so-2' }),
    'payments/pay-3': paidInvoice({ orderId: 'pay-3', taxUrl: null, receiptStatus: 'CREATED', providerOrderId: 'inv-3', shopOrderId: 'so-3' }),
  })
  const s = await stand(docs, { notify: async () => false, client: async (a) => { client.push(a.journal.text); return { status: 'failed' } }, np: npSays({ 3: { StatusCode: '102' } }) })
  await s.step()
  assert.ok(s.calls.alerts.length >= 5, String(s.calls.alerts.length))
  const text = [...logs.slice(before), ...s.calls.alerts, ...s.calls.sms.map((c) => c.text), ...client].join('\n')
  for (const bad of [PHONE, 'Шевченко', 'Тарас', 'Григорович', 'taras@example.com', 'Умань', 'Відділення №77', STATUS_TOKEN, 'NP-KEY', 'SECRET']) assert.ok(!text.includes(bad), bad)
})

test('index.js: шаг магазина подключён к сверке; хуки получили notifyClient и sendSms', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const hooks = src.indexOf('createShopPaymentHooks({ adminDb, payments: paymentsApi, siteUrl: SITE_URL, notifyClient, sendSms })')
  const step = src.indexOf('paymentsApi.addReconcileStep(createShopReconcile({ adminDb, payments: paymentsApi, hooks: shopHooks, siteUrl: SITE_URL }).step)')
  assert.ok(hooks > 0)
  assert.ok(step > hooks)
  assert.ok(src.indexOf('const { notifyClient } = registerNotifications(') < hooks)
  assert.ok(src.indexOf('const sendSms = ') < hooks)
  assert.ok(step < src.indexOf('jsonServer.router('))
})
