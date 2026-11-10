// node --test: перевірка ключів ФОП без грошей — без мережі і Firebase, відповіді провайдерів підмінені.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { checkFopKeys, checkLiqpay, checkMonoAcquire, checkMonoChast, checkCheckbox, checkNovaPoshta } from './fopKeyCheck.js'
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
  const r = await checkFopKeys(withAllKeys(), {
    liqpayStatus: async () => ({ err_code: 'payment_not_found' }),
    monoDetails: async () => ({ merchantName: 'ФОП', edrpou: '1' }),
    monoReport: async () => ({ orders: [] }),
    checkbox: cbIo(),
    np: npOk(),
  })
  const json = JSON.stringify(r)
  for (const v of Object.values(ALL_SECRETS)) assert.ok(!json.includes(v), `витік ${v}`)
  assert.deepEqual(Object.keys(r).sort(), ['checkbox', 'liqpay', 'monoAcquire', 'monoChast', 'novaPoshta'])
})

// ---------- monobank Частини ----------
const MC = { storeId: 'store-1', storeSecret: 'MC-SECRET-VALUE' }
const chastFop = (over = {}) => fullFop({ methods: { ...fullFop().methods, monoChast: true }, monoChast: MC, ...over })
const httpErrBody = (status, data) => Object.assign(httpErr(status), { response: { status, data } })

test('monobank Частини: звіт магазину — зелений, 401 розрізняє чужий store id і невірний secret', async () => {
  let asked
  const ok = await checkMonoChast(chastFop(), async (_f, date) => { asked = date; return { orders: [] } }, () => new Date('2026-11-10T23:30:00Z'))
  assert.equal(ok.status, 'ok')
  assert.equal(asked, '2026-11-11') // дата за Києвом, не за UTC
  assert.equal(ok.note, undefined)
  const sig = await checkMonoChast(chastFop(), async () => { throw httpErrBody(401, { message: 'Signature is not valid' }) })
  assert.equal(sig.status, 'bad')
  assert.match(sig.message, /secret не підходить/)
  const store = await checkMonoChast(chastFop(), async () => { throw httpErrBody(401, { message: 'Signature data for store [x] not found' }) })
  assert.equal(store.status, 'bad')
  assert.match(store.message, /не знає цей store id/)
  // збій банку — не поганий ключ
  assert.equal((await checkMonoChast(chastFop(), async () => { throw httpErr(500) })).status, 'unknown')
  assert.match((await checkMonoChast(chastFop(), async () => { throw httpErr(400) })).message, /400/)
  assert.equal((await checkMonoChast(chastFop(), async () => { throw new Error('timeout') })).status, 'unknown')
  assert.equal((await checkMonoChast(chastFop(), async () => '<html>')).status, 'unknown')
  assert.equal((await checkMonoChast(chastFop(), async () => [])).status, 'unknown')
  // спосіб вимкнено у формі — ключ годиться, але кажемо про це
  assert.match((await checkMonoChast(chastFop({ methods: { monoChast: false } }), async () => ({}))).note, /частинами monobank вимкнено/)
})

test('monobank Частини: без ключів або з поганим store id банк не питаємо', async () => {
  const boom = async () => { throw new Error('не мав викликатись') }
  assert.equal((await checkMonoChast(fullFop(), boom)).status, 'none')
  assert.match((await checkMonoChast(fullFop({ monoChast: { storeSecret: 'x' } }), boom)).message, /store id/)
  assert.match((await checkMonoChast(fullFop({ monoChast: { storeId: 'x' } }), boom)).message, /store secret/)
  for (const storeId of ['магазин', 'a b', 'a\nb']) {
    assert.match((await checkMonoChast(fullFop({ monoChast: { storeId, storeSecret: 's' } }), boom)).message, /зайві символи/, storeId)
  }
})

// ---------- Checkbox ----------
const CB = { licenseKey: 'CB-LICENSE-VALUE', pinCode: '98765', cashierName: 'Касир' }
const cbFop = (over = {}) => fullFop({ checkbox: { ...CB }, ...over })
const REGISTER = { title: 'Каса 1', fiscal_number: '4000123456', address: 'Київ', is_test: false }
const CASHIER = { full_name: 'Іваненко Іван', blocked: null, is_test: false, signature_type: 'CLOUD_SIGNATURE', certificate_end: '2027-06-01T00:00:00Z', organization: { title: 'ФОП Іваненко', edrpou: '1234567890', subscription_exp: '2027-01-01' } }
const cbIo = (over = {}) => ({
  register: async () => REGISTER,
  signIn: async () => 'token',
  me: async () => CASHIER,
  signature: async () => ({ online: true, type: 'CLOUD_SIGNATURE', shift_open_possibility: true }),
  shift: async () => ({ status: 'OPENED' }),
  billing: async () => ({ status: 'ACTIVE', date_to_block: null, units: 3 }),
  ...over,
})
const NOW = () => new Date('2026-11-10T12:00:00Z')
const ALL_SECRETS = { ...SECRETS, mc: MC.storeSecret, cb: CB.licenseKey, pin: CB.pinCode }
const withAllKeys = () => chastFop({ checkbox: { ...CB } })

