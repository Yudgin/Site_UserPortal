// API магазина для сервера сайта runferry.ua: лента товаров и поиск Новой Почты. Браузер сюда не ходит, токен
// SHOP_SITE_TOKEN живёт только на сервере сайта. Правила ленты в shopCore.js, здесь чтение Firestore и ответы.
import { timingSafeEqual } from 'crypto'
import { rateLimit } from './rateLimit.js'
import { loadFopFresh } from './fops.js'
import { KYIV_DAY } from './shopPayments.js'
import { NP_REF_RE, SALES_MODES, buildCatalogFeed } from './shopCore.js'

// Сервер сайта ждёт чтение 8 с: отвечаем раньше, чтобы сбой НП не выглядел сбоем портала.
const NP_BUDGET_MS = 7000
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

const withBudget = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`немає відповіді за ${ms} мс`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

// Реф в том виде, в каком его примет заказ (validateOrderInput): другой выбрать в списке незачем, заказ не пройдёт.
const npRef = (v) => {
  const ref = str(v).toLowerCase()
  return NP_REF_RE.test(ref) ? ref : ''
}

const isPostomat = (wh) => String(wh?.TypeOfWarehouse || '') === POSTOMAT_TYPE
  || /поштомат|почтомат/i.test(`${wh?.Description || ''} ${wh?.DescriptionRu || ''}`)

export function registerShopOrders(app, deps) {
  const {
    adminDb, npRequest, hooks, siteUrl = 'https://my.runferry.com', npBudgetMs = NP_BUDGET_MS,
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
