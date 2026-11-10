// node --test: «Тестовий чек» на /fops — продаж і одразу повернення; тіло чека повернення для Checkbox.
// Без мережі: Checkbox підмінений локальним сервером на 127.0.0.1, маршрут — підставленими функціями.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

// Адресу фальшивого Checkbox задаємо ДО імпорту checkbox.js: BASE читається під час завантаження модуля.
const fake = { posts: [], signins: 0, opens: 0, shiftQueue: [] }
const cbApp = express()
cbApp.use(express.json())
cbApp.post('/api/v1/cashier/signinPinCode', (_req, res) => { fake.signins += 1; res.json({ access_token: `tok-${fake.signins}` }) })
// Стан зміни по черзі з shiftQueue, далі — відкрита.
cbApp.get('/api/v1/cashier/shift', (_req, res) => res.json({ status: fake.shiftQueue.shift() || 'OPENED' }))
cbApp.post('/api/v1/shifts', (_req, res) => { fake.opens += 1; res.status(202).json({ status: 'OPENING' }) })
cbApp.post('/api/v1/receipts/sell', (req, res) => {
  fake.posts.push({ body: req.body, headers: req.headers })
  res.status(201).json({ id: req.body.id, status: 'CREATED' })
})
const cbSrv = await new Promise((ok) => { const s = cbApp.listen(0, '127.0.0.1', () => ok(s)) })
after(() => cbSrv.close())
process.env.CHECKBOX_BASE_URL = `http://127.0.0.1:${cbSrv.address().port}`
const { sellReceipt, returnReceipt } = await import('./checkbox.js')
const { registerFopsAdmin } = await import('./fopsAdmin.js')

const GOODS = [{ name: 'Ремонт (тестовий чек)', price: 10, qty: 1, code: 'TEST-REPAIR' }]

test('чек повернення: ті самі позиції з is_return, та сама сума тим самим способом, посилання на продаж', async () => {
  const fop = { id: 'f-return', name: 'ФОП', checkbox: { licenseKey: 'LK', pinCode: '1' } }
  await sellReceipt(fop, { goods: GOODS, paymentLabel: 'Оплата (тест)' })
  const sale = fake.posts.at(-1).body
  const r = await returnReceipt(fop, { goods: GOODS, paymentLabel: 'Повернення (тест)', relatedReceiptId: sale.id })
  const ret = fake.posts.at(-1).body
  assert.equal(ret.related_receipt_id, sale.id)
  assert.notEqual(ret.id, sale.id)
  assert.deepEqual(ret.goods.map((g) => g.is_return), [true])
  assert.equal(sale.goods[0].is_return, undefined) // продаж лишився продажем
  assert.equal(sale.related_receipt_id, undefined)
  assert.deepEqual(ret.goods[0].good, sale.goods[0].good)
  assert.equal(ret.goods[0].quantity, 1000)
  assert.deepEqual(ret.payments, [{ type: 'CASHLESS', value: 1000, label: 'Повернення (тест)' }])
  assert.equal(r.receiptId, ret.id)
  assert.equal(fake.posts.at(-1).headers['x-license-key'], 'LK')
  await assert.rejects(() => returnReceipt(fop, { goods: GOODS }), /id чека продажи/)
})

test('токен каси привʼязаний до ключа: інший ключ — новий вхід, а не чужий токен', async () => {
  const before = fake.signins
  const fop = (licenseKey) => ({ id: 'f-token', name: 'ФОП', checkbox: { licenseKey, pinCode: '1' } })
  await sellReceipt(fop('KEY-A'), { goods: GOODS })
  await sellReceipt(fop('KEY-A'), { goods: GOODS })
  assert.equal(fake.signins - before, 1)
  await sellReceipt(fop('KEY-B'), { goods: GOODS })
  assert.equal(fake.signins - before, 2)
  assert.equal(fake.posts.at(-1).headers['x-license-key'], 'KEY-B')
  assert.equal(fake.posts.at(-1).headers.authorization, `Bearer tok-${fake.signins}`)
  await sellReceipt(fop('KEY-A'), { goods: GOODS })
  assert.equal(fake.signins - before, 3)
})

test('зміна вже відкривається — другий запит на відкриття не шлемо, лише чекаємо', async () => {
  fake.shiftQueue = ['OPENING', 'OPENED']
  const opens = fake.opens
  await sellReceipt({ id: 'f-opening', name: 'ФОП', checkbox: { licenseKey: 'LK2', pinCode: '1' } }, { goods: GOODS })
  assert.equal(fake.opens, opens)
  fake.shiftQueue = ['CLOSED', 'OPENED']
  await sellReceipt({ id: 'f-closed', name: 'ФОП', checkbox: { licenseKey: 'LK3', pinCode: '1' } }, { goods: GOODS })
  assert.equal(fake.opens, opens + 1)
})

// ---------- маршрут ----------
const FOP = { id: 'f1', name: 'ФОП', checkbox: { licenseKey: 'LK', pinCode: '1' } }
const httpErrBody = (status, data) => Object.assign(new Error(`status ${status}`), { response: { status, data } })

