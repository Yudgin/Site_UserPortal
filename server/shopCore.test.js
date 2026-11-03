// node --test: правила магазина (server/shopCore.js) и реквизиты продавца на ФОП через настоящие fopsAdmin.js и loadFopFresh. Без сети и Firebase.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import express from 'express'
import {
  SALES_MODES, SHOP_STATES, STATUS_TOKEN_RE, NP_DELIVERED, NP_GONE, NP_REFUSED, NP_NOT_HANDED, npDateToIso,
  shopPhone, maskPhone, validateOrderInput, orderFingerprint, orderIdFromKey, phoneKeyOf, newStatusToken, phoneCodeHash,
  canTransition, transitionPatch, sellerFilled, publicSeller, npMissing, codPairAllowed, shopSellable,
  pricedItem, skuOnSale, buildCatalogFeed, npOutcome,
} from './shopCore.js'
import { findMaterial } from './siteCatalog.js'
import { npDateToIso as npDateOriginal } from './incomingRefresh.js'
import { registerFopsAdmin } from './fopsAdmin.js'
import { loadFopFresh, refreshFops, getFop, listFopsPublic } from './fops.js'

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex')
const REF_A = '8d5a980d-391c-11dd-90d9-001a92567626'
const REF_B = '1ec09d88-e1c2-11e3-8c4a-0050568002cf'
const CALLBACK = { callbackBaseUrl: 'https://portal.example' }

// ---------- findMaterial (D12) ----------

test('findMaterial: дубль кода и код, отличный только регистром, дают отказ', () => {
  const one = { code: 'V2-LID-R', price: 800 }
  let errors = []
  assert.equal(findMaterial({ materials: [one] }, 'V2-LID-R', errors), one)
  assert.deepEqual(errors, [])

  errors = []
  findMaterial({ materials: [one, { code: 'V2-LID-R', price: 1 }] }, 'V2-LID-R', errors)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /2 материала с кодом V2-LID-R/)

  errors = []
  findMaterial({ materials: [one, { code: ' v2-lid-r ', price: 1 }] }, 'V2-LID-R', errors)
  assert.equal(errors.length, 1)

  errors = []
  assert.equal(findMaterial({ materials: [] }, 'V2-LID-R', errors), null)
  assert.equal(findMaterial(null, 'V2-LID-R', errors), null)
  assert.deepEqual(errors, [])
})

// ---------- вход заказа ----------

const orderBody = (over = {}) => ({
  idempotencyKey: '3f1c2d9e-8a7b-4c6d-9e0f-1a2b3c4d5e6f', sku: 'V2-LID-R', qty: 1, method: 'card',
  lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', phone: '+380671234567', email: 'buyer@example.com',
  cityRef: REF_A, cityName: 'Київ', warehouseRef: REF_B, warehouseName: 'Відділення №1',
  offerVersion: '2026-11-03', consentOffer: true, consentPersonalData: true, expectedTotalUah: 800,
  ...over,
})

test('телефон: только номер Украины, +380 и 9 цифр', () => {
  for (const ok of ['+380671234567', '380671234567', '0671234567', '671234567', '80671234567', '00380671234567', '+38 (067) 123-45-67']) {
    assert.equal(shopPhone(ok), '+380671234567', ok)
  }
  for (const bad of [
    '', '   ', 'abc', '12345', '+49 151 12345678', '067123456', '+380671234567999', '1380671234567', '11380671234567',
    '0671234567 0671234568', 'тел 0671234567', '+380012345678',
    380671234567, null, undefined, {}, ['0671234567'],
  ]) {
    assert.equal(shopPhone(bad), '', String(bad))
  }
})

test('маска телефона: видны код страны и две последние цифры', () => {
  assert.equal(maskPhone('+380671234567'), '+380•••••••67')
  for (const bad of ['', null, undefined, '0671234567', '+38067123456']) assert.equal(maskPhone(bad), '', String(bad))
})

test('вход заказа: верное тело проходит, поля приведены к одному виду', () => {
  const r = validateOrderInput(orderBody({
    lastName: '  Нечуй-Левицький ', firstName: "Мар'яна", middleName: '', phone: '067 123 45 67', email: ' Buyer@Example.COM ',
    cityRef: REF_A.toUpperCase(), warehouseRef: ` ${REF_B.toUpperCase()} `, cityName: ' Київ ', warehouseName: ' Відділення №1 ',
  }))
  assert.equal(r.ok, true)
  assert.equal(r.value.lastName, 'Нечуй-Левицький')
  assert.equal(r.value.firstName, "Мар'яна")
  assert.equal(r.value.middleName, '')
  assert.equal(r.value.phone, '+380671234567')
  assert.equal(r.value.email, 'buyer@example.com')
  assert.equal(r.value.cityRef, REF_A)
  assert.equal(r.value.warehouseRef, REF_B)
  assert.equal(r.value.cityName, 'Київ')
  assert.equal(r.value.warehouseName, 'Відділення №1')
})

test('вход заказа: ключ от 16 до 64 символов', () => {
  for (const key of ['a'.repeat(16), 'a'.repeat(64)]) assert.equal(validateOrderInput(orderBody({ idempotencyKey: key })).ok, true, key)
})

test('вход заказа: необязательные по батькові и почта могут отсутствовать', () => {
  const { middleName: _m, email: _e, ...rest } = orderBody()
  const r = validateOrderInput(rest)
  assert.equal(r.ok, true)
  assert.equal(r.value.middleName, '')
  assert.equal(r.value.email, '')
})

test('вход заказа: все три вида апострофа в имени', () => {
  for (const name of ["Мар'яна", 'Мар’яна', 'Марʼяна']) assert.equal(validateOrderInput(orderBody({ firstName: name })).ok, true, name)
})

test('вход заказа: цена, ФОП, язык и адрес возврата из тела в value не попадают', () => {
  const r = validateOrderInput(orderBody({ price: 1, total: 1, amount: 1, fopId: 'x', fopOverride: {}, lang: 'en', resultUrl: 'https://evil.example', state: 'paid' }))
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.value).sort(), [
    'cityName', 'cityRef', 'consentOffer', 'consentPersonalData', 'email', 'expectedTotalUah', 'firstName', 'idempotencyKey', 'lastName',
    'method', 'middleName', 'offerVersion', 'phone', 'qty', 'sku', 'warehouseName', 'warehouseRef',
  ])
})

