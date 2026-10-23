// Связь номенклатуры портала с карточками товаров сайта (runferry.ua / runferry.de…).
// Решение владельца 2026-10-23: runferry-briefs/catalog/site-portal-parts-link-2026-10-23.md.
//
// Общий ключ — артикул (sku) = code материала в priceList/current (Firestore droidmaps-runferry).
// Карточка на сайте (Firestore runferry-eu): черновик — productDrafts/{slug} (витрина его не читает),
// опубликованная — products/{slug}. Связь хранится с обеих сторон: у материала site {slug, status, url},
// у карточки sku + portalRef. У статьи базы знаний — relatedSkus.
//
// Здесь только чистые функции: проверки и план изменений. Чтение и запись делает
// server/scripts/site-catalog.mjs (инструмент агента, доступ владельца через ADC).

export const SKU_RE = /^[A-Z0-9-]{1,10}$/
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SPARE_PARTS_CATEGORY = 'spare-parts'
export const PORTAL_PRICE_URL = 'https://my.runferry.com/pricelist-admin'
export const SITE_LOCALES = ['de', 'en', 'pl', 'nl', 'ro', 'cs', 'uk', 'bg']

// Витрина каждого рынка (packages/config/src/tenants в RunferryDE). Карточка без списка рынков
// продаётся везде — для портала ссылка ведёт на runferry.ua.
const MARKET_BASE_URL = {
  UA: 'https://runferry.ua/uk',
  DE: 'https://www.runferry.de/de',
  CZ: 'https://runferry.cz/cs',
  RO: 'https://runferry.ro/ro',
}

export function siteProductUrl(slug, availableMarkets) {
  const markets = Array.isArray(availableMarkets) ? availableMarkets.map((m) => String(m).toUpperCase()) : []
  const market = !markets.length || markets.includes('UA') ? 'UA' : markets.find((m) => MARKET_BASE_URL[m]) || 'DE'
  return `${MARKET_BASE_URL[market]}/products/${slug}`
}

export const portalPriceUrl = (sku) => `${PORTAL_PRICE_URL}?code=${encodeURIComponent(sku)}`

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

// Поля FirestoreProduct (RunferryDE packages/types/src/product.ts) + поля связи.
// Незнакомый ключ — ошибка: так опечатка в описании не уедет на сайт молча.
const PRODUCT_KEYS = new Set([
  'slug', 'name', 'category', 'description', 'shortDescription', 'basePrice', 'currency', 'images',
  'configImages', 'badge', 'inStock', 'specifications', 'features', 'relatedProducts', 'similarProducts',
  'countryPricing', 'weight', 'length', 'width', 'height', 'shipmentMode', 'availableMarkets',
  'updatedAt', 'createdAt', 'sku', 'compatibleModels', 'portalRef', 'translations',
])
const TRANSLATION_KEYS = new Set(['name', 'description', 'shortDescription', 'features'])

