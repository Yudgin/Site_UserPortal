// node --test: чистые функции связи прайса портала с карточками сайта (без Firestore и сети).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SKU_RE, siteProductUrl, portalPriceUrl, validateSiteProduct, buildDraftDoc, planDraft, planPublish,
  planUnpublish, planLinkArticle, statusReport, findMatches, replaceMaterial, relatedPartsLine,
} from './siteCatalog.js'

const NOW = '2026-10-23T12:00:00.000Z'
const servo = { id: 'mat-servo', code: 'M-SERVO', name: { uk: 'Сервопривід' }, unit: { uk: 'шт' }, price: 950, active: true }
const pl = (...materials) => ({ materials: [servo, ...materials] })

const spec = (extra = {}) => ({
  sku: 'V2-LID-R',
  slug: 'solo-v2-lid-rect',
  compatibleModels: ['Solo V2'],
  portal: { name: { uk: 'Кришка Solo V2 прямокутна', ru: 'Крышка Solo V2 прямоугольная' }, price: 450 },
  site: {
    name: 'Deckel für SOLO V2, rechteckig',
    shortDescription: 'Ersatzdeckel für SOLO V2',
    description: 'Rechteckiger Ersatzdeckel für das Futterboot SOLO V2 (ab 2020).',
    basePrice: 12,
    images: ['/images/products/spare-parts/solo-v2-lid-rect/1.jpg'],
    translations: { uk: { name: 'Кришка для SOLO V2 прямокутна', shortDescription: 'Запасна кришка', description: 'Прямокутна кришка.' } },
  },
  ...extra,
})

test('SKU format', () => {
  for (const ok of ['V2-LID-R', 'M-SERVO', 'M-ECHO200S', 'A']) assert.ok(SKU_RE.test(ok), ok)
  for (const bad of ['v2-lid-r', 'V2_LID', 'V2-LID-RM-X1', '', 'КРИШКА']) assert.ok(!SKU_RE.test(bad), bad)
})

test('siteProductUrl picks the storefront by markets', () => {
  assert.equal(siteProductUrl('x'), 'https://runferry.ua/uk/products/x')
  assert.equal(siteProductUrl('x', []), 'https://runferry.ua/uk/products/x')
  assert.equal(siteProductUrl('x', ['DE', 'UA']), 'https://runferry.ua/uk/products/x')
  assert.equal(siteProductUrl('x', ['de']), 'https://www.runferry.de/de/products/x')
  assert.equal(siteProductUrl('x', ['PL', 'CZ']), 'https://runferry.cz/cs/products/x')
  assert.equal(siteProductUrl('x', ['PL']), 'https://www.runferry.de/de/products/x')
  assert.equal(portalPriceUrl('V2-LID-R'), 'https://my.runferry.com/pricelist-admin?code=V2-LID-R')
})

test('buildDraftDoc: full product shape with link fields, no stray undefined keys', () => {
  const d = buildDraftDoc(spec(), { nowIso: NOW })
  assert.equal(d.category, 'spare-parts')
  assert.equal(d.currency, 'EUR')
  assert.equal(d.inStock, true)
  assert.deepEqual(d.countryPricing, {})
  assert.equal(d.sku, 'V2-LID-R')
  assert.deepEqual(d.portalRef, { kind: 'material', code: 'V2-LID-R', url: 'https://my.runferry.com/pricelist-admin?code=V2-LID-R' })
  assert.equal(d.createdAt, NOW)
  assert.ok(!('weight' in d) && !('badge' in d))
  assert.deepEqual(validateSiteProduct(d), [])
  const again = buildDraftDoc(spec(), { nowIso: '2026-10-24T00:00:00.000Z', existingDraft: d })
  assert.equal(again.createdAt, NOW)
  assert.equal(again.updatedAt, '2026-10-24T00:00:00.000Z')
})

