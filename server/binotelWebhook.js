// Загальний приймач вебхуків АТС Binotel на runferry-backend (контракт узгоджено з сесією «1С телефонія
// міграція», 2026-10-16). Зараз тут лише API CALL SETTINGS; apiCallCompleted і API PUSH додає та сесія
// в цей самий модуль (шляхи /api/binotel/call-completed і /api/binotel/push).
//
//   POST /api/binotel/call-settings
//     Хто шле: сьогодні — 1С як проксі (Binotel → 1С bot:/binotel → тіло байт-у-байт сюди, заголовок
//     x-binotel-via: 1c; наш JSON 1С повертає Binotel як свій), пізніше — сам Binotel (URL перемкне
//     підтримка Binotel). Авторизація: заголовок x-binotel-token АБО ?k= (Binotel заголовків не задає),
//     значення = env BINOTEL_WEBHOOK_TOKEN (Secret Manager binotel-webhook-token). Немає env → 503,
//     невірний токен → 403.
//     Тіло: application/x-www-form-urlencoded (як шле Binotel; вкладені поля в PHP-нотації a[b][0][c])
//     або JSON. Поля apiCallSettings: requestType, externalNumber, pbxNumber (вхідний) / internalNumber
//     (вихідний), companyID, callType (0 — вхідний, 1 — вихідний).
//     Відповідь: завжди HTTP 200 і JSON — {customerData?, routeData?} або {} («нам нічого сказати» —
//     1С тоді відповідає Binotel по-старому; сам Binotel на {} іде за сценарієм лінії).
//     Критичний шлях — лише Firestore (3 читання паралельно, бюджет LOOKUP_BUDGET_MS), без зовнішніх
//     викликів; журнал пишеться ПІСЛЯ відповіді.
//
// Маршрутизацію перемикає документ Firestore system/binotelRouting (без деплою; див. DEFAULT_ROUTING і
// normalizeRouting): поза scope (за замовчуванням — лише testNumbers) відповідаємо {}, тож реальні клієнти
// живуть на логіці 1С, поки сесія дзвінків не скаже scope:'all'.
// Журнал: binotelEvents/{autoId} (kind 'call-settings'; сире тіло, наша відповідь, рішення, затримка),
// expireAt = +180 днів (TTL-політика Firestore). У callEvents (операторська дошка) — лише прапорцем
// mirrorCallEvents і лише вхідні, на які ми відповіли по суті: туди вже пише call.incoming старий
// операторський бот, інакше картки задвоюються.
import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { normPhone } from './phone.js'

const nowIso = () => new Date().toISOString()
const LOOKUP_BUDGET_MS = Number(process.env.BINOTEL_LOOKUP_BUDGET_MS || 1200) // 1С чекає нас ≤ 2 с
const RAW_MAX_STORE = 8 * 1024 // скільки сирого тіла кладемо в журнал
const JOURNAL_TTL_DAYS = 180
const SR_SCAN_LIMIT = 25 // заявок одного телефону для вибору «головної»
export const NAME_MAX = 43 // Binotel: довше обрізає плагін/телефон
export const DESC_MAX = 70

// Підписи для картки дзвінка (укр.) — дзеркало src/types/serviceRequest.ts
const STAGE_UK = {
  received: 'Отримано', diagnosed: 'Діагностовано', waiting_parts: 'Чекаємо запчастини',
  repaired: 'Відремонтовано', packed: 'Запаковано', shipped: 'Відправлено',
}
const STATUS_UK = {
  new: 'Нова', diagnostics: 'Діагностика', offered: 'Запропоновано', approved: 'Погоджено',
  in_work: 'В роботі', done: 'Виконано', cancelled: 'Скасовано',
}

// ---------- розбір тіла ----------