test('вход заказа: длинные названия города и отделения обрезаются, а не ломают заказ', () => {
  const r = validateOrderInput(orderBody({ cityName: 'к'.repeat(500), warehouseName: 'в'.repeat(500) }))
  assert.equal(r.ok, true)
  assert.equal(r.value.cityName.length, 120)
  assert.equal(r.value.warehouseName.length, 200)
})

const BAD_FIELDS = [
  ['idempotencyKey', ['', 'short', 'a'.repeat(15), 'a'.repeat(65), 'пробіл у ключі 1234567890', 123, null]],
  ['sku', ['', 'v2-lid-r', 'V2_LID', 'V2-LID-RM-X1', 7, null]],
  ['qty', [0, 2, '1', 1.5, null, undefined]],
  ['method', ['', 'liqpay', 'CARD', ['card'], null, undefined]],
  // Без букв: дефисы, апострофы, знак тысяч из кириллицы, ʼ (это буква для \\p{L}, но не кириллица).
  ['lastName', ['', 'Я', 'Ivanov', 'Шевченко Тарас', 'Шевченко1', 'я'.repeat(41), null, 5, {}, '--', "''", '-ʼ-', '҂҂', 'ʼʼ', '’’', 'Я-', "'Я", 'Я҂']],
  ['firstName', ['', 'Т', 'Taras', 'Та рас', 'Та<b>рас', null, '--', '҂҂', 'ʼʼ']],
  ['middleName', ['Г', 'Hryhorovych', 'Григо рович', '--', '҂҂']],
  ['phone', ['', 'abc', '+49 151 12345678', 671234567, null]],
  ['email', ['без-собаки', 'a@b', 'a b@c.ua', `${'a'.repeat(120)}@b.ua`, 'a,b@c.ua', 'a,b@c.d', 'a..b@gmail.com', '.a@b.ua', 'a.@b.ua', 'ivan@пошта.укр', 'іван@example.com', 'a@b..ua', 'a@-b.ua', 'a@b-.ua', 'a@b.u', 'a@b.1a']],
  ['cityRef', ['', 'kyiv', `${REF_A}0`, 5, null]],
  ['cityName', ['', '   ', 5, null]],
  ['warehouseRef', ['', 'wh', 5, null]],
  ['warehouseName', ['', '   ', null]],
  ['offerVersion', ['', '   ', 'v'.repeat(41), 5, null]],
  ['consentOffer', [false, 'true', 1, null, undefined]],
  ['consentPersonalData', [false, 'true', 1, null, undefined]],
  ['expectedTotalUah', ['800', -1, NaN, Infinity, null, undefined]],
]

for (const [field, values] of BAD_FIELDS) {
  test(`вход заказа: неверное ${field} называется в fields`, () => {
    for (const v of values) {
      const r = validateOrderInput(orderBody({ [field]: v }))
      assert.equal(r.ok, false, `${field}=${String(v)}`)
      assert.deepEqual(r.fields, [field], `${field}=${String(v)}`)
    }
  })
}

test('вход заказа: настоящие имена и адреса проходят', () => {
  for (const name of ['Нечуй-Левицький', "Мар'яна", 'Мар’яна', 'Марʼяна', 'Ґе', 'Їжак', 'Єва', 'Ли', "О'Коннор", 'я'.repeat(40)]) {
    assert.equal(validateOrderInput(orderBody({ lastName: name, firstName: name, middleName: name })).ok, true, name)
  }
  for (const email of ['a@b.ua', 'first.last+tag@sub.example.com', "o'neil@example.com", 'a_b-c@my-shop.com.ua', 'ivan@xn--80a1acny.xn--j1amh', 'A.B@EXAMPLE.COM']) {
    assert.equal(validateOrderInput(orderBody({ email })).ok, true, email)
  }
})

test('вход заказа: не объект и пустое тело не падают и перечисляют обязательные поля', () => {
  for (const body of [null, undefined, 'x', 5, [], {}]) {
    const r = validateOrderInput(body)
    assert.equal(r.ok, false)
    assert.ok(r.fields.includes('sku') && r.fields.includes('phone') && r.fields.includes('consentOffer'))
    assert.ok(!r.fields.includes('middleName') && !r.fields.includes('email'))
  }
})

// ---------- отпечаток, ключи, токен ----------

const valueOf = (over) => validateOrderInput(orderBody(over)).value

test('отпечаток: не зависит от вида записи, цены и согласий', () => {
  const base = orderFingerprint(valueOf())
  assert.match(base, /^[0-9a-f]{64}$/)
  assert.equal(orderFingerprint(valueOf({ phone: '067 123 45 67', email: 'BUYER@example.com', cityRef: REF_A.toUpperCase() })), base)
  assert.equal(orderFingerprint(valueOf({ expectedTotalUah: 900, offerVersion: 'другая', idempotencyKey: 'another-key-1234567', cityName: 'Другое' })), base)
})

test('отпечаток: меняется от каждого поля заказа', () => {
  const base = orderFingerprint(valueOf())
  const changes = {
    sku: 'V2-LID-H', method: 'cod', lastName: 'Коваль', firstName: 'Іван', middleName: 'Іванович',
    phone: '+380671234568', email: 'other@example.com', cityRef: REF_B, warehouseRef: REF_A,
  }
  for (const [k, v] of Object.entries(changes)) assert.notEqual(orderFingerprint(valueOf({ [k]: v })), base, k)
  assert.notEqual(orderFingerprint({ ...valueOf(), qty: 2 }), base)
})

test('отпечаток: перенос букв между полями даёт другой отпечаток', () => {
  assert.notEqual(
    orderFingerprint(valueOf({ lastName: 'Коваль', firstName: 'Іван' })),
    orderFingerprint(valueOf({ lastName: 'Ковал', firstName: 'ьІван' })),
  )
})

test('id заказа: so- и 32 hex от sha256 ключа', () => {
  const key = '3f1c2d9e-8a7b-4c6d-9e0f-1a2b3c4d5e6f'
  assert.equal(orderIdFromKey(key), `so-${sha256(key).slice(0, 32)}`)
  assert.match(orderIdFromKey(key), /^so-[0-9a-f]{32}$/)
  assert.notEqual(orderIdFromKey(key), orderIdFromKey(`${key}x`))
})

