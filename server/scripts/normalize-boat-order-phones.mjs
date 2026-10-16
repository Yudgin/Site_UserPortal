// Разова нормалізація boatOrders.clientPhone до канонічного +380XXXXXXXXX (2026-10-16). Навіщо: входящий
// дзвінок Binotel шукає покупку кораблика за номером (server/binotelWebhook.js, варіанти +380…/380…/0…), а
// BoatOrderPage до цієї правки писав номер як набрали — формат із дужками пошук не знаходить.
// Запуск із каталогу server/ (там firebase-admin): node scripts/normalize-boat-order-phones.mjs [--apply]
// Без --apply — тільки звіт (dry-run). Автентифікація — ADC (gcloud auth application-default login).
//
// Правило — як крок 2 у backfill-stage1.mjs: склейку двох номерів («…, … (дружина)») НЕ усікаємо мовчки,
// лишаємо як є і виводимо в «перевірити вручну»; нерозпізнаний номер (іноземний, сміття) не чіпаємо.
// updatedAt НЕ освіжаємо: формат номера — не дія по замовленню (порядок і «свіжість» списку не змінюються).
// Повний журнал (id, було → стало) — у scripts/out/normalize-boat-order-phones-<режим>-<час>.jsonl: перевірка
// перед застосуванням і дані для відкату. Повторний прогін нічого не змінює.
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

const snap = await db.collection('boatOrders').get()
console.log(`${PROJECT}: boatOrders=${snap.size}, mode=${APPLY ? 'APPLY' : 'dry-run'}`)

const stats = { empty: 0, canonical: 0, fixed: 0, manual: 0, unknown: 0 }
const samples = { fixed: [], manual: [], unknown: [] }
const changes = []
let batch = db.batch(); let inBatch = 0
const commit = async () => { if (inBatch && APPLY) await batch.commit(); batch = db.batch(); inBatch = 0 }

for (const d of snap.docs) {
  const raw = (d.data() || {}).clientPhone
  if (raw === undefined || raw === null || raw === '') { stats.empty++; continue }
  const canon = normPhone(raw)
  const digits = String(raw).replace(/\D/g, '')
  if (canon && digits.length - 12 >= 9) {
    stats.manual++
    samples.manual.push(`${d.id}: ${raw}`)
  } else if (!canon) {
    stats.unknown++
    samples.unknown.push(`${d.id}: ${raw}`)
  } else if (canon === raw) {
    stats.canonical++
  } else {
    stats.fixed++
    changes.push({ id: d.id, field: 'clientPhone', before: raw, after: canon })
    samples.fixed.push(`${d.id}: ${JSON.stringify(raw)} → ${canon}`)
    batch.set(d.ref, { clientPhone: canon }, { merge: true }); inBatch++
    if (inBatch >= 400) await commit()
  }
}
await commit()
console.log('stats:', JSON.stringify(stats))
for (const [k, v] of Object.entries(samples)) if (v.length) console.log(`${k}:\n  ` + v.join('\n  '))
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `normalize-boat-order-phones-${APPLY ? 'apply' : 'dry'}-${nowIso().replace(/[:.]/g, '-')}.jsonl`)
writeFileSync(outFile, changes.map((c) => JSON.stringify(c)).join('\n') + (changes.length ? '\n' : ''))
console.log(`журнал змін: ${changes.length} записів → ${outFile}`)
if (!APPLY) console.log('dry-run: нічого не записано. Повторіть із --apply, щоб застосувати.')