test('validateSiteProduct catches the usual mistakes', () => {
  const d = buildDraftDoc(spec(), { nowIso: NOW })
  const errs = validateSiteProduct({ ...d, basePrice: '12', colour: 'red', availableMarkets: ['ua'], translations: { ru: {} } })
  assert.ok(errs.some((e) => e.startsWith('basePrice')))
  assert.ok(errs.some((e) => e.includes('«colour»')))
  assert.ok(errs.some((e) => e.startsWith('availableMarkets')))
  assert.ok(errs.some((e) => e.includes('«ru»')))
  assert.ok(validateSiteProduct({ ...d, portalRef: { kind: 'material', code: 'OTHER' } }).some((e) => e.includes('совпадать')))
  assert.ok(validateSiteProduct({ ...d, description: ' ' }).some((e) => e.startsWith('description')))
})

test('planDraft: new part → inactive material + draft', () => {
  const p = planDraft({ spec: spec(), priceList: pl(), nowIso: NOW, newMaterialId: 'mat-abc123' })
  assert.deepEqual(p.errors, [])
  assert.equal(p.material.mode, 'create')
  assert.deepEqual(p.material.after, {
    id: 'mat-abc123', code: 'V2-LID-R', name: spec().portal.name, unit: { uk: 'шт', ru: 'шт', en: 'pcs' }, price: 450,
    compatibleModels: ['Solo V2'], site: { slug: 'solo-v2-lid-rect', status: 'draft', syncedAt: NOW }, active: false,
  })
  assert.equal(p.draftAfter.slug, 'solo-v2-lid-rect')
  assert.deepEqual(p.warnings, [])
})

test('planDraft: existing material is linked, its name/price/active untouched', () => {
  const p = planDraft({ spec: spec({ sku: 'M-SERVO', slug: 'servo' }), priceList: pl(), nowIso: NOW })
  assert.deepEqual(p.errors, [])
  assert.equal(p.material.mode, 'link')
  assert.equal(p.material.after.price, 950)
  assert.equal(p.material.after.active, true)
  assert.deepEqual(p.material.after.name, servo.name)
  assert.deepEqual(p.material.after.site, { slug: 'servo', status: 'draft', syncedAt: NOW })
  assert.ok(p.warnings.some((w) => w.includes('не меняет')))
})

test('planDraft refuses conflicts', () => {
  const linked = { ...servo, code: 'V2-LID-R', id: 'mat-x', site: { slug: 'other-slug', status: 'draft', syncedAt: NOW } }
  assert.ok(planDraft({ spec: spec(), priceList: pl(linked), nowIso: NOW }).errors.some((e) => e.includes('other-slug')))
  const dup = planDraft({ spec: spec(), priceList: pl({ ...servo, id: 'a', code: 'V2-LID-R' }, { ...servo, id: 'b', code: 'V2-LID-R' }), nowIso: NOW })
  assert.ok(dup.errors.some((e) => e.includes('2 материала')))
  const similar = planDraft({ spec: spec(), priceList: pl({ ...servo, id: 'c', code: 'v2-lid-r ' }), nowIso: NOW, newMaterialId: 'm' })
  assert.ok(similar.errors.some((e) => e.includes('регистром')))
  const busy = planDraft({ spec: spec(), priceList: pl(), product: { slug: 'solo-v2-lid-rect', name: 'X' }, nowIso: NOW, newMaterialId: 'm' })
  assert.ok(busy.errors.some((e) => e.includes('занят')))
  const published = planDraft({ spec: spec(), priceList: pl(), product: { slug: 'solo-v2-lid-rect', sku: 'V2-LID-R' }, nowIso: NOW, newMaterialId: 'm' })
  assert.ok(published.errors.some((e) => e.includes('unpublish')))
  const skuElsewhere = planDraft({ spec: spec(), priceList: pl(), productsWithSku: [{ slug: 'old', sku: 'V2-LID-R' }], nowIso: NOW, newMaterialId: 'm' })
  assert.ok(skuElsewhere.errors.some((e) => e.includes('«old»')))
  const foreignDraft = planDraft({ spec: spec(), priceList: pl(), draft: { slug: 'solo-v2-lid-rect', sku: 'V2-LID-H' }, nowIso: NOW, newMaterialId: 'm' })
  assert.ok(foreignDraft.errors.some((e) => e.includes('V2-LID-H')))
  const noPrice = planDraft({ spec: spec({ portal: { name: { uk: 'К' } } }), priceList: pl(), nowIso: NOW, newMaterialId: 'm' })
  assert.ok(noPrice.errors.some((e) => e.startsWith('portal.price')))
  assert.ok(planDraft({ spec: spec({ sku: 'v2' }), priceList: pl() }).errors[0].startsWith('sku'))
})

