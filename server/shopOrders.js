// API магазина для сервера сайта runferry.ua: лента, поиск Новой Почты, заказ, счёт monobank, статус, отмена. Браузер сюда
// не ходит, токен SHOP_SITE_TOKEN живёт только на сервере сайта. Правила в shopCore.js, здесь чтение Firestore и ответы.
// Токен статуса и данные покупателя в журнал не пишем.
import { timingSafeEqual } from 'crypto'
import { rateLimit } from './rateLimit.js'
import { loadFopFresh } from './fops.js'
import * as monoAcquire from './monoAcquire.js'
import { KYIV_DAY } from './shopPayments.js'
import {
  NP_REF_RE, SALES_MODES, STATUS_TOKEN_RE, acceptsOrders, buildCatalogFeed, buildOrderDoc, canTransition, cardOpenFor, claimFresh, invoiceView,
  newStatusToken, orderFingerprint, orderIdFromKey, orderPublicView, orderStatusUrl, pricedItem, shopLimit, shopSellable, skuOnSale, transitionPatch, validateOrderInput,
} from './shopCore.js'

// Сервер сайта ждёт чтение 8 с: отвечаем раньше, чтобы сбой НП не выглядел сбоем портала.
const NP_BUDGET_MS = 7000
// Сайт ждёт создание и оплату 25 с: проверка отделения или чтение статуса счёта по 4 с плюс счёт monobank 20 с.
const ADDRESS_BUDGET_MS = 4000
const BANK_READ_BUDGET_MS = 4000
const BANK_POLL_EVERY_MS = 10 * 1000
export const INVOICE_VALIDITY_SEC = 60 * 60
const CARD_RECEIPT_LABEL = 'Інтернет еквайринг'
// Единственный текст портала, который покупатель видит сам (страница банка): остальные на сайте по кодам ошибок. Владелец ещё не утвердил.
const invoiceDestination = (orderNo) => `Замовлення ${orderNo}`
const POSTOMAT_TYPE = '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc'
// Всё под /api/shop, кроме /api/shop/admin: там вход владельца, а не токен сайта. Границу пути после совпадения проверяет app.use.
const SITE_PATHS = /^\/api\/shop(?!\/admin(?:\/|$))/i

// Что случилось с артикулом и что сделать владельцу.
const DROP_TEXT = {
  'material-errors': 'у прайсі кілька позицій із цим кодом або схожий код. Залиште одну на сторінці прайса',
  'no-material': 'у прайсі немає позиції з цим кодом. Додайте її на сторінці прайса або вимкніть артикул у магазині',
  'not-published': 'позиція неактивна або картку не опубліковано. Перевірте її на сторінці прайса або вимкніть артикул у магазині',
  'no-card-data': 'у позиції немає назви або адреси картки. Заповніть їх на сторінці прайса',
  'price-out-of-range': 'ціна поза межами з налаштувань магазину. Виправте ціну на сторінці прайса або межі в магазині',
}

const nowIso = () => new Date().toISOString()
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra } })

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export const withBudget = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`немає відповіді за ${ms} мс`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

// Реф в том виде, в каком его примет заказ (validateOrderInput): другой выбрать в списке незачем, заказ не пройдёт.
const npRef = (v) => {
  const ref = str(v).toLowerCase()
  return NP_REF_RE.test(ref) ? ref : ''
}

export const isPostomat = (wh) => String(wh?.TypeOfWarehouse || '') === POSTOMAT_TYPE
  || /поштомат|почтомат/i.test(`${wh?.Description || ''} ${wh?.DescriptionRu || ''}`)