test('ключ телефона: sha256 номера, номера в журнале нет', () => {
  assert.equal(phoneKeyOf('+380671234567'), sha256('+380671234567'))
  assert.ok(!phoneKeyOf('+380671234567').includes('671234567'))
})

test('токен статуса: 22 символа base64url, каждый раз новый', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) {
    const t = newStatusToken()
    assert.match(t, STATUS_TOKEN_RE)
    assert.equal(Buffer.from(t, 'base64url').length, 16)
    seen.add(t)
  }
  assert.equal(seen.size, 200)
  for (const bad of ['', 'short', `${'a'.repeat(22)}=`, `${'a'.repeat(21)}/`, 'a'.repeat(23), 'RF-123456']) assert.ok(!STATUS_TOKEN_RE.test(bad), bad)
})

test('хэш кода: sha256(token:code), зависит и от токена, и от кода', () => {
  assert.equal(phoneCodeHash('tok', '1234'), sha256('tok:1234'))
  assert.notEqual(phoneCodeHash('tok', '1234'), phoneCodeHash('tok', '1235'))
  assert.notEqual(phoneCodeHash('tok', '1234'), phoneCodeHash('tok2', '1234'))
})

// ---------- переходы ----------

// Таблица раздела C: полный перебор, поэтому лишний переход тоже падает.
const ALLOWED = {
  card: {
    awaiting_payment: ['paid', 'payment_review', 'cancelled', 'expired'],
    paid: ['shipped', 'reversed'],
    shipped: ['delivered', 'refused', 'paid', 'reversed'],
    delivered: ['reversed'],
    refused: ['returned', 'reversed'],
    returned: ['reversed'],
    payment_review: ['paid', 'reversed'],
    reversed: [],
    cancelled: ['payment_review'],
    expired: ['payment_review'],
  },
  cod: {
    phone_pending: ['cod_confirmed', 'cancelled', 'expired'],
    cod_confirmed: ['shipped', 'cancelled'],
    shipped: ['delivered', 'refused', 'cod_confirmed'],
    delivered: [],
    refused: ['returned'],
    returned: [],
    cancelled: [],
    expired: [],
  },
}

test('состояния: ровно те, что в разделе C', () => {
  assert.deepEqual([...SHOP_STATES].sort(), [
    'awaiting_payment', 'cancelled', 'cod_confirmed', 'delivered', 'expired', 'paid', 'payment_review', 'phone_pending', 'refused', 'returned', 'reversed', 'shipped',
  ])
})

for (const [method, table] of Object.entries(ALLOWED)) {
  test(`переходы: полная таблица для ${method}`, () => {
    for (const [from, allowed] of Object.entries(table)) {
      for (const to of SHOP_STATES) {
        assert.equal(canTransition({ state: from, method }, to), allowed.includes(to), `${method}: ${from} -> ${to}`)
      }
    }
  })
}

test('переходы: неизвестное состояние, цель и пустой заказ не проходят', () => {
  assert.equal(canTransition({ state: 'nope', method: 'card' }, 'paid'), false)
  assert.equal(canTransition({ state: 'paid', method: 'card' }, 'nope'), false)
  assert.equal(canTransition({ state: 'paid' }, 'reversed'), false)
  assert.equal(canTransition(null, 'paid'), false)
  assert.equal(canTransition(undefined, 'paid'), false)
})

test('запись перехода: состояние, строка истории, время; исходный заказ не меняется', () => {
  const order = { state: 'awaiting_payment', method: 'card', history: [{ at: 'old', from: null, to: 'awaiting_payment', by: 'create' }] }
  const snapshot = JSON.parse(JSON.stringify(order))
  const p = transitionPatch(order, 'cancelled', { at: '2026-11-03T10:00:00.000Z', by: 'buyer', patch: { cancelReason: 'superseded' } })
  assert.deepEqual(p, {
    cancelReason: 'superseded', state: 'cancelled', updatedAt: '2026-11-03T10:00:00.000Z',
    history: [...snapshot.history, { at: '2026-11-03T10:00:00.000Z', from: 'awaiting_payment', to: 'cancelled', by: 'buyer' }],
  })
  assert.deepEqual(order, snapshot)
})

test('запись перехода: запрещённый переход даёт null, patch не может подменить состояние и историю', () => {
  assert.equal(transitionPatch({ state: 'reversed', method: 'card' }, 'paid', { at: 'x' }), null)
  const p = transitionPatch({ state: 'paid', method: 'card' }, 'shipped', { at: 'x', patch: { state: 'delivered', history: [], updatedAt: 'y' } })
  assert.equal(p.state, 'shipped')
  assert.equal(p.updatedAt, 'x')
  assert.deepEqual(p.history, [{ at: 'x', from: 'paid', to: 'shipped', by: null }])
})

test('запись перехода: время по умолчанию есть, undefined в Firestore не уйдёт', () => {
  const p = transitionPatch({ state: 'paid', method: 'card' }, 'shipped')
  assert.ok(Date.parse(p.updatedAt))
  assert.equal(p.history[0].at, p.updatedAt)
  assert.equal(p.history[0].by, null)
})

// ---------- продавец и гейт ----------

const seller = (over = {}) => ({
  displayName: 'Продавець', ipn: '1234567890', address: 'Київ, вул. Тестова, 1', actualAddress: 'Львів, вул. Інша, 2',
  email: 'shop@example.com', phone: '+380670000000', ...over,
})
const readyFop = (over = {}) => ({
  id: 'f2', name: 'ФОП', active: true,
  methods: { monoAcquire: true, cod: true },
  seller: seller(),
  novaPoshta: { apiKey: 'np-key', senderRef: 's', contactRef: 'c', senderPhone: '380', cityRef: 'k', warehouseRef: 'w' },
  monoAcquire: { token: 'mono-token' },
  checkbox: { licenseKey: 'lic', pinCode: '1234' },
  ...over,
})
const CONTROL = { codKind: 'control', codReceiptMode: 'ettn' }
const MONEY = { codKind: 'money', codReceiptMode: 'manual' }
const COD = { ...CALLBACK, priceUah: 800 }

test('реквизиты: фактический адрес необязателен и наружу не отдаётся', () => {
  assert.equal(sellerFilled(seller()), true)
  assert.equal(sellerFilled(seller({ actualAddress: '' })), true)
  assert.deepEqual(publicSeller({ seller: seller() }), {
    name: 'Продавець', ipn: '1234567890', address: 'Київ, вул. Тестова, 1', email: 'shop@example.com', phone: '+380670000000',
  })
})