// Вкладені form-поля як у qs/PHP: a[b][0][c]=v → {a:{b:[{c:v}]}}. Глибина ≤ 6, індекси масивів ≤ 200,
// ключі __proto__/constructor/prototype відкидаються. Повтор простого ключа → масив значень.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const decode = (s) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}
export function parseNestedForm(raw) {
  const out = {}
  if (!raw) return out
  for (const part of String(raw).split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = decode(eq === -1 ? part : part.slice(0, eq))
    const val = eq === -1 ? '' : decode(part.slice(eq + 1))
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key)
    const path = m ? [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1])] : [key]
    if (path.length > 7 || path.some((k) => BAD_KEYS.has(k))) continue
    let node = out
    for (let i = 0; i < path.length; i++) {
      let k = path[i]
      const last = i === path.length - 1
      if (k === '') k = Array.isArray(node) ? node.length : Object.keys(node).length // a[]=…
      if (Array.isArray(node) && !/^\d+$/.test(String(k))) break
      if (Array.isArray(node) && Number(k) > 200) break
      if (last) {
        if (node[k] === undefined) node[k] = val
        else if (Array.isArray(node[k])) node[k].push(val)
        else if (typeof node[k] !== 'object') node[k] = [node[k], val]
      } else {
        if (node[k] === undefined || typeof node[k] !== 'object') node[k] = /^\d+$/.test(path[i + 1]) || path[i + 1] === '' ? [] : {}
        node = node[k]
      }
    }
  }
  return out
}

// Сире тіло → об'єкт. JSON — за Content-Type або якщо тіло починається з «{»; інакше form-urlencoded.
export function parseBinotelBody(rawBuf, contentType = '') {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : typeof rawBuf === 'string' ? rawBuf : '' // без тіла body-parser лишає {}
  const trimmed = raw.trim()
  const looksJson = /json/i.test(contentType) || trimmed.startsWith('{')
  if (looksJson) {
    try {
      const j = JSON.parse(trimmed || '{}')
      return { raw, format: 'json', data: j && typeof j === 'object' && !Array.isArray(j) ? j : {} }
    } catch { /* не JSON — пробуємо як форму */ }
  }
  return { raw, format: 'form', data: parseNestedForm(trimmed) }
}

// ---------- документ system/binotelRouting ----------

export const DEFAULT_ROUTING = {
  enabled: true, // false → завжди {} (повністю логіка 1С)
  scope: 'test', // 'test' — відповідаємо лише номерам з testNumbers; 'all' — усім
  testNumbers: [],
  // 'passthrough' — routeData не віддаємо (сценарій лінії); 'route' — routeId; 'byClient' — сценарій за категорією
  // клієнта з categoryRoutes (схема сесії «Голосові заглушки для сценаріїв Binotel», 2026-10-16)
  mode: 'passthrough',
  routeId: null,
  routeType: 'route', // або 'routeWithTime' (ID у двох списках Binotel можуть збігатися)
  overrides: {}, // {телефон: routeId | {id, type} | 0} — діє за будь-якого mode; 0/null → без routeData
  // mode 'byClient': {openRequest: S2, knownClient: S1, unknown: —} — routeId | {id, type}; тип за замовчуванням
  // routeWithTime (робочий час рахує Binotel); категорії немає або id порожній → без routeData (сценарій лінії S0)
  categoryRoutes: {},
  sendCustomerData: true,
  assignedToEmployeeNumber: null, // 1С зараз завжди шле 906
  mirrorCallEvents: false,
}

const posInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const routeTypeOf = (t) => (t === 'routeWithTime' ? 'routeWithTime' : 'route')
// Запис маршруту: число або {id|routeId, type|routeType}; тип за замовчуванням — defaultType.
const routeEntry = (v, defaultType) => (v && typeof v === 'object'
  ? { id: posInt(v.id ?? v.routeId), type: routeTypeOf(v.type ?? v.routeType ?? defaultType) }
  : { id: posInt(v), type: routeTypeOf(defaultType) })
export const CATEGORIES = ['openRequest', 'knownClient', 'unknown']