// Проверка документа карточки перед записью на сайт. Возвращает список ошибок (пусто — годится).
export function validateSiteProduct(doc) {
  const errors = []
  if (!isObj(doc)) return ['карточка: не объект']
  for (const k of Object.keys(doc)) if (!PRODUCT_KEYS.has(k)) errors.push(`карточка: незнакомое поле «${k}»`)
  if (!SLUG_RE.test(doc.slug || '')) errors.push('slug: только латиница в нижнем регистре, цифры и дефис')
  for (const k of ['name', 'category', 'description', 'shortDescription']) {
    if (!nonEmpty(doc[k])) errors.push(`${k}: обязательное поле (текст на немецком — основной язык сайта)`)
  }
  if (typeof doc.basePrice !== 'number' || !Number.isFinite(doc.basePrice) || doc.basePrice < 0) {
    errors.push('basePrice: цена в евро без НДС, число ≥ 0')
  }
  if (doc.currency !== 'EUR') errors.push('currency: только EUR')
  if (!isStrArr(doc.images)) errors.push('images: список путей к фото')
  if (typeof doc.inStock !== 'boolean') errors.push('inStock: да/нет')
  if (!isObj(doc.specifications) || !Object.values(doc.specifications).every((v) => typeof v === 'string')) {
    errors.push('specifications: объект «название → значение» (строки)')
  }
  if (!isObj(doc.countryPricing)) errors.push('countryPricing: объект (пустой — цена одна для всех рынков)')
  for (const k of ['features', 'relatedProducts', 'similarProducts', 'configImages', 'compatibleModels']) {
    if (doc[k] !== undefined && !isStrArr(doc[k])) errors.push(`${k}: список строк`)
  }
  if (doc.availableMarkets !== undefined) {
    if (!isStrArr(doc.availableMarkets) || !doc.availableMarkets.every((m) => /^[A-Z]{2}$/.test(m))) {
      errors.push('availableMarkets: коды стран из двух заглавных букв (UA, DE…)')
    }
  }
  for (const k of ['weight', 'length', 'width', 'height']) {
    if (doc[k] !== undefined && (typeof doc[k] !== 'number' || doc[k] <= 0)) errors.push(`${k}: число > 0`)
  }
  if (doc.shipmentMode !== undefined && !['auto', 'manual', 'inherit'].includes(doc.shipmentMode)) {
    errors.push('shipmentMode: auto | manual | inherit')
  }
  if (doc.sku !== undefined && !SKU_RE.test(doc.sku)) errors.push('sku: до 10 знаков, A-Z, 0-9 и дефис')
  if (doc.portalRef !== undefined) {
    const p = doc.portalRef
    if (!isObj(p) || p.kind !== 'material' || !SKU_RE.test(p.code || '')) errors.push('portalRef: {kind: "material", code: артикул}')
    else if (doc.sku !== undefined && p.code !== doc.sku) errors.push('portalRef.code должен совпадать с sku')
  }
  if (doc.translations !== undefined) {
    if (!isObj(doc.translations)) errors.push('translations: объект по языкам')
    else {
      for (const [lang, t] of Object.entries(doc.translations)) {
        if (!SITE_LOCALES.includes(lang)) { errors.push(`translations: язык «${lang}» не из языков сайта (${SITE_LOCALES.join(', ')})`); continue }
        if (!isObj(t)) { errors.push(`translations.${lang}: объект`); continue }
        for (const k of Object.keys(t)) if (!TRANSLATION_KEYS.has(k)) errors.push(`translations.${lang}: незнакомое поле «${k}»`)
        for (const k of ['name', 'description', 'shortDescription']) {
          if (t[k] !== undefined && typeof t[k] !== 'string') errors.push(`translations.${lang}.${k}: текст`)
        }
        if (t.features !== undefined && !isStrArr(t.features)) errors.push(`translations.${lang}.features: список строк`)
      }
    }
  }
  return errors
}

// Черновик карточки из описания агента. Поля, которых нет в описании, не появляются в документе.
export function buildDraftDoc(spec, { nowIso, existingDraft } = {}) {
  const s = spec.site || {}
  const doc = {
    slug: spec.slug,
    name: s.name,
    category: s.category || SPARE_PARTS_CATEGORY,
    description: s.description,
    shortDescription: s.shortDescription,
    basePrice: s.basePrice,
    currency: 'EUR',
    images: s.images || [],
    inStock: s.inStock ?? true,
    specifications: s.specifications || {},
    countryPricing: s.countryPricing || {},
  }
  for (const k of ['configImages', 'badge', 'features', 'relatedProducts', 'similarProducts', 'weight', 'length',
    'width', 'height', 'shipmentMode', 'availableMarkets']) {
    if (s[k] !== undefined) doc[k] = s[k]
  }
  doc.sku = spec.sku
  doc.compatibleModels = spec.compatibleModels || []
  doc.portalRef = { kind: 'material', code: spec.sku, url: portalPriceUrl(spec.sku) }
  if (s.translations !== undefined) doc.translations = s.translations
  doc.createdAt = (existingDraft && existingDraft.createdAt) || nowIso
  doc.updatedAt = nowIso
  return doc
}

const materialsOf = (priceList) => (priceList && Array.isArray(priceList.materials) ? priceList.materials : [])

