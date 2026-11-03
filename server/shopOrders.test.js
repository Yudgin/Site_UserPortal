// node --test: API магазина для сервера сайта (server/shopOrders.js): токен, лента, поиск Новой Почты.
// Без сети и Firestore: настоящие loadFopFresh, buildCatalogFeed и sendAlerts поверх фейковой базы, НП и Telegram подменены.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { rateLimit } from './rateLimit.js'
import { createShopPaymentHooks, KYIV_DAY } from './shopPayments.js'
import { registerShopOrders } from './shopOrders.js'

const TOKEN = 'shop-test-token-0123456789'
const CITY = '8d5a980d-391c-11dd-90d9-001a92567626'
const SETTLEMENT = 'e718a680-4b33-11e4-ab6d-005056801329'
const WH = '1ec09d88-e1c2-11e3-8c4a-0050568002cf'
const WH2 = '7b422fc5-e1b8-11e3-8c4a-0050568002cf'
const POSTOMAT_TYPE = '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc'
process.env.SHOP_CALLBACK_BASE_URL = 'https://portal.test'

// ---------- фейковая база ----------

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(docs = {}) { this.docs = clone(docs); this.reads = []; this.writes = []; this.broken = {}; this.txError = null }
  collection(name) {
    return {
      doc: (id) => {
        if (typeof id !== 'string' || !id) throw new Error('Firestore: document id must be a non-empty string')
        const path = `${name}/${id}`
        return {
          id, path,
          get: async () => {
            this.reads.push(path)
            if (this.broken[path]) throw new Error(`база: ${path} не читається`)
            return { id, exists: this.docs[path] !== undefined, data: () => clone(this.docs[path]) }
          },
          set: async (v, opts) => this.write(path, v, opts),
        }
      },
    }
  }
  write(path, v, opts) {
    this.writes.push(path)
    if (opts && opts.merge && this.docs[path]) deepMerge(this.docs[path], v)
    else this.docs[path] = clone(v)
  }
  async runTransaction(fn) {
    if (this.txError) throw this.txError
    let wrote = false
    return fn({
      get: async (ref) => { if (wrote) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
      set: (ref, v, opts) => { wrote = true; this.write(ref.path, v, opts) },
    })
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
  id: `m-${code}`, code, active: true, price: 800, name: { uk: `Кришка ${code}` },
  site: { status: 'published', slug: `slug-${code.toLowerCase()}` }, secretNote: 'SECRET-price-note', ...over,
})
const sales = (over = {}) => ({
  mode: 'live', methods: { card: true, cod: false }, fopId: 'fop-2', offerVersion: '2026-11-03',
  codKind: 'control', codReceiptMode: 'ettn', skus: { 'V2-LID-R': rule() }, ...over,
})
const shopDocs = ({ cfg = sales(), materials = [material()], meta = fopMeta(), secret = fopSecret() } = {}) => ({
  ...(cfg ? { 'system/shopSales': cfg } : {}),
  ...(materials ? { 'priceList/current': { materials } } : {}),
  ...(meta ? { 'fops/fop-2': meta } : {}),
  ...(secret ? { 'fopSecrets/fop-2': secret } : {}),
})
const item = (over = {}) => ({
  sku: 'V2-LID-R', slug: 'slug-v2-lid-r', titleUk: 'Кришка V2-LID-R', priceUah: 800,
  orderable: true, showBuyButton: true, methods: { card: true, cod: false }, ...over,
})
const closedItem = (over = {}) => item({ orderable: false, showBuyButton: false, methods: { card: false, cod: false }, ...over })

// ---------- стенд ----------

let limiterNo = 0
const openLimiter = () => rateLimit({ name: `test-${++limiterNo}`, windowMs: 60 * 1000, max: 5000, keyFn: () => 'x' })
const npNever = async () => { throw new Error('НП не повинна викликатись') }

const stand = async (t, {
  db = new FakeDb(shopDocs()), token = TOKEN, np = npNever, notify = async () => true, npBudgetMs, npLimiter = openLimiter(), before, after,
} = {}) => {
  const calls = { np: [], alerts: [] }
  const was = process.env.SHOP_SITE_TOKEN
  if (token) process.env.SHOP_SITE_TOKEN = token
  else delete process.env.SHOP_SITE_TOKEN
  const app = express()
  app.use(express.json())
  if (before) before(app)
  registerShopOrders(app, {
    adminDb: db,
    npRequest: async (...args) => { calls.np.push(args); return np(...args) },
    hooks: createShopPaymentHooks({ adminDb: db, payments: { notifyOwner: async (text) => { calls.alerts.push(text); return notify(text) } }, mono: {} }),
    siteUrl: 'https://portal.test',
    npBudgetMs,
    npLimiter: npLimiter === 'default' ? undefined : npLimiter,
  })
  if (after) after(app)
  if (was === undefined) delete process.env.SHOP_SITE_TOKEN
  else process.env.SHOP_SITE_TOKEN = was
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  t.after(() => srv.close())
  const call = async (method, path, { body, raw, headers = { 'x-shop-token': TOKEN } } = {}) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
      method,
      headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    assert.match(r.headers.get('content-type') || '', /^application\/json/, `${method} ${path}: ${text}`)
    assert.ok(!text.includes('<'), `${method} ${path}: ${text}`)
    return { status: r.status, text, json: JSON.parse(text) }
  }
  const catalog = (opts) => call('GET', '/api/shop/catalog', opts)
  return { db, calls, call, catalog, feed: async () => { const r = await catalog(); assert.equal(r.status, 200, r.text); return r.json.data } }
}

