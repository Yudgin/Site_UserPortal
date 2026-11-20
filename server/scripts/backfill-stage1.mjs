// Разовий бекфіл даних заявок під етап 1 мобільного додатка сервісу (рішення власника 2026-10-08).
// Запуск із каталогу server/ (там firebase-admin): node scripts/backfill-stage1.mjs [--apply]
// Без --apply — тільки звіт (dry-run). Автентифікація — ADC (gcloud auth application-default login).
//
// Що робить (кожен крок ідемпотентний, повторний прогін нічого не зламає):
//  1) specialistUids = specialists[].uid           — вибірка «Мої заявки» (array-contains)
//  2) clientPhone → канонічний +380XXXXXXXXX        — пошук за номером / картка клієнта
//  3) ТТН відправлення клієнту, яку портал раніше писав у waybillNumber («до нас») і затирав вхідну
//     з 1С: ознака — npScenario return/purchase/parts (ТТН створена сервером) АБО номер зустрічається
//     в надісланих оповіщеннях «ttn» цієї заявки (мастер увів вручну через «Повідомити про відправку»).
//     Переносимо в returnTtn (якщо там порожньо або той самий номер), а waybillNumber відновлюємо зі
//     знімка 1С (onec/snapshot.raw.shipment.ttn) або очищаємо (синк заповнить порожнє поле).
//  Повний журнал змін (id, поле, було → стало) пишеться в scripts/out/backfill-stage1-<час>.jsonl
//  і в dry-run, і в apply — щоб перевірити перед застосуванням і мати дані для відкату.
//  4) stage (фізичний етап): порожній і є returnTtn → 'shipped' (історичні заявки 1С/1С6)
//  5) serviceCenterId для імпорту 1С6 (sr-1c6-*): назва «СЦ: …» у скарзі → реєстр serviceCenters за назвою
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normPhone } from '../phone.js'

const APPLY = process.argv.includes('--apply')
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry'
initializeApp({ credential: applicationDefault(), projectId: PROJECT })
const db = getFirestore()
const nowIso = () => new Date().toISOString()
const isEmpty = (v) => v === undefined || v === null || v === ''
const normTtn = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }
const normName = (s) => String(s || '').trim().toLowerCase()

const centersSnap = await db.collection('serviceCenters').get()
const centerByName = new Map()
for (const d of centersSnap.docs) { const c = d.data() || {}; if (c.name) centerByName.set(normName(c.name), d.id) }

// Номери, які вже надсилали клієнтам як «відправлено» (подія ttn): ознака, що ТТН у waybillNumber —
// насправді зворотна (введена вручну на хабі до цього пакета, без npScenario).
const sentTtnByRequest = new Map()
const ntfSnap = await db.collection('notifications').where('event', '==', 'ttn').get()
for (const d of ntfSnap.docs) {
  const n = d.data() || {}
  if (n.status !== 'sent' || !n.serviceRequestId) continue
  const nums = new Set()
  const m = String(d.id).match(/-ttn-(\d{8,20})$/); if (m) nums.add(m[1])
  for (const x of String(n.text || '').match(/\d{8,20}/g) || []) nums.add(x)
  if (!nums.size) continue
  const set = sentTtnByRequest.get(n.serviceRequestId) || new Set()
  for (const x of nums) set.add(x)
  sentTtnByRequest.set(n.serviceRequestId, set)
}

const snap = await db.collection('serviceRequests').get()
console.log(`${PROJECT}: serviceRequests=${snap.size}, centers=${centersSnap.size}, ttn-notifications=${ntfSnap.size}, mode=${APPLY ? 'APPLY' : 'dry-run'}`)

const stats = { specialistUids: 0, phone: 0, phoneManual: 0, ttnMove: 0, ttnClearDup: 0, ttnRestored: 0, ttnConflict: 0, stage: 0, center1c6: 0, docs: 0 }
const samples = { phone: [], phoneManual: [], ttnMove: [], ttnConflict: [], center1c6: [] }
const changes = [] // повний журнал: { id, field, before, after }
const logChange = (id, field, before, after) => changes.push({ id, field, before: before ?? null, after: after ?? null })
let batch = db.batch(); let inBatch = 0
const commit = async () => { if (inBatch && APPLY) await batch.commit(); batch = db.batch(); inBatch = 0 }