// Материал с этим артикулом; дубликаты кода — ошибка (код вводится руками и не проверяется на странице).
function findMaterial(priceList, sku, errors) {
  const all = materialsOf(priceList)
  const exact = all.filter((m) => m.code === sku)
  if (exact.length > 1) errors.push(`в прайсе ${exact.length} материала с кодом ${sku} — оставьте один на странице прайса`)
  const similar = all.filter((m) => m.code !== sku && String(m.code || '').trim().toUpperCase() === sku)
  if (similar.length) errors.push(`в прайсе есть код «${similar[0].code}», отличающийся от ${sku} только регистром/пробелами`)
  return exact[0] || null
}

const DEFAULT_UNIT = { uk: 'шт', ru: 'шт', en: 'pcs' }

// План команды draft: позиция в прайсе портала (создать неактивной или привязать существующую)
// + черновик карточки на сайте. Ничего не пишет.
// productsWithSku — карточки products с этим sku (любой slug).
export function planDraft({ spec, priceList, draft, product, productsWithSku = [], nowIso, newMaterialId }) {
  const errors = []
  const warnings = []
  if (!isObj(spec)) return { errors: ['описание: не объект'], warnings }
  const { sku, slug } = spec
  if (!SKU_RE.test(sku || '')) errors.push('sku: до 10 знаков, A-Z, 0-9 и дефис (например V2-LID-R)')
  if (!SLUG_RE.test(slug || '')) errors.push('slug: только латиница в нижнем регистре, цифры и дефис (например solo-v2-lid-rect)')
  if (spec.compatibleModels !== undefined && !isStrArr(spec.compatibleModels)) errors.push('compatibleModels: список строк')
  if (errors.length) return { errors, warnings }

  const existing = findMaterial(priceList, sku, errors)
  let material
  if (existing) {
    if (existing.site && existing.site.slug && existing.site.slug !== slug) {
      errors.push(`артикул ${sku} уже связан с карточкой «${existing.site.slug}»`)
    }
    if (spec.portal) warnings.push(`позиция ${sku} уже есть в прайсе: название и цену инструмент не меняет — правьте на странице прайса`)
    const after = { ...existing, site: { slug, status: 'draft', syncedAt: nowIso } }
    if (spec.compatibleModels) after.compatibleModels = spec.compatibleModels
    material = { mode: 'link', before: existing, after }
  } else {
    const p = spec.portal || {}
    if (!isObj(p.name) || !nonEmpty(p.name.uk)) errors.push('portal.name.uk: название позиции для прайса портала (украинский)')
    if (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0) errors.push('portal.price: цена в гривнах, число ≥ 0')
    if (p.unit !== undefined && (!isObj(p.unit) || !nonEmpty(p.unit.uk))) errors.push('portal.unit: {uk: "шт", …}')
    const after = {
      id: newMaterialId,
      code: sku,
      name: p.name,
      unit: p.unit || DEFAULT_UNIT,
      price: p.price,
      compatibleModels: spec.compatibleModels || [],
      site: { slug, status: 'draft', syncedAt: nowIso },
      // Неактивна, пока владелец не утвердит цену: включает команда publish.
      active: false,
    }
    material = { mode: 'create', before: null, after }
  }

  if (product) {
    if (product.sku === sku) errors.push(`карточка ${slug} уже опубликована — чтобы править как черновик, сначала unpublish`)
    else errors.push(`slug «${slug}» на сайте уже занят товаром «${product.name || slug}»${product.sku ? ` (артикул ${product.sku})` : ''}`)
  }
  const others = productsWithSku.filter((p) => p.slug !== slug)
  if (others.length) errors.push(`артикул ${sku} уже стоит у товара «${others[0].slug}» на сайте`)
  if (draft && draft.sku && draft.sku !== sku) errors.push(`черновик «${slug}» принадлежит артикулу ${draft.sku}`)

  const draftAfter = buildDraftDoc(spec, { nowIso, existingDraft: draft })
  errors.push(...validateSiteProduct(draftAfter))
  if (!draftAfter.images.length) warnings.push('фото нет: черновик можно сохранить, публикация — только с фото')
  if (!draftAfter.translations || !draftAfter.translations.uk || !nonEmpty(draftAfter.translations.uk.name)) {
    warnings.push('нет украинского текста (site.translations.uk): на runferry.ua карточка будет по-немецки')
  }
  return { errors, warnings, material, draftBefore: draft || null, draftAfter }
}

