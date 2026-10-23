// Инструмент агента: карточки запчастей на сайте (runferry.ua / runferry.de…) и их связь с прайсом портала.
// Решение владельца 2026-10-23: runferry-briefs/catalog/site-portal-parts-link-2026-10-23.md.
//
// Запуск из каталога server/ (там firebase-admin), доступ — ADC владельца (gcloud auth application-default login):
//   node scripts/site-catalog.mjs find <слово>                     — поиск в прайсе портала и на сайте
//   node scripts/site-catalog.mjs status [АРТИКУЛ]                 — что связано и где расхождения
//   node scripts/site-catalog.mjs show-draft <АРТИКУЛ|slug>        — черновик карточки целиком (на согласование)
//   node scripts/site-catalog.mjs draft <описание.json> [--apply]   — позиция прайса + черновик карточки
//   node scripts/site-catalog.mjs publish <АРТИКУЛ> [--apply] [--allow-no-photo]
//   node scripts/site-catalog.mjs unpublish <АРТИКУЛ> [--apply]
//   node scripts/site-catalog.mjs link-article <idСтатьи> <АРТИКУЛ…> [--remove] [--apply]
//
// Без --apply — только показывает, что изменится. publish — ТОЛЬКО по слову владельца «публікуй <артикул>».
// Каждая запись идёт в журнал scripts/out/site-catalog-<время>.jsonl (было → стало) — для проверки и отката.
// Прайс пишется транзакцией с архивной копией в priceArchive (как страница /pricelist-admin);
// после записи открытая страница прайса устарела — её надо обновить, она сама попросит.
// Формат описания для draft — buildDraftDoc/planDraft в server/siteCatalog.js и бриф (раздел «Описание карточки»).
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import {
  planDraft, planPublish, planUnpublish, planLinkArticle, statusReport, findMatches, replaceMaterial, SKU_RE,
} from '../siteCatalog.js'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [cmd, ...rest] = args.filter((a) => !a.startsWith('--'))
const APPLY = flags.has('--apply')
const PORTAL_PROJECT = process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry'
const SITE_PROJECT = process.env.SITE_FIREBASE_PROJECT_ID || 'runferry-eu'
const ACTOR = 'site-catalog (агент)'

const portalDb = getFirestore(initializeApp({ credential: applicationDefault(), projectId: PORTAL_PROJECT }, 'portal'))
const siteDb = getFirestore(initializeApp({ credential: applicationDefault(), projectId: SITE_PROJECT }, 'site'))
portalDb.settings({ ignoreUndefinedProperties: true })
siteDb.settings({ ignoreUndefinedProperties: true })