export function normalizeRouting(doc) {
  const d = doc && typeof doc === 'object' ? doc : null
  if (!d) return { ...DEFAULT_ROUTING, enabled: false, missing: true }
  const testNumbers = (Array.isArray(d.testNumbers) ? d.testNumbers : []).map(normPhone).filter(Boolean)
  const overrides = {}
  const src = d.overrides && typeof d.overrides === 'object' ? d.overrides : d.override && typeof d.override === 'object' ? d.override : {}
  for (const [k, v] of Object.entries(src)) {
    const p = normPhone(k)
    if (!p) continue
    overrides[p] = routeEntry(v, d.routeType)
  }
  const categoryRoutes = {}
  const cr = d.categoryRoutes && typeof d.categoryRoutes === 'object' ? d.categoryRoutes : {}
  for (const c of CATEGORIES) if (cr[c] != null) categoryRoutes[c] = routeEntry(cr[c], 'routeWithTime')
  const assigned = d.assignedToEmployeeNumber == null ? '' : String(d.assignedToEmployeeNumber).trim()
  return {
    enabled: d.enabled !== false,
    scope: d.scope === 'all' ? 'all' : 'test',
    testNumbers,
    mode: d.mode === 'route' || d.mode === 'byClient' ? d.mode : 'passthrough',
    routeId: posInt(d.routeId),
    routeType: routeTypeOf(d.routeType),
    overrides,
    categoryRoutes,
    sendCustomerData: d.sendCustomerData !== false,
    assignedToEmployeeNumber: assigned === '' ? null : /^\d+$/.test(assigned) ? Number(assigned) : assigned, // числом, як шле 1С
    mirrorCallEvents: d.mirrorCallEvents === true,
  }
}

// ---------- відповідь ----------

export const clip = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…'
}
const nationalPretty = (e164) => {
  const d = String(e164 || '').replace(/\D/g, '').slice(-9) // 671234567
  return d.length === 9 ? `0${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}` : ''
}
const isActive = (sr) => !['done', 'cancelled'].includes(sr.status) && sr.stage !== 'shipped'
const tsOf = (sr) => String(sr.updatedAt || sr.createdAt || '')
const numberOf = (sr) => String(sr?.onec?.number || '').replace(/^0+/, '')

// Головна заявка: спершу активні (не виконані/скасовані/відправлені), серед них — найсвіжіша.
export function pickRequests(list) {
  const arr = (list || []).filter(Boolean)
  const active = arr.filter(isActive).sort((a, b) => tsOf(b).localeCompare(tsOf(a)))
  const rest = arr.filter((x) => !isActive(x)).sort((a, b) => tsOf(b).localeCompare(tsOf(a)))
  return { main: active[0] || rest[0] || null, activeCount: active.length, total: arr.length }
}

export function buildCustomerData({ phone, requests, profile, siteUrl, assignedToEmployeeNumber }) {
  const { main, activeCount, total } = pickRequests(requests)
  const name = clip(main?.clientName || profile?.name || nationalPretty(phone) || 'Невідомий номер', NAME_MAX)
  let description
  if (main) {
    const no = numberOf(main)
    const head = `${isActive(main) ? 'Ремонт' : 'Останній ремонт'}${no ? ` №${no}` : ''}`
    const state = STAGE_UK[main.stage] || STATUS_UK[main.status] || ''
    const more = activeCount > 1 ? ` (+${activeCount - 1})` : ''
    const parts = [head + more, state, main.boat, main.complaint].filter(Boolean)
    description = clip(parts.join(' · '), DESC_MAX)
  } else {
    description = profile ? 'Клієнт без заявок' : 'Новий номер, заявок немає'
  }
  const base = String(siteUrl || 'https://my.runferry.com').replace(/\/+$/, '')
  const cd = {
    name,
    description,
    linkToCrmUrl: main ? `${base}/service-request/${encodeURIComponent(main.id)}` : `${base}/service-requests`,
    linkToCrmTitle: main ? clip(`Заявка${numberOf(main) ? ` №${numberOf(main)}` : ''}${total > 1 ? ` (усього ${total})` : ''}`, DESC_MAX) : 'Заявки',
  }
  if (assignedToEmployeeNumber) cd.assignedToEmployeeNumber = assignedToEmployeeNumber
  return cd
}

// Категорія клієнта для mode 'byClient': незакрита заявка (не done/cancelled/shipped) → openRequest; реальна історія
// (будь-яка заявка або профіль клієнта з сайту/ботів) → knownClient; інакше unknown. Картки, які 1С створює на кожен
// дзвінок, сюди не потрапляють — у нашій базі їх немає. Пошук не встиг → null (маршрут не віддаємо).
export function clientCategory(lookup) {
  if (!lookup) return null
  const reqs = (lookup.requests || []).filter(Boolean)
  if (reqs.some(isActive)) return 'openRequest'
  if (reqs.length || lookup.profile) return 'knownClient'
  return 'unknown'
}