const until = async (fn, what = 'умова') => {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > 2000) throw new Error(`не дочекались: ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const today = () => KYIV_DAY.format(new Date())
const errorOf = (r) => r.json.error.code

const SITE_ROUTES = [
  ['GET', '/api/shop/catalog'],
  ['POST', '/api/shop/np/cities', { q: 'Київ' }],
  ['POST', '/api/shop/np/warehouses', { cityRef: CITY }],
  ['GET', '/api/shop/nothing'],
  ['POST', '/api/shop/catalog', {}],
]

// ---------- токен ----------

test('токен: нет, чужой, другой длины, не тот заголовок, в адресе: 403 на всех маршрутах, база и НП не тронуты', async (t) => {
  const s = await stand(t)
  const bad = [
    {},
    { 'x-shop-token': 'x'.repeat(TOKEN.length) },
    { 'x-shop-token': TOKEN.slice(0, -1) },
    { 'x-shop-token': `${TOKEN}0` },
    { 'x-shop-token': TOKEN.toUpperCase() },
    { 'x-admin-token': TOKEN },
    { authorization: `Bearer ${TOKEN}` },
  ]
  for (const headers of bad) {
    for (const [method, path, body] of SITE_ROUTES) {
      const r = await s.call(method, path, { body, headers })
      assert.equal(r.status, 403, `${path} ${JSON.stringify(headers)}`)
      assert.deepEqual(r.json.success, false)
      assert.equal(errorOf(r), 'FORBIDDEN')
    }
  }
  assert.equal((await s.call('GET', `/api/shop/catalog?k=${TOKEN}&token=${TOKEN}`, { headers: {} })).status, 403)
  assert.deepEqual(s.db.reads, [])
  assert.deepEqual(s.calls.np, [])
})

test('токен не настроен: 503 на всех маршрутах, база и НП не тронуты', async (t) => {
  const s = await stand(t, { token: '' })
  for (const [method, path, body] of SITE_ROUTES) {
    const r = await s.call(method, path, { body })
    assert.equal(r.status, 503, path)
    assert.equal(errorOf(r), 'NOT_CONFIGURED')
  }
  assert.deepEqual(s.db.reads, [])
  assert.deepEqual(s.calls.np, [])
})

test('верный токен: лента отвечает 200 в стиле портала', async (t) => {
  const s = await stand(t)
  const r = await s.catalog()
  assert.equal(r.status, 200)
  assert.equal(r.json.success, true)
  assert.deepEqual(Object.keys(r.json), ['success', 'data'])
})

// ---------- лента: режимы ----------

test('лента: документа настроек нет: off, без продавца и товаров, прайс и ФОП не читаются', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ cfg: null })) })
  const d = await s.feed()
  assert.equal(d.mode, 'off')
  assert.equal(d.seller, null)
  assert.equal(d.offerVersion, '')
  assert.deepEqual(d.items, [])
  assert.deepEqual(s.db.reads, ['system/shopSales'])
})

test('лента: off отдаёт продавца и items:[], прайс не читает и его сбой выключателю не мешает', async (t) => {
  const db = new FakeDb(shopDocs({ cfg: sales({ mode: 'off' }) }))
  db.broken['priceList/current'] = true
  const s = await stand(t, { db })
  const d = await s.feed()
  assert.equal(d.mode, 'off')
  assert.deepEqual(d.seller, publicSeller)
  assert.equal(d.offerVersion, '2026-11-03')
  assert.deepEqual(d.items, [])
  assert.ok(!db.reads.includes('priceList/current'))
  await settle()
  assert.deepEqual(s.calls.alerts, [])
})

test('лента: неизвестный режим и режим другого типа работают как off', async (t) => {
  for (const mode of ['LIVE', 'on', '', 1, null, undefined]) {
    const cfg = sales({ mode })
    if (mode === undefined) delete cfg.mode
    const db = new FakeDb(shopDocs({ cfg }))
    db.broken['priceList/current'] = true
    const s = await stand(t, { db })
    const d = await s.feed()
    assert.equal(d.mode, 'off', String(mode))
    assert.deepEqual(d.items, [])
    assert.deepEqual(d.seller, publicSeller)
  }
})

test('лента: prices показывает цену, заказать нельзя', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ mode: 'prices' }) })) })
  const d = await s.feed()
  assert.equal(d.mode, 'prices')
  assert.deepEqual(d.items, [closedItem()])
})

test('лента: hidden принимает заказы без кнопки, live с кнопкой', async (t) => {
  const hidden = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ mode: 'hidden' }) })) })
  assert.deepEqual((await hidden.feed()).items, [item({ showBuyButton: false })])
  const live = await stand(t)
  const d = await live.feed()
  assert.equal(d.mode, 'live')
  assert.deepEqual(d.items, [item()])
  assert.deepEqual(d.seller, publicSeller)
  assert.equal(d.offerVersion, '2026-11-03')
  assert.ok(!Number.isNaN(Date.parse(d.generatedAt)))
})

test('лента: в ответе только условленные поля, секретов и служебного нет', async (t) => {
  const s = await stand(t)
  const r = await s.catalog()
  assert.deepEqual(Object.keys(r.json.data).sort(), ['generatedAt', 'items', 'mode', 'offerVersion', 'seller'])
  assert.deepEqual(Object.keys(r.json.data.items[0]).sort(), ['methods', 'orderable', 'priceUah', 'showBuyButton', 'sku', 'slug', 'titleUk'])
  for (const hidden of ['SECRET', 'fop-2', 'actualAddress', 'Фактична', 'codKind', 'minUah', 'dropped']) assert.ok(!r.text.includes(hidden), hidden)
})

test('лента: кэша нет: выключатель, цена и реквизиты действуют со следующего запроса', async (t) => {
  const s = await stand(t)
  assert.equal((await s.feed()).mode, 'live')
  s.db.docs['system/shopSales'].mode = 'off'
  assert.deepEqual((await s.feed()).items, [])
  s.db.docs['system/shopSales'].mode = 'live'
  s.db.docs['priceList/current'].materials[0].price = 900
  s.db.docs['fops/fop-2'].seller.displayName = 'Новий продавець'
  const d = await s.feed()
  assert.equal(d.items[0].priceUah, 900)
  assert.equal(d.seller.name, 'Новий продавець')
})

test('лента: прайса нет совсем: 200, товаров нет, алерт', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ materials: null })) })
  assert.deepEqual((await s.feed()).items, [])
  await until(() => s.calls.alerts.length === 1, 'алерт')
})

// ---------- лента: ФОП и артикул не готовы ----------

const NOT_READY = {
  'нет реквизитов': { meta: fopMeta({ seller: undefined }) },
  'реквизиты неполные': { meta: fopMeta({ seller: { ...seller(), ipn: '' } }) },
  'ФОП неактивен': { meta: fopMeta({ active: false }) },
  'нет галочки monobank': { meta: fopMeta({ methods: {} }) },
  'галочка снята': { meta: fopMeta({ methods: { monoAcquire: false } }) },
  'нет ключа monobank': { secret: fopSecret({ monoAcquire: {} }) },
  'нет ключа кассы': { secret: fopSecret({ checkbox: { pinCode: 'p' } }) },
  'нет кассира': { secret: fopSecret({ checkbox: { licenseKey: 'l' } }) },
  'нет ключа НП': { secret: fopSecret({ novaPoshta: {} }) },
  'нет отправителя НП': { meta: fopMeta({ novaPoshta: { contactRef: 'c' } }) },
  'нет секретов': { secret: null },
}

for (const [name, setup] of Object.entries(NOT_READY)) {
  test(`лента: ФОП не готов (${name}): цена видна, заказать нельзя, 200`, async (t) => {
    const s = await stand(t, { db: new FakeDb(shopDocs(setup)) })
    const d = await s.feed()
    assert.deepEqual(d.items, [closedItem()])
    await settle()
    assert.deepEqual(s.calls.alerts, [])
  })
}

test('лента: ФОП не задан или не найден: продавца нет, заказать нельзя', async (t) => {
  for (const docs of [shopDocs({ cfg: sales({ fopId: '' }) }), shopDocs({ cfg: sales({ fopId: '  ' }) }), shopDocs({ cfg: sales({ fopId: 5 }) }), shopDocs({ meta: null, secret: null })]) {
    const s = await stand(t, { db: new FakeDb(docs) })
    const d = await s.feed()
    assert.equal(d.seller, null)
    assert.deepEqual(d.items, [closedItem()])
  }
  const off = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ mode: 'off' }), meta: null, secret: null })) })
  const d = await off.feed()
  assert.equal(d.seller, null)
  assert.deepEqual(d.items, [])
})

test('лента: без SHOP_CALLBACK_BASE_URL карта закрыта: иначе счёт ушёл бы без колбэка', async (t) => {
  const was = process.env.SHOP_CALLBACK_BASE_URL
  delete process.env.SHOP_CALLBACK_BASE_URL
  t.after(() => { process.env.SHOP_CALLBACK_BASE_URL = was })
  const s = await stand(t)
  assert.deepEqual((await s.feed()).items, [closedItem()])
})

test('лента: неактивный ФОП без товаров: реквизиты остаются для страницы оферты', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ mode: 'off' }), meta: fopMeta({ active: false }) })) })
  assert.deepEqual((await s.feed()).seller, publicSeller)
})

test('лента: артикул снят, нет в наличии, склад пуст, способ выключен: orderable:false', async (t) => {
  const cases = [
    sales({ skus: { 'V2-LID-R': rule({ inStock: false }) } }),
    sales({ skus: { 'V2-LID-R': rule({ enabled: false }) } }),
    sales({ skus: { 'V2-LID-R': rule({ stock: 0 }) } }),
    sales({ methods: { card: false, cod: false } }),
    sales({ methods: undefined }),
  ]
  for (const cfg of cases) {
    const s = await stand(t, { db: new FakeDb(shopDocs({ cfg })) })
    assert.deepEqual((await s.feed()).items, [closedItem()], JSON.stringify(cfg))
  }
})

test('лента: наложка открыта только при разрешённой паре и галочке ФОП', async (t) => {
  const on = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ methods: { card: true, cod: true } }) })) })
  assert.deepEqual((await on.feed()).items[0].methods, { card: true, cod: true })
  const pair = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ methods: { card: true, cod: true }, codKind: 'money', codReceiptMode: 'ettn' }) })) })
  assert.deepEqual((await pair.feed()).items[0].methods, { card: true, cod: false })
})

test('лента: артикулы независимы: один без цены, другой продаётся', async (t) => {
  const cfg = sales({ skus: { 'V2-LID-R': rule(), 'V2-LID-H': rule(), 'V2-LID-RM': rule({ inStock: false }) } })
  const materials = [material(), material('V2-LID-H', { price: 5000 }), material('V2-LID-RM', { price: 900 })]
  const s = await stand(t, { db: new FakeDb(shopDocs({ cfg, materials })) })
  const d = await s.feed()
  assert.deepEqual(d.items.map((i) => [i.sku, i.priceUah, i.orderable]), [['V2-LID-R', 800, true], ['V2-LID-RM', 900, false]])
  await until(() => s.calls.alerts.length === 1, 'алерт')
  assert.match(s.calls.alerts[0], /V2-LID-H/)
})

// ---------- лента: выпавшая позиция ----------

const DROPS = {
  'material-errors': [material(), material()],
  'no-material': [material('V2-OTHER')],
  'not-published': [material('V2-LID-R', { active: false })],
  'no-card-data': [material('V2-LID-R', { name: {} })],
  'price-out-of-range': [material('V2-LID-R', { price: 90000 })],
}
const DROP_WORDS = {
  'material-errors': /кілька позицій/,
  'no-material': /немає позиції/,
  'not-published': /неактивна/,
  'no-card-data': /немає назви/,
  'price-out-of-range': /поза межами/,
}

for (const [reason, materials] of Object.entries(DROPS)) {
  test(`лента: позиция выпала (${reason}): её нет в ответе, алерт со следующим шагом и ссылкой, причина наружу не уходит`, async (t) => {
    const s = await stand(t, { db: new FakeDb(shopDocs({ materials })) })
    const r = await s.catalog()
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.data.items, [])
    assert.ok(!r.text.includes(reason))
    await until(() => s.calls.alerts.length === 1, 'алерт')
    const text = s.calls.alerts[0]
    assert.match(text, /V2-LID-R/)
    assert.match(text, DROP_WORDS[reason])
    assert.match(text, /https:\/\/portal\.test\/shop-orders$/)
    assert.ok(!text.includes('undefined'))
    assert.ok(!text.includes(TOKEN))
  })
}

test('алерт ленты: один в сутки на артикул, на всех экземплярах, sentAt записан', async (t) => {
  const db = new FakeDb(shopDocs({ materials: [] }))
  const a = await stand(t, { db })
  const b = await stand(t, { db })
  await a.feed()
  await until(() => db.docs[`shopDaily/${today()}`]?.alerts?.['feed-V2-LID-R']?.sentAt, 'sentAt')
  await a.feed()
  await b.feed()
  await settle()
  assert.equal(a.calls.alerts.length, 1)
  assert.equal(b.calls.alerts.length, 0)
  const saved = db.docs[`shopDaily/${today()}`].alerts['feed-V2-LID-R']
  assert.equal(saved.text, a.calls.alerts[0])
  assert.ok(Date.parse(saved.at) && Date.parse(saved.sentAt))
})

test('алерт ленты: вчерашняя метка сегодняшнему не мешает, сегодняшняя глушит', async (t) => {
  const yesterday = KYIV_DAY.format(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const old = new FakeDb({ ...shopDocs({ materials: [] }), [`shopDaily/${yesterday}`]: { alerts: { 'feed-V2-LID-R': { at: 'x', sentAt: 'x', text: 'x' } } } })
  const s = await stand(t, { db: old })
  await s.feed()
  await until(() => s.calls.alerts.length === 1, 'алерт')

  const fresh = new FakeDb({ ...shopDocs({ materials: [] }), [`shopDaily/${today()}`]: { unpaid: 3, alerts: { 'feed-V2-LID-R': { at: 'x', sentAt: 'x', text: 'x' } } } })
  const silent = await stand(t, { db: fresh })
  await silent.feed()
  await settle()
  assert.deepEqual(silent.calls.alerts, [])
  assert.equal(fresh.docs[`shopDaily/${today()}`].unpaid, 3)
  // Пустой alerts при merge в настоящем Firestore стёр бы метки дня, поэтому записи быть не должно.
  assert.deepEqual(fresh.writes, [])
})

test('алерт ленты: сутки считаются по Киеву, как в shopDaily у оплат', async (t) => {
  // 22:30 UTC 3 ноября: в Киеве уже 4 ноября.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T22:30:00.000Z') })
  const s = await stand(t, { db: new FakeDb(shopDocs({ materials: [] })) })
  await s.feed()
  await until(() => s.calls.alerts.length === 1, 'алерт')
  assert.ok(s.db.docs['shopDaily/2026-11-04'])
  assert.equal(s.db.docs['shopDaily/2026-11-03'], undefined)
})

test('алерт ленты: не трогает счётчики дня и шлёт только по новым артикулам', async (t) => {
  const cfg = sales({ skus: { 'V2-LID-R': rule(), 'V2-LID-H': rule() } })
  const db = new FakeDb({ ...shopDocs({ cfg, materials: [] }), [`shopDaily/${today()}`]: { unpaid: 3, sms: 2, alerts: { 'feed-V2-LID-R': { at: 'x', sentAt: 'x', text: 'старий' } } } })
  const s = await stand(t, { db })
  await s.feed()
  await until(() => s.calls.alerts.length === 1, 'алерт')
  assert.match(s.calls.alerts[0], /V2-LID-H/)
  await until(() => db.docs[`shopDaily/${today()}`].alerts['feed-V2-LID-H']?.sentAt, 'sentAt')
  const day = db.docs[`shopDaily/${today()}`]
  assert.equal(day.unpaid, 3)
  assert.equal(day.sms, 2)
  assert.equal(day.alerts['feed-V2-LID-R'].text, 'старий')
})

test('алерт ленты: Telegram не ответил: sentAt пуст, в этих сутках лента не шлёт снова (повтор за сверкой)', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ materials: [] })), notify: async () => false })
  await s.feed()
  await until(() => s.calls.alerts.length === 1, 'алерт')
  await settle()
  await s.feed()
  await settle()
  assert.equal(s.calls.alerts.length, 1)
  const saved = s.db.docs[`shopDaily/${today()}`].alerts['feed-V2-LID-R']
  assert.equal(saved.sentAt, null)
  assert.ok(saved.text)
})

test('алерт ленты: зависший Telegram не задерживает ответ', async (t) => {
  const s = await stand(t, { db: new FakeDb(shopDocs({ materials: [] })), notify: () => new Promise(() => {}) })
  assert.deepEqual((await s.feed()).items, [])
  await until(() => s.calls.alerts.length === 1, 'алерт')
  assert.deepEqual((await s.feed()).items, [])
})

test('алерт ленты: сбой транзакции ленту не ломает', async (t) => {
  const db = new FakeDb(shopDocs({ materials: [] }))
  db.txError = new Error('транзакція впала')
  const logs = []
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')) })
  const s = await stand(t, { db })
  assert.deepEqual((await s.feed()).items, [])
  await until(() => logs.length === 1, 'журнал')
  assert.match(logs[0], /алерт стрічки/)
  assert.deepEqual(s.calls.alerts, [])
})

test('алерт ленты: выключенный владельцем артикул не беспокоит, в режиме off алертов нет', async (t) => {
  const disabled = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ skus: { 'V2-LID-R': rule({ enabled: false }) } }), materials: [] })) })
  assert.deepEqual((await disabled.feed()).items, [])
  await settle()
  assert.deepEqual(disabled.calls.alerts, [])
  assert.ok(!disabled.db.reads.some((p) => p.startsWith('shopDaily/')))
  assert.deepEqual(disabled.db.writes, [])

  const off = await stand(t, { db: new FakeDb(shopDocs({ cfg: sales({ mode: 'off' }), materials: [] })) })
  await off.feed()
  await settle()
  assert.deepEqual(off.calls.alerts, [])
})

// ---------- лента: сбои чтения ----------

test('лента: сбой чтения настроек, прайса или ФОП даёт 503, а не 200 с пустым списком и не алерт', async (t) => {
  for (const path of ['system/shopSales', 'priceList/current', 'fops/fop-2', 'fopSecrets/fop-2']) {
    const db = new FakeDb(shopDocs())
    db.broken[path] = true
    const logs = []
    const mock = t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')) })
    const s = await stand(t, { db })
    const r = await s.catalog()
    mock.mock.restore()
    assert.equal(r.status, 503, path)
    assert.equal(r.json.success, false)
    assert.equal(errorOf(r), 'CATALOG_UNAVAILABLE')
    assert.ok(!r.text.includes(path), 'путь базы наружу не уходит')
    assert.equal(logs.length, 1)
    await settle()
    assert.deepEqual(s.calls.alerts, [])
  }
})

test('лента: Firestore не поднялся (adminDb null): 503', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const s = await stand(t, { db: null })
  const r = await s.catalog()
  logs.mock.restore()
  assert.equal(r.status, 503)
  assert.equal(errorOf(r), 'CATALOG_UNAVAILABLE')
})

// ---------- только JSON ----------

test('JSON: битое тело: без токена 403, с токеном 400, токен не настроен 503', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')) })
  const raw = '{"phone":"+380671234567",'
  const s = await stand(t)
  const open = await s.call('POST', '/api/shop/np/cities', { raw, headers: {} })
  assert.equal(open.status, 403)
  assert.equal(errorOf(open), 'FORBIDDEN')
  const bad = await s.call('POST', '/api/shop/np/cities', { raw })
  assert.equal(bad.status, 400)
  assert.equal(errorOf(bad), 'BAD_INPUT')
  assert.ok(!bad.text.includes('380671234567'))
  const none = await stand(t, { token: '' })
  assert.equal((await none.call('POST', '/api/shop/np/cities', { raw })).status, 503)
  assert.deepEqual(logs.filter((l) => l.includes('380671234567')), [], 'тело покупателя не в журнале')
  assert.deepEqual(s.calls.np, [])
})

test('JSON: слишком большое тело: 413 в том же виде', async (t) => {
  const s = await stand(t)
  const r = await s.call('POST', '/api/shop/np/cities', { body: { q: 'я'.repeat(200 * 1024) } })
  assert.equal(r.status, 413)
  assert.equal(errorOf(r), 'BAD_INPUT')
  assert.deepEqual(s.calls.np, [])
})

test('JSON: чужая ошибка без статуса: 500 без подробностей', async (t) => {
  const boom = (app) => app.use('/api/shop/boom', (_req, _res, next) => next(new Error('деталь-сбою')))
  const s = await stand(t, { before: boom })
  const r = await s.call('GET', '/api/shop/boom')
  assert.equal(r.status, 500)
  assert.equal(errorOf(r), 'INTERNAL')
  assert.ok(!r.text.includes('деталь-сбою'))
  for (const status of [502, 302]) {
    const failing = (app) => app.use('/api/shop/failing', (_req, _res, next) => next(Object.assign(new Error('x'), { status })))
    const other = await stand(t, { before: failing })
    const r2 = await other.call('GET', '/api/shop/failing')
    assert.equal(r2.status, 500, 'не клиентская ошибка не выдаётся за неё')
    assert.equal(errorOf(r2), 'INTERNAL')
    assert.equal((await other.call('GET', '/api/shop/failing', { headers: {} })).status, 403)
  }
})

test('JSON: адрес мимо маршрута и чужой метод: 404 с токеном, 403 без него', async (t) => {
  const s = await stand(t)
  for (const [method, path] of [['GET', '/api/shop'], ['GET', '/api/shop/'], ['GET', '/api/shop/orders'], ['POST', '/api/shop/catalog'], ['GET', '/api/shop/np/cities'], ['DELETE', '/api/shop/np/warehouses'], ['GET', '/API/SHOP/nothing']]) {
    const r = await s.call(method, path)
    assert.equal(r.status, 404, `${method} ${path}`)
    assert.equal(errorOf(r), 'NOT_FOUND')
    assert.equal((await s.call(method, path, { headers: {} })).status, 403, `${method} ${path}`)
  }
})

test('адреса: /api/shop/admin и чужие адреса не закрыты токеном сайта, зарегистрировать их можно и позже', async (t) => {
  const ok = (_req, res) => res.json({ reached: true })
  const later = (app) => {
    app.get('/api/shop/admin', ok)
    app.get('/api/shop/admin/orders', ok)
    app.post('/api/shop/admin/settings', ok)
    app.get('/api/shopping', ok)
    app.get('/api/shop-other', ok)
  }
  const s = await stand(t, { after: later })
  for (const [method, path] of [['GET', '/api/shop/admin'], ['GET', '/api/shop/admin/orders'], ['GET', '/API/SHOP/ADMIN/orders'], ['POST', '/api/shop/admin/settings'], ['GET', '/api/shopping'], ['GET', '/api/shop-other']]) {
    const r = await s.call(method, path, { headers: {} })
    assert.equal(r.status, 200, path)
    assert.equal(r.json.reached, true)
  }
  // Похожее на admin имя остаётся под токеном.
  assert.equal((await s.call('GET', '/api/shop/administrator', { headers: {} })).status, 403)
})

// ---------- Новая Почта: города ----------

const address = (over = {}) => ({ Present: 'м. Київ, Київська обл.', MainDescription: 'Київ', Area: 'Київська', Region: '', Ref: SETTLEMENT, DeliveryCity: CITY, Warehouses: 100, ...over })
const npOk = (data) => async () => ({ success: true, data, errors: [] })
const citiesOk = (...found) => npOk([{ TotalCount: found.length, Addresses: found }])

test('НП, города: ref это DeliveryCity, а не Settlement; лишние поля не уходят; запрос к НП как у прокси портала', async (t) => {
  const s = await stand(t, { np: citiesOk(address(), address({ Present: 'с. Бровари', Area: 'Київська', DeliveryCity: WH })) })
  const r = await s.call('POST', '/api/shop/np/cities', { body: { q: 'Ки' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { success: true, data: { items: [
    { ref: CITY, name: 'м. Київ, Київська обл.', area: 'Київська' },
    { ref: WH, name: 'с. Бровари', area: 'Київська' },
  ] } })
  assert.deepEqual(s.calls.np, [['Address', 'searchSettlements', { CityName: 'Ки', Limit: 20 }]])
})

test('НП, города: строка без рефа доставки, с кривым рефом или без названия отбрасывается; регистр рефа приводится', async (t) => {
  const s = await stand(t, { np: citiesOk(
    address({ DeliveryCity: '' }), address({ DeliveryCity: undefined }), address({ DeliveryCity: 'not-a-ref' }), address({ Present: '' }),
    null, address({ DeliveryCity: CITY.toUpperCase(), Area: undefined }),
  ) })
  const r = await s.call('POST', '/api/shop/np/cities', { body: { q: 'Київ' } })
  assert.deepEqual(r.json.data.items, [{ ref: CITY, name: 'м. Київ, Київська обл.', area: '' }])
})

test('НП, города: q короче 2 или длиннее 60, не строка: 400 без запроса к НП', async (t) => {
  const s = await stand(t, { np: citiesOk() })
  const bad = [{}, { q: '' }, { q: 'я' }, { q: '   ' }, { q: '  я  ' }, { q: 'я'.repeat(61) }, { q: 5 }, { q: null }, { q: ['Київ'] }, { q: { a: 'Київ' } }, ['Київ'], { query: 'Київ' }]
  for (const body of bad) {
    const r = await s.call('POST', '/api/shop/np/cities', { body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(r.json.success, false)
    assert.equal(errorOf(r), 'BAD_INPUT')
    assert.deepEqual(r.json.error.fields, ['q'])
  }
  assert.deepEqual(s.calls.np, [])
})

test('НП, города: границы q и обрезка пробелов', async (t) => {
  const s = await stand(t, { np: citiesOk() })
  for (const [q, sent] of [['яя', 'яя'], ['я'.repeat(60), 'я'.repeat(60)], [`  Київ  `, 'Київ'], [` ${'я'.repeat(60)} `, 'я'.repeat(60)]]) {
    assert.equal((await s.call('POST', '/api/shop/np/cities', { body: { q } })).status, 200, q)
    assert.equal(s.calls.np.at(-1)[2].CityName, sent)
  }
})

test('НП, города: ничего не найдено: 200 и пустой список, это не сбой', async (t) => {
  for (const data of [[], [{ TotalCount: 0, Addresses: [] }], [{ TotalCount: 0 }], [null]]) {
    const s = await stand(t, { np: npOk(data) })
    const r = await s.call('POST', '/api/shop/np/cities', { body: { q: 'Ніде' } })
    assert.equal(r.status, 200, JSON.stringify(data))
    assert.deepEqual(r.json, { success: true, data: { items: [] } })
  }
})

// ---------- Новая Почта: сбои ----------

const NP_FAILURES = {
  'сеть': async () => { throw new Error('connect ETIMEDOUT SECRET-host') },
  'НП отказала': async () => ({ success: false, data: [], errors: ['API key is not valid SECRET-np'] }),
  'страница вместо JSON': async () => '<html>SECRET-page</html>',
  'нет data': async () => ({ success: true }),
  'data не список': async () => ({ success: true, data: { a: 1 } }),
  'нет ответа': async () => null,
  'нет success': async () => ({ data: [] }),
  'success строкой': async () => ({ success: 'true', data: [] }),
}

for (const [name, np] of Object.entries(NP_FAILURES)) {
  test(`НП: ${name}: 502 NP_UNAVAILABLE на обоих маршрутах, текст НП наружу не уходит`, async (t) => {
    const logs = t.mock.method(console, 'error', () => {})
    const s = await stand(t, { np })
    for (const [path, body] of [['/api/shop/np/cities', { q: 'Київ' }], ['/api/shop/np/warehouses', { cityRef: CITY }]]) {
      const r = await s.call('POST', path, { body })
      assert.equal(r.status, 502, path)
      assert.equal(r.json.success, false)
      assert.equal(errorOf(r), 'NP_UNAVAILABLE')
      assert.ok(!r.text.includes('SECRET'))
    }
    assert.equal(logs.mock.callCount(), 2)
  })
}

test('НП: не уложилась в бюджет: 502, портал отвечает раньше тайм-аута сайта', async (t) => {
  const logs = t.mock.method(console, 'error', () => {})
  const s = await stand(t, { np: () => new Promise(() => {}), npBudgetMs: 20 })
  for (const [path, body] of [['/api/shop/np/cities', { q: 'Київ' }], ['/api/shop/np/warehouses', { cityRef: CITY }]]) {
    const started = Date.now()
    const r = await s.call('POST', path, { body })
    assert.equal(r.status, 502, path)
    assert.equal(errorOf(r), 'NP_UNAVAILABLE')
    assert.ok(Date.now() - started < 2000)
  }
  assert.equal(logs.mock.callCount(), 2)
})

test('НП: бюджет по умолчанию меньше тайм-аута чтения на сайте (8 с)', () => {
  const src = readFileSync(new URL('./shopOrders.js', import.meta.url), 'utf8')
  const ms = Number(src.match(/const NP_BUDGET_MS = (\d+)/)[1])
  assert.ok(ms > 0 && ms < 8000, String(ms))
})

// ---------- Новая Почта: отделения ----------

const wh = (over = {}) => ({ Ref: WH, Description: 'Відділення №1: вул. Пирогівський шлях, 135', DescriptionRu: 'Отделение №1', TypeOfWarehouse: '841339c7-591a-42e2-8233-7a0a00f0ed6f', CityRef: CITY, Number: '1', ...over })

test('НП, отделения: только ref и name; запрос к НП как у прокси портала', async (t) => {
  const s = await stand(t, { np: npOk([wh(), wh({ Ref: WH2, Description: 'Відділення №2' })]) })
  const r = await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { success: true, data: { items: [
    { ref: WH, name: 'Відділення №1: вул. Пирогівський шлях, 135' },
    { ref: WH2, name: 'Відділення №2' },
  ] } })
  assert.deepEqual(s.calls.np, [['Address', 'getWarehouses', { CityRef: CITY, FindByString: '', Limit: 5000 }]])
})

test('НП, отделения: поштоматы не попадают: по типу, по названию на двух языках, в любом регистре', async (t) => {
  const s = await stand(t, { np: npOk([
    wh({ Ref: WH2, Description: 'Звичайна назва', TypeOfWarehouse: POSTOMAT_TYPE }),
    wh({ Ref: WH2, Description: 'Поштомат "Нова Пошта" №1' }),
    wh({ Ref: WH2, Description: 'ПОШТОМАТ №2' }),
    wh({ Ref: WH2, Description: 'Пункт видачі', DescriptionRu: 'Почтомат №3' }),
    wh(),
  ]) })
  const r = await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY } })
  assert.deepEqual(r.json.data.items.map((i) => i.ref), [WH])
})

test('НП, отделения: строка без названия, с кривым рефом и не объект отбрасываются; регистр рефа приводится', async (t) => {
  const s = await stand(t, { np: npOk([wh({ Ref: 'bad' }), wh({ Ref: undefined }), wh({ Description: '' }), null, wh({ Ref: WH.toUpperCase() })]) })
  const r = await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY } })
  assert.deepEqual(r.json.data.items, [{ ref: WH, name: wh().Description }])
})

test('НП, отделения: кривой cityRef: 400 без запроса к НП; регистр и пробелы приводятся', async (t) => {
  const s = await stand(t, { np: npOk([]) })
  for (const body of [{}, { cityRef: '' }, { cityRef: 'Київ' }, { cityRef: `${CITY}x` }, { cityRef: 5 }, { cityRef: null }, { cityRef: [CITY] }, [CITY]]) {
    const r = await s.call('POST', '/api/shop/np/warehouses', { body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(errorOf(r), 'BAD_INPUT')
    assert.deepEqual(r.json.error.fields, ['cityRef'])
  }
  assert.deepEqual(s.calls.np, [])
  assert.equal((await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: ` ${CITY.toUpperCase()} ` } })).status, 200)
  assert.equal(s.calls.np[0][2].CityRef, CITY)
})

test('НП, отделения: в городе ничего нет или одни поштоматы: 200 и пустой список', async (t) => {
  for (const data of [[], [wh({ TypeOfWarehouse: POSTOMAT_TYPE })]]) {
    const s = await stand(t, { np: npOk(data) })
    const r = await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY } })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.data.items, [])
  }
})

// ---------- Новая Почта: лимит ----------

test('НП: лимит общий на оба маршрута: 429 в стиле портала, НП не вызывается; запросы без токена его не тратят', async (t) => {
  const npLimiter = rateLimit({ name: 'test-tight', windowMs: 60 * 1000, max: 2, keyFn: () => 'x' })
  const s = await stand(t, { np: npOk([]), npLimiter })
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await s.call('POST', '/api/shop/np/cities', { body: { q: 'Київ' }, headers: {} })).status, 403)
    assert.equal((await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY }, headers: {} })).status, 403)
  }
  assert.equal((await s.call('POST', '/api/shop/np/cities', { body: { q: 'Київ' } })).status, 200)
  assert.equal((await s.call('POST', '/api/shop/np/warehouses', { body: { cityRef: CITY } })).status, 200)
  for (const [path, body] of [['/api/shop/np/cities', { q: 'Київ' }], ['/api/shop/np/warehouses', { cityRef: CITY }]]) {
    const r = await s.call('POST', path, { body })
    assert.equal(r.status, 429, path)
    assert.equal(r.json.success, false)
    assert.equal(errorOf(r), 'RATE_LIMITED')
  }
  assert.equal(s.calls.np.length, 2)
  // Лента под этот лимит не подпадает.
  assert.equal((await s.catalog()).status, 200)
})

test('НП: лимит по умолчанию 300 в минуту и не зависит от адреса: сервер сайта один', async (t) => {
  const s = await stand(t, { np: npOk([]), npLimiter: 'default' })
  for (let i = 0; i < 300; i += 1) {
    const r = await s.call('POST', '/api/shop/np/cities', { body: {}, headers: { 'x-shop-token': TOKEN, 'x-forwarded-for': `10.0.0.${i % 250}` } })
    assert.equal(r.status, 400, String(i))
  }
  const r = await s.call('POST', '/api/shop/np/cities', { body: {}, headers: { 'x-shop-token': TOKEN, 'x-forwarded-for': '10.1.1.1' } })
  assert.equal(r.status, 429)
})

// ---------- подключение ----------

test('index.js: маршруты до json-server, с настоящими npRequest и хуками оплат', () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const register = src.indexOf('registerShopOrders(app, { adminDb, npRequest, hooks: shopHooks, payments: paymentsApi, siteUrl: SITE_URL })')
  assert.ok(register > 0)
  assert.ok(register < src.indexOf('jsonServer.router('))
  assert.ok(src.indexOf('const npRequest = ') < register)
  assert.ok(src.indexOf('paymentsApi.setShopHooks(shopHooks)') > 0)
  assert.ok(src.indexOf('const shopHooks = createShopPaymentHooks(') < register)
})