test('реквизиты: без любого обязательного поля продавца нет', () => {
  for (const k of ['displayName', 'ipn', 'address', 'email', 'phone']) {
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(sellerFilled(seller({ [k]: v })), false, `${k}=${String(v)}`)
      assert.equal(publicSeller({ seller: seller({ [k]: v }) }), null, `${k}=${String(v)}`)
    }
  }
  for (const s of [null, undefined, {}]) assert.equal(sellerFilled(s), false)
  assert.equal(publicSeller(null), null)
  assert.equal(publicSeller({}), null)
})

test('гейт: готовый ФОП проходит картой и наложкой', () => {
  assert.deepEqual(shopSellable(readyFop(), 'card', {}, CALLBACK), { ok: true })
  assert.deepEqual(shopSellable(readyFop(), 'cod', CONTROL, COD), { ok: true })
  assert.deepEqual(shopSellable(readyFop(), 'cod', MONEY, COD), { ok: true })
})

test('гейт: нет ФОП, неизвестный способ, пустой ФОП не падают', () => {
  assert.deepEqual(shopSellable(null, 'card', {}, CALLBACK), { ok: false, code: 'NOT_CONFIGURED', missing: ['fop'] })
  const unknown = shopSellable(readyFop(), 'liqpay', {}, CALLBACK)
  assert.equal(unknown.ok, false)
  assert.deepEqual(unknown.missing, ['method'])
  assert.equal(shopSellable({}, 'card', {}, CALLBACK).ok, false)
  assert.equal(shopSellable({}, 'cod', null, CALLBACK).ok, false)
})

// [что сломано, какой пункт назван]: общие условия для обоих способов.
const COMMON_GAPS = [
  [{ active: false }, 'active'],
  [{ seller: undefined }, 'seller'],
  [{ seller: seller({ ipn: '  ' }) }, 'seller'],
  [{ novaPoshta: undefined }, 'novaPoshta.apiKey'],
  ...['apiKey', 'senderRef', 'contactRef', 'senderPhone', 'cityRef', 'warehouseRef'].map((k) => (
    [{ novaPoshta: { ...readyFop().novaPoshta, [k]: '' } }, `novaPoshta.${k}`]
  )),
]

for (const [method, cfg, opts] of [['card', {}, CALLBACK], ['cod', CONTROL, COD]]) {
  test(`гейт ${method}: без общего условия отказ NOT_CONFIGURED и причина названа`, () => {
    for (const [over, name] of COMMON_GAPS) {
      const r = shopSellable(readyFop(over), method, cfg, opts)
      assert.equal(r.ok, false, name)
      assert.equal(r.code, 'NOT_CONFIGURED', name)
      assert.ok(r.missing.includes(name), `${name}: ${r.missing}`)
    }
  })
}

test('гейт карта: без каждого условия карты отказ', () => {
  const gaps = [
    [{ monoAcquire: undefined }, 'monoAcquire.token'],
    [{ monoAcquire: { token: '' } }, 'monoAcquire.token'],
    [{ checkbox: undefined }, 'checkbox.licenseKey'],
    [{ checkbox: { pinCode: '1234' } }, 'checkbox.licenseKey'],
    [{ checkbox: { licenseKey: 'lic' } }, 'checkbox.cashier'],
    [{ checkbox: { licenseKey: 'lic', login: 'l' } }, 'checkbox.cashier'],
    [{ checkbox: { licenseKey: 'lic', password: 'p' } }, 'checkbox.cashier'],
  ]
  for (const [over, name] of gaps) {
    const r = shopSellable(readyFop(over), 'card', {}, CALLBACK)
    assert.equal(r.code, 'NOT_CONFIGURED', name)
    assert.ok(r.missing.includes(name), `${name}: ${r.missing}`)
  }
})

test('гейт карта: кассир по паре логин и пароль тоже проходит', () => {
  assert.equal(shopSellable(readyFop({ checkbox: { licenseKey: 'lic', login: 'l', password: 'p' } }), 'card', {}, CALLBACK).ok, true)
})

test('гейт карта: без адреса колбэка отказ, по умолчанию адрес из окружения', (t) => {
  const prev = process.env.SHOP_CALLBACK_BASE_URL
  t.after(() => { if (prev === undefined) delete process.env.SHOP_CALLBACK_BASE_URL; else process.env.SHOP_CALLBACK_BASE_URL = prev })

  delete process.env.SHOP_CALLBACK_BASE_URL
  assert.ok(shopSellable(readyFop(), 'card', {}).missing.includes('SHOP_CALLBACK_BASE_URL'))
  assert.ok(shopSellable(readyFop(), 'card', {}, { callbackBaseUrl: '' }).missing.includes('SHOP_CALLBACK_BASE_URL'))
  process.env.SHOP_CALLBACK_BASE_URL = 'https://portal.example'
  assert.equal(shopSellable(readyFop(), 'card', {}).ok, true)
  // Наложке колбэк банка не нужен.
  delete process.env.SHOP_CALLBACK_BASE_URL
  assert.equal(shopSellable(readyFop(), 'cod', MONEY, { priceUah: 800 }).ok, true)
})

test('гейт: галочка способа строго true, отсутствующая не считается включённой (не как methodOn)', () => {
  for (const methods of [undefined, {}, { monoAcquire: false }, { monoAcquire: 'true' }, { monoAcquire: 1 }, { cod: true }]) {
    const r = shopSellable(readyFop({ methods }), 'card', {}, CALLBACK)
    assert.equal(r.ok, false, JSON.stringify(methods))
    assert.equal(r.code, 'METHOD_OFF', JSON.stringify(methods))
    assert.ok(r.missing.includes('methods.monoAcquire'))
  }
  for (const methods of [undefined, {}, { cod: false }, { cod: 'true' }, { monoAcquire: true }]) {
    const r = shopSellable(readyFop({ methods }), 'cod', CONTROL, COD)
    assert.equal(r.code, 'METHOD_OFF', JSON.stringify(methods))
    assert.ok(r.missing.includes('methods.cod'))
  }
})

test('гейт: выключатели магазина в настройках на гейт не влияют (тестовый телефон наложки)', () => {
  assert.equal(shopSellable(readyFop(), 'card', { methods: { card: false } }, CALLBACK).ok, true)
  assert.equal(shopSellable(readyFop(), 'cod', { ...CONTROL, methods: { cod: false } }, COD).ok, true)
})