test('planDraft warns about missing photo and Ukrainian text', () => {
  const s = spec()
  s.site = { ...s.site, images: [], translations: undefined }
  const p = planDraft({ spec: s, priceList: pl(), nowIso: NOW, newMaterialId: 'm' })
  assert.deepEqual(p.errors, [])
  assert.equal(p.warnings.length, 2)
})

const draftedList = () => {
  const p = planDraft({ spec: spec(), priceList: pl(), nowIso: NOW, newMaterialId: 'mat-abc123' })
  return { priceList: { materials: replaceMaterial(pl(), p.material.after) }, draft: p.draftAfter }
}

test('planPublish: draft → product, material active with site url', () => {
  const { priceList, draft } = draftedList()
  const p = planPublish({ sku: 'V2-LID-R', priceList, draft, nowIso: '2026-10-25T00:00:00.000Z' })
  assert.deepEqual(p.errors, [])
  assert.equal(p.siteOp, 'publish')
  assert.equal(p.productAfter.createdAt, NOW)
  assert.equal(p.productAfter.updatedAt, '2026-10-25T00:00:00.000Z')
  assert.equal(p.material.after.active, true)
  assert.deepEqual(p.material.after.site, {
    slug: 'solo-v2-lid-rect', status: 'published', url: 'https://runferry.ua/uk/products/solo-v2-lid-rect', syncedAt: '2026-10-25T00:00:00.000Z',
  })
})

test('planPublish: no photo → refused unless allowed; rerun after portal failure only syncs portal', () => {
  const { priceList, draft } = draftedList()
  const bare = { ...draft, images: [] }
  assert.ok(planPublish({ sku: 'V2-LID-R', priceList, draft: bare, nowIso: NOW }).errors.some((e) => e.includes('фото')))
  assert.deepEqual(planPublish({ sku: 'V2-LID-R', priceList, draft: bare, nowIso: NOW, allowNoPhoto: true }).errors, [])
  const rerun = planPublish({ sku: 'V2-LID-R', priceList, product: { ...draft }, nowIso: NOW })
  assert.deepEqual(rerun.errors, [])
  assert.equal(rerun.siteOp, 'none')
  assert.equal(rerun.material.after.site.status, 'published')
  assert.ok(planPublish({ sku: 'M-SERVO', priceList, nowIso: NOW }).errors.some((e) => e.includes('сначала draft')))
  assert.ok(planPublish({ sku: 'V2-LID-H', priceList, nowIso: NOW }).errors.some((e) => e.includes('нет позиции')))
  assert.ok(planPublish({ sku: 'V2-LID-R', priceList, product: { slug: 'solo-v2-lid-rect', sku: 'X' }, nowIso: NOW }).errors.length)
})

test('planUnpublish: only tool-made cards go back to drafts', () => {
  const { priceList, draft } = draftedList()
  const pub = planPublish({ sku: 'V2-LID-R', priceList, draft, nowIso: NOW })
  const after = { materials: replaceMaterial(priceList, pub.material.after) }
  const u = planUnpublish({ sku: 'V2-LID-R', priceList: after, product: pub.productAfter, nowIso: '2026-10-26T00:00:00.000Z' })
  assert.deepEqual(u.errors, [])
  assert.equal(u.siteOp, 'unpublish')
  assert.equal(u.draftAfter.updatedAt, '2026-10-26T00:00:00.000Z')
  assert.deepEqual(u.material.after.site, { slug: 'solo-v2-lid-rect', status: 'draft', syncedAt: '2026-10-26T00:00:00.000Z' })
  assert.equal(u.material.after.active, true)
  const foreign = { ...pub.productAfter, portalRef: undefined }
  assert.ok(planUnpublish({ sku: 'V2-LID-R', priceList: after, product: foreign, nowIso: NOW }).errors.some((e) => e.includes('вручную')))
  assert.ok(planUnpublish({ sku: 'V2-LID-R', priceList: after, product: pub.productAfter, draft, nowIso: NOW }).errors.length)
  assert.equal(planUnpublish({ sku: 'V2-LID-R', priceList: after, draft, nowIso: NOW }).siteOp, 'none')
})

