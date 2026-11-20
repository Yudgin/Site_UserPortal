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

// Без пробелов: Новая Почта делит имя получателя по пробелам (novaPoshtaTtn.js). Минимум две кириллические буквы:
// из одних дефисов и апострофов получателя в накладной не назвать, а Script=Cyrillic включает и не буквы (҂).
const NAME_RE = /^(?=(?:.*?(?=\p{L})\p{Script=Cyrillic}){2})(?:(?=\p{L})\p{Script=Cyrillic}|['’ʼ-]){2,40}$/u
export const NP_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/
// Адрес уходит кассе в чек. Домен только ASCII (кириллический вводят в punycode): что касса ответит на другое, не проверялось.
const EMAIL_RE = /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/

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
    // Ключ прежнего заказа этой вкладки: покупатель исправил данные, в том числе телефон, и прежний неоплаченный надо закрыть.
    replacesKey: str(b.replacesKey),
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
    replacesKey: !value.replacesKey || KEY_RE.test(value.replacesKey),
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

// Тот же ли покупатель по имени: регистр, вид апострофа и по батькові не в счёт. Телефон сам по себе не доказывает,
// что это тот же человек: знающий чужой номер иначе закрывал бы чужой неоплаченный заказ.
const nameKey = (v) => str(v).toLowerCase().replace(/[’ʼ]/g, "'")
export const sameBuyerNames = (a, b) => !!a && !!b && nameKey(a.lastName) === nameKey(b.lastName) && nameKey(a.firstName) === nameKey(b.firstName)

// Адрес страницы статуса: 128 случайных бит, не зависят от телефона и номера заказа.
export const STATUS_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/
export const newStatusToken = () => crypto.randomBytes(16).toString('base64url')

export const phoneCodeHash = (token, code) => sha256(`${token}:${code}`)

// ---------- заказ ----------

const ORDER_NO_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const LIMIT_DEFAULTS = { unpaidPerDay: 40, payAttemptsPerOrder: 5 }
// Захват создания счёта или накладной считается живым 3 минуты: дольше ни банк, ни НП не отвечают, значит, процесс упал.
const CLAIM_FRESH_MS = 3 * 60 * 1000
const NP_TRACK_URL = 'https://novaposhta.ua/tracking/?cargo_number='

// Номер для людей считается из id заказа: повтор запроса даёт тот же номер и счётчик не нужен. Доступа номер не даёт.
export const orderNoFromId = (id) => {
  const h = sha256(id)
  return 'RF-' + Array.from({ length: 6 }, (_, i) => ORDER_NO_ABC[parseInt(h.slice(i * 2, i * 2 + 2), 16) % ORDER_NO_ABC.length]).join('')
}

export const shopLimit = (cfg, name) => {
  const v = cfg && cfg.limits && cfg.limits[name]
  return Number.isInteger(v) && v >= 0 ? v : LIMIT_DEFAULTS[name]
}

export const claimFresh = (at, now = Date.now()) => !!at && now - Date.parse(at) < CLAIM_FRESH_MS

export const acceptsOrders = (cfg) => !!cfg && (cfg.mode === 'hidden' || cfg.mode === 'live')

// Можно ли сейчас вести покупателя на страницу банка. Гейта ФОП здесь нет: он нужен только новому заказу и новому счёту.
export const cardOpenFor = (cfg, sku) => acceptsOrders(cfg) && (cfg.methods || {}).card === true && skuOnSale((cfg.skus || {})[sku])

// value из validateOrderInput; item из pricedItem; цена, ФОП и продавец из тела запроса сюда не попадают.
// Реквизиты продавца замораживаем: страница статуса подтверждает покупателю, у кого он купил, даже если реквизиты потом сменятся.
export function buildOrderDoc({ id, value: v, fingerprint, item, fop, statusToken, addressVerified, at }) {
  return {
    orderNo: orderNoFromId(id), statusToken, idempotencyKey: v.idempotencyKey, fingerprint, state: 'awaiting_payment', method: v.method, cancelReason: null,
    sku: v.sku, titleUk: item.titleUk, qty: 1, total: item.priceUah, fopId: fop.id, seller: publicSeller(fop), offerVersion: v.offerVersion,
    consent: { offerVersion: v.offerVersion, acceptedAt: at, personalData: true },
    lastName: v.lastName, firstName: v.firstName, middleName: v.middleName, clientName: [v.lastName, v.firstName, v.middleName].filter(Boolean).join(' '),
    clientPhone: v.phone, phoneKey: phoneKeyOf(v.phone), email: v.email,
    clientCityRef: v.cityRef, clientCityName: v.cityName, clientWarehouseRef: v.warehouseRef, clientWarehouseName: v.warehouseName, addressVerified,
    payment: { paymentId: null, invoiceId: null, pageUrl: null, status: null, createdAt: null, expiresAt: null, initiatedAt: at, lastBankCheckAt: null },
    paymentIds: [], payAttempts: 0, receipt: { status: 'none' }, sms: {}, alerts: {},
    history: [{ at, from: null, to: 'awaiting_payment', by: 'site' }], createdAt: at, updatedAt: at,
  }
}

const INVOICE_CLOSED = new Set(['failure', 'expired', 'removed'])
const BANK_BUSY = new Set(['processing', 'hold', 'success', 'reversed'])

// Неоплаченный заказ, по которому деньги уже идут или пришли, а хук оплаты ещё не дошёл: последний ответ банка по текущему счёту
// или документ оплаты. Отменять такой заказ нельзя.
const PAY_IN_FLIGHT = new Set(['processing', 'hold', 'success'])
export const payInFlight = (order, payments = []) => order?.state === 'awaiting_payment'
  && (PAY_IN_FLIGHT.has(order.payment?.status) || payments.some((p) => p?.status === 'paid'))

// Документ оплаты показывает, что денег по счёту нет: сверка может закрыть заказ, если так у всех его счетов.
export const invoiceFinal = (payment) => !payment || INVOICE_CLOSED.has(payment.status) || payment.status === 'reversed'

// Адрес страницы статуса: сюда банк возвращает покупателя, эта же ссылка уходит в сообщении.
export const orderStatusUrl = (siteBaseUrl, statusToken) => `${str(siteBaseUrl).replace(/\/+$/, '')}/uk/order/${statusToken}`

// Текущий счёт заказа. payment это документ payments/{id}, первоисточник; order.payment.status только последний ответ банка на опрос.
// closed: денег по счёту нет и новый создать можно. Счёт не закрыт и не живой: ждём банк, новый создавать нельзя, прежний могли оплатить.
export function invoiceView(order, payment, now = Date.now()) {
  const cur = order.payment || {}
  const creating = claimFresh(cur.initiatedAt, now)
  const closed = !cur.paymentId || (!!payment && INVOICE_CLOSED.has(payment.status))
  const live = !!payment && payment.status === 'pending' && !!cur.pageUrl && now < Date.parse(cur.expiresAt) && !BANK_BUSY.has(cur.status)
  return { creating, closed, live, checking: creating || (!closed && !live) }
}

export const RECEIPT_FAILED = new Set(['ERROR', 'CANCELLED', 'no-checkbox'])
const receiptView = (order, paid) => {
  if (!paid) return { status: 'none', url: null }
  if (paid.taxUrl) return { status: 'ready', url: paid.taxUrl }
  if (paid.status === 'reversed' || paid.receiptStatus === 'amount-mismatch') return { status: 'none', url: null }
  if (RECEIPT_FAILED.has(paid.receiptStatus) || (order.receipt && order.receipt.status === 'failed')) return { status: 'failed', url: null }
  return { status: 'pending', url: null }
}

// Наружу только свои стадии, сырой текст статуса НП не отдаём. Накладная на закрытом заказе покупателю не обещана: её удаляют.
const deliveryView = (order) => {
  if (!order.ttn || order.ttnOnClosed) return { ttn: null, trackUrl: null, stage: 'none' }
  const stage = order.state === 'delivered' ? 'received'
    : order.state === 'refused' || order.state === 'returned' ? 'refused'
      : npOutcome(order.npDelivery && order.npDelivery.code, { shippedAt: order.shippedAt }) === 'moving' ? 'moving' : 'created'
  return { ttn: String(order.ttn), trackUrl: `${NP_TRACK_URL}${order.ttn}`, stage }
}

// Ответ страницы статуса: перечисляем поля явно, всё остальное из заказа наружу не выходит. Токен, имя, полный телефон, почта,
// адрес, рефы НП, fopId, id оплат и счетов, журнал, алерты и согласие сюда не попадают. payUrl поневоле содержит номер счёта банка.
export function orderPublicView(order, { payment = null, paidPayment = null, open = false, maxPayAttempts = LIMIT_DEFAULTS.payAttemptsPerOrder, now = Date.now() } = {}) {
  const inv = order.state === 'awaiting_payment' ? invoiceView(order, payment, now) : null
  return {
    orderNo: order.orderNo,
    state: order.state,
    cancelReason: order.cancelReason || null,
    method: order.method,
    item: { sku: order.sku, titleUk: order.titleUk, qty: order.qty, totalUah: order.total },
    seller: order.seller || null,
    offerVersion: order.offerVersion,
    payment: {
      payUrl: inv && inv.live && open ? order.payment.pageUrl : null,
      canRetry: !!inv && inv.closed && !inv.creating && open && (order.payAttempts || 0) < maxPayAttempts,
      checking: !!inv && inv.checking,
    },
    receipt: receiptView(order, paidPayment),
    delivery: deliveryView(order),
    phoneConfirm: { required: order.state === 'phone_pending', phoneMasked: maskPhone(order.clientPhone), resendInSec: 0, attemptsLeft: 0 },
  }
}

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
export function transitionPatch(order, to, { at = new Date().toISOString(), by = null, patch = {}, note = null } = {}) {
  if (!canTransition(order, to)) return null
  return { ...patch, state: to, history: [...(order.history || []), { at, from: order.state, to, by, ...(note ? { note } : {}) }], updatedAt: at }
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

// Годится ли шаблон для посылки покупателю этого ФОП. Адрес клиента saveInternetDocument подставляет, только если получатель клиент и отделение;
// без описания сервер написал бы «кораблик». Пустой список: годится.
export function npTemplateProblems(tpl, fopId) {
  if (!tpl) return ['missing']
  const problems = []
  const check = (ok, name) => { if (!ok) problems.push(name) }
  check(tpl.active !== false, 'inactive')
  check(tpl.scenario === 'parts', 'scenario')
  check(tpl.fopId === fopId, 'fop')
  check(filled(tpl.description), 'description')
  check((tpl.senderTarget || 'service') === 'service', 'sender')
  check((tpl.recipientTarget || 'client') === 'client', 'recipient')
  check(String(tpl.serviceType || 'WarehouseWarehouse').endsWith('Warehouse'), 'service-type')
  // Оферта обещает доставку за тарифами НП при получении: плательщик-отправитель отправлял бы каждую посылку за счёт ФОП.
  check((tpl.payerType || 'recipient') !== 'sender', 'payer')
  return problems
}

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

// ---------- страницы владельца ----------

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const SITE_BASE_RE = /^https:\/\/\S+$/
const CONFIG_ID_RE = /^[\w-]{0,64}$/
const LIMIT_NAMES = ['unpaidPerDay', 'smsPerDay', 'smsPerPhoneDay', 'codOpenPerPhone', 'codeSendsPerOrder', 'codeAttempts', 'payAttemptsPerOrder', 'moneyWaitDays']
const COUNT = (v) => Number.isInteger(v) && v >= 0
const AMOUNT = (v) => Number.isFinite(v) && v > 0
const skuRuleOk = (r) => isMap(r) && typeof r.enabled === 'boolean' && typeof r.inStock === 'boolean' && (r.stock === null || r.stock === undefined || COUNT(r.stock))
  && AMOUNT(r.minUah) && AMOUNT(r.maxUah) && r.minUah <= r.maxUah

export const siteBaseUrlOk = (v) => SITE_BASE_RE.test(str(v))

// Кто, кроме владельца, видит заказы магазина: uid из users, список ведёт владелец. Роль директора не годится сама по себе:
// она ограничена центрами, а покупатели магазина ни к одному центру не относятся.
const STAFF_UID_RE = /^[\w-]{1,128}$/
const STAFF_UIDS_MAX = 20
export const shopStaffAllowed = (cfg, uid) => !!uid && Array.isArray(cfg?.staffUids) && cfg.staffUids.includes(uid)

// Что можно менять страницей: всё остальное в теле, включая ownerTestOkAt, не проходит. skus заменяются целиком, чтобы артикул можно было убрать,
// methods и limits дополняются. Настройки проверяются вместе с прежними: одно поле mode=off проходит всегда, это аварийный выключатель.
export function salesSettingsNext(body, prev = {}) {
  const b = isMap(body) ? body : {}
  const patch = {}
  const fields = []
  const take = (k, value, ok) => {
    if (!(k in b)) return
    if (ok) patch[k] = value
    else fields.push(k)
  }
  take('mode', b.mode, SALES_MODES.includes(b.mode))
  take('fopId', str(b.fopId), CONFIG_ID_RE.test(str(b.fopId)))
  take('npTemplateId', str(b.npTemplateId), CONFIG_ID_RE.test(str(b.npTemplateId)))
  take('siteBaseUrl', str(b.siteBaseUrl), !str(b.siteBaseUrl) || (str(b.siteBaseUrl).length <= 200 && siteBaseUrlOk(b.siteBaseUrl)))
  take('offerVersion', str(b.offerVersion), str(b.offerVersion).length <= 40)
  take('codKind', b.codKind, ['control', 'money'].includes(b.codKind))
  take('codReceiptMode', b.codReceiptMode, ['ettn', 'manual'].includes(b.codReceiptMode))
  take('cardReceiptLabel', str(b.cardReceiptLabel), str(b.cardReceiptLabel).length <= 128)
  take('codReceiptLabel', str(b.codReceiptLabel), str(b.codReceiptLabel).length <= 128)
  take('ownerPhone', str(b.ownerPhone) ? shopPhone(b.ownerPhone) : '', !str(b.ownerPhone) || !!shopPhone(b.ownerPhone))
  const testPhones = Array.isArray(b.codTestPhones) ? b.codTestPhones.map(shopPhone) : null
  take('codTestPhones', testPhones, !!testPhones && testPhones.length <= 20 && testPhones.every(Boolean))
  take('methods', { ...prev.methods, ...b.methods }, isMap(b.methods) && Object.entries(b.methods).every(([k, v]) => SHOP_METHODS.includes(k) && typeof v === 'boolean'))
  const limitOk = ([k, v]) => (k === 'piiPaidDays' ? v === null || (Number.isInteger(v) && v > 0) : LIMIT_NAMES.includes(k) && COUNT(v))
  take('limits', { ...prev.limits, ...b.limits }, isMap(b.limits) && Object.entries(b.limits).every(limitOk))
  take('skus', b.skus, isMap(b.skus) && Object.entries(b.skus).every(([sku, rule]) => SKU_RE.test(sku) && skuRuleOk(rule)))
  const staffUids = Array.isArray(b.staffUids) ? [...new Set(b.staffUids.map(str))] : null
  take('staffUids', staffUids, !!staffUids && staffUids.length <= STAFF_UIDS_MAX && b.staffUids.every((u) => typeof u === 'string') && staffUids.every((u) => STAFF_UID_RE.test(u)))
  if (fields.length) return { ok: false, code: 'BAD_SETTINGS', fields }

  const next = { ...prev, ...patch }
  if (!SALES_MODES.includes(next.mode)) next.mode = 'off'
  const touchesCod = ['methods', 'codKind', 'codReceiptMode'].some((k) => k in patch)
  if ((next.mode !== 'off' || touchesCod) && (next.methods || {}).cod === true && !codPairAllowed(next.codKind, next.codReceiptMode)) return { ok: false, code: 'COD_PAIR_FORBIDDEN', fields: ['codKind', 'codReceiptMode'] }
  if (acceptsOrders(next)) {
    if (!next.ownerTestOkAt) return { ok: false, code: 'OWNER_TEST_REQUIRED', fields: [] }
    const missing = ['fopId', 'offerVersion'].filter((k) => !str(next[k]))
    if (!siteBaseUrlOk(next.siteBaseUrl)) missing.push('siteBaseUrl')
    if (missing.length) return { ok: false, code: 'BAD_SETTINGS', fields: missing }
  }
  return { ok: true, next }
}

// Данные получателя, которые исправляет владелец. Только переданные поля; адрес всегда целиком. Правила те же, что у нового заказа.
export function validateRecipient(body) {
  const b = isMap(body) ? body : {}
  const value = {}
  const fields = []
  const take = (k, v, ok) => {
    if (!(k in b)) return
    if (ok) value[k] = v
    else fields.push(k)
  }
  take('phone', shopPhone(b.phone), !!shopPhone(b.phone))
  take('lastName', str(b.lastName), NAME_RE.test(str(b.lastName)))
  take('firstName', str(b.firstName), NAME_RE.test(str(b.firstName)))
  take('middleName', str(b.middleName), !str(b.middleName) || NAME_RE.test(str(b.middleName)))
  const email = str(b.email).toLowerCase()
  take('email', email, !email || (email.length <= 120 && EMAIL_RE.test(email)))
  if (['cityRef', 'cityName', 'warehouseRef', 'warehouseName'].some((k) => k in b)) {
    const address = { cityRef: str(b.cityRef).toLowerCase(), cityName: str(b.cityName).slice(0, 120), warehouseRef: str(b.warehouseRef).toLowerCase(), warehouseName: str(b.warehouseName).slice(0, 200) }
    if (!NP_REF_RE.test(address.cityRef)) fields.push('cityRef')
    if (!address.cityName) fields.push('cityName')
    if (!NP_REF_RE.test(address.warehouseRef)) fields.push('warehouseRef')
    if (!address.warehouseName) fields.push('warehouseName')
    Object.assign(value, address)
  }
  if (!fields.length && !Object.keys(value).length) fields.push('empty')
  return fields.length ? { ok: false, fields } : { ok: true, value }
}

// Красные плашки считаются из текущего состояния: алерт остаётся в заказе навсегда, а плашка гаснет, когда причины больше нет.
export function orderFlags(order, now = Date.now()) {
  const alerts = order.alerts || {}
  const paidCard = order.method === 'card' && !!order.paidPaymentId && order.state !== 'reversed'
  const flags = []
  const flag = (on, name) => { if (on) flags.push(name) }
  flag(order.state === 'payment_review', 'payment-review')
  flag(paidCard && order.receipt?.status === 'failed', 'receipt-failed')
  flag(!order.ttn && canTransition(order, 'shipped') && (order.ttnError === 'unknown' || (!!order.ttnCreatingAt && !claimFresh(order.ttnCreatingAt, now))), 'ttn-unknown')
  flag(order.ttnOnClosed === true, 'ttn-on-closed')
  flag(paidCard && (order.state === 'refused' || order.state === 'returned'), 'refund-due')
  flag(Object.keys(alerts).some((k) => k.startsWith('sms-') && alerts[k]), 'sms-failed')
  flag(order.state === 'shipped' && !!alerts[`np-not-handed-${order.ttn}`] && String(order.npDelivery?.code) === NP_NOT_HANDED, 'not-handed')
  return flags
}

export const orderNeedsAction = (order, now = Date.now()) => ((order.state === 'paid' || order.state === 'cod_confirmed') && !order.ttn) || orderFlags(order, now).length > 0

export const orderAdminRow = (id, order, now = Date.now()) => ({
  id, orderNo: order.orderNo, state: order.state, method: order.method, sku: order.sku, titleUk: order.titleUk, total: order.total,
  clientName: order.clientName || null, clientPhone: order.clientPhone || null, clientCityName: order.clientCityName || null, clientWarehouseName: order.clientWarehouseName || null,
  ttn: order.ttn || null, receiptStatus: order.receipt?.status || 'none', createdAt: order.createdAt, paidAt: order.paidAt || null, shippedAt: order.shippedAt || null,
  flags: orderFlags(order, now), needsAction: orderNeedsAction(order, now),
})

// Карточка: заказ целиком, кроме того, что открывает его снаружи или считается от телефона. Токен только как готовая ссылка для кнопки «Скопіювати посилання».
const ADMIN_HIDDEN = ['statusToken', 'idempotencyKey', 'fingerprint', 'phoneKey', 'phoneCode']
export function orderAdminView(id, order, { siteBaseUrl, now = Date.now() } = {}) {
  const view = { id, ...order }
  for (const k of ADMIN_HIDDEN) delete view[k]
  view.statusUrl = siteBaseUrlOk(siteBaseUrl) && order.statusToken ? orderStatusUrl(siteBaseUrl, order.statusToken) : null
  view.flags = orderFlags(order, now)
  view.needsAction = orderNeedsAction(order, now)
  return view
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

// Запись из ответа НП для заказа. Сырой текст статуса только для карточки владельца, покупателю он не отдаётся.
export function npDeliveryFrom(doc, prev, at) {
  const code = String(doc?.StatusCode ?? '').trim()
  return { code, text: String(doc?.Status || '').slice(0, 120), changedAt: prev?.code === code && prev.changedAt ? prev.changedAt : at, final: false }
}

export const npDeliveredAt = (doc, at) => npDateToIso(doc?.RecipientDateTime) || npDateToIso(doc?.ActualDeliveryDate) || at

// НП больше не знает накладную: номер уходит в историю, заказ снова ждёт накладную.
export const ttnGonePatch = (order, code, at) => ({
  ttn: null, npDocRef: null, npCostOnSite: null, npEstimatedDelivery: null, npFopId: null, ttnCreatingAt: null, ttnError: null,
  shippedAt: null, npDelivery: null, npCheckedAt: null,
  ttnHistory: [...(order.ttnHistory || []), { ttn: order.ttn, at, reason: `np-${code}` }],
})

// ---------- шаг памятки в алерте ----------

// Какой шаг памятки владельца решает алерт (runferry-briefs, catalog/ua-shop-owner-guide-2026-11.md). Номера менять только вместе с памяткой.
// Шаги 2 и 12 не из алертов: отказ на экране накладной и аварийное выключение. Шаг 13 о подготовке к продажам, на него ведёт тест алерта.
const ALERT_GUIDE_STEPS = [
  [1, /^(new-paid$|no-ttn-)/],
  [3, /^(ttn-gone-|np-not-handed-|ttn-on-closed-)/],
  [4, /^(np-stale-|np-no-final-)/],
  [5, /^(refused-|refund-day-20$|reversed$|extra-payment-|extra-reversed-|partial-refund-)/],
  [6, /^(amount-mismatch$|late-payment$|amount-unverified$|reversed-signal$|unknown-status-|ttn-payment-blocked$)/],
  [7, /^receipt-(failed|late|claim)$/],
  [8, /^sms-/],
  [9, /^possible-duplicate$/],
  [10, /^(stock-out$|stock-oversold$|feed-)/],
  [11, /^(day-limit$|gate-card$)/],
  [13, /^test-alert$/],
]

export const alertGuideStep = (kind) => ALERT_GUIDE_STEPS.find(([, re]) => re.test(kind))?.[0] ?? null

// Строка в конце алерта, текст в заказе остаётся без неё. Вид без шага ведёт на памятку в целом.
export const withGuideStep = (kind, text) => {
  const step = alertGuideStep(kind)
  return `${text}\nПам'ятка${step ? `, крок ${step}` : ''}`
}

// ---------- стирание ----------

// Что стирается у заказа: всё, по чему можно узнать покупателя. fingerprint и phoneKey считаются от телефона и перебираются.
export const piiPurgePatch = (at) => ({
  lastName: null, firstName: null, middleName: null, clientName: null, clientPhone: null, phoneKey: null, email: null, fingerprint: null,
  clientCityRef: null, clientCityName: null, clientWarehouseRef: null, clientWarehouseName: null, phoneCode: null,
  piiPurgedAt: at, updatedAt: at,
})
