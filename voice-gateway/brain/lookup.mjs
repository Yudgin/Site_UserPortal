// Пошук клієнта у Firestore для картки — ті самі запити, що в приймача Binotel (server/clientLookup.js), лише читання.
// firebase-admin беремо з server/node_modules (своїх залежностей у шлюзу немає), креди — ADC: на Mac
// `gcloud auth application-default login`, на ВМ GCE — сервісний акаунт. Бюджет як у приймача: не встигли — null.
import { createRequire } from 'node:module'
import { makeClientLookup } from '../../server/clientLookup.js'

const TIMEOUT = Symbol('timeout')
// Результат або TIMEOUT; помилку віддаємо як {error}, щоб у лозі було видно справжню причину, а не «не встиг».
const withBudget = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(TIMEOUT), ms)
  p.then((v) => { clearTimeout(t); resolve({ value: v }) }, (e) => { clearTimeout(t); resolve({ error: e }) })
})

function openFirestore(projectId) {
  const req = createRequire(new URL('../../server/package.json', import.meta.url))
  const { initializeApp, applicationDefault, getApps } = req('firebase-admin/app')
  const { getFirestore } = req('firebase-admin/firestore')
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId })
  return getFirestore(app)
}

// Повертає {lookup(phoneE164) → {requests, profile, orders} | null, warm()}. db — для тестів (підроблений Firestore).
export function makeLookup({ projectId = 'droidmaps-runferry', budgetMs = 1200, db = null, log = () => {} } = {}) {
  let adminDb = db
  let find = null
  const init = () => {
    if (!find) {
      adminDb = adminDb || openFirestore(projectId)
      find = makeClientLookup(adminDb)
    }
    return find
  }
  async function lookup(phone) {
    if (!phone) return null
    try {
      const r = await withBudget(Promise.resolve().then(() => init()(phone)), budgetMs)
      if (r === TIMEOUT) {
        log(`поиск клиента: не уложился в ${budgetMs} мс`)
        return null
      }
      if (r.error) throw r.error
      return r.value
    } catch (e) {
      log(`поиск клиента: ошибка ${e?.message || e}`)
      return null
    }
  }
  // Прогрів gRPC-каналу на старті (перше читання після запуску ~0,5–1 с) — одне читання, без запису.
  async function warm() {
    init()
    await adminDb.collection('system').doc('binotelRouting').get()
  }
  return { lookup, warm }
}

export default makeLookup
