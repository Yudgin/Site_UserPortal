// Правила магазина на runferry.ua без Firestore и сети: проверка заказа, отпечаток, токен статуса, переходы состояний,
// гейт ФОП, лента для сайта, статусы Новой Почты. Чтение, запись и транзакции делают маршруты магазина.
import crypto from 'crypto'
import { normPhone } from './phone.js'
import { SKU_RE, findMaterial } from './siteCatalog.js'
import { NP_DELIVERED, NP_GONE, npDateToIso } from './incomingRefresh.js'

export { NP_DELIVERED, NP_GONE, npDateToIso }

export const SALES_MODES = ['off', 'prices', 'hidden', 'live']
export const SHOP_METHODS = ['card', 'cod']

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const filled = (v) => !!v && String(v).trim() !== ''

// ---------- вход заказа ----------

// Без пробелов: Новая Почта делит имя получателя по пробелам (novaPoshtaTtn.js).
const NAME_RE = /^[\p{Script=Cyrillic}'’ʼ-]{2,40}$/u
const NP_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// +380 и 9 цифр. normPhone вынимает номер и из склейки цифр: здесь это чужой номер, поэтому такой ввод не берём.
// Абонентский номер не начинается с нуля: это потерянная цифра, а телефон для покупателя единственный канал.
export const shopPhone = (raw) => {
  if (typeof raw !== 'string' || !/^[\d\s()+-]+$/.test(raw)) return ''
  const phone = normPhone(raw)
  const prefix = raw.replace(/\D/g, '').slice(0, -9)
  return /^\+380[1-9]\d{8}$/.test(phone) && ['', '0', '80', '380', '00380'].includes(prefix) ? phone : ''
}

export const maskPhone = (phone) => (/^\+380\d{9}$/.test(String(phone || '')) ? `+380•••••••${phone.slice(-2)}` : '')

// Белый список полей: цена, ФОП, язык и адрес возврата из тела в value не попадают.
export function validateOrderInput(body) {
  const b = body && typeof body === 'object' ? body : {}
  const value = {
    idempotencyKey: str(b.idempotencyKey),
    sku: str(b.sku),
    qty: b.qty,
    method: b.method,
    lastName: str(b.lastName),
    firstName: str(b.firstName),
    middleName: str(b.middleName),
    phone: shopPhone(b.phone),
    email: str(b.email).toLowerCase(),
    cityRef: str(b.cityRef).toLowerCase(),
    cityName: str(b.cityName).slice(0, 120),
    warehouseRef: str(b.warehouseRef).toLowerCase(),
    warehouseName: str(b.warehouseName).slice(0, 200),
    offerVersion: str(b.offerVersion),
    consentOffer: b.consentOffer,
    consentPersonalData: b.consentPersonalData,
    expectedTotalUah: b.expectedTotalUah,
  }
  const checks = {
    idempotencyKey: KEY_RE.test(value.idempotencyKey),
    sku: SKU_RE.test(value.sku),
    qty: value.qty === 1,
    method: SHOP_METHODS.includes(value.method),
    lastName: NAME_RE.test(value.lastName),
    firstName: NAME_RE.test(value.firstName),
    middleName: !value.middleName || NAME_RE.test(value.middleName),
    phone: !!value.phone,
    email: !value.email || (value.email.length <= 120 && EMAIL_RE.test(value.email)),
    cityRef: NP_REF_RE.test(value.cityRef),
    cityName: !!value.cityName,
    warehouseRef: NP_REF_RE.test(value.warehouseRef),
    warehouseName: !!value.warehouseName,
    offerVersion: !!value.offerVersion && value.offerVersion.length <= 40,
    consentOffer: value.consentOffer === true,
    consentPersonalData: value.consentPersonalData === true,
    expectedTotalUah: Number.isFinite(value.expectedTotalUah) && value.expectedTotalUah >= 0,
  }
  const fields = Object.keys(checks).filter((k) => !checks[k])
  return fields.length ? { ok: false, fields } : { ok: true, value }
}

// Отпечаток считается по value из validateOrderInput: телефон и почта там уже приведены к одному виду.
export const orderFingerprint = (v) => sha256(JSON.stringify([
  v.sku, v.qty, v.method, v.lastName, v.firstName, v.middleName, v.phone, v.email, v.cityRef, v.warehouseRef,
]))

export const orderIdFromKey = (idempotencyKey) => 'so-' + sha256(idempotencyKey).slice(0, 32)
export const phoneKeyOf = (phone) => sha256(phone)

// Адрес страницы статуса: 128 случайных бит, не зависят от телефона и номера заказа.
export const STATUS_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
export const newStatusToken = () => crypto.randomBytes(16).toString('base64url')

export const phoneCodeHash = (token, code) => sha256(`${token}:${code}`)

// ---------- переходы состояний ----------

const NEXT_STATES = {
  phone_pending: ['cod_confirmed', 'cancelled', 'expired'],
  cod_confirmed: ['shipped', 'cancelled'],
  awaiting_payment: ['paid', 'payment_review', 'cancelled', 'expired'],
  paid: ['shipped', 'reversed'],
  shipped: ['delivered', 'refused', 'paid', 'cod_confirmed', 'reversed'],
  delivered: ['reversed'],
  refused: ['returned', 'reversed'],
  returned: ['reversed'],
  payment_review: ['paid', 'reversed'],
  reversed: [],
  cancelled: ['payment_review'],
  expired: ['payment_review'],
}
export const SHOP_STATES = Object.keys(NEXT_STATES)
const CARD_ONLY = new Set(['paid', 'payment_review', 'reversed'])

export const canTransition = (order, to) => {
  if (!(NEXT_STATES[order?.state] || []).includes(to)) return false
  if (CARD_ONLY.has(to)) return order.method === 'card'
  if (to === 'cod_confirmed') return order.method === 'cod'
  return true
}

// Что записать при переходе; null, если такого перехода нет. Строка истории как в хуках оплаты (shopPayments.js).
export function transitionPatch(order, to, { at = new Date().toISOString(), by = null, patch = {} } = {}) {
  if (!canTransition(order, to)) return null
  return { ...patch, state: to, history: [...(order.history || []), { at, from: order.state, to, by }], updatedAt: at }
}

// ---------- продавец и гейт ФОП ----------

// actualAddress необязателен: нужен ли он отдельно, решает юрист, и наружу он не отдаётся.
const SELLER_REQUIRED = ['displayName', 'ipn', 'address', 'email', 'phone']
export const sellerFilled = (seller) => !!seller && SELLER_REQUIRED.every((k) => filled(seller[k]))

// То, что видит покупатель: лента, оферта, страница статуса.
export const publicSeller = (fop) => {
  const s = fop && fop.seller
  if (!sellerFilled(s)) return null
  return { name: s.displayName, ipn: s.ipn, address: s.address, email: s.email, phone: s.phone }
}

// Условия Новой Почты. Отдельно, потому что маршрут накладной проверяет только их:
// снятая галочка способа не должна мешать отправить оплаченное.
export const npMissing = (fop) => {
  const np = (fop && fop.novaPoshta) || {}
  return ['apiKey', 'senderRef', 'contactRef', 'senderPhone', 'cityRef', 'warehouseRef']
    .filter((k) => !filled(np[k]))
    .map((k) => `novaPoshta.${k}`)
}

// Наложка: только эти две пары. Деньги переводом и авточек Checkbox вместе запрещены, пока Checkbox письменно не подтвердит.
export const codPairAllowed = (kind, receiptMode) => (kind === 'control' && receiptMode === 'ettn') || (kind === 'money' && receiptMode === 'manual')

// Можно ли принять новый заказ или счёт. Только для них: оплаченное отправляется и чекуется без этого гейта.
// Галочка строго true: methodOn считает отсутствующий ключ включённым. Выключатели магазина (cfg.methods) здесь не смотрим:
// тестовый телефон наложки проходит при выключенном способе. priceUah нужен наложке.
export function shopSellable(fop, method, cfg, { priceUah, callbackBaseUrl = process.env.SHOP_CALLBACK_BASE_URL } = {}) {
  if (!fop) return { ok: false, code: 'NOT_CONFIGURED', missing: ['fop'] }
  const missing = []
  const need = (ok, name) => { if (!ok) missing.push(name) }
  need(fop.active !== false, 'active')
  need(sellerFilled(fop.seller), 'seller')
  missing.push(...npMissing(fop))

  const methods = fop.methods || {}
  const cb = fop.checkbox || {}
  const cashier = filled(cb.pinCode) || (filled(cb.login) && filled(cb.password))
  let methodOff = false
  if (method === 'card') {
    methodOff = methods.monoAcquire !== true
    need(!methodOff, 'methods.monoAcquire')
    need(filled(fop.monoAcquire && fop.monoAcquire.token), 'monoAcquire.token')
    need(filled(cb.licenseKey), 'checkbox.licenseKey')
    need(cashier, 'checkbox.cashier')
    need(filled(callbackBaseUrl), 'SHOP_CALLBACK_BASE_URL')
  } else if (method === 'cod') {
    methodOff = methods.cod !== true
    need(!methodOff, 'methods.cod')
    need(Number.isInteger(priceUah), 'priceUah')
    const kind = cfg && cfg.codKind
    const receiptMode = cfg && cfg.codReceiptMode
    need(codPairAllowed(kind, receiptMode), 'codPair')
    if (kind === 'control' && receiptMode === 'ettn') {
      need(filled(cb.licenseKey), 'checkbox.licenseKey')
      need(cashier, 'checkbox.cashier') // заготовка чека создаётся от кассира
    }
  } else {
    missing.push('method')
  }
  if (!missing.length) return { ok: true }
  return { ok: false, code: methodOff ? 'METHOD_OFF' : 'NOT_CONFIGURED', missing }
}

// ---------- лента ----------

// Позиция из прайса, которой можно назвать цену: условия как в siteCatalog.relatedPartsLine плюс границы из настроек.
// Цена только из прайса, границы ловят опечатку в нём.
export function pricedItem(priceList, sku, rule) {
  const errors = []
  const m = findMaterial(priceList, sku, errors)
  if (errors.length) return { reason: 'material-errors', errors }
  if (!m) return { reason: 'no-material' }
  if (!m.active || !m.site || m.site.status !== 'published') return { reason: 'not-published' }
  const slug = str(m.site.slug)
  const titleUk = str(m.name && m.name.uk)
  if (!slug || !titleUk) return { reason: 'no-card-data' }
  const { minUah, maxUah } = rule || {}
  if (!Number.isFinite(m.price) || m.price <= 0 || !Number.isFinite(minUah) || !Number.isFinite(maxUah) || m.price < minUah || m.price > maxUah) {
    return { reason: 'price-out-of-range' }
  }
  return { item: { sku, slug, titleUk, priceUah: m.price } }
}

export const skuOnSale = (rule) => !!rule && rule.enabled === true && rule.inStock === true && !(typeof rule.stock === 'number' && rule.stock <= 0)

// feed уходит сайту. dropped только для алерта: сюда попадают артикулы из настроек, у которых нельзя назвать цену.
// Способ в ленте открыт, если его включили в настройках и ФОП прошёл гейт; иначе форма отказала бы уже после заполнения.
export function buildCatalogFeed({ sales, priceList, fop, now = new Date().toISOString(), callbackBaseUrl } = {}) {
  const cfg = sales || {}
  const mode = SALES_MODES.includes(cfg.mode) ? cfg.mode : 'off'
  const feed = { generatedAt: now, mode, offerVersion: str(cfg.offerVersion), seller: publicSeller(fop), items: [] }
  const dropped = []
  if (mode === 'off') return { feed, dropped }
  const cfgMethods = cfg.methods || {}
  for (const [sku, rule] of Object.entries(cfg.skus || {})) {
    const { item, reason, errors } = pricedItem(priceList, sku, rule)
    if (!item) {
      dropped.push({ sku, reason, ...(errors ? { errors } : {}) })
      continue
    }
    const open = (mode === 'hidden' || mode === 'live') && skuOnSale(rule)
    const methods = {
      card: open && cfgMethods.card === true && shopSellable(fop, 'card', cfg, { callbackBaseUrl }).ok,
      cod: open && cfgMethods.cod === true && shopSellable(fop, 'cod', cfg, { callbackBaseUrl, priceUah: item.priceUah }).ok,
    }
    const orderable = methods.card || methods.cod
    feed.items.push({ ...item, orderable, showBuyButton: orderable && mode === 'live', methods })
  }
  return { feed, dropped }
}

// ---------- Новая Почта ----------

export const NP_REFUSED = new Set(['102', '103', '108', '105'])
export const NP_NOT_HANDED = '1'
const NP_NOT_FOUND_GRACE_MS = 3 * 24 * 60 * 60 * 1000

// Что значит код НП для отправленного заказа. none: ничего не менять. 3 «номер не найден» бывает и у свежей накладной,
// поэтому заказ вернётся назад только через 3 дня; без даты отправки не возвращаем.
export function npOutcome(code, { shippedAt, now = Date.now() } = {}) {
  const c = String(code ?? '').trim()
  if (!c) return 'none'
  if (NP_DELIVERED.has(c)) return 'delivered'
  if (NP_REFUSED.has(c)) return 'refused'
  if (NP_GONE.has(c)) return c === '2' || now - Date.parse(shippedAt) > NP_NOT_FOUND_GRACE_MS ? 'back' : 'none'
  return c === NP_NOT_HANDED ? 'not-handed' : 'moving'
}