for (const d of snap.docs) {
  const r = d.data() || {}
  const patch = {}

  // 1) specialistUids
  if (Array.isArray(r.specialists)) {
    const uids = r.specialists.map((s) => s && s.uid).filter(Boolean)
    const cur = Array.isArray(r.specialistUids) ? r.specialistUids : null
    if (!cur || cur.length !== uids.length || cur.some((u, i) => u !== uids[i])) { patch.specialistUids = uids; stats.specialistUids++ }
  }

  // 2) телефон. Склейку двох номерів («…, … (дружина)») НЕ усікаємо мовчки — лишаємо як є і
  //    виводимо в список «перевірити вручну».
  if (!isEmpty(r.clientPhone)) {
    const digits = String(r.clientPhone).replace(/\D/g, '')
    const canon = normPhone(r.clientPhone)
    if (canon && digits.length - 12 >= 9) {
      stats.phoneManual++
      if (samples.phoneManual.length < 10) samples.phoneManual.push(`${d.id}: ${r.clientPhone}`)
    } else if (canon && canon !== r.clientPhone) {
      patch.clientPhone = canon; stats.phone++
      logChange(d.id, 'clientPhone', r.clientPhone, canon)
      if (samples.phone.length < 5) samples.phone.push(`${d.id}: ${r.clientPhone} → ${canon}`)
    }
  }

  // 3) ТТН відправлення клієнту, записана порталом у waybillNumber
  const wb = normTtn(r.waybillNumber)
  const rtCur = normTtn(r.returnTtn)
  const toClientScenario = ['return', 'purchase', 'parts'].includes(r.npScenario)
  const sentAsShipped = wb && (sentTtnByRequest.get(d.id) || new Set()).has(wb)
  if (wb && (toClientScenario || sentAsShipped)) {
    let incoming = ''
    try {
      const s = await d.ref.collection('onec').doc('snapshot').get()
      incoming = s.exists ? normTtn(s.data()?.raw?.shipment?.ttn) : ''
    } catch { /* ignore */ }
    if (!rtCur || rtCur === wb) {
      // returnTtn порожній → переносимо; той самий номер → лише прибираємо дубль із waybillNumber
      if (!rtCur) { patch.returnTtn = wb; stats.ttnMove++; logChange(d.id, 'returnTtn', r.returnTtn, wb) } else stats.ttnClearDup++
      patch.waybillNumber = incoming && incoming !== wb ? incoming : null
      if (patch.waybillNumber) stats.ttnRestored++
      logChange(d.id, 'waybillNumber', r.waybillNumber, patch.waybillNumber)
      if (samples.ttnMove.length < 5) samples.ttnMove.push(`${d.id}: waybillNumber ${wb} → returnTtn=${patch.returnTtn || rtCur}; waybillNumber=${patch.waybillNumber}`)
    } else {
      // returnTtn з 1С інший — його не чіпаємо; waybillNumber відновлюємо зі знімка або очищаємо,
      // і виводимо для ручної перевірки (дві різні зворотні ТТН на одну заявку).
      patch.waybillNumber = incoming && incoming !== wb ? incoming : null
      if (patch.waybillNumber) stats.ttnRestored++
      stats.ttnConflict++
      logChange(d.id, 'waybillNumber', r.waybillNumber, patch.waybillNumber)
      if (samples.ttnConflict.length < 10) samples.ttnConflict.push(`${d.id}: waybillNumber ${wb} (зворотна, портал) vs returnTtn ${rtCur} (1С); waybillNumber → ${patch.waybillNumber}`)
    }
  }

  // 4) етап для історичних заявок
  const returnTtn = patch.returnTtn ?? r.returnTtn
  if (isEmpty(r.stage) && !isEmpty(returnTtn)) {
    const at = nowIso()
    patch.stage = 'shipped'; patch.stageSince = at
    patch.stageHistory = [...(Array.isArray(r.stageHistory) ? r.stageHistory : []), { stage: 'shipped', at, by: 'backfill', note: `ТТН ${normTtn(returnTtn) || returnTtn}` }]
    stats.stage++
    logChange(d.id, 'stage', r.stage, 'shipped')
  }

  // 5) центр для імпорту 1С6
  if (d.id.startsWith('sr-1c6-') && isEmpty(r.serviceCenterId)) {
    const m = String(r.complaint || '').match(/СЦ:\s*([^·]+?)(?:\s*·|$)/)
    const cid = m ? centerByName.get(normName(m[1])) : ''
    if (cid) { patch.serviceCenterId = cid; stats.center1c6++; logChange(d.id, 'serviceCenterId', r.serviceCenterId, cid); if (samples.center1c6.length < 5) samples.center1c6.push(`${d.id}: «${m[1].trim()}» → ${cid}`) }
  }
  if (patch.specialistUids) logChange(d.id, 'specialistUids', r.specialistUids, patch.specialistUids)

  if (Object.keys(patch).length) {
    patch.updatedAt = nowIso()
    stats.docs++
    batch.set(d.ref, patch, { merge: true }); inBatch++
    if (inBatch >= 400) await commit()
  }
}
await commit()
console.log('stats:', JSON.stringify(stats))
for (const [k, v] of Object.entries(samples)) if (v.length) console.log(`${k}:\n  ` + v.join('\n  '))
// Повний журнал змін — у файл (і dry-run, і apply): перевірка перед застосуванням, дані для відкату.
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `backfill-stage1-${APPLY ? 'apply' : 'dry'}-${nowIso().replace(/[:.]/g, '-')}.jsonl`)
writeFileSync(outFile, changes.map((c) => JSON.stringify(c)).join('\n') + (changes.length ? '\n' : ''))
console.log(`журнал змін: ${changes.length} записів → ${outFile}`)
if (!APPLY) console.log('dry-run: нічого не записано. Повторіть із --apply, щоб застосувати.')