// Рішення: що відповісти на apiCallSettings. Повертає {response, decision, routeId, category}.
export function decideCallSettings({ fields, routing, lookup, siteUrl }) {
  const phone = normPhone(fields.externalNumber)
  if (fields.requestType && fields.requestType !== 'apiCallSettings') return { response: {}, decision: 'not-call-settings' }
  if (!phone) return { response: {}, decision: 'no-phone' }
  if (!routing || !routing.enabled) return { response: {}, decision: routing?.missing ? 'no-routing-doc' : 'disabled' }
  if (routing.scope === 'test' && !routing.testNumbers.includes(phone)) return { response: {}, decision: 'out-of-scope' }
  const incoming = String(fields.callType ?? '0') !== '1'
  const response = {}
  if (routing.sendCustomerData && lookup) {
    response.customerData = buildCustomerData({ phone, requests: lookup.requests, profile: lookup.profile, siteUrl, assignedToEmployeeNumber: routing.assignedToEmployeeNumber })
  }
  let routeId = null
  let category = null
  let routeType = routing.routeType
  let decision = incoming ? 'passthrough' : 'outgoing'
  if (incoming) {
    const ov = routing.overrides[phone]
    if (ov) {
      routeId = ov.id
      routeType = ov.type
      decision = routeId ? 'override' : 'override-none'
    } else if (routing.mode === 'route' && routing.routeId) {
      routeId = routing.routeId
      decision = 'route'
    } else if (routing.mode === 'byClient') {
      category = clientCategory(lookup)
      const entry = category ? routing.categoryRoutes[category] : null
      if (entry?.id) {
        routeId = entry.id
        routeType = entry.type
      }
      decision = `byClient:${category || 'no-lookup'}${entry?.id ? '' : '-none'}`
    }
  }
  if (routeId) response.routeData = { type: routeType, id: routeId }
  if (!lookup && routing.sendCustomerData) decision += '+lookup-timeout'
  return { response, decision, routeId, category }
}

// ---------- маршрут ----------

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}
const TIMEOUT = Symbol('timeout')
const withBudget = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(TIMEOUT), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(TIMEOUT) })
})