test('гейт наложка: разрешены только пары control+ettn и money+manual', () => {
  assert.equal(codPairAllowed('control', 'ettn'), true)
  assert.equal(codPairAllowed('money', 'manual'), true)
  for (const [kind, mode] of [['money', 'ettn'], ['control', 'manual'], ['', ''], [undefined, undefined], ['money', undefined], [undefined, 'ettn']]) {
    assert.equal(codPairAllowed(kind, mode), false, `${kind}+${mode}`)
    const r = shopSellable(readyFop(), 'cod', { codKind: kind, codReceiptMode: mode }, COD)
    assert.equal(r.ok, false, `${kind}+${mode}`)
    assert.ok(r.missing.includes('codPair'))
  }
  assert.ok(shopSellable(readyFop(), 'cod', null, COD).missing.includes('codPair'))
})

test('гейт наложка: цена только целая, без цены отказ', () => {
  for (const priceUah of [799.99, 800.5, '800', NaN, null, undefined]) {
    const r = shopSellable(readyFop(), 'cod', MONEY, { ...CALLBACK, priceUah })
    assert.equal(r.ok, false, String(priceUah))
    assert.ok(r.missing.includes('priceUah'))
  }
  assert.ok(shopSellable(readyFop(), 'card', {}, { ...CALLBACK, priceUah: 799.99 }).ok, 'карте дробная цена не мешает')
})

test('гейт наложка: заготовке чека нужна касса с кассиром, ручному чеку касса не нужна', () => {
  for (const [checkbox, name] of [[undefined, 'checkbox.licenseKey'], [{ pinCode: '1' }, 'checkbox.licenseKey'], [{ licenseKey: 'lic' }, 'checkbox.cashier']]) {
    const r = shopSellable(readyFop({ checkbox }), 'cod', CONTROL, COD)
    assert.equal(r.ok, false, name)
    assert.ok(r.missing.includes(name), name)
  }
  assert.equal(shopSellable(readyFop({ checkbox: undefined }), 'cod', MONEY, COD).ok, true)
})

test('условия НП для накладной отдельно от гейта: способ и продавец им не мешают', () => {
  assert.deepEqual(npMissing(readyFop({ methods: {}, seller: undefined, active: false, checkbox: undefined })), [])
  assert.deepEqual(npMissing(readyFop({ novaPoshta: { ...readyFop().novaPoshta, senderRef: ' ' } })), ['novaPoshta.senderRef'])
  assert.equal(npMissing(null).length, 6)
})

// ---------- лента ----------

const SKU = 'V2-LID-R'
const material = (over = {}) => ({
  id: 'mat-1', code: SKU, name: { uk: 'Кришка Solo V2' }, unit: { uk: 'шт' }, price: 800, active: true,
  site: { slug: 'solo-v2-lid-rect', status: 'published', url: 'https://runferry.ua/uk/products/solo-v2-lid-rect' },
  ...over,
})
const rule = (over = {}) => ({ enabled: true, inStock: true, stock: null, minUah: 600, maxUah: 1200, ...over })
const sales = (over = {}) => ({
  mode: 'live', methods: { card: true, cod: false }, offerVersion: '2026-11-03', fopId: 'f2', siteBaseUrl: 'https://runferry.ua',
  ownerPhone: '+380670000001', ...CONTROL, skus: { [SKU]: rule() },
  ...over,
})
const feedOf = (over = {}) => buildCatalogFeed({
  sales: sales(), priceList: { materials: [material()] }, fop: readyFop(), now: '2026-11-03T10:00:00.000Z', ...CALLBACK, ...over,
})

test('лента live: форма контракта из раздела B', () => {
  const { feed, dropped } = feedOf()
  assert.deepEqual(feed, {
    generatedAt: '2026-11-03T10:00:00.000Z',
    mode: 'live',
    offerVersion: '2026-11-03',
    seller: { name: 'Продавець', ipn: '1234567890', address: 'Київ, вул. Тестова, 1', email: 'shop@example.com', phone: '+380670000000' },
    items: [{
      sku: SKU, slug: 'solo-v2-lid-rect', titleUk: 'Кришка Solo V2', priceUah: 800,
      orderable: true, showBuyButton: true, methods: { card: true, cod: false },
    }],
  })
  assert.deepEqual(dropped, [])
})

test('лента: все режимы', () => {
  const cases = [
    // [режим, строк, orderable, кнопка]
    ['off', 0],
    ['prices', 1, false, false],
    ['hidden', 1, true, false],
    ['live', 1, true, true],
    ['nope', 0],
    [undefined, 0],
  ]
  for (const [mode, count, orderable, button] of cases) {
    const { feed } = feedOf({ sales: sales({ mode }) })
    assert.equal(feed.mode, SALES_MODES.includes(mode) ? mode : 'off', String(mode))
    assert.equal(feed.items.length, count, String(mode))
    assert.ok(feed.seller, `${mode}: продавец нужен странице оферты при любом режиме`)
    if (count) {
      assert.equal(feed.items[0].orderable, orderable, String(mode))
      assert.equal(feed.items[0].showBuyButton, button, String(mode))
      assert.equal(feed.items[0].priceUah, 800, String(mode))
      assert.equal(feed.items[0].methods.card, orderable, String(mode))
    }
  }
})

test('лента: нет документа настроек: пусто, режим off, продавец только если ФОП известен', () => {
  for (const s of [null, undefined, 'x']) {
    const { feed, dropped } = feedOf({ sales: s })
    assert.equal(feed.mode, 'off')
    assert.deepEqual(feed.items, [])
    assert.equal(feed.offerVersion, '')
    assert.deepEqual(dropped, [])
  }
  assert.equal(feedOf({ sales: null, fop: null }).feed.seller, null)
  assert.equal(feedOf({ sales: sales({ mode: 'off' }), fop: readyFop({ seller: seller({ ipn: '' }) }) }).feed.seller, null)
  assert.deepEqual(buildCatalogFeed().feed.items, [])
})