test('Checkbox: каса, касир, підпис і зміна — зелений, з даними для звірки', async () => {
  const r = await checkCheckbox(cbFop(), cbIo(), NOW)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.cashRegister, { title: 'Каса 1', fiscalNumber: '4000123456', address: 'Київ' })
  assert.equal(r.cashierName, 'Іваненко Іван')
  assert.equal(r.merchantName, 'ФОП Іваненко')
  assert.equal(r.edrpou, '1234567890')
  assert.equal(r.shift, 'OPENED')
  assert.equal(r.note, undefined)
  // зміни немає: порожнє тіло — не збій
  assert.equal((await checkCheckbox(cbFop(), cbIo({ shift: async () => '' }), NOW)).shift, 'NONE')
  // стан зміни не прочитали — вердикт той самий, зміна невідома
  const noShift = await checkCheckbox(cbFop(), cbIo({ shift: async () => { throw httpErr(500) } }), NOW)
  assert.equal(noShift.status, 'ok')
  assert.equal(noShift.shift, null)
  // ключ підпису скоро закінчиться
  const soon = await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, certificate_end: '2026-11-20T00:00:00Z' }) }), NOW)
  assert.equal(soon.status, 'ok')
  assert.match(soon.note, /менш ніж за 14 днів/)
})

test('Checkbox: невірний ключ ліцензії — червоний з текстом Checkbox, далі не йдемо', async () => {
  let signed = 0
  const r = await checkCheckbox(cbFop(), cbIo({
    register: async () => { throw httpErrBody(403, { code: 'cash_register.invalid_license_key', message: 'Невірний ключ ліцензії каси' }) },
    signIn: async () => { signed += 1 },
  }), NOW)
  assert.equal(r.status, 'bad')
  assert.equal(r.message, 'Checkbox: Невірний ключ ліцензії каси')
  assert.equal(signed, 0)
  assert.equal((await checkCheckbox(cbFop(), cbIo({ register: async () => { throw httpErr(403) } }), NOW)).message, 'Checkbox не приймає ключ ліцензії каси')
  // збій Checkbox — не поганий ключ
  assert.equal((await checkCheckbox(cbFop(), cbIo({ register: async () => { throw httpErr(502) } }), NOW)).status, 'unknown')
  assert.equal((await checkCheckbox(cbFop(), cbIo({ register: async () => { throw new Error('timeout') } }), NOW)).status, 'unknown')
  assert.equal((await checkCheckbox(cbFop(), cbIo({ register: async () => 'oops' }), NOW)).status, 'unknown')
})

test('Checkbox: тестова каса, невірний PIN, блок, тестовий касир, прострочений ключ підпису — червоні', async () => {
  const testReg = await checkCheckbox(cbFop(), cbIo({ register: async () => ({ ...REGISTER, is_test: true }) }), NOW)
  assert.equal(testReg.status, 'bad')
  assert.match(testReg.message, /тестова каса/)
  const pin = await checkCheckbox(cbFop(), cbIo({ signIn: async () => { throw httpErrBody(403, { message: 'Невірний пін-код' }) } }), NOW)
  assert.equal(pin.status, 'bad')
  assert.equal(pin.message, 'Checkbox: Невірний пін-код')
  assert.equal(pin.cashRegister.fiscalNumber, '4000123456') // каса вже відома: показуємо, яку саме перевіряли
  assert.equal((await checkCheckbox(cbFop(), cbIo({ signIn: async () => { throw httpErr(503) } }), NOW)).status, 'unknown')
  for (const blocked of [true, 'Заблоковано адміністратором']) {
    const r = await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, blocked }) }), NOW)
    assert.equal(r.status, 'bad', String(blocked))
    assert.match(r.message, /заблоковано/)
  }
  assert.equal((await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, blocked: '' }) }), NOW)).status, 'ok')
  assert.match((await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, signature_type: 'TEST' }) }), NOW)).message, /тестовий касир/)
  assert.match((await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, is_test: true }) }), NOW)).message, /тестовий касир/)
  const expired = await checkCheckbox(cbFop(), cbIo({ me: async () => ({ ...CASHIER, certificate_end: '2026-11-01T00:00:00Z' }) }), NOW)
  assert.equal(expired.status, 'bad')
  assert.match(expired.message, /скінчився/)
})

