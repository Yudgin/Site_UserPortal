// Пошук клієнта у Firestore для картки — ті самі запити, що в приймача Binotel (server/clientLookup.js), лише читання.
// firebase-admin беремо з server/node_modules (своїх залежностей у шлюзу немає), креди — ADC: на Mac
// `gcloud auth application-default login`, на ВМ GCE — сервісний акаунт. Бюджет як у приймача: не встигли — null.
import { createRequire } from 'node:module'
import { makeClientLookup } from '../../server/clientLookup.js'
import { pickRequestsForAi } from './card.mjs'

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

// Угода: у клієнтській сторінці accepted має пріоритет над acceptedAt / agreement_at. Відсутнє поле — невідомо,
// а явне false або порожня дата — не прийнято. Назовні повертаємо лише ознаку, без дати чи інших даних клієнта.
export function termsAcceptedAtField(source, field) {
  const parts = String(field || '').split('.').filter(Boolean)
  if (!parts.length || parts.some((x) => ['__proto__', 'prototype', 'constructor'].includes(x))) return null
  let value = source
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return null
    value = value[part]
  }
  const accepted = (v) => v === true || v === 'true' ? true : v === false || v === 'false' ? false : null
  if (value && typeof value === 'object') {
    const explicit = accepted(value.accepted)
    if (explicit != null) return explicit
    if (Object.hasOwn(value, 'acceptedAt')) return value.acceptedAt != null && value.acceptedAt !== ''
    if (Object.hasOwn(value, 'agreement_at')) return value.agreement_at != null && value.agreement_at !== ''
    return null
  }
  const explicit = accepted(value)
  if (explicit != null) return explicit
  if (/^(?:acceptedAt|agreement_at)$/.test(parts.at(-1))) return value != null && value !== ''
  return null
}

// Повертає {lookup(phoneE164) → {requests, profile, orders} | null, recentAppCalls(srId) → [дзвінки] | null, warm()}.
// db — для тестів (підроблений Firestore).
export const APP_CALLS_LIMIT = 10
export function makeLookup({ projectId = 'droidmaps-runferry', budgetMs = 1200, callsBudgetMs = 600, termsField = '', db = null, now = Date.now, log = () => {} } = {}) {
  let adminDb = db
  let find = null
  let routingData = null
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
      const run = async () => {
        const result = await init()(phone)
        if (!termsField) return result
        const { main, mainOpen } = pickRequestsForAi(result.requests, now())
        return { ...result, termsAccepted: mainOpen ? await requestTerms(main.id, main) : null }
      }
      const r = await withBudget(Promise.resolve().then(run), budgetMs)
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
  // VG_TERMS_FIELD порожнє — жодного нового читання. Доступний верхній рівень заявки (clientAcceptedTerms.accepted)
  // або вже збережений 1С-знімок (onec/snapshot.raw.clientAcceptedTerms чи onec/snapshot.raw.agreement_at).
  async function requestTerms(srId, request = null) {
    if (!termsField || !srId) return null
    const prefix = 'onec/snapshot.'
    if (!termsField.startsWith(prefix)) return termsAcceptedAtField(request, termsField)
    try {
      const run = () => {
        init()
        return adminDb.collection('serviceRequests').doc(srId).collection('onec').doc('snapshot').get()
      }
      const r = await withBudget(Promise.resolve().then(run), budgetMs)
      if (r === TIMEOUT) {
        log(`соглашение заявки: не уложилась в ${budgetMs} мс`)
        return null
      }
      if (r.error) throw r.error
      return r.value.exists ? termsAcceptedAtField(r.value.data(), termsField.slice(prefix.length)) : null
    } catch (e) {
      log(`соглашение заявки: ошибка ${e?.message || e}`)
      return null
    }
  }
  // Останні дзвінки з застосунку по заявці (режим обговорення, VG_DS_SOURCE=calls): лише читання,
  // serviceRequests/{id}/calls orderBy('createdAt','desc') limit 10 (одиночний індекс усередині колекції Firestore створює
  // сам). Не встигли за callsBudgetMs або помилка — null («обговорення немає»), дзвінок не чекає.
  async function recentAppCalls(srId) {
    if (!srId || typeof srId !== 'string') return null
    try {
      const run = () => {
        init()
        return adminDb.collection('serviceRequests').doc(srId).collection('calls').orderBy('createdAt', 'desc').limit(APP_CALLS_LIMIT).get()
      }
      const r = await withBudget(Promise.resolve().then(run), callsBudgetMs)
      if (r === TIMEOUT) {
        log(`звонки заявки: не уложились в ${callsBudgetMs} мс — обсуждения нет`)
        return null
      }
      if (r.error) throw r.error
      return r.value.docs.map((d) => ({ id: d.id, ...d.data() }))
    } catch (e) {
      log(`звонки заявки: ошибка ${e?.message || e} — обсуждения нет`)
      return null
    }
  }
  // Прогрів gRPC-каналу на старті (перше читання після запуску ~0,5–1 с) — одне читання, без запису.
  async function warm() {
    init()
    const snap = await adminDb.collection('system').doc('binotelRouting').get()
    routingData = snap.exists ? snap.data() : null
    return routingData
  }
  return { lookup, recentAppCalls, requestTerms, warm, routing: () => routingData }
}

export default makeLookup