test('лента: артикул выключен или нет в наличии: цена есть, заказать нельзя', () => {
  for (const over of [{ enabled: false }, { enabled: undefined }, { inStock: false }, { inStock: undefined }, { stock: 0 }, { stock: -1 }]) {
    const { feed, dropped } = feedOf({ sales: sales({ skus: { [SKU]: rule(over) } }) })
    const [item] = feed.items
    assert.equal(item.priceUah, 800, JSON.stringify(over))
    assert.equal(item.orderable, false, JSON.stringify(over))
    assert.equal(item.showBuyButton, false, JSON.stringify(over))
    assert.deepEqual(item.methods, { card: false, cod: false }, JSON.stringify(over))
    assert.deepEqual(dropped, [])
  }
  const codOn = sales({ methods: { card: true, cod: true }, skus: { [SKU]: rule({ inStock: false }) } })
  assert.deepEqual(feedOf({ sales: codOn }).feed.items[0].methods, { card: false, cod: false })
  assert.deepEqual(feedOf({ sales: sales({ mode: 'prices', methods: { card: true, cod: true } }) }).feed.items[0].methods, { card: false, cod: false })
  assert.equal(skuOnSale(rule({ stock: 3 })), true)
  assert.equal(skuOnSale(rule()), true)
  assert.equal(skuOnSale(null), false)
})

test('лента: ФОП не готов: цена есть, заказать нельзя, причина наружу не уходит', () => {
  const fops = [null, readyFop({ active: false }), readyFop({ seller: undefined }), readyFop({ monoAcquire: undefined }), readyFop({ methods: {} })]
  for (const fop of fops) {
    const { feed } = feedOf({ fop })
    assert.equal(feed.items[0].orderable, false)
    assert.equal(feed.items[0].showBuyButton, false)
    assert.deepEqual(Object.keys(feed.items[0]).sort(), ['methods', 'orderable', 'priceUah', 'showBuyButton', 'sku', 'slug', 'titleUk'])
  }
  assert.equal(feedOf({ callbackBaseUrl: '' }).feed.items[0].orderable, false)
})

test('лента: способы: нужны и настройка магазина, и гейт; orderable, если открыт хотя бы один', () => {
  const m = (methods, extra = {}) => feedOf({ sales: sales({ methods, ...extra }) }).feed.items[0]
  assert.deepEqual(m({ card: true, cod: true }).methods, { card: true, cod: true })
  assert.deepEqual(m({ card: false, cod: true }).methods, { card: false, cod: true })
  assert.equal(m({ card: false, cod: true }).orderable, true)
  assert.equal(m({ card: false, cod: false }).orderable, false)
  assert.equal(m(undefined).orderable, false)
  assert.equal(m({ card: 'true' }).methods.card, false)
  // money+ettn: наложка закрыта, карта работает.
  assert.deepEqual(m({ card: true, cod: true }, { codKind: 'money', codReceiptMode: 'ettn' }).methods, { card: true, cod: false })
})

test('лента: дробная цена закрывает наложку, но не карту', () => {
  const { feed } = feedOf({ sales: sales({ methods: { card: true, cod: true } }), priceList: { materials: [material({ price: 799.99 })] } })
  assert.equal(feed.items[0].priceUah, 799.99)
  assert.deepEqual(feed.items[0].methods, { card: true, cod: false })
})

test('лента: позиция, у которой нельзя назвать цену, выпадает и названа для алерта', () => {
  const dupes = [material(), material({ id: 'mat-2', price: 1 })]
  const cases = [
    [{ materials: [] }, 'no-material'],
    [null, 'no-material'],
    [{ materials: dupes }, 'material-errors'],
    [{ materials: [material(), material({ id: 'mat-2', code: 'v2-lid-r' })] }, 'material-errors'],
    [{ materials: [material({ active: false })] }, 'not-published'],
    [{ materials: [material({ site: undefined })] }, 'not-published'],
    [{ materials: [material({ site: { slug: 'x', status: 'draft' } })] }, 'not-published'],
    [{ materials: [material({ site: { status: 'published' } })] }, 'no-card-data'],
    [{ materials: [material({ name: { ru: 'Крышка' } })] }, 'no-card-data'],
    [{ materials: [material({ name: undefined })] }, 'no-card-data'],
    [{ materials: [material({ price: 599.99 })] }, 'price-out-of-range'],
    [{ materials: [material({ price: 1200.01 })] }, 'price-out-of-range'],
    [{ materials: [material({ price: 0 })] }, 'price-out-of-range'],
    [{ materials: [material({ price: '800' })] }, 'price-out-of-range'],
    [{ materials: [material({ price: undefined })] }, 'price-out-of-range'],
  ]
  for (const [priceList, reason] of cases) {
    for (const mode of ['prices', 'hidden', 'live']) {
      const { feed, dropped } = feedOf({ priceList, sales: sales({ mode }) })
      assert.deepEqual(feed.items, [], reason)
      assert.equal(dropped.length, 1, reason)
      assert.equal(dropped[0].sku, SKU)
      assert.equal(dropped[0].reason, reason)
    }
  }
  assert.match(feedOf({ priceList: { materials: dupes } }).dropped[0].errors[0], /материала с кодом/)
  // Пока продажи выключены, алертов нет.
  assert.deepEqual(feedOf({ priceList: { materials: [] }, sales: sales({ mode: 'off' }) }).dropped, [])
})

test('лента: границы цены включительно и обязательны', () => {
  for (const price of [600, 1200]) assert.equal(feedOf({ priceList: { materials: [material({ price })] } }).feed.items.length, 1, String(price))
  for (const over of [{ minUah: undefined }, { maxUah: undefined }, { minUah: '600' }, { maxUah: null }]) {
    const { feed, dropped } = feedOf({ sales: sales({ skus: { [SKU]: rule(over) } }) })
    assert.deepEqual(feed.items, [], JSON.stringify(over))
    assert.equal(dropped[0].reason, 'price-out-of-range')
  }
  const noRule = feedOf({ sales: sales({ skus: { [SKU]: null } }) })
  assert.equal(noRule.dropped[0].reason, 'price-out-of-range')
})

test('лента: нулевая и отрицательная цена не проходят и при широких границах', () => {
  const wide = sales({ skus: { [SKU]: rule({ minUah: -100, maxUah: 1200 }) } })
  for (const price of [0, -5]) {
    const { feed, dropped } = feedOf({ sales: wide, priceList: { materials: [material({ price })] } })
    assert.deepEqual(feed.items, [], String(price))
    assert.equal(dropped[0].reason, 'price-out-of-range')
  }
})

