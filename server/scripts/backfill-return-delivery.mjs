#!/usr/bin/env node
// Дозаповнення serviceRequests.returnDelivery {ttn, shippedAt, deliveredAt} з історії зворотної ТТН у знімку 1С
// (serviceRequests/{id}/onec/snapshot.raw.returnTtnHistory). Далі поле підтримує нічна синхронізація (onecSync.js).
// Потрібне для правила власника 2026-10-17 «заявка відкрита, доки клієнт не отримав кораблик, і ще 14 днів після»
// (isOpen у binotelWebhook.js). Креди — ADC.
//   node scripts/backfill-return-delivery.mjs           # усухую: що змінилося б + як зміняться категорії дзвінків
//   node scripts/backfill-return-delivery.mjs --write   # записати лише поле returnDelivery (updatedAt не чіпаємо)
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { returnDeliveryOf } from '../onecSync.js'
import { isOpen, clientCategory, normalizeRouting } from '../binotelWebhook.js'

const WRITE = process.argv.includes('--write')
// Кожне читання/запис — з таймаутом і повторами: довгий послідовний прохід по ~575 знімках інколи «зависав» на одному
// gRPC-виклику, і Node завершувався з «unsettled top-level await» посеред запису (2026-10-17).
const keepAlive = setInterval(() => {}, 1000)
const withRetry = async (fn, label) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))])
    } catch (e) {
      if (attempt === 3) throw new Error(`${label}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
}
const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry' }))
const same = (a, b) => !!a && !!b && (a.ttn || null) === (b.ttn || null) && (a.shippedAt || null) === (b.shippedAt || null) && (a.deliveredAt || null) === (b.deliveredAt || null)

const docs = (await db.collection('serviceRequests').get()).docs
const routingSnap = await db.collection('system').doc('binotelRouting').get()
const cfg = normalizeRouting(routingSnap.exists ? routingSnap.data() : {})
const nowMs = Date.now()
let scanned = 0, withRd = 0, delivered = 0, changed = 0, written = 0
const before = [], after = []
for (const d of docs) {
  const sr = { id: d.id, ...d.data() }
  before.push(sr)
  if (!sr.externalRequestId && !sr.onec) { after.push(sr); continue }
  const snap = await withRetry(() => d.ref.collection('onec').doc('snapshot').get(), `snapshot ${d.id}`)
  if (scanned % 100 === 0) console.error(`… ${scanned} знімків`)
  scanned++
  const rd = snap.exists && snap.data().raw ? returnDeliveryOf(snap.data().raw) : null
  if (!rd) { after.push(sr); continue }
  withRd++
  if (rd.deliveredAt) delivered++
  after.push({ ...sr, returnDelivery: rd })
  if (!same(rd, sr.returnDelivery)) {
    changed++
    if (WRITE) { await withRetry(() => d.ref.update({ returnDelivery: rd }), `update ${d.id}`); written++ }
  }
}
const tally = (list) => {
  const byPhone = {}
  for (const s of list) if (s.clientPhone) (byPhone[s.clientPhone] ||= []).push(s)
  const t = {}
  for (const reqs of Object.values(byPhone)) { const k = clientCategory({ requests: reqs, orders: [] }, nowMs, cfg); t[k] = (t[k] || 0) + 1 }
  return t
}
const openCount = (list) => list.filter((s) => isOpen(s, nowMs, cfg)).length
console.log(`snapshots scanned ${scanned}, with return TTN ${withRd}, delivered ${delivered}, would change ${changed}${WRITE ? `, written ${written}` : ' (dry run)'}`)
console.log(`open requests: without returnDelivery ${openCount(before)}, with returnDelivery ${openCount(after)}`)
console.log('categories by phone (requests only, no boat orders):', 'before', JSON.stringify(tally(before)), 'after', JSON.stringify(tally(after)))
clearInterval(keepAlive)