test('planLinkArticle adds/removes known SKUs only', () => {
  const priceList = pl({ ...servo, id: 'r', code: 'V2-LID-R' }, { ...servo, id: 'h', code: 'V2-LID-H' })
  const art = { id: 'solo-v2-lid-types', relatedSkus: ['V2-LID-H'] }
  const add = planLinkArticle({ article: art, skus: ['V2-LID-R', 'V2-LID-H'], priceList })
  assert.deepEqual(add.errors, [])
  assert.deepEqual(add.after, ['V2-LID-H', 'V2-LID-R'])
  assert.ok(add.changed)
  assert.ok(planLinkArticle({ article: art, skus: ['V2-LID-RM'], priceList }).errors.some((e) => e.includes('V2-LID-RM')))
  assert.ok(planLinkArticle({ article: art, skus: ['bad sku'], priceList }).errors.length)
  const rm = planLinkArticle({ article: art, skus: ['V2-LID-H'], priceList, remove: true })
  assert.deepEqual(rm.after, [])
  assert.ok(!planLinkArticle({ article: { relatedSkus: [] }, skus: ['V2-LID-H'], priceList, remove: true }).changed)
  assert.ok(planLinkArticle({ article: null, skus: ['V2-LID-H'], priceList }).errors.length)
})

test('statusReport flags drift between the two sides', () => {
  const { priceList, draft } = draftedList()
  assert.deepEqual(statusReport({ priceList, drafts: [draft] })[0].issues, [])
  assert.ok(statusReport({ priceList }).find((r) => r.sku === 'V2-LID-R').issues.some((i) => i.includes('черновика на сайте нет')))
  const orphan = statusReport({ priceList: pl(), products: [{ slug: 'x', sku: 'X-1' }] })
  assert.ok(orphan[0].issues.some((i) => i.includes('позиции нет')))
  assert.ok(orphan[0].issues.some((i) => i.includes('нет ссылки на позицию портала')))
  const pub = planPublish({ sku: 'V2-LID-R', priceList, draft, nowIso: NOW })
  const after = { materials: replaceMaterial(priceList, pub.material.after) }
  assert.deepEqual(statusReport({ priceList: after, products: [pub.productAfter] })[0].issues, [])
  assert.ok(statusReport({ priceList: after }).find((r) => r.sku === 'V2-LID-R').issues.some((i) => i.includes('карточки на сайте нет')))
})

test('findMatches searches codes, slugs and names in every language', () => {
  const { priceList, draft } = draftedList()
  const r = findMatches({ query: 'кришка', priceList, drafts: [draft], products: [{ slug: 'solo-v2', name: 'SOLO V2' }] })
  assert.equal(r.materials.length, 1)
  assert.equal(r.drafts.length, 1)
  assert.equal(r.products.length, 0)
  assert.equal(findMatches({ query: 'solo v2', priceList, products: [{ slug: 'solo-v2', name: 'SOLO V2' }] }).products.length, 1)
  assert.equal(findMatches({ query: ' ', priceList }).materials.length, 0)
})

test('relatedPartsLine names only published, active parts', () => {
  const pubPart = { code: 'V2-LID-R', name: { uk: 'Кришка Solo V2 прямокутна' }, price: 450, active: true, site: { slug: 's', status: 'published', url: 'https://runferry.ua/uk/products/s' } }
  const draftPart = { ...pubPart, code: 'V2-LID-H', site: { slug: 'h', status: 'draft' } }
  const inactive = { ...pubPart, code: 'V2-LID-RM', active: false }
  const line = relatedPartsLine(['V2-LID-R', 'V2-LID-H', 'V2-LID-RM', 'NONE'], [pubPart, draftPart, inactive])
  assert.equal(line, 'Запчастини (можна дати клієнту посилання): Кришка Solo V2 прямокутна [V2-LID-R] — 450 грн — https://runferry.ua/uk/products/s')
  assert.equal(relatedPartsLine(['V2-LID-H'], [draftPart]), '')
  assert.equal(relatedPartsLine(undefined, [pubPart]), '')
})