test('лента: только артикулы из настроек, остальной прайс наружу не идёт', () => {
  const { feed } = feedOf({ priceList: { materials: [material(), material({ id: 'mat-9', code: 'M-SERVO', price: 950 })] } })
  assert.deepEqual(feed.items.map((i) => i.sku), [SKU])
  assert.deepEqual(feedOf({ sales: sales({ skus: undefined }) }).feed.items, [])
})

test('лента: несколько артикулов считаются независимо', () => {
  const { feed, dropped } = feedOf({
    sales: sales({ skus: { [SKU]: rule(), 'V2-LID-H': rule({ inStock: false }), 'V2-LID-RM': rule() } }),
    priceList: { materials: [material(), material({ id: 'mat-2', code: 'V2-LID-H', price: 850 })] },
  })
  assert.deepEqual(feed.items.map((i) => [i.sku, i.orderable]), [[SKU, true], ['V2-LID-H', false]])
  assert.deepEqual(dropped, [{ sku: 'V2-LID-RM', reason: 'no-material' }])
})

test('лента: секреты, настройки и служебные поля не утекают', () => {
  const json = JSON.stringify(feedOf().feed)
  for (const leak of ['np-key', 'mono-token', 'lic', '1234"', 'actualAddress', 'Львів', 'fopId', 'f2', 'ownerPhone', '+380670000001', 'minUah', 'maxUah', 'stock', 'mat-1', 'siteBaseUrl']) {
    assert.ok(!json.includes(leak), `утечка ${leak}`)
  }
})

test('цена для заказа: та же функция, что в ленте; значение только из прайса', () => {
  assert.deepEqual(pricedItem({ materials: [material()] }, SKU, rule()), {
    item: { sku: SKU, slug: 'solo-v2-lid-rect', titleUk: 'Кришка Solo V2', priceUah: 800 },
  })
  assert.equal(pricedItem({ materials: [material()] }, 'OTHER', rule()).reason, 'no-material')
})

// ---------- Новая Почта ----------

test('коды НП: наборы', () => {
  assert.deepEqual([...NP_DELIVERED].sort(), ['10', '106', '11', '9'])
  assert.deepEqual([...NP_GONE].sort(), ['2', '3'])
  assert.deepEqual([...NP_REFUSED].sort(), ['102', '103', '105', '108'])
  assert.equal(NP_NOT_HANDED, '1')
  assert.equal(npDateToIso, npDateOriginal)
  assert.equal(npDateToIso('21.05.2024 13:53:47'), '2024-05-21T10:53:47.000Z')
})

test('код НП: что значит для отправленного заказа', () => {
  const now = Date.parse('2026-11-10T12:00:00.000Z')
  const shippedAt = '2026-11-01T12:00:00.000Z'
  const cases = [
    ['9', 'delivered'], ['10', 'delivered'], ['11', 'delivered'], ['106', 'delivered'], [9, 'delivered'],
    ['102', 'refused'], ['103', 'refused'], ['108', 'refused'], ['105', 'refused'],
    ['2', 'back'], ['3', 'back'],
    ['1', 'not-handed'], [1, 'not-handed'],
    ['4', 'moving'], ['5', 'moving'], ['7', 'moving'], ['8', 'moving'], ['41', 'moving'], ['101', 'moving'], ['104', 'moving'],
    ['', 'none'], ['   ', 'none'], [null, 'none'], [undefined, 'none'],
  ]
  for (const [code, want] of cases) assert.equal(npOutcome(code, { shippedAt, now }), want, String(code))
})

test('код 3: заказ возвращается только через 3 дня, код 2 сразу', () => {
  const shippedAt = '2026-11-01T12:00:00.000Z'
  const at = (s) => ({ shippedAt, now: Date.parse(s) })
  assert.equal(npOutcome('3', at('2026-11-01T12:00:01.000Z')), 'none')
  assert.equal(npOutcome('3', at('2026-11-04T12:00:00.000Z')), 'none')
  assert.equal(npOutcome('3', at('2026-11-04T12:00:00.001Z')), 'back')
  assert.equal(npOutcome('2', at('2026-11-01T12:00:01.000Z')), 'back')
  // Без даты отправки заказ назад не возвращаем.
  for (const bad of [undefined, null, '', 'nope']) assert.equal(npOutcome('3', { shippedAt: bad }), 'none', String(bad))
  assert.equal(npOutcome('3'), 'none')
  // Без now считаем от текущего времени.
  assert.equal(npOutcome('3', { shippedAt: '2020-01-01T00:00:00.000Z' }), 'back')
  assert.equal(npOutcome('3', { shippedAt: new Date().toISOString() }), 'none')
})

// ---------- реквизиты продавца через настоящие fopsAdmin.js и loadFopFresh ----------

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor() { this.docs = {} }
  collection(name) {
    const db = this
    return {
      doc: (id) => ({
        id,
        get: async () => ({ id, exists: !!db.docs[`${name}/${id}`], data: () => clone(db.docs[`${name}/${id}`]) }),
        set: async (v, opts) => {
          const path = `${name}/${id}`
          if (opts && opts.merge && db.docs[path]) deepMerge(db.docs[path], v)
          else db.docs[path] = clone(v)
        },
      }),
      get: async () => {
        const docs = Object.keys(db.docs).filter((p) => p.startsWith(`${name}/`)).map((p) => ({ id: p.split('/')[1], data: () => clone(db.docs[p]) }))
        return { docs, forEach: (fn) => docs.forEach(fn) }
      },
    }
  }
}