// Статуси, які по черзі віддає getReceipt для кожного чека; далі — CREATED.
const stub = ({ saleStatus = 'CREATED', saleNext = ['DONE'], retStatus = 'CREATED', retNext = ['DONE'], sellError, returnError } = {}) => {
  const log = []
  const queue = { sale: [...saleNext], ret: [...retNext] }
  const done = (id, status) => ({ receiptId: id, status, fiscalCode: status === 'DONE' ? `FC-${id}` : null, taxUrl: status === 'DONE' ? `https://check.test/${id}` : null })
  return {
    log,
    receipts: {
      signin: async () => { log.push('signin') },
      sellReceipt: async (_f, args) => {
        log.push(`sell:${args.paymentLabel}`)
        if (sellError) throw sellError
        return done('sale', saleStatus)
      },
      returnReceipt: async (_f, args) => {
        log.push(`return:${args.relatedReceiptId}:${args.paymentLabel}`)
        assert.deepEqual(args.goods, GOODS)
        if (returnError) throw returnError
        return done('ret', retStatus)
      },
      getReceipt: async (_f, id) => {
        log.push(`get:${id}`)
        return done(id, queue[id].shift() ?? 'CREATED')
      },
    },
  }
}

const startApp = async (deps) => {
  const app = express()
  app.use(express.json())
  registerFopsAdmin(app, { adminDb: {}, verifyAdmin: async () => true, loadFop: async (_db, id) => (id === 'f1' ? FOP : null), sleep: async () => {}, ...deps })
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}
const post = async (a, id = 'f1') => {
  const r = await fetch(`${a.url}/api/fops/admin/${id}/test-receipt`, { method: 'POST' })
  return { status: r.status, body: await r.json() }
}

test('тестовий чек: продаж, очікування реєстрації, повернення до цього продажу', async (t) => {
  const s = stub()
  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  const { status, body } = await post(a)
  assert.equal(status, 200)
  assert.equal(body.data.status, 'DONE')
  assert.equal(body.data.fiscalCode, 'FC-sale')
  assert.equal(body.data.refund.status, 'DONE')
  assert.equal(body.data.refund.fiscalCode, 'FC-ret')
  assert.equal(body.data.refund.taxUrl, 'https://check.test/ret')
  // свіжий вхід перед продажем; повернення — до щойно створеного продажу
  assert.deepEqual(s.log, ['signin', 'sell:Оплата (тест)', 'get:sale', 'return:sale:Повернення (тест)', 'get:ret'])
})

test('тестовий чек: продаж не зареєстровано — повертати нічого', async (t) => {
  const s = stub({ saleNext: ['ERROR'] })
  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  const { status, body } = await post(a)
  assert.equal(status, 200)
  assert.equal(body.data.status, 'ERROR')
  assert.deepEqual(body.data.refund, { skipped: 'not_registered' })
  assert.ok(!s.log.some((l) => l.startsWith('return')))
})

test('тестовий чек: ДПС довго не приймає продаж — чекаємо обмежено, повернення не створюємо', async (t) => {
  let slept = 0
  const s = stub({ saleNext: [] })
  const a = await startApp({ receipts: s.receipts, sleep: async () => { slept += 1 } })
  t.after(a.close)
  const { status, body } = await post(a)
  assert.equal(status, 200)
  assert.equal(body.data.status, 'CREATED')
  assert.deepEqual(body.data.refund, { skipped: 'sale_pending' })
  assert.equal(s.log.filter((l) => l === 'get:sale').length, 13)
  assert.equal(slept, 13)
  assert.ok(!s.log.some((l) => l.startsWith('return')))
})

test('тестовий чек: повернення ще реєструється — показуємо як є', async (t) => {
  const s = stub({ retNext: [] })
  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  const { body } = await post(a)
  assert.equal(body.data.status, 'DONE')
  assert.equal(body.data.refund.receiptId, 'ret')
  assert.equal(body.data.refund.status, 'CREATED')
})

test('тестовий чек: повернення не вдалося — продаж показуємо, причину повернення теж', async (t) => {
  const s = stub({ returnError: httpErrBody(422, { message: 'Чек не знайдено' }) })
  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  const { status, body } = await post(a)
  assert.equal(status, 200)
  assert.equal(body.data.fiscalCode, 'FC-sale')
  assert.equal(body.data.refund.error, 'Checkbox: Чек не знайдено')
})

test('тестовий чек: невірний ключ каси — 502 з текстом Checkbox, повернення не пробуємо', async (t) => {
  const s = stub({ sellError: httpErrBody(403, { code: 'cash_register.invalid_license_key', message: 'Невірний ключ ліцензії каси' }) })
  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  const { status, body } = await post(a)
  assert.equal(status, 502)
  // людині — текст Checkbox, у дужках — код, а не сирий JSON
  assert.equal(body.error.message, 'Checkbox: Невірний ключ ліцензії каси (cash_register.invalid_license_key)')
  assert.ok(!s.log.some((l) => l.startsWith('return')))
})

test('тестовий чек: без входу 403, без каси 400, невідомий ФОП 404, збій читання 500 — касу не чіпаємо', async (t) => {
  const s = stub()
  const anon = await startApp({ receipts: s.receipts, verifyAdmin: undefined })
  t.after(anon.close)
  assert.equal((await post(anon)).status, 403)

  const noCash = await startApp({ receipts: s.receipts, loadFop: async () => ({ id: 'f1', name: 'ФОП', checkbox: { pinCode: '1' } }) })
  t.after(noCash.close)
  assert.equal((await post(noCash)).status, 400)

  const a = await startApp({ receipts: s.receipts })
  t.after(a.close)
  assert.equal((await post(a, 'nope')).status, 404)

  const failing = await startApp({ receipts: s.receipts, loadFop: async () => { throw new Error('firestore down') } })
  t.after(failing.close)
  assert.equal((await post(failing)).status, 500)
  assert.deepEqual(s.log, [])
})
