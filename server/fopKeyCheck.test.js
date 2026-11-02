// node --test: перевірка ключів ФОП без грошей — без мережі і Firebase, відповіді провайдерів підмінені.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { checkFopKeys, checkLiqpay, checkMonoAcquire, checkNovaPoshta } from './fopKeyCheck.js'
import { registerFopsAdmin } from './fopsAdmin.js'
import { loadFopFresh } from './fops.js'

const SECRETS = { pub: 'PUB-SECRET-VALUE', priv: 'PRIV-SECRET-VALUE', token: 'MONO-SECRET-VALUE', np: 'NP-SECRET-VALUE' }
const fullFop = (over = {}) => ({
  id: 'f1', name: 'ФОП', methods: { liqpayCard: true, monoAcquire: true, cod: true },
  liqpay: { publicKey: SECRETS.pub, privateKey: SECRETS.priv },
  monoAcquire: { token: SECRETS.token },
  novaPoshta: { apiKey: SECRETS.np, senderRef: 'sender-1', contactRef: 'c', senderPhone: '380', cityRef: 'k', warehouseRef: 'w' },
  ...over,
})
const npOk = (options = [{ CanAfterpaymentOnGoodsCost: true }]) => async (_k, _m, method) => (method === 'getCounterparties'
  ? { success: true, data: [{ Ref: 'sender-1' }] }
  : { success: true, data: options })
const httpErr = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })

test('LiqPay: зелений вердикт лише на підтверджений код', async () => {
  const lp = (r) => async () => r
  assert.equal((await checkLiqpay(fullFop(), lp({ err_code: 'payment_not_found' }))).status, 'ok')
  assert.equal((await checkLiqpay(fullFop(), lp({ err_code: 'public_key_not_found' }))).status, 'bad')
  assert.equal((await checkLiqpay(fullFop(), lp({ err_code: 'invalid_signature' }))).status, 'bad')
  const other = await checkLiqpay(fullFop(), lp({ err_code: 'err_access' }))
  assert.equal(other.status, 'unknown')
  assert.match(other.message, /err_access/)
  assert.equal((await checkLiqpay(fullFop(), lp(null))).status, 'unknown')
  assert.equal((await checkLiqpay(fullFop(), lp('<html>'))).status, 'unknown')
  assert.equal((await checkLiqpay(fullFop(), lp({ status: 'success' }))).status, 'unknown')
})

test('LiqPay: без ключів провайдера не викликаємо', async () => {
  const boom = async () => { throw new Error('не мав викликатись') }
  assert.equal((await checkLiqpay(fullFop({ liqpay: undefined }), boom)).status, 'none')
  assert.equal((await checkLiqpay(fullFop({ liqpay: { privateKey: 'x' } }), boom)).status, 'bad')
  assert.equal((await checkLiqpay(fullFop({ liqpay: { publicKey: 'x' } }), boom)).status, 'bad')
})

test('monobank: показує чий кабінет, 403 — поганий токен, збій мережі — невідомо', async () => {
  const ok = await checkMonoAcquire(fullFop(), async () => ({ merchantId: 'm', merchantName: 'ФОП Тест', edrpou: '123' }))
  assert.equal(ok.status, 'ok')
  assert.equal(ok.merchantName, 'ФОП Тест')
  assert.equal(ok.edrpou, '123')
  assert.equal(ok.merchantId, undefined)
  assert.equal((await checkMonoAcquire(fullFop(), async () => { throw httpErr(403) })).status, 'bad')
  assert.equal((await checkMonoAcquire(fullFop(), async () => { throw httpErr(500) })).status, 'unknown')
  assert.equal((await checkMonoAcquire(fullFop(), async () => { throw new Error('timeout') })).status, 'unknown')
  assert.equal((await checkMonoAcquire(fullFop({ monoAcquire: undefined }))).status, 'none')
})