test('Checkbox: підпис касира — не відкрити зміну або не на звʼязку — червоний; відкрита зміна — не привід', async () => {
  const closed = { shift: async () => ({ status: 'CLOSED' }) }
  const cant = await checkCheckbox(cbFop(), cbIo({ ...closed, signature: async () => ({ online: true, shift_open_possibility: false }) }), NOW)
  assert.equal(cant.status, 'bad')
  assert.match(cant.message, /зміну зараз відкрити не можна/)
  // зміна вже відкрита: другу не відкрити, але чеки йдуть
  assert.equal((await checkCheckbox(cbFop(), cbIo({ signature: async () => ({ online: true, shift_open_possibility: false }) }), NOW)).status, 'ok')
  const offline = await checkCheckbox(cbFop(), cbIo({ signature: async () => ({ online: false }) }), NOW)
  assert.equal(offline.status, 'bad')
  assert.match(offline.message, /Підпис касира зараз недоступний/)
  // зміну не прочитали, а відкрити не можна: це може бути й відкрита зміна — не червоний
  const unknownShift = await checkCheckbox(cbFop(), cbIo({ shift: async () => { throw httpErr(500) }, signature: async () => ({ online: true, shift_open_possibility: false }) }), NOW)
  assert.equal(unknownShift.status, 'unknown')
  // профіль або підпис не прочитали — невідомо, а не «все добре»
  assert.equal((await checkCheckbox(cbFop(), cbIo({ signature: async () => { throw httpErr(500) } }), NOW)).status, 'unknown')
  const noMe = await checkCheckbox(cbFop(), cbIo({ me: async () => { throw httpErr(500) } }), NOW)
  assert.equal(noMe.status, 'unknown')
  assert.equal(noMe.cashRegister.title, 'Каса 1')
})

test('Checkbox: без ключа, PIN або з символами в ключі нікуди не ходимо; ключ і PIN не повертаємо', async () => {
  const boom = async () => { throw new Error('не мав викликатись') }
  const io = { register: boom, signIn: boom, me: boom, signature: boom, shift: boom }
  assert.equal((await checkCheckbox(fullFop(), io, NOW)).status, 'none')
  assert.match((await checkCheckbox(fullFop({ checkbox: { pinCode: '1' } }), io, NOW)).message, /ключа ліцензії/)
  assert.match((await checkCheckbox(fullFop({ checkbox: { licenseKey: 'k' } }), io, NOW)).message, /PIN/)
  assert.match((await checkCheckbox(fullFop({ checkbox: { licenseKey: 'ключ', pinCode: '1' } }), io, NOW)).message, /зайві символи/)
  // логін і пароль замість PIN — теж вхід
  assert.equal((await checkCheckbox(fullFop({ checkbox: { licenseKey: 'k', login: 'l', password: 'p' } }), cbIo(), NOW)).status, 'ok')
  // вхід логіном і паролем: пароль у тексті помилки теж маскуємо
  const loginFop = fullFop({ checkbox: { licenseKey: 'k', login: 'cashier', password: 'CB-PASSWORD-VALUE' } })
  const pw = await checkCheckbox(loginFop, cbIo({ signIn: async () => { throw httpErrBody(422, { message: 'bad CB-PASSWORD-VALUE' }) } }), NOW)
  assert.equal(pw.status, 'bad')
  assert.ok(!JSON.stringify(pw).includes('CB-PASSWORD-VALUE'))
  // Checkbox повторив ключ або PIN у тексті помилки — маскуємо
  const echoed = await checkCheckbox(cbFop(), cbIo({ signIn: async () => { throw httpErrBody(403, { message: `ключ ${CB.licenseKey}, pin ${CB.pinCode}` }) } }), NOW)
  assert.ok(!JSON.stringify(echoed).includes(CB.licenseKey))
  assert.ok(!JSON.stringify(echoed).includes(CB.pinCode))
})

// Відповідь Checkbox на продаж у заблоковану касу (знято в бою 2026-11-10, текст скорочено).
const BLOCKED = { code: 'organization.billing_disabled', message: 'Касу заблоковано, необхідно виконати оплату послуг на веб-порталі https://my.checkbox.ua' }