export function registerShopOrders(app, deps) {
  const {
    adminDb, npRequest, hooks, payments, mono = monoAcquire, siteUrl = 'https://my.runferry.com', npBudgetMs = NP_BUDGET_MS,
    addressBudgetMs = ADDRESS_BUDGET_MS, bankReadBudgetMs = BANK_READ_BUDGET_MS,
    // Лимит по адресу покупателя считает сайт. Здесь общий на экземпляр: страховка ключа НП, им же работают ремонты.
    npLimiter = rateLimit({ name: 'shop-np', windowMs: 60 * 1000, max: 300, keyFn: () => 'site' }),
  } = deps
  const TOKEN = process.env.SHOP_SITE_TOKEN || ''
  if (!TOKEN) console.warn('⚠️  SHOP_SITE_TOKEN not set — /api/shop/* answers 503')

  const guard = (req, res, next) => {
    if (!TOKEN) return fail(res, 503, 'NOT_CONFIGURED', 'SHOP_SITE_TOKEN not set')
    if (!safeEqual(req.get('x-shop-token'), TOKEN)) return fail(res, 403, 'FORBIDDEN', 'Bad shop token')
    next()
  }

  // ---------- лента ----------

  const loadSales = async () => {
    const s = await adminDb.collection('system').doc('shopSales').get()
    return s.exists ? s.data() : null
  }

  // Ошибку чтения не глотаем: сайт заменяет кэш любым ответом 200, а пустой прайс выглядел бы как снятые с продажи товары.
  // При off прайс не нужен: выключатель не должен зависеть от его чтения.
  const loadFeed = async () => {
    const sales = await loadSales()
    const withPrices = !!sales && sales.mode !== 'off' && SALES_MODES.includes(sales.mode)
    const fopId = str(sales?.fopId)
    const [prices, fop] = await Promise.all([
      withPrices ? adminDb.collection('priceList').doc('current').get() : null,
      fopId ? loadFopFresh(adminDb, fopId) : null,
    ])
    return { sales, ...buildCatalogFeed({ sales, priceList: prices?.exists ? prices.data() : null, fop }) }
  }

  // Раз в сутки на артикул для всех экземпляров: метка лежит в shopDaily и ставится транзакцией вместе с текстом.
  // Выключенный владельцем артикул не беспокоит: иначе алерт приходил бы каждый день, пока он в настройках.
  const alertDropped = async ({ sales, dropped }) => {
    const worth = dropped.filter((d) => sales?.skus?.[d.sku]?.enabled === true)
    if (!worth.length) return
    const ref = adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date()))
    const fresh = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const seen = (snap.exists && snap.data().alerts) || {}
      const at = nowIso()
      const alerts = {}
      for (const { sku, reason } of worth) {
        if (seen[`feed-${sku}`]) continue
        alerts[`feed-${sku}`] = { at, sentAt: null, text: `⚠️ Магазин: артикул ${sku} випав із вітрини, покупці бачать «Ціна за запитом»: ${DROP_TEXT[reason]}: ${siteUrl}/shop-orders` }
      }
      if (Object.keys(alerts).length) tx.set(ref, { alerts }, { merge: true })
      return alerts
    })
    await hooks.sendAlerts(ref, fresh)
  }

  app.get('/api/shop/catalog', guard, async (_req, res) => {
    let result
    try {
      result = await loadFeed()
    } catch (e) {
      console.error('shop: стрічка:', e.message)
      return fail(res, 503, 'CATALOG_UNAVAILABLE', 'Catalog is temporarily unavailable')
    }
    res.json({ success: true, data: result.feed })
    // После ответа: сайт ждёт ленту 3 с, а Telegram может отвечать дольше.
    alertDropped(result).catch((e) => console.error('shop: алерт стрічки:', e.message))
  })

  // ---------- Новая Почта ----------

  // Сбой и пустой список разные вещи: покупатель должен видеть «не завантажилось, повторити», а не «немає відділень».
  const npData = async (calledMethod, props, budgetMs = npBudgetMs) => {
    const r = await withBudget(npRequest('Address', calledMethod, props), budgetMs)
    if (r?.success !== true || !Array.isArray(r.data)) throw new Error(`${calledMethod}: відповідь НП не успішна`)
    return r.data
  }

  const citiesLike = async (q) => {
    const data = await npData('searchSettlements', { CityName: q, Limit: 20 })
    const found = Array.isArray(data[0]?.Addresses) ? data[0].Addresses : []
    return found
      .map((a) => ({ ref: npRef(a?.DeliveryCity), name: str(a?.Present), area: str(a?.Area) }))
      .filter((c) => c.ref && c.name)
  }

  // Полный список города без поштоматов: отделение покупатель ищет на своей стороне.
  const warehousesOf = async (cityRef, budgetMs) => {
    const data = await npData('getWarehouses', { CityRef: cityRef, FindByString: '', Limit: 5000 }, budgetMs)
    return data
      .filter((wh) => !isPostomat(wh))
      .map((wh) => ({ ref: npRef(wh?.Ref), name: str(wh?.Description) }))
      .filter((w) => w.ref && w.name)
  }

  const npFail = (res, what, e) => {
    console.error(`shop: НП ${what}:`, e.message)
    return fail(res, 502, 'NP_UNAVAILABLE', 'Nova Poshta is temporarily unavailable')
  }

  app.post('/api/shop/np/cities', guard, npLimiter, async (req, res) => {
    const q = str(req.body?.q)
    if (q.length < 2 || q.length > 60) return fail(res, 400, 'BAD_INPUT', 'q must be 2-60 characters', { fields: ['q'] })
    try {
      res.json({ success: true, data: { items: await citiesLike(q) } })
    } catch (e) {
      npFail(res, 'міста', e)
    }
  })

  app.post('/api/shop/np/warehouses', guard, npLimiter, async (req, res) => {
    const cityRef = npRef(req.body?.cityRef)
    if (!cityRef) return fail(res, 400, 'BAD_INPUT', 'cityRef must be a Nova Poshta ref', { fields: ['cityRef'] })
    try {
      res.json({ success: true, data: { items: await warehousesOf(cityRef) } })
    } catch (e) {
      npFail(res, 'відділення', e)
    }
  })

  // ---------- заказы: общее ----------

  const orders = () => adminDb.collection('shopOrders')
  const answer = (res, status, data) => res.status(status).json({ success: true, data })
  const orderAnswer = (order, next) => ({ token: order.statusToken, orderNo: order.orderNo, state: order.state, next })
  const orderNotFound = (res) => fail(res, 404, 'NOT_FOUND', 'No such order')
  const notPayable = (res) => fail(res, 409, 'NOT_PAYABLE', 'Order cannot be paid')
  const redirectTo = (url) => ({ type: 'redirect', url })

  const safely = (what, handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (e) {
      console.error(`shop: ${what}:`, e?.response?.status || e.message)
      if (!res.headersSent) fail(res, 500, 'INTERNAL', 'Internal error')
    }
  }

  // Кривой формат и неизвестный токен для сайта одно и то же; кривой формат не тратит чтение.
  const orderByToken = async (raw) => {
    const token = String(raw || '')
    if (!STATUS_TOKEN_RE.test(token)) return null
    const q = await orders().where('statusToken', '==', token).limit(1).get()
    return q.empty ? null : { ref: orders().doc(q.docs[0].id), order: q.docs[0].data() }
  }

  // Гейт для нового заказа и нового счёта. ФОП без кэша, счёт создаётся с этим же объектом.
  const gateFop = async (fopId, cfg, priceUah) => {
    const fop = fopId ? await loadFopFresh(adminDb, fopId) : null
    const gate = shopSellable(fop, 'card', cfg, { priceUah })
    if (!gate.ok) return { gate }
    if (!/^https:\/\/\S+$/.test(str(cfg.siteBaseUrl))) return { gate: { code: 'NOT_CONFIGURED', missing: ['siteBaseUrl'] } }
    return { fop }
  }
  const gateFail = (res, { code, missing }) => {
    console.warn(`shop: ФОП не проходить гейт: ${code}: ${missing.join(', ')}`)
    return code === 'METHOD_OFF' ? fail(res, 409, code, 'Payment method is off') : fail(res, 503, 'NOT_CONFIGURED', 'Shop is not configured')
  }

  // Вызывающие не ждут: защиту от двойной оплаты дают опрос всех счетов и алерт, а не успех снятия. Ошибку банка только пишем в журнал.
  const removeInvoices = async (order) => {
    for (const id of order.paymentIds || []) {
      try {
        await hooks.removeLiveInvoice(id)
      } catch (e) {
        console.error(`shop: рахунок ${id} не знято:`, e?.response?.status || e.message)
      }
    }
  }

  // Захват payment.initiatedAt уже стоит. Сбой банка: заказ остаётся, захват снят, возвращаем null.
  // Заказ закрыли, пока банк отвечал: ссылку не выдаём, счёт снимаем, но помним: по нему всё равно могут заплатить.
  const issueInvoice = async (ref, order, fop, cfg) => {
    let created
    try {
      const r = await payments.createPayment({
        fopId: fop.id, fopOverride: fop, method: 'mono-acquire', amount: order.total, shopOrderId: ref.id,
        goods: [{ name: order.titleUk, price: order.total, qty: 1, code: order.sku }],
        description: invoiceDestination(order.orderNo),
        resultUrl: orderStatusUrl(cfg.siteBaseUrl, order.statusToken),
        paymentLabel: str(cfg.cardReceiptLabel) || CARD_RECEIPT_LABEL,
        validitySec: INVOICE_VALIDITY_SEC,
        webHookBase: process.env.SHOP_CALLBACK_BASE_URL,
      })
      if (!r.ok) throw new Error(r.code)
      created = r.data
    } catch (e) {
      console.error(`shop: рахунок замовлення ${order.orderNo}:`, e?.response?.status || e.message)
      await ref.set({ payment: { initiatedAt: null }, updatedAt: nowIso() }, { merge: true })
      return null
    }
    const saved = await payments.loadOrder(created.orderId).catch(() => null)
    const at = nowIso()
    const open = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      const stillOpen = cur.state === 'awaiting_payment'
      tx.set(ref, {
        payment: {
          paymentId: created.orderId, invoiceId: saved?.providerOrderId || null, pageUrl: stillOpen ? created.pageUrl : null, status: 'created',
          createdAt: at, expiresAt: new Date(Date.parse(at) + INVOICE_VALIDITY_SEC * 1000).toISOString(), initiatedAt: null, lastBankCheckAt: null,
        },
        paymentIds: [...(cur.paymentIds || []), created.orderId],
        payAttempts: (cur.payAttempts || 0) + 1,
        updatedAt: at,
      }, { merge: true })
      return stillOpen
    })
    if (open) return redirectTo(created.pageUrl)
    removeInvoices({ paymentIds: [created.orderId] })
    return { type: 'status' }
  }

  const settleInBackground = (payment, st, source) => {
    payments.settleMonoAcquire(payment, st, source).catch((e) => console.error(`shop: оплата ${payment.orderId}:`, e?.response?.status || e.message))
  }

  // ---------- создание заказа ----------

  // true или false, если НП ответила; null, если нет: заказ не срываем, накладную всё равно создаёт человек.
  const warehouseFits = async (cityRef, warehouseRef) => {
    try {
      return (await warehousesOf(cityRef, addressBudgetMs)).some((w) => w.ref === warehouseRef)
    } catch (e) {
      console.warn('shop: відділення не перевірено:', e.message)
      return null
    }
  }

  // Повтор никогда не создаёт счёт: новый счёт только через /pay. Выключенные продажи ведут на статус, живая ссылка не выдаётся.
  const repeatNext = async (order) => {
    if (order.state !== 'awaiting_payment' || !cardOpenFor(await loadSales(), order.sku)) return { type: 'status' }
    const payment = order.payment?.paymentId ? await payments.loadOrder(order.payment.paymentId) : null
    return invoiceView(order, payment).live ? redirectTo(order.payment.pageUrl) : { type: 'status' }
  }
  const answerRepeat = async (res, order, fingerprint) => {
    if (order.fingerprint !== fingerprint) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'Same key, different order data')
    return answer(res, 200, orderAnswer(order, await repeatNext(order)))
  }

  app.post('/api/shop/orders', guard, safely('замовлення', async (req, res) => {
    const input = validateOrderInput(req.body)
    if (!input.ok) return fail(res, 400, 'BAD_INPUT', 'Bad order fields', { fields: input.fields })
    const v = input.value
    const ref = orders().doc(orderIdFromKey(v.idempotencyKey))
    const fingerprint = orderFingerprint(v)
    const seen = await ref.get()
    if (seen.exists) return answerRepeat(res, seen.data(), fingerprint)

    const cfg = await loadSales()
    if (!acceptsOrders(cfg)) return fail(res, 409, 'SALES_OFF', 'Sales are off')
    const rule = (cfg.skus || {})[v.sku]
    if (!skuOnSale(rule)) return fail(res, 409, 'NOT_FOR_SALE', 'Item is not for sale')
    const prices = await adminDb.collection('priceList').doc('current').get()
    const { item } = pricedItem(prices.exists ? prices.data() : null, v.sku, rule)
    if (!item) return fail(res, 409, 'NOT_FOR_SALE', 'Item is not for sale')
    if (v.expectedTotalUah !== item.priceUah) return fail(res, 409, 'PRICE_CHANGED', 'Price has changed', { priceUah: item.priceUah })
    if (v.offerVersion !== str(cfg.offerVersion)) return fail(res, 409, 'OFFER_CHANGED', 'Offer has changed', { offerVersion: str(cfg.offerVersion) })
    // Наложка приходит второй волной (P16): до неё только карта, даже если способ включили в настройках.
    if (v.method !== 'card' || (cfg.methods || {}).card !== true) return fail(res, 409, 'METHOD_OFF', 'Payment method is off')
    const { fop, gate } = await gateFop(str(cfg.fopId), cfg, item.priceUah)
    if (!fop) return gateFail(res, gate)
    const fits = await warehouseFits(v.cityRef, v.warehouseRef)
    if (fits === false) return fail(res, 422, 'BAD_WAREHOUSE', 'Warehouse does not fit the city')

    const at = nowIso()
    const doc = buildOrderDoc({ id: ref.id, value: v, fingerprint, item, fop, statusToken: newStatusToken(), addressVerified: fits === true, at })
    const dayRef = adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date(at)))
    const phoneRef = adminDb.collection('shopPhones').doc(doc.phoneKey)
    const limit = shopLimit(cfg, 'unpaidPerDay')
    // Оплата уменьшает счётчик, замена и отмена нет: иначе скрипт создавал бы и снимал счета без предела.
    const out = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists) return { existing: snap.data() }
      const day = await tx.get(dayRef)
      const unpaid = (day.exists && day.data().unpaid) || 0
      if (unpaid >= limit) {
        if (day.exists && day.data().alerts?.['day-limit']) return { dayLimit: {} }
        const alerts = { 'day-limit': { at, sentAt: null, text: `⚠️ Магазин: сьогодні вже ${unpaid} неоплачених замовлень карткою, це денний ліміт. Нові замовлення не приймаються до півночі, продажі не вимкнено. Якщо це справжні покупці, скиньте лічильник на сторінці замовлень: ${siteUrl}/shop-orders` } }
        tx.set(dayRef, { alerts }, { merge: true })
        return { dayLimit: alerts }
      }
      const phone = await tx.get(phoneRef)
      const prevId = phone.exists ? (phone.data().openCard || {})[v.sku] : null
      const prevRef = prevId ? orders().doc(prevId) : null
      const prevSnap = prevRef ? await tx.get(prevRef) : null
      const prev = prevSnap?.exists && prevSnap.data().state === 'awaiting_payment' ? prevSnap.data() : null
      if (prev) tx.set(prevRef, transitionPatch(prev, 'cancelled', { at, by: 'superseded', patch: { cancelReason: 'superseded', payment: { pageUrl: null } } }), { merge: true })
      tx.set(ref, doc)
      tx.set(dayRef, { unpaid: unpaid + 1 }, { merge: true })
      tx.set(phoneRef, { openCard: { [v.sku]: ref.id } }, { merge: true })
      return { prev }
    })
    if (out.existing) return answerRepeat(res, out.existing, fingerprint)
    if (out.dayLimit) {
      hooks.sendAlerts(dayRef, out.dayLimit).catch((e) => console.error('shop: алерт ліміту:', e.message))
      return fail(res, 429, 'DAY_LIMIT', 'Daily order limit reached')
    }
    if (out.prev) removeInvoices(out.prev)
    const next = await issueInvoice(ref, doc, fop, cfg)
    return answer(res, 201, orderAnswer(doc, next || { type: 'status', payIssue: 'BANK_UNAVAILABLE' }))
  }))

  // ---------- статус ----------

  // Возврату с банка не верим и спрашиваем сами, не чаще раза в 10 секунд на все экземпляры. Идёт после ответа: банк, Telegram и касса
  // могут отвечать долго, а новое состояние страница увидит на следующем опросе.
  const pollBank = async (ref, payment) => {
    const claimed = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (Date.now() - Date.parse(cur.payment?.lastBankCheckAt) < BANK_POLL_EVERY_MS) return false
      tx.set(ref, { payment: { lastBankCheckAt: nowIso() } }, { merge: true })
      return true
    })
    if (!claimed) return
    const fop = await payments.resolveFop(payment.fopId)
    if (!fop) return console.warn(`shop: ФОП ${payment.fopId} не завантажено, платіж ${payment.orderId} чекає`)
    const st = await mono.invoiceStatus(fop, payment.providerOrderId)
    await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.payment?.paymentId === payment.orderId) tx.set(ref, { payment: { status: String(st?.status || '') } }, { merge: true })
    })
    await payments.settleMonoAcquire(payment, st, 'status')
  }

  app.get('/api/shop/orders/:token', guard, safely('статус', async (req, res) => {
    const found = await orderByToken(req.params.token)
    if (!found) return orderNotFound(res)
    const { ref, order } = found
    const awaiting = order.state === 'awaiting_payment'
    const [cfg, payment, paidPayment] = await Promise.all([
      // Настройки не прочитались: ссылку на банк не показываем, а статус отдаём.
      awaiting ? loadSales().catch((e) => { console.error('shop: налаштування для статусу:', e.message); return null }) : null,
      awaiting && order.payment?.paymentId ? payments.loadOrder(order.payment.paymentId) : null,
      order.paidPaymentId ? payments.loadOrder(order.paidPaymentId) : null,
    ])
    answer(res, 200, orderPublicView(order, { payment, paidPayment, open: cardOpenFor(cfg, order.sku), maxPayAttempts: shopLimit(cfg, 'payAttemptsPerOrder') }))
    if (payment?.status === 'pending') {
      pollBank(ref, payment).catch((e) => console.error(`shop: опитування банку ${payment.orderId}:`, e?.response?.status || e.message))
    }
  }))

  // ---------- оплата ----------

  app.post('/api/shop/orders/:token/pay', guard, safely('оплата', async (req, res) => {
    const found = await orderByToken(req.params.token)
    if (!found) return orderNotFound(res)
    const { ref, order } = found
    if (order.state !== 'awaiting_payment' || order.method !== 'card') return notPayable(res)
    const cfg = await loadSales()
    if (!acceptsOrders(cfg)) return fail(res, 409, 'SALES_OFF', 'Sales are off')
    if ((cfg.methods || {}).card !== true) return fail(res, 409, 'METHOD_OFF', 'Payment method is off')
    if (!skuOnSale((cfg.skus || {})[order.sku])) return fail(res, 409, 'NOT_FOR_SALE', 'Item is not for sale')
    const { fop, gate } = await gateFop(order.fopId, cfg, order.total)
    if (!fop) return gateFail(res, gate)

    // Новый счёт только после конечного ответа банка по прежнему: иначе покупатель мог бы заплатить дважды.
    const cur = order.payment || {}
    const bankBusy = () => fail(res, 409, 'PAY_IN_PROGRESS', 'Payment is in progress')
    if (cur.paymentId) {
      const payment = await payments.loadOrder(cur.paymentId)
      const view = invoiceView(order, payment)
      if (payment?.status === 'pending') {
        let st
        try {
          st = await withBudget(mono.invoiceStatus(fop, payment.providerOrderId), bankReadBudgetMs)
        } catch (e) {
          console.warn(`shop: статус рахунку ${payment.orderId}:`, e?.response?.status || e.message)
          return view.live ? answer(res, 200, { next: redirectTo(cur.pageUrl) }) : fail(res, 502, 'BANK_UNAVAILABLE', 'Bank is temporarily unavailable')
        }
        const bank = st?.status
        if (bank === 'success' || bank === 'reversed') {
          settleInBackground(payment, st, 'pay')
          return notPayable(res)
        }
        if (bank === 'failure' || bank === 'expired') await payments.settleMonoAcquire(payment, st, 'pay')
        else return bank === 'created' && view.live ? answer(res, 200, { next: redirectTo(cur.pageUrl) }) : bankBusy()
      } else if (!view.closed) {
        return notPayable(res)
      }
    }

    const maxAttempts = shopLimit(cfg, 'payAttemptsPerOrder')
    const claim = await adminDb.runTransaction(async (tx) => {
      const o = (await tx.get(ref)).data()
      if (o.state !== 'awaiting_payment') return { code: 'NOT_PAYABLE' }
      if (claimFresh(o.payment?.initiatedAt) || (o.payment?.paymentId || null) !== (cur.paymentId || null)) return { code: 'PAY_IN_PROGRESS' }
      if ((o.payAttempts || 0) >= maxAttempts) return { code: 'TOO_MANY_PAY_ATTEMPTS' }
      tx.set(ref, { payment: { initiatedAt: nowIso() }, updatedAt: nowIso() }, { merge: true })
      return { order: o }
    })
    if (claim.code === 'NOT_PAYABLE') return notPayable(res)
    if (claim.code === 'PAY_IN_PROGRESS') return bankBusy()
    if (claim.code) return fail(res, 429, claim.code, 'Too many payment attempts')
    const next = await issueInvoice(ref, claim.order, fop, cfg)
    return next ? answer(res, 200, { next }) : fail(res, 502, 'BANK_UNAVAILABLE', 'Bank is temporarily unavailable')
  }))

  // ---------- отмена ----------

  // Работает и при выключенных продажах. Повтор отвечает статусом, двойной клик не должен показывать ошибку,
  // и заново пробует снять счёт, если банк в прошлый раз отказал; снятый счёт в банк больше не идёт.
  app.post('/api/shop/orders/:token/cancel', guard, safely('скасування', async (req, res) => {
    const found = await orderByToken(req.params.token)
    if (!found) return orderNotFound(res)
    const { ref, order } = found
    const phoneRef = order.phoneKey ? adminDb.collection('shopPhones').doc(order.phoneKey) : null
    const out = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.state === 'cancelled') return { order: cur }
      if (claimFresh(cur.ttnCreatingAt) || !canTransition(cur, 'cancelled')) return { refused: true }
      const phone = phoneRef ? await tx.get(phoneRef) : null
      const patch = transitionPatch(cur, 'cancelled', { by: 'buyer', patch: { cancelReason: 'buyer', payment: { pageUrl: null } } })
      tx.set(ref, patch, { merge: true })
      if (phone?.exists && (phone.data().openCard || {})[cur.sku] === ref.id) tx.set(phoneRef, { openCard: { [cur.sku]: null } }, { merge: true })
      return { order: { ...cur, ...patch, payment: { ...cur.payment, pageUrl: null } } }
    })
    if (out.refused) return fail(res, 409, 'NOT_CANCELLABLE', 'Order cannot be cancelled')
    removeInvoices(out.order)
    return answer(res, 200, orderPublicView(out.order))
  }))

  // ---------- конец маршрутов сайта: новые ставить выше ----------

  // Без этого адрес мимо маршрута и битое тело ответил бы Express страницей HTML, а битое тело ещё и без проверки токена:
  // глобальный парсер падает раньше маршрута. Тело в журнал не пишем: в нём данные покупателя.
  app.use(SITE_PATHS, guard, (_req, res) => fail(res, 404, 'NOT_FOUND', 'No such shop route'))
  app.use(SITE_PATHS, (err, req, res, _next) => {
    const client = err.status >= 400 && err.status < 500
    guard(req, res, () => fail(res, client ? err.status : 500, client ? 'BAD_INPUT' : 'INTERNAL', client ? 'Bad request body' : 'Internal error'))
  })
}

export default registerShopOrders