test('ключ годиться, але клієнтам спосіб не пропонується — називаємо, який саме', async () => {
  const off = fullFop({ methods: { liqpayCard: false, liqpayPaypart: false, monoAcquire: false, cod: false } })
  const lpOk = async () => ({ err_code: 'payment_not_found' })
  assert.match((await checkLiqpay(off, lpOk)).note, /LiqPay вимкнено/)
  assert.match((await checkMonoAcquire(off, async () => ({ merchantName: 'x' }))).note, /monobank вимкнено/)
  assert.match((await checkNovaPoshta(off, npOk())).note, /Накладений платіж вимкнено/)
  assert.equal((await checkMonoAcquire(fullFop(), async () => ({ merchantName: 'x' }))).note, undefined)
  // картою вимкнено, частинами увімкнено: LiqPay клієнтам усе ще пропонується
  assert.equal((await checkLiqpay(fullFop({ methods: { liqpayCard: false, liqpayPaypart: true } }), lpOk)).note, undefined)
  // вимкнений ФОП: жоден спосіб не пропонується, хоч перемикачі й увімкнені
  assert.match((await checkLiqpay(fullFop({ active: false }), lpOk)).note, /нові оплати на нього не проходять/)
  // галочка не забороняє оплату: окно не обіцяє, що клієнт цього способу не побачить
  assert.match((await checkLiqpay(off, lpOk)).note, /все одно можуть його пропонувати/)
  // ТТН і наложка на вимкненому ФОП створюються, тож про заборону не пишемо
  assert.match((await checkNovaPoshta(fullFop({ active: false }), npOk())).note, /все одно створюються/)
})

test('LiqPay: тестовий ключ — червоний, запит не йде', async () => {
  const boom = async () => { throw new Error('не мав викликатись') }
  const r = await checkLiqpay(fullFop({ liqpay: { publicKey: 'sandbox_i1', privateKey: 'sandbox_x' } }), boom)
  assert.equal(r.status, 'bad')
  assert.match(r.message, /sandbox/)
})

test('monobank: незрозуміла відповідь і символи в токені не дають хибних вердиктів', async () => {
  assert.equal((await checkMonoAcquire(fullFop(), async () => ({}))).status, 'unknown')
  assert.equal((await checkMonoAcquire(fullFop(), async () => '<html>')).status, 'unknown')
  assert.equal((await checkMonoAcquire(fullFop(), async () => ({ merchantId: 'm' }))).status, 'unknown')
  const codeOnly = await checkMonoAcquire(fullFop(), async () => ({ merchantId: 'm', merchantName: '', edrpou: '123' }))
  assert.equal(codeOnly.status, 'ok')
  assert.equal(codeOnly.edrpou, '123')
  const boom = async () => { throw new Error('не мав викликатись') }
  for (const token of ['токен', 'ab\ncd', 'ab cd']) {
    const r = await checkMonoAcquire(fullFop({ monoAcquire: { token } }), boom)
    assert.equal(r.status, 'bad', token)
    assert.match(r.message, /зайві символи/)
  }
  assert.equal((await checkMonoAcquire(fullFop(), async () => { throw httpErr(401) })).status, 'bad')
  assert.match((await checkMonoAcquire(fullFop(), async () => { throw httpErr(429) })).message, /429/)
})

test('Нова Пошта: ключ, поля відправника, сам відправник і контроль оплати', async () => {
  assert.equal((await checkNovaPoshta(fullFop({ novaPoshta: {} }))).status, 'none')
  const npFor = (over) => fullFop({ novaPoshta: { ...fullFop().novaPoshta, ...over } })
  const bad = await checkNovaPoshta(fullFop(), async () => ({ success: false, errors: ['API key expired'] }))
  assert.equal(bad.status, 'bad')
  assert.match(bad.message, /API key expired/)
  // збій сервісу не видаємо за поганий ключ: власник не має міняти робочий ключ
  assert.equal((await checkNovaPoshta(fullFop(), async () => ({ success: false, errors: ['Internal error'] }))).status, 'unknown')
  assert.equal((await checkNovaPoshta(fullFop(), async () => '<html>')).status, 'unknown')
  assert.equal((await checkNovaPoshta(fullFop(), async () => null)).status, 'unknown')
  assert.equal((await checkNovaPoshta(fullFop(), async () => ({ success: true, data: {} }))).status, 'unknown')
  // значення ключа в тексті помилки НП маскуємо
  const echoed = await checkNovaPoshta(fullFop(), async () => ({ success: false, errors: [`API key ${SECRETS.np} expired`] }))
  assert.ok(!echoed.message.includes(SECRETS.np))
  // неповний відправник: ТТН відмовить, зеленого бути не може
  for (const [field, word] of [['senderRef', 'відправник'], ['contactRef', 'контактна особа'], ['senderPhone', 'телефон'], ['cityRef', 'місто'], ['warehouseRef', 'відділення']]) {
    const r = await checkNovaPoshta(npFor({ [field]: '' }), npOk())
    assert.equal(r.status, 'bad', field)
    assert.ok(r.message.includes(word), field)
  }
  const foreign = await checkNovaPoshta(npFor({ senderRef: 'чужий' }), npOk())
  assert.equal(foreign.status, 'bad')
  assert.match(foreign.message, /не з цього кабінету/)
  assert.equal((await checkNovaPoshta(fullFop(), npOk())).paymentControl, true)
  assert.equal((await checkNovaPoshta(fullFop(), npOk([{ CanAfterpaymentOnGoodsCost: false }]))).paymentControl, false)
  assert.equal((await checkNovaPoshta(fullFop(), npOk([{}]))).paymentControl, null)
  assert.equal((await checkNovaPoshta(fullFop(), async () => { throw new Error('timeout') })).status, 'unknown')
  const optsFail = await checkNovaPoshta(fullFop(), async (_k, _m, method) => {
    if (method === 'getCounterparties') return { success: true, data: [{ Ref: 'sender-1' }] }
    throw new Error('timeout')
  })
  assert.equal(optsFail.status, 'ok')
  assert.equal(optsFail.paymentControl, null)
})