test('Checkbox: каса заблокована за несплату — червоний з текстом Checkbox, звідки б не прийшла відмова', async () => {
  const fromBilling = await checkCheckbox(cbFop(), cbIo({ billing: async () => { throw httpErrBody(403, BLOCKED) } }), NOW)
  assert.equal(fromBilling.status, 'bad')
  assert.match(fromBilling.message, /^Checkbox: Касу заблоковано/)
  assert.match(fromBilling.message, /my\.checkbox\.ua/)
  assert.equal(fromBilling.cashierName, 'Іваненко Іван') // решта даних для звірки лишається
  // той самий код на будь-якому читанні — теж блок, навіть із незвичним HTTP-кодом
  assert.equal((await checkCheckbox(cbFop(), cbIo({ shift: async () => { throw httpErrBody(400, BLOCKED) } }), NOW)).status, 'bad')
  assert.equal((await checkCheckbox(cbFop(), cbIo({ register: async () => { throw httpErrBody(400, BLOCKED) } }), NOW)).status, 'bad')
  assert.equal((await checkCheckbox(cbFop(), cbIo({ signIn: async () => { throw httpErrBody(400, BLOCKED) } }), NOW)).status, 'bad')
})

test('Checkbox: підписка — закінчилась червоний, скоро — попередження, з датою', async () => {
  const meWith = (subscription_exp) => cbIo({ me: async () => ({ ...CASHIER, organization: { ...CASHIER.organization, subscription_exp } }) })
  const expired = await checkCheckbox(cbFop(), meWith('2026-11-09'), NOW)
  assert.equal(expired.status, 'bad')
  assert.match(expired.message, /Підписка Checkbox закінчилась 09\.11\.2026/)
  assert.equal(expired.subscriptionExp, '2026-11-09')
  // останній день підписки — ще можна
  assert.equal((await checkCheckbox(cbFop(), meWith('2026-11-10'), NOW)).status, 'ok')
  const soon = await checkCheckbox(cbFop(), meWith('2026-11-15'), NOW)
  assert.equal(soon.status, 'ok')
  assert.match(soon.note, /Підписка Checkbox закінчується 15\.11\.2026/)
  assert.equal((await checkCheckbox(cbFop(), meWith('2026-12-31'), NOW)).note, undefined)
})

test('Checkbox: дата блокування і статус оплати', async () => {
  const bill = (v) => cbIo({ billing: async () => v })
  const past = await checkCheckbox(cbFop(), bill({ status: 'ACTIVE', date_to_block: '2026-11-01T00:00:00Z' }), NOW)
  assert.equal(past.status, 'bad')
  assert.match(past.message, /заблокував касу 01\.11\.2026/)
  const soon = await checkCheckbox(cbFop(), bill({ status: 'ACTIVE', date_to_block: '2026-11-14T00:00:00Z' }), NOW)
  assert.equal(soon.status, 'ok')
  assert.match(soon.note, /заблокує касу 14\.11\.2026/)
  assert.equal(soon.dateToBlock, '2026-11-14T00:00:00Z')
  for (const status of ['BLOCKED', 'billing_disabled', 'DEBT']) {
    const r = await checkCheckbox(cbFop(), bill({ status }), NOW)
    assert.equal(r.status, 'bad', status)
    assert.equal(r.billingStatus, status)
  }
  // незнайомий статус — показуємо як є, вердикт не псуємо
  const odd = await checkCheckbox(cbFop(), bill({ status: 'TRIAL' }), NOW)
  assert.equal(odd.status, 'ok')
  assert.equal(odd.billingStatus, 'TRIAL')
})

test('Checkbox: стан оплати не прочитали — ключі зелені, але з підказкою перевірити оплату', async () => {
  const noBill = await checkCheckbox(cbFop(), cbIo({ billing: async () => { throw httpErr(500) } }), NOW)
  assert.equal(noBill.status, 'ok') // підписку видно з профілю касира
  assert.equal(noBill.note, undefined)
  const nothing = await checkCheckbox(cbFop(), cbIo({
    billing: async () => { throw httpErr(500) },
    me: async () => ({ ...CASHIER, organization: { title: 'ФОП Іваненко', edrpou: '1234567890' } }),
  }), NOW)
  assert.equal(nothing.status, 'ok')
  assert.match(nothing.note, /не показав стан оплати/)
})

test('звірка: каса Checkbox і кабінет monobank різних осіб — червоний', async () => {
  const io = (monoEdrpou) => ({
    liqpayStatus: async () => ({ err_code: 'payment_not_found' }),
    monoDetails: async () => ({ merchantName: 'ФОП', edrpou: monoEdrpou }),
    monoReport: async () => ({ orders: [] }),
    checkbox: cbIo(),
    np: npOk(),
  })
  const same = await checkFopKeys(withAllKeys(), io('1234567890'))
  assert.equal(same.checkbox.status, 'ok')
  const other = await checkFopKeys(withAllKeys(), io('0987654321'))
  assert.equal(other.checkbox.status, 'bad')
  assert.match(other.checkbox.message, /іншій особі/)
  assert.equal(other.monoAcquire.status, 'ok')
  // monobank не назвав код — звіряти нічим, вердикт каси не чіпаємо
  assert.equal((await checkFopKeys(withAllKeys(), io(''))).checkbox.status, 'ok')
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