const standFops = async (t) => {
  const db = new FakeDb()
  const app = express()
  app.use(express.json())
  registerFopsAdmin(app, { adminDb: db, verifyAdmin: async () => true, refreshFops })
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  t.after(() => srv.close())
  const url = `http://127.0.0.1:${srv.address().port}/api/fops/admin`
  const put = async (id, body) => {
    const r = await fetch(`${url}/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(r.status, 200)
  }
  const list = async () => (await (await fetch(url)).json()).data
  return { db, put, list }
}

// То, что шлёт форма: ФОП с ключами, но без реквизитов продавца.
const formBody = (over = {}) => ({
  name: 'ФОП', active: true,
  methods: { monoAcquire: true, cod: true },
  novaPoshta: { senderRef: 's', contactRef: 'c', senderPhone: '380', cityRef: 'k', warehouseRef: 'w' },
  secrets: { monoAcquire: { token: 'mono-token' }, checkbox: { licenseKey: 'lic', pinCode: '1234' }, novaPoshta: { apiKey: 'np-key' } },
  ...over,
})

test('D13: без реквизитов гейт отвечает NOT_CONFIGURED, после сохранения формы они доходят до гейта через loadFopFresh', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody())
  const before = shopSellable(await loadFopFresh(db, 'f2'), 'card', {}, CALLBACK)
  assert.deepEqual(before, { ok: false, code: 'NOT_CONFIGURED', missing: ['seller'] })

  await put('f2', formBody({ seller: seller() }))
  const fop = await loadFopFresh(db, 'f2')
  assert.deepEqual(fop.seller, seller())
  assert.deepEqual(shopSellable(fop, 'card', {}, CALLBACK), { ok: true })
  assert.deepEqual(shopSellable(fop, 'cod', CONTROL, COD), { ok: true })
  assert.equal(publicSeller(fop).name, 'Продавець')
  assert.equal(buildCatalogFeed({ sales: { mode: 'off' }, fop }).feed.seller.name, 'Продавець')
})

test('D13: сохранение без реквизитов и с пустыми реквизитами их не стирает', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: seller() }))
  const empty = { displayName: '', ipn: '', address: '', actualAddress: '', email: '', phone: '' }
  const spaces = { displayName: '  ', ipn: ' ', address: '', actualAddress: '', email: '', phone: '' }
  for (const body of [{}, formBody(), formBody({ seller: {} }), formBody({ seller: empty }), formBody({ seller: spaces }), formBody({ seller: null }), formBody({ seller: 'x' }), formBody({ seller: [] })]) {
    await put('f2', body)
    assert.deepEqual((await loadFopFresh(db, 'f2')).seller, seller(), JSON.stringify(body.seller))
  }
})

test('D13: новый ФОП с пустыми реквизитами не получает поля seller', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: { displayName: '', ipn: '', address: '', actualAddress: '', email: '', phone: '' } }))
  assert.ok(!('seller' in db.docs['fops/f2']))
  assert.equal((await loadFopFresh(db, 'f2')).seller, undefined)
})

test('D13: одно поле можно очистить, остальные на месте, гейт снова закрыт', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: seller() }))
  await put('f2', formBody({ seller: seller({ ipn: '' }) }))
  const fop = await loadFopFresh(db, 'f2')
  assert.equal(fop.seller.ipn, '')
  assert.equal(fop.seller.displayName, 'Продавець')
  assert.deepEqual(shopSellable(fop, 'card', {}, CALLBACK).missing, ['seller'])
  // Фактический адрес тоже можно убрать, продавец остаётся заполненным.
  await put('f2', formBody({ seller: seller({ actualAddress: '' }) }))
  const after = await loadFopFresh(db, 'f2')
  assert.equal(after.seller.actualAddress, '')
  assert.equal(shopSellable(after, 'card', {}, CALLBACK).ok, true)
})

test('D13: часть полей в теле меняет только их', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: seller() }))
  await put('f2', formBody({ seller: { phone: '+380670000099' } }))
  assert.deepEqual((await loadFopFresh(db, 'f2')).seller, seller({ phone: '+380670000099' }))
})

test('D13: пробелы снимаются, длина ограничена, не строки и лишние поля не пишутся', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: {
    displayName: `  ${'н'.repeat(500)}  `, ipn: ' 1234567890 ', address: 'а'.repeat(500), actualAddress: 'ф'.repeat(500),
    email: 'e'.repeat(500), phone: '1'.repeat(500), extra: 'лишнее', token: 'секрет',
  } }))
  let s = (await loadFopFresh(db, 'f2')).seller
  assert.equal(s.displayName.length, 200)
  assert.equal(s.ipn, '1234567890')
  assert.equal(s.address.length, 300)
  assert.equal(s.actualAddress.length, 300)
  assert.equal(s.email.length, 120)
  assert.equal(s.phone.length, 32)
  assert.deepEqual(Object.keys(s).sort(), ['actualAddress', 'address', 'displayName', 'email', 'ipn', 'phone'])
  await put('f2', formBody({ seller: { ipn: '1'.repeat(500) } }))
  assert.equal((await loadFopFresh(db, 'f2')).seller.ipn.length, 32)
  await put('f2', formBody({ seller: { ipn: '1234567890' } }))

  await put('f2', formBody({ seller: { displayName: 'Нове', ipn: 5, email: { a: 1 }, phone: null, address: ['x'] } }))
  s = (await loadFopFresh(db, 'f2')).seller
  assert.equal(s.displayName, 'Нове')
  assert.equal(s.ipn, '1234567890')
  assert.equal(s.email.length, 120)
})

test('D13: реквизиты лежат в мете, а не в секретах; ключи формой не трогаются', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: seller() }))
  assert.deepEqual(db.docs['fops/f2'].seller, seller())
  assert.ok(!('seller' in db.docs['fopSecrets/f2']))
  const secretsBefore = clone(db.docs['fopSecrets/f2'])
  await put('f2', formBody({ seller: seller({ phone: '+380670000099' }), secrets: undefined }))
  assert.deepEqual(db.docs['fopSecrets/f2'], secretsBefore)
})

test('D13: список для формы отдаёт реквизиты, у ФОП без них пустой объект', async (t) => {
  const { put, list } = await standFops(t)
  await put('a', formBody({ name: 'А', seller: seller() }))
  await put('b', formBody({ name: 'Б' }))
  const items = await list()
  assert.deepEqual(items.find((f) => f.id === 'a').seller, seller())
  assert.deepEqual(items.find((f) => f.id === 'b').seller, {})
})

test('D13: реквизиты доживают и до кэша getFop, а публичный список их не показывает', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ seller: seller() }))
  await refreshFops(db)
  assert.deepEqual(getFop('f2').seller, seller())
  const pub = listFopsPublic().find((f) => f.id === 'f2')
  assert.ok(pub)
  assert.ok(!('seller' in pub))
})

test('D13: неактивный ФОП с реквизитами: продавец в ленте есть, продавать нельзя', async (t) => {
  const { db, put } = await standFops(t)
  await put('f2', formBody({ active: false, seller: seller() }))
  const fop = await loadFopFresh(db, 'f2')
  assert.equal(shopSellable(fop, 'card', {}, CALLBACK).ok, false)
  assert.deepEqual(shopSellable(fop, 'card', {}, CALLBACK).missing, ['active'])
  assert.ok(publicSeller(fop))
})