test('значення ключів не потрапляють у відповідь', async () => {
  const r = await checkFopKeys(fullFop(), {
    liqpayStatus: async () => ({ err_code: 'payment_not_found' }),
    monoDetails: async () => ({ merchantName: 'ФОП', edrpou: '1' }),
    np: npOk(),
  })
  const json = JSON.stringify(r)
  for (const v of Object.values(SECRETS)) assert.ok(!json.includes(v), `витік ${v}`)
  assert.deepEqual(Object.keys(r).sort(), ['liqpay', 'monoAcquire', 'novaPoshta'])
})

// ---------- маршрут ----------
const startApp = async (deps) => {
  const app = express()
  app.use(express.json())
  registerFopsAdmin(app, deps)
  const srv = await new Promise((ok) => { const s = app.listen(0, () => ok(s)) })
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

test('маршрут: без входу 403 і провайдерів не чіпає', async (t) => {
  let called = 0
  const a = await startApp({ adminDb: {}, checkKeys: async () => { called += 1; return {} }, loadFop: async () => fullFop() })
  t.after(a.close)
  const r = await fetch(`${a.url}/api/fops/admin/f1/check-keys`, { method: 'POST' })
  assert.equal(r.status, 403)
  assert.equal(called, 0)
})

test('маршрут: власник отримує вердикти, невідомий ФОП — 404, збій читання — 500 без вердикту', async (t) => {
  const a = await startApp({
    adminDb: {}, verifyAdmin: async () => true,
    loadFop: async (_db, id) => (id === 'f1' ? fullFop() : null),
    checkKeys: async () => ({ liqpay: { status: 'ok', message: 'm' } }),
  })
  t.after(a.close)
  const ok = await fetch(`${a.url}/api/fops/admin/f1/check-keys`, { method: 'POST' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).data.liqpay.status, 'ok')
  assert.equal((await fetch(`${a.url}/api/fops/admin/nope/check-keys`, { method: 'POST' })).status, 404)

  let checked = 0
  const failing = await startApp({
    adminDb: {}, verifyAdmin: async () => true,
    loadFop: async () => { throw new Error('firestore down') },
    checkKeys: async () => { checked += 1; return {} },
  })
  t.after(failing.close)
  assert.equal((await fetch(`${failing.url}/api/fops/admin/f1/check-keys`, { method: 'POST' })).status, 500)
  assert.equal(checked, 0)
})

test('loadFopFresh: збирає мету і ключі, не ковтає помилку Firestore', async () => {
  const dbOf = (docs) => ({ collection: (c) => ({ doc: (id) => ({ get: async () => {
    if (docs === 'fail') throw new Error('firestore down')
    const d = docs[`${c}/${id}`]
    return { exists: !!d, data: () => d }
  } }) }) })
  const fop = await loadFopFresh(dbOf({
    'fops/f1': { name: 'Н', active: false, methods: { cod: true }, novaPoshta: { senderRef: 's' } },
    'fopSecrets/f1': { novaPoshta: { apiKey: 'k' }, monoAcquire: { token: 't' } },
  }), 'f1')
  assert.equal(fop.name, 'Н')
  assert.equal(fop.active, false)
  assert.deepEqual(fop.novaPoshta, { senderRef: 's', apiKey: 'k' })
  assert.equal(fop.monoAcquire.token, 't')
  // ключі ще не задавали
  const noSecrets = await loadFopFresh(dbOf({ 'fops/f2': { name: 'Б' } }), 'f2')
  assert.equal(noSecrets.liqpay, undefined)
  // документа немає: кеш (тут порожній)
  assert.equal(await loadFopFresh(dbOf({}), 'nope'), null)
  await assert.rejects(() => loadFopFresh(dbOf('fail'), 'f1'), /firestore down/)
})