export function registerBinotelWebhook(app, deps) {
  const { adminDb, siteUrl } = deps
  const TOKEN = process.env.BINOTEL_WEBHOOK_TOKEN || ''
  if (!TOKEN) console.warn('⚠️  BINOTEL_WEBHOOK_TOKEN not set — /api/binotel/* answers 503')

  // Тіло читаємо самі (глобальні парсери пропускають /api/binotel/ — див. index.js): потрібні сирі байти
  // для журналу і власний розбір вкладених полів.
  const rawBody = express.raw({ type: () => true, limit: '256kb' })
  const guard = (req, res, next) => {
    if (!TOKEN) return res.status(503).json({ ok: false, error: 'BINOTEL_WEBHOOK_TOKEN not set' })
    const given = req.get('x-binotel-token') || (typeof req.query.k === 'string' ? req.query.k : '')
    if (!safeEqual(given, TOKEN)) return res.status(403).json({ ok: false })
    next()
  }

  const lookupClient = async (phone) => {
    const digits = phone.replace(/\D/g, '')
    const [srSnap, profSnap] = await Promise.all([
      adminDb.collection('serviceRequests').where('clientPhone', '==', phone).limit(SR_SCAN_LIMIT).get(),
      adminDb.collection('clientProfiles').doc(digits).get(),
    ])
    return {
      requests: srSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      profile: profSnap.exists ? profSnap.data() : null,
    }
  }
  const loadRouting = async () => {
    const s = await adminDb.collection('system').doc('binotelRouting').get()
    return normalizeRouting(s.exists ? s.data() : null)
  }
  // Прогрів gRPC-каналу Firestore на старті інстансу: перше читання після холодного старту ~0,5–1 с,
  // а 1С чекає нас ≤ 2 с — нехай цю ціну заплатить старт, а не перший дзвінок.
  if (adminDb) loadRouting().catch(() => {})

  app.post('/api/binotel/call-settings', guard, rawBody, async (req, res) => {
    const started = Date.now()
    let parsed = { raw: '', format: 'form', data: {} }
    let result = { response: {}, decision: 'error' }
    let routing = null
    let lookup = null
    try {
      parsed = parseBinotelBody(req.body, req.get('content-type') || '')
      const f = parsed.data
      const phone = normPhone(f.externalNumber)
      if (!adminDb) {
        result = { response: {}, decision: 'no-db' }
      } else {
        const [r, l] = await Promise.all([
          withBudget(loadRouting(), LOOKUP_BUDGET_MS),
          phone ? withBudget(lookupClient(phone), LOOKUP_BUDGET_MS) : Promise.resolve(null),
        ])
        routing = r === TIMEOUT ? null : r
        lookup = l === TIMEOUT ? null : l
        result = routing ? decideCallSettings({ fields: f, routing, lookup, siteUrl }) : { response: {}, decision: 'routing-timeout' }
      }
    } catch (e) {
      console.error('binotel/call-settings:', e.message)
      result = { response: {}, decision: 'error' }
    }
    const latencyMs = Date.now() - started
    res.status(200).json(result.response)

    // ---- журнал (після відповіді, поза критичним шляхом) ----
    if (!adminDb) return
    try {
      const f = parsed.data || {}
      const phone = normPhone(f.externalNumber) || null
      const ref = adminDb.collection('binotelEvents').doc()
      const at = nowIso()
      const main = lookup ? pickRequests(lookup.requests).main : null
      const entry = {
        kind: 'call-settings',
        via: String(req.get('x-binotel-via') || 'direct').slice(0, 32),
        format: parsed.format,
        requestType: f.requestType ? String(f.requestType) : null,
        callType: f.callType != null ? Number(f.callType) : null,
        externalNumber: phone,
        externalNumberRaw: f.externalNumber != null ? String(f.externalNumber).slice(0, 32) : null,
        pbxNumber: f.pbxNumber != null ? String(f.pbxNumber) : null,
        internalNumber: f.internalNumber != null ? String(f.internalNumber) : null,
        companyID: f.companyID != null ? String(f.companyID) : null,
        generalCallID: f.generalCallID != null ? String(f.generalCallID) : null,
        raw: parsed.raw.length > RAW_MAX_STORE ? parsed.raw.slice(0, RAW_MAX_STORE) : parsed.raw,
        rawTruncated: parsed.raw.length > RAW_MAX_STORE,
        parsed: parsed.raw.length <= RAW_MAX_STORE ? f : null,
        response: result.response,
        decision: result.decision,
        routeId: result.routeId || null,
        category: result.category || null,
        serviceRequestId: main?.id || null,
        latencyMs,
        at,
        expireAt: new Date(Date.now() + JOURNAL_TTL_DAYS * 86400 * 1000),
      }
      // Ключі розібраного тіла — від АТС; якщо Firestore відкине якесь ім'я поля (__x__ тощо), пишемо без parsed.
      await ref.set(entry).catch(() => ref.set({ ...entry, parsed: null, parsedRejected: true }))
      // Дзеркало — лише для вхідних, на які ми відповіли по суті (інакше дублювали б картки старого бота).
      if (routing?.mirrorCallEvents && phone && String(f.callType ?? '0') !== '1' && Object.keys(result.response).length) {
        const callId = `binotel-cs-${ref.id}`
        await adminDb.collection('callEvents').doc(callId).set({
          callId, source: 'binotel-settings', kind: 'incoming', phone,
          clientName: result.response.customerData?.name || null,
          line: f.pbxNumber != null ? String(f.pbxNumber) : null,
          serviceRequestId: main?.id || null, routeId: result.routeId || null, binotelEventId: ref.id,
          direction: 'inbound', at, lastType: 'call.incoming', updatedAt: at,
        }, { merge: true })
      }
    } catch (e) {
      console.error('binotel/call-settings journal:', e.message)
    }
  })
}

export default registerBinotelWebhook