const nowIso = () => new Date().toISOString()
const newMaterialId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return 'mat-' + Array.from(crypto.randomBytes(6), (b) => chars[b % chars.length]).join('')
}
const priceRef = () => portalDb.doc('priceList/current')
const show = (v) => JSON.stringify(v, null, 2)

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out')
const journalFile = join(outDir, `site-catalog-${nowIso().replace(/[:.]/g, '-')}.jsonl`)
const journal = (entry) => {
  mkdirSync(outDir, { recursive: true })
  appendFileSync(journalFile, JSON.stringify({ at: nowIso(), cmd, ...entry }) + '\n')
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

function report(plan) {
  for (const w of plan.warnings || []) console.log(`  ! ${w}`)
  if (plan.errors && plan.errors.length) {
    console.log('ОШИБКИ — ничего не записано:')
    for (const e of plan.errors) console.log(`  ✗ ${e}`)
    process.exit(2)
  }
}

async function loadPriceList() {
  const snap = await priceRef().get()
  if (!snap.exists) die(`${PORTAL_PROJECT}: priceList/current не найден`)
  return snap.data()
}
const getDoc = async (db, path) => {
  const s = await db.doc(path).get()
  return s.exists ? s.data() : null
}
const listAll = async (db, col) => (await db.collection(col).get()).docs.map((d) => d.data())
const productsWithSku = async (sku) => (await siteDb.collection('products').where('sku', '==', sku).get()).docs.map((d) => d.data())

// Записать позицию прайса: транзакция перечитывает прайс, перестраивает план на свежих данных и архивирует прежнюю версию.
async function writeMaterial(replan) {
  return portalDb.runTransaction(async (tx) => {
    const snap = await tx.get(priceRef())
    if (!snap.exists) throw new Error('priceList/current не найден')
    const prev = snap.data()
    const plan = replan(prev)
    if (plan.errors && plan.errors.length) throw new Error('прайс изменился во время записи: ' + plan.errors.join('; '))
    const after = plan.material.after
    const archiveId = crypto.randomBytes(12).toString('base64url')
    tx.set(portalDb.collection('priceArchive').doc(archiveId), { ...prev, archiveId, archivedAt: nowIso(), supersededBy: ACTOR })
    tx.set(priceRef(), { ...prev, materials: replaceMaterial(prev, after), updatedAt: nowIso(), updatedBy: ACTOR })
    journal({ project: PORTAL_PROJECT, path: 'priceList/current#materials/' + after.id, before: plan.material.before, after, archiveId })
    return after
  })
}

function printMaterialChange(material) {
  const verb = material.mode === 'create' ? 'СОЗДАТЬ (неактивной до publish)' : 'ОБНОВИТЬ'
  console.log(`Портал ${PORTAL_PROJECT}, прайс → материал ${material.after.code}: ${verb}`)
  if (material.before) console.log('  было: ' + JSON.stringify({ site: material.before.site || null, active: material.before.active, compatibleModels: material.before.compatibleModels }))
  console.log('  станет: ' + JSON.stringify(material.mode === 'create' ? material.after : { site: material.after.site, active: material.after.active, compatibleModels: material.after.compatibleModels }))
}

const reminder = () => console.log('Прайс портала изменён: если страница /pricelist-admin открыта — обновите её перед правкой.')

async function cmdFind(query) {
  if (!query) die('find <слово>')
  const [priceList, products, drafts] = await Promise.all([loadPriceList(), listAll(siteDb, 'products'), listAll(siteDb, 'productDrafts')])
  const r = findMatches({ query, priceList, products, drafts })
  console.log(`Прайс портала (${r.materials.length}):`)
  for (const m of r.materials) console.log(`  ${m.code} — ${(m.name && m.name.uk) || ''} — ${m.price} грн${m.active ? '' : ' (неактивна)'}${m.site ? ` — сайт: ${m.site.slug} (${m.site.status})` : ''}`)
  console.log(`Сайт, карточки (${r.products.length}):`)
  for (const p of r.products) console.log(`  ${p.slug} — ${p.name} — ${p.basePrice} € — ${p.category}${p.sku ? ` — артикул ${p.sku}` : ''}`)
  console.log(`Сайт, черновики (${r.drafts.length}):`)
  for (const p of r.drafts) console.log(`  ${p.slug} — ${p.name} — ${p.basePrice} €${p.sku ? ` — артикул ${p.sku}` : ''}`)
}

async function cmdStatus(sku) {
  const [priceList, products, drafts] = await Promise.all([loadPriceList(), listAll(siteDb, 'products'), listAll(siteDb, 'productDrafts')])
  const rows = statusReport({ priceList, products, drafts }).filter((r) => !sku || r.sku === sku)
  if (!rows.length) console.log(sku ? `${sku}: связей нет` : 'Связанных позиций нет')
  for (const r of rows) {
    const m = r.material
    console.log(`${r.sku}:`)
    console.log(`  портал: ${m ? `${(m.name && m.name.uk) || ''} — ${m.price} грн — ${m.active ? 'активна' : 'неактивна'} — сайт: ${m.site ? `${m.site.slug} (${m.site.status})${m.site.url ? ' ' + m.site.url : ''}` : 'нет'}` : 'нет'}`)
    console.log(`  сайт: ${r.product ? `опубликовано ${r.product.slug} — ${r.product.basePrice} €` : r.draft ? `черновик ${r.draft.slug} — ${r.draft.basePrice} €` : 'нет'}`)
    for (const i of r.issues) console.log(`  ✗ ${i}`)
  }
}

async function cmdShowDraft(key) {
  if (!key) die('show-draft <АРТИКУЛ|slug>')
  let draft = SKU_RE.test(key) ? null : await getDoc(siteDb, `productDrafts/${key}`)
  if (!draft) {
    const snap = await siteDb.collection('productDrafts').where('sku', '==', key).get()
    draft = snap.empty ? null : snap.docs[0].data()
  }
  if (!draft) die(`черновика ${key} нет`)
  console.log(show(draft))
}

async function cmdDraft(file) {
  if (!file) die('draft <описание.json>')
  const spec = JSON.parse(readFileSync(file, 'utf8'))
  const sku = spec.sku
  const slug = spec.slug
  const [priceList, draft, product, withSku] = await Promise.all([
    loadPriceList(),
    slug ? getDoc(siteDb, `productDrafts/${slug}`) : null,
    slug ? getDoc(siteDb, `products/${slug}`) : null,
    sku ? productsWithSku(sku) : [],
  ])
  const id = newMaterialId()
  const plan = planDraft({ spec, priceList, draft, product, productsWithSku: withSku, nowIso: nowIso(), newMaterialId: id })
  report(plan)
  printMaterialChange(plan.material)
  console.log(`Сайт ${SITE_PROJECT}: productDrafts/${slug} — ${draft ? 'ОБНОВИТЬ' : 'СОЗДАТЬ'} (витрина черновики не видит)`)
  console.log(show(plan.draftAfter))
  if (!APPLY) return console.log('\nРежим просмотра. Записать: та же команда с --apply')

  // Сначала сайт, потом портал: оба шага идемпотентны, повторный запуск после сбоя доводит до конца.
  await siteDb.doc(`productDrafts/${slug}`).set(plan.draftAfter)
  journal({ project: SITE_PROJECT, path: `productDrafts/${slug}`, before: draft, after: plan.draftAfter })
  await writeMaterial((fresh) => planDraft({
    spec, priceList: fresh, draft: plan.draftAfter, product: null, productsWithSku: withSku, nowIso: plan.draftAfter.updatedAt, newMaterialId: id,
  }))
  console.log(`Записано. Журнал: ${journalFile}`)
  reminder()
}

async function cmdPublish(sku) {
  if (!SKU_RE.test(sku || '')) die('publish <АРТИКУЛ>')
  const priceList = await loadPriceList()
  const slug = (priceList.materials || []).find((m) => m.code === sku)?.site?.slug
  const [draft, product] = slug ? await Promise.all([getDoc(siteDb, `productDrafts/${slug}`), getDoc(siteDb, `products/${slug}`)]) : [null, null]
  const plan = planPublish({ sku, priceList, draft, product, nowIso: nowIso(), allowNoPhoto: flags.has('--allow-no-photo') })
  report(plan)
  console.log(plan.siteOp === 'publish'
    ? `Сайт ${SITE_PROJECT}: productDrafts/${slug} → products/${slug} (карточка появится на витрине)`
    : `Сайт: карточка products/${slug} уже есть — синхронизирую только портал`)
  printMaterialChange(plan.material)
  if (!APPLY) return console.log('\nРежим просмотра. Опубликовать: та же команда с --apply (только по слову владельца)')

  if (plan.siteOp === 'publish') {
    await siteDb.runTransaction(async (tx) => {
      const dRef = siteDb.doc(`productDrafts/${slug}`)
      const pRef = siteDb.doc(`products/${slug}`)
      const [d, p] = await Promise.all([tx.get(dRef), tx.get(pRef)])
      if (!d.exists || p.exists) throw new Error('черновик или карточка изменились во время публикации — запустите ещё раз')
      tx.create(pRef, plan.productAfter)
      tx.delete(dRef)
    })
    journal({ project: SITE_PROJECT, path: `products/${slug}`, before: null, after: plan.productAfter, movedFrom: `productDrafts/${slug}` })
  }
  await writeMaterial((fresh) => planPublish({ sku, priceList: fresh, draft: null, product: plan.productAfter, nowIso: plan.material.after.site.syncedAt }))
  console.log(`Опубликовано: ${plan.material.after.site.url}\nЖурнал: ${journalFile}`)
  reminder()
}

async function cmdUnpublish(sku) {
  if (!SKU_RE.test(sku || '')) die('unpublish <АРТИКУЛ>')
  const priceList = await loadPriceList()
  const slug = (priceList.materials || []).find((m) => m.code === sku)?.site?.slug
  const [draft, product] = slug ? await Promise.all([getDoc(siteDb, `productDrafts/${slug}`), getDoc(siteDb, `products/${slug}`)]) : [null, null]
  const plan = planUnpublish({ sku, priceList, draft, product, nowIso: nowIso() })
  report(plan)
  console.log(plan.siteOp === 'unpublish'
    ? `Сайт ${SITE_PROJECT}: products/${slug} → productDrafts/${slug} (карточка исчезнет с витрины)`
    : `Сайт: карточки на витрине уже нет, есть черновик — синхронизирую только портал`)
  printMaterialChange(plan.material)
  if (!APPLY) return console.log('\nРежим просмотра. Снять с витрины: та же команда с --apply')

  if (plan.siteOp === 'unpublish') {
    await siteDb.runTransaction(async (tx) => {
      const dRef = siteDb.doc(`productDrafts/${slug}`)
      const pRef = siteDb.doc(`products/${slug}`)
      const [d, p] = await Promise.all([tx.get(dRef), tx.get(pRef)])
      if (d.exists || !p.exists) throw new Error('черновик или карточка изменились — запустите ещё раз')
      tx.set(dRef, { ...p.data(), updatedAt: plan.draftAfter.updatedAt })
      tx.delete(pRef)
    })
    journal({ project: SITE_PROJECT, path: `productDrafts/${slug}`, before: null, after: plan.draftAfter, movedFrom: `products/${slug}` })
  }
  await writeMaterial((fresh) => planUnpublish({ sku, priceList: fresh, draft: plan.draftAfter || draft, product: null, nowIso: plan.material.after.site.syncedAt }))
  console.log(`Снято с витрины, карточка снова черновик. Журнал: ${journalFile}`)
  reminder()
}

async function cmdLinkArticle(articleId, skus) {
  if (!articleId || !skus.length) die('link-article <idСтатьи> <АРТИКУЛ…> [--remove]')
  const ref = portalDb.doc(`knowledgeArticles/${articleId}`)
  const [article, priceList] = await Promise.all([getDoc(portalDb, ref.path), loadPriceList()])
  const remove = flags.has('--remove')
  const plan = planLinkArticle({ article, skus, priceList, remove })
  report(plan)
  console.log(`Портал, статья ${articleId}: relatedSkus ${JSON.stringify(plan.before)} → ${JSON.stringify(plan.after)}`)
  if (!plan.changed) return console.log('Изменений нет.')
  if (!APPLY) return console.log('\nРежим просмотра. Записать: та же команда с --apply')
  await ref.update({ relatedSkus: plan.after, updatedAt: nowIso(), updatedBy: ACTOR })
  journal({ project: PORTAL_PROJECT, path: ref.path + '#relatedSkus', before: plan.before, after: plan.after })
  console.log(`Записано. Журнал: ${journalFile}`)
}

const commands = {
  find: () => cmdFind(rest.join(' ')),
  status: () => cmdStatus(rest[0]),
  'show-draft': () => cmdShowDraft(rest[0]),
  draft: () => cmdDraft(rest[0]),
  publish: () => cmdPublish(rest[0]),
  unpublish: () => cmdUnpublish(rest[0]),
  'link-article': () => cmdLinkArticle(rest[0], rest.slice(1)),
}
if (!commands[cmd]) die(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 13).join('\n'))
await commands[cmd]()
process.exit(0)