// План команды publish: черновик → products/{slug}, позиция прайса активна, на портале ссылка.
// Если карточка уже на сайте (повторный запуск после сбоя на портале) — только синхронизация портала.
export function planPublish({ sku, priceList, draft, product, nowIso, allowNoPhoto = false }) {
  const errors = []
  const warnings = []
  const m = findMaterial(priceList, sku, errors)
  if (!m) return { errors: [...errors, `в прайсе нет позиции ${sku}`], warnings }
  const slug = m.site && m.site.slug
  if (!slug) return { errors: [...errors, `у позиции ${sku} нет карточки: сначала draft`], warnings }

  let siteOp = 'none'
  let productAfter = null
  if (product) {
    if (product.sku !== sku) errors.push(`slug «${slug}» на сайте занят другим товаром`)
    else if (draft) warnings.push('на сайте есть и карточка, и черновик: черновик не трогаю, удалите его вручную после сверки')
    productAfter = product
  } else if (!draft) {
    errors.push(`черновика «${slug}» нет на сайте`)
  } else {
    if (draft.sku !== sku) errors.push(`черновик «${slug}» принадлежит артикулу ${draft.sku}`)
    if (!allowNoPhoto && !(Array.isArray(draft.images) && draft.images.length)) {
      errors.push('у черновика нет фото — публикация только с фото (или --allow-no-photo по слову владельца)')
    }
    productAfter = { ...draft, updatedAt: nowIso, createdAt: draft.createdAt || nowIso }
    errors.push(...validateSiteProduct(productAfter))
    siteOp = 'publish'
  }
  if (errors.length) return { errors, warnings }
  const materialAfter = {
    ...m,
    active: true,
    site: { slug, status: 'published', url: siteProductUrl(slug, productAfter.availableMarkets), syncedAt: nowIso },
  }
  return { errors, warnings, siteOp, slug, productAfter, material: { mode: 'update', before: m, after: materialAfter } }
}

// План команды unpublish: products/{slug} → обратно в черновики. Снимает только карточки,
// заведённые инструментом (sku и portalRef совпадают). Активность позиции на портале не меняет.
export function planUnpublish({ sku, priceList, draft, product, nowIso }) {
  const errors = []
  const warnings = []
  const m = findMaterial(priceList, sku, errors)
  if (!m) return { errors: [...errors, `в прайсе нет позиции ${sku}`], warnings }
  const slug = m.site && m.site.slug
  if (!slug) return { errors: [...errors, `у позиции ${sku} нет карточки`], warnings }

  let siteOp = 'none'
  let draftAfter = null
  if (product) {
    if (product.sku !== sku || !product.portalRef || product.portalRef.code !== sku) {
      errors.push(`товар «${slug}» заведён не инструментом (нет sku/portalRef ${sku}) — снимайте вручную`)
    }
    if (draft) errors.push(`на сайте есть и карточка, и черновик «${slug}» — сначала разберитесь, какой оставить`)
    draftAfter = { ...product, updatedAt: nowIso }
    siteOp = 'unpublish'
  } else if (!draft) {
    errors.push(`на сайте нет ни карточки, ни черновика «${slug}»`)
  }
  if (errors.length) return { errors, warnings }
  const after = { ...m, site: { slug, status: 'draft', syncedAt: nowIso } }
  return { errors, warnings, siteOp, slug, draftAfter, material: { mode: 'update', before: m, after } }
}

// План команды link-article: relatedSkus статьи базы знаний. При добавлении артикул должен быть в прайсе.
export function planLinkArticle({ article, skus, priceList, remove = false }) {
  const errors = []
  if (!article) return { errors: ['статьи нет'] }
  if (!skus.length) errors.push('укажите хотя бы один артикул')
  for (const s of skus) {
    if (!SKU_RE.test(s)) {
      errors.push(`«${s}»: не артикул (до 10 знаков, A-Z, 0-9 и дефис)`)
      continue
    }
    if (!remove && !findMaterial(priceList, s, errors)) errors.push(`в прайсе нет позиции ${s}`)
  }
  const before = Array.isArray(article.relatedSkus) ? article.relatedSkus : []
  const after = remove ? before.filter((s) => !skus.includes(s)) : [...before, ...skus.filter((s) => !before.includes(s))]
  return { errors, before, after, changed: before.join() !== after.join() }
}

// Сверка обеих сторон: что связано, где расходится.
export function statusReport({ priceList, products = [], drafts = [] }) {
  const skus = new Set()
  for (const m of materialsOf(priceList)) if (m.site) skus.add(m.code)
  for (const p of [...products, ...drafts]) if (p.sku) skus.add(p.sku)
  const rows = []
  for (const sku of [...skus].sort()) {
    const issues = []
    const ms = materialsOf(priceList).filter((m) => m.code === sku)
    const m = ms[0] || null
    const prods = products.filter((p) => p.sku === sku)
    const drs = drafts.filter((d) => d.sku === sku)
    const product = prods[0] || null
    const draft = drs[0] || null
    if (ms.length > 1) issues.push(`в прайсе ${ms.length} позиции с этим кодом`)
    if (prods.length > 1) issues.push(`на сайте ${prods.length} карточки с этим артикулом: ${prods.map((p) => p.slug).join(', ')}`)
    if (!m) issues.push('на сайте есть, в прайсе портала позиции нет')
    else if (!m.site) issues.push('у позиции прайса нет ссылки на сайт')
    else {
      const slug = m.site.slug
      if (m.site.status === 'published') {
        if (!product) issues.push('на портале «опубліковано», а карточки на сайте нет')
        if (!m.active) issues.push('опубликовано, но позиция прайса неактивна')
      }
      if (m.site.status === 'draft') {
        if (product) issues.push('на портале «чернетка», а на сайте карточка уже опубликована')
        else if (!draft) issues.push('на портале «чернетка», а черновика на сайте нет')
      }
      for (const d of [product, draft]) if (d && d.slug !== slug) issues.push(`slug на сайте «${d.slug}», на портале «${slug}»`)
    }
    if (product && draft) issues.push('на сайте есть и карточка, и черновик')
    for (const d of [product, draft]) {
      if (d && (!d.portalRef || d.portalRef.code !== sku)) issues.push(`у «${d.slug}» нет ссылки на позицию портала ${sku}`)
    }
    rows.push({ sku, material: m, product, draft, issues })
  }
  return rows
}

// Поиск по прайсу портала и сайту (код, артикул, slug, названия на всех языках).
export function findMatches({ query, priceList, products = [], drafts = [] }) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { materials: [], products: [], drafts: [] }
  const hit = (...vals) => vals.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
  const names = (o) => (isObj(o) ? Object.values(o) : [])
  const trNames = (p) => (isObj(p.translations) ? Object.values(p.translations).map((t) => (isObj(t) ? t.name : '')) : [])
  return {
    materials: materialsOf(priceList).filter((m) => hit(m.code, ...names(m.name))),
    products: products.filter((p) => hit(p.slug, p.sku, p.name, ...trNames(p))),
    drafts: drafts.filter((p) => hit(p.slug, p.sku, p.name, ...trNames(p))),
  }
}

// Заменить материал в прайсе по id (или добавить новый). Возвращает новый массив материалов.
export function replaceMaterial(priceList, after) {
  const list = materialsOf(priceList)
  const i = list.findIndex((m) => m.id === after.id)
  return i === -1 ? [...list, after] : list.map((m, idx) => (idx === i ? after : m))
}

// Строка для ИИ: связанные со статьёй запчасти с ценой и ссылкой на сайт.
// Только активные позиции с опубликованной карточкой — черновики клиенту не называем.
export function relatedPartsLine(skus, materials) {
  if (!Array.isArray(skus) || !skus.length || !Array.isArray(materials)) return ''
  const parts = skus
    .map((s) => materials.find((m) => m.code === s))
    .filter((m) => m && m.active && m.site && m.site.status === 'published' && m.site.url)
    .map((m) => `${(m.name && m.name.uk) || m.code} [${m.code}] — ${m.price} грн — ${m.site.url}`)
  return parts.length ? 'Запчастини (можна дати клієнту посилання): ' + parts.join('; ') : ''
}
