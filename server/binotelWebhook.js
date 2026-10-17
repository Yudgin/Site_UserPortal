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
//     Критичний шлях — лише Firestore (4 читання паралельно: маршрутизація, заявки, профіль, замовлення корабликів;
//     бюджет LOOKUP_BUDGET_MS), без зовнішніх викликів; запис журналу стартує до відповіді, чекаємо його
//     ≤ JOURNAL_BUDGET_MS (на Cloud Run з троттлінгом CPU фонова запис після res.send ненадійна).
//
// Маршрутизацію перемикає документ Firestore system/binotelRouting (без деплою; див. DEFAULT_ROUTING і
// normalizeRouting): поза scope (за замовчуванням — лише testNumbers) відповідаємо {}, тож реальні клієнти
// живуть на логіці 1С, поки сесія дзвінків не скаже scope:'all'. Порядок для вхідного: персональний override →
// mode ('route' — один сценарій; 'byClient' — S2 «Відкрита заявка» / S1 «Відомий клієнт» / без routeData → S0
// лінії, див. isOpen і clientCategory). Вихідний (callType 1) — ніколи без routeData. Поки працює 1С-проксі,
// персональний Клиенты.Сценарий 1С важливіший за наш routeData (так зроблено у фрагменті 1С).
// Журнал: binotelEvents/{autoId} (kind 'call-settings'; сире тіло, наша відповідь, рішення, затримка),
// expireAt = +180 днів (TTL-політика Firestore). У callEvents (операторська дошка) — лише прапорцем
// mirrorCallEvents і лише вхідні, на які ми відповіли по суті: туди вже пише call.incoming старий
// операторський бот, інакше картки задвоюються.
import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { normPhone } from './phone.js'

const nowIso = () => new Date().toISOString()
const LOOKUP_BUDGET_MS = Number(process.env.BINOTEL_LOOKUP_BUDGET_MS || 1200) // 1С чекає нас ≤ 2 с
// Журнал пишемо ДО відповіді, але чекаємо його не довше цього: після res.send інстансу Cloud Run з троттлінгом CPU
// (економія з 2026-10-14) майже не дають процесора, фонова запис могла б загубитися. Не встиг — відповідаємо однаково.
const JOURNAL_BUDGET_MS = Number(process.env.BINOTEL_JOURNAL_BUDGET_MS || 300)
const RAW_MAX_STORE = 8 * 1024 // скільки сирого тіла кладемо в журнал
const JOURNAL_TTL_DAYS = 180
const SR_SCAN_LIMIT = 100 // заявок одного телефону (у найактивнішого номера вже 24; без orderBy — беремо з запасом)
const ORDER_SCAN_LIMIT = 10 // замовлень корабликів одного телефону
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

// Вкладені form-поля як у qs/PHP: a[b][0][c]=v → {a:{b:[{c:v}]}}. Обмеження проти зловмисного тіла (ревʼю 2026-10-16):
// ≤ MAX_FORM_PARTS пар (як parameterLimit у qs), глибина ≤ 6, індекси й довжина масивів ≤ 200, «a[]» лише для масивів
// (на об'єкті порожній ключ коштував би Object.keys на кожну пару — квадратичний розбір), ключі
// __proto__/constructor/prototype відкидаються, наявність ключа — лише власна (успадкований toString тощо не рахується).
// Повтор простого ключа → масив значень.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_FORM_PARTS = 1000
const MAX_ARRAY = 200
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const decode = (s) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}
export function parseNestedForm(raw) {
  const out = {}
  if (!raw) return out
  for (const part of String(raw).split('&', MAX_FORM_PARTS)) {
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
      if (k === '') {
        if (!Array.isArray(node)) break // a[]= лише в масив
        k = node.length
      }
      if (Array.isArray(node) && (!/^\d+$/.test(String(k)) || Number(k) >= MAX_ARRAY)) break
      const cur = own(node, k) ? node[k] : undefined
      if (last) {
        if (cur === undefined) node[k] = val
        else if (Array.isArray(cur)) { if (cur.length < MAX_ARRAY) cur.push(val) }
        else if (typeof cur !== 'object' || cur === null) node[k] = [cur, val]
      } else {
        if (cur === undefined || cur === null || typeof cur !== 'object') node[k] = /^\d+$/.test(path[i + 1]) || path[i + 1] === '' ? [] : {}
        node = node[k]
      }
    }
  }
  return out
}

// Значення поля АТС як рядок: лише рядок або скінченне число; об'єкти/масиви (externalNumber[toString]=1 тощо) → ''.
// Інакше String(obj) у normPhone кидав би TypeError і (поза try) валив процес.
export const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')

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
  // Білий список ліній Runferry (pbxNumber вхідного). Решта ліній АТС (camarad 0679468531 — близько третини вхідних)
  // → {} 'bypass-line': інакше наш routeData перебив би сценарій чужої лінії. [] у документі — без фільтра.
  lines: ['+380679278039', '+380443338049'],
  // 'passthrough' — routeData не віддаємо (сценарій лінії); 'route' — routeId; 'byClient' — сценарій за категорією
  // клієнта з categoryRoutes (схема сесії «Голосові заглушки для сценаріїв Binotel», 2026-10-16)
  mode: 'passthrough',
  routeId: null,
  routeType: 'route', // або 'routeWithTime' (ID у двох списках Binotel можуть збігатися)
  overrides: {}, // {телефон: routeId | {id, type} | 0} — діє за будь-якого mode; 0/null → без routeData
  // mode 'byClient': {openRequest: S2, knownClient: S1, unknown: —} — routeId | {id, type}; тип за замовчуванням
  // routeWithTime (робочий час рахує Binotel); категорії немає або id порожній → без routeData (сценарій лінії S0)
  categoryRoutes: {},
  // Пороги «незакритої» заявки (днів від останньої справжньої дії) — див. isOpen. 180 — страховка: на 2026-10-16
  // усі 17 заявок з відкритим статусом молодші (найстарша жива in_work — 65 днів), 60 відрізало б її.
  openMaxAgeDays: 180,
  doneGraceDays: 14, // днів ПІСЛЯ отримання кораблика клієнтом (правило власника 2026-10-17)
  transitMaxDays: 21, // відправлено, а отримання невідоме: ≈ до 7 днів доставки + 14 днів після отримання
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
    // force: true — наш routeData важливіший за Клиенты.Сценарий 1С (заголовок X-Runferry-Route-Priority: override)
    overrides[p] = { ...routeEntry(v, d.routeType), ...(v && typeof v === 'object' && v.force === true ? { force: true } : {}) }
  }
  const categoryRoutes = {}
  const cr = d.categoryRoutes && typeof d.categoryRoutes === 'object' ? d.categoryRoutes : {}
  for (const c of CATEGORIES) if (cr[c] != null) categoryRoutes[c] = routeEntry(cr[c], 'routeWithTime')
  // Синонім у термінах сценаріїв Binotel (S2 «Відкрита заявка», S1 «Відомий клієнт»); categoryRoutes важливіший.
  const sc = d.scenarioIds && typeof d.scenarioIds === 'object' ? d.scenarioIds : {}
  if (categoryRoutes.openRequest == null && sc.S2 != null) categoryRoutes.openRequest = routeEntry(sc.S2, 'routeWithTime')
  if (categoryRoutes.knownClient == null && sc.S1 != null) categoryRoutes.knownClient = routeEntry(sc.S1, 'routeWithTime')
  const days = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== '' ? Number(v) : def)
  const assigned = d.assignedToEmployeeNumber == null ? '' : String(d.assignedToEmployeeNumber).trim()
  // lines: [] — свідомо без фільтра; непорожній масив без жодного валідного номера (опечатка, «a, b» одним рядком)
  // — НЕ вимикає фільтр, а лишає типовий список (інакше лінія camarad отримала б наш routeData).
  let lines = DEFAULT_ROUTING.lines
  if (Array.isArray(d.lines)) {
    const parsed = d.lines.flatMap((x) => str(x).split(/[,;]/)).map((x) => normPhone(x)).filter(Boolean)
    lines = d.lines.length === 0 ? [] : parsed.length ? parsed : DEFAULT_ROUTING.lines
  }
  return {
    enabled: d.enabled !== false,
    scope: d.scope === 'all' ? 'all' : 'test',
    testNumbers,
    lines,
    mode: d.mode === 'route' || d.mode === 'byClient' ? d.mode : 'passthrough',
    routeId: posInt(d.routeId),
    routeType: routeTypeOf(d.routeType),
    overrides,
    categoryRoutes,
    openMaxAgeDays: days(d.openMaxAgeDays, DEFAULT_ROUTING.openMaxAgeDays),
    doneGraceDays: days(d.doneGraceDays, DEFAULT_ROUTING.doneGraceDays),
    transitMaxDays: days(d.transitMaxDays, DEFAULT_ROUTING.transitMaxDays),
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
const numberOf = (sr) => String(sr?.onec?.number || '').replace(/^0+/, '')
const ddmmyyyy = (iso) => {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
}
// Дата за Києвом «ДД.ММ», з роком, якщо не поточний (дата отримання з 1С — за Києвом; UTC-день зсунув би нічні).
const KYIV_DATE = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' })
const kyivDayMonth = (iso, nowMs = Date.now()) => {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  const [dd, mm, yyyy] = KYIV_DATE.format(new Date(t)).split('.')
  const curYear = KYIV_DATE.format(new Date(nowMs)).split('.')[2]
  return yyyy === curYear ? `${dd}.${mm}` : `${dd}.${mm}.${yyyy}`
}
// Ім'я, схоже на номер телефону (в імпорті продажів трапляється), іменем не вважаємо.
const realName = (s) => (s && String(s).replace(/\D/g, '').length < 7 ? String(s) : '')

// ---------- клієнт: заявки, покупки, категорія ----------

const DAY_MS = 86400 * 1000
// Записи stageHistory, які пишуться автоматично з часом прогону, а не події: синхронізація 1С і бекфіл.
// np-ttn (рух посилки Новою Поштою) — справжня подія, її рахуємо.
const AUTO_STAGE_BY = new Set(['1c-sync', 'backfill'])
// Виняток: перехід у 'shipped' від 1c-sync (НЕ перший запис історії) — справжня подія. Щоденна синхронізація пише його,
// коли в 1С з'являється нова зворотна ТТН (onecSync.js, rtKnown), а np-ttn тоді вже нічого не додає. Перший запис
// 'shipped' ставлять масові прогони старим ремонтам — його не рахуємо. На 2026-10-16 таких записів 1c-sync немає.
const isRealStageEvent = (h, i) => !!h && (!AUTO_STAGE_BY.has(h.by) || (h.by === '1c-sync' && h.stage === 'shipped' && i > 0))
const msOf = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? t : 0
}
// Остання справжня дія по заявці. updatedAt НЕ беремо: масові прогони синхронізації 1С (2026-09-21, 10-06, 10-13,
// 10-14) і бекфіл оновили його майже всім заявкам. createdAt у заявок з 1С = дата документа 1С (parse1cDate).
// doneAt / statusChangedAt / paidAt — якщо колись їх почнуть ставити записувачі статусу (зараз payments.js,
// estimateEngine і хаб час завершення не пишуть, тож doneGraceDays рахується від останньої дії людини).
export const lastActivityMs = (sr) => Math.max(
  msOf(sr?.createdAt),
  msOf(sr?.diagnostics?.at),
  msOf(sr?.doneAt),
  msOf(sr?.statusChangedAt),
  msOf(sr?.paidAt),
  ...(Array.isArray(sr?.stageHistory) ? sr.stageHistory : []).filter(isRealStageEvent).map((h) => msOf(h.at)),
)
// Заявка відкрита, доки клієнт не отримав кораблик, і ще doneGraceDays (14) днів після отримання (правило власника
// 2026-10-17, runferry-briefs/telephony/ai-first-discussion-join-2026-10-17.md, розділ 12, п. 4). Скасована — ніколи.
//   1. Отримання відоме (returnDelivery.deliveredAt — перше «Відправлення отримано» останньої посилки з історії НП у
//      1С, кладе синхронізація) → відкрита ≤ doneGraceDays після нього.
//   2. Відправлено, отримання невідоме → відкрита ≤ transitMaxDays (21 ≈ доставка + 14 днів) від найпізнішої
//      відправки: returnDelivery.shippedAt, справжній запис 'shipped' (np-ttn, людина, перехід 1c-sync), інакше
//      остання дія.
//   3. Виконана, а про відправку нічого (оплата/хаб без ТТН, самовивіз, старий імпорт 1С) → ≤ transitMaxDays від
//      завершення (doneAt / paidAt / statusChangedAt, інакше остання дія) — наближення з брифу власника.
//   4. Інакше кораблик у нас → ≤ openMaxAgeDays (180) від останньої дії — страховка від покинутих ремонтів з 1С.
// Коли фаз кілька, перемагає найпізніша: відправка, повернення в роботу (гарантія, етап після завершення) чи
// завершення. returnDelivery НЕ беремо, якщо після нього є нова відправка порталом/людиною або повернення в роботу.
// Записи 1c-sync 'shipped' доставку не перекривають: це той самий сигнал із тієї ж 1С, записаний часом прогону.
// Номер ТТН заявки з returnDelivery не звіряємо: returnTtn у заявці пишеться лише раз і застаріває, коли 1С
// відправляє повторно з новим номером (ревʼю 2026-10-17).
const stageEvents = (sr) => (Array.isArray(sr?.stageHistory) ? sr.stageHistory : []).filter(isRealStageEvent)
const shippedEventMs = (sr, skip1c = false) => Math.max(0, ...stageEvents(sr)
  .filter((h) => h.stage === 'shipped' && !(skip1c && h.by === '1c-sync')).map((h) => msOf(h.at)))
// Робота з корабликом (він у нас): справжній етап, крім 'shipped', діагностика, зміна статусу не на 'done'.
const reopenEventMs = (sr) => Math.max(0, ...stageEvents(sr).filter((h) => h.stage !== 'shipped').map((h) => msOf(h.at)),
  msOf(sr?.diagnostics?.at), sr?.status !== 'done' ? msOf(sr?.statusChangedAt) : 0)
// Кораблик повернули до нас (гарантія тощо): останній справжній 'received' новіший за завершення (doneAt/paidAt), за
// будь-який запис 'shipped' в історії (навіть 1c-sync/backfill — верхня межа відправки старого імпорту) або за
// справжній робочий етап перед ним. Перший 'received' звичайного ремонту (до нього нічого) — не повернення.
const boatReceivedBack = (sr) => {
  const evs = stageEvents(sr)
  const rAt = Math.max(0, ...evs.filter((h) => h.stage === 'received').map((h) => msOf(h.at)))
  if (!rAt) return false
  const anyShipped = (Array.isArray(sr?.stageHistory) ? sr.stageHistory : []).some((h) => h && h.stage === 'shipped' && msOf(h.at) && msOf(h.at) < rAt)
  const workBefore = evs.some((h) => h.stage !== 'shipped' && h.stage !== 'received' && msOf(h.at) < rAt)
  const doneMs = Math.max(msOf(sr?.doneAt), msOf(sr?.paidAt))
  // Старий імпорт 'done' без часу завершення: будь-який справжній 'received' — уже після нього (п'яте коло ревʼю).
  const legacyDone = sr?.status === 'done' && doneMs === 0
  return (doneMs > 0 && rAt > doneMs) || legacyDone || anyShipped || workBefore
}
// Верхня межа часу відправки, коли справжньої дати немає: найпізніший запис 'shipped' в історії будь-якого походження
// (1c-sync, backfill пишуть його тоді, коли відправку вже видно).
const shippedBoundMs = (sr) => Math.max(0, ...(Array.isArray(sr?.stageHistory) ? sr.stageHistory : [])
  .filter((h) => h && h.stage === 'shipped').map((h) => msOf(h.at)))
const normTtnDigits = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }
// Посилки запчастин/купівлі (npScenario parts/purchase) — не повернення кораблика.
const boatShipStage = (sr) => sr?.stage === 'shipped' && !['parts', 'purchase'].includes(sr?.npScenario)
export function currentDelivery(sr) {
  const rd = sr?.returnDelivery
  if (!rd || typeof rd !== 'object') return null
  const anchor = msOf(rd.deliveredAt) || msOf(rd.shippedAt)
  if (!anchor) return null
  if (shippedEventMs(sr, true) > anchor || reopenEventMs(sr) > anchor) return null
  return rd
}
export function isOpen(sr, nowMs, cfg = DEFAULT_ROUTING) {
  if (!sr || sr.status === 'cancelled') return false
  const days = (t) => (nowMs - t) / DAY_MS
  const rd = currentDelivery(sr)
  const deliveredMs = msOf(rd?.deliveredAt)
  if (deliveredMs) return days(deliveredMs) <= cfg.doneGraceDays
  const reopenMs = reopenEventMs(sr)
  // Дата відправки — і з перекритої доставки: вона відома, просто старша за подальшу роботу (четверте коло ревʼю).
  const shipMs = Math.max(msOf(sr.returnDelivery?.shippedAt), msOf(rd?.shippedAt), shippedEventMs(sr))
  const shipped = !!rd || boatShipStage(sr) || (!!normTtnDigits(sr.returnTtn) && sr.status === 'done')
  if (shipped) {
    // Дата відправки відома і новіша за роботу з корабликом → у дорозі.
    if (shipMs > 0 && shipMs >= reopenMs) return days(shipMs) <= cfg.transitMaxDays
    // Дата невідома (returnTtn без запису 'shipped'): у дорозі від останньої дії, якщо тільки кораблик не повернули
    // до нас (тоді він знову в нас; ревʼю 2026-10-17, третє й четверте коло).
    if (shipMs === 0) {
      const bound = shippedBoundMs(sr)
      const back = boatReceivedBack(sr) || (bound > 0 && reopenMs > bound)
      if (!back) return days(lastActivityMs(sr)) <= cfg.transitMaxDays
    }
  }
  if (sr.status === 'done') {
    const doneMs = Math.max(msOf(sr.doneAt), msOf(sr.paidAt), msOf(sr.statusChangedAt))
    // Після завершення (або старого імпорту без часу) кораблик повернули в роботу — він у нас.
    if (reopenMs > doneMs) return days(lastActivityMs(sr)) <= cfg.openMaxAgeDays
    return days(doneMs || lastActivityMs(sr)) <= cfg.transitMaxDays
  }
  return days(lastActivityMs(sr)) <= cfg.openMaxAgeDays
}
// Справжня історія з клієнтом: будь-яка заявка, крім скасованої без жодної ТТН; або купівля кораблика (не лід і не
// скасоване замовлення). Самого clientProfiles НЕ досить: профіль створюється автоматично з будь-якої форми чи чату.
// returnTtn буває й накладною купівлі/запчастин (npScenario purchase/parts), а не поверненням — для «справжньої
// історії» це однаково: щось фізично їхало цьому клієнту.
const isHistory = (sr) => !!sr && !(sr.status === 'cancelled' && !sr.waybillNumber && !sr.returnTtn)
const isPurchase = (o) => !!o && !['lead', 'cancelled'].includes(o.status)
// Дата купівлі — лише soldAt: у імпорту продажів 18.07 createdAt = дата імпорту, а не продажу. createdAt — тільки
// для порядку, коли soldAt немає.
const purchaseTs = (o) => msOf(o.soldAt) || msOf(o.createdAt)

// Головна заявка: спершу незакриті, серед них — з найсвіжішою дією; інакше найсвіжіша будь-яка.
export function pickRequests(list, nowMs = Date.now(), cfg = DEFAULT_ROUTING) {
  const arr = (list || []).filter(Boolean)
  const byActivity = (a, b) => lastActivityMs(b) - lastActivityMs(a)
  const open = arr.filter((x) => isOpen(x, nowMs, cfg)).sort(byActivity)
  const rest = arr.filter((x) => !isOpen(x, nowMs, cfg)).sort(byActivity)
  return { main: open[0] || rest[0] || null, mainOpen: open.length > 0, openCount: open.length, total: arr.length }
}

// Категорія клієнта для mode 'byClient': незакрита заявка → openRequest (S2); справжня історія → knownClient (S1);
// інакше unknown (сценарій лінії S0). Картки, які 1С створює на кожен дзвінок, сюди не потрапляють — у нашій базі
// їх немає. Пошук не встиг → null (маршрут не віддаємо).
export function clientCategory(lookup, nowMs = Date.now(), cfg = DEFAULT_ROUTING) {
  if (!lookup) return null
  const reqs = (lookup.requests || []).filter(Boolean)
  if (reqs.some((x) => isOpen(x, nowMs, cfg))) return 'openRequest'
  if (reqs.some(isHistory) || (lookup.orders || []).some(isPurchase)) return 'knownClient'
  return 'unknown'
}

export function buildCustomerData({ phone, requests, orders, profile, siteUrl, assignedToEmployeeNumber, nowMs = Date.now(), cfg = DEFAULT_ROUTING }) {
  const { main, mainOpen, openCount, total } = pickRequests(requests, nowMs, cfg)
  const purchase = (orders || []).filter(isPurchase).sort((a, b) => purchaseTs(b) - purchaseTs(a))[0] || null
  const name = clip(realName(main?.clientName) || realName(profile?.name) || realName(purchase?.clientName) || nationalPretty(phone) || 'Невідомий номер', NAME_MAX)
  const base = String(siteUrl || 'https://my.runferry.com').replace(/\/+$/, '')
  let description
  let linkToCrmUrl = `${base}/service-requests`
  let linkToCrmTitle = 'Заявки'
  if (main) {
    const no = numberOf(main)
    const head = `${mainOpen ? 'Ремонт' : 'Останній ремонт'}${no ? ` №${no}` : ''}`
    // Закритий ремонт показуємо статусом («Виконано»/«Скасовано»), а не етапом: синхронізація 1С поставила
    // 'received' сотням виконаних ремонтів, і «Отримано» читалося б як «кораблик у нас». Виняток — «Відправлено».
    const deliveredAt = main.status !== 'cancelled' ? currentDelivery(main)?.deliveredAt : null
    const state = deliveredAt
      ? `Клієнт отримав ${kyivDayMonth(deliveredAt, nowMs)}`
      : mainOpen
        ? STAGE_UK[main.stage] || STATUS_UK[main.status] || ''
        : main.stage === 'shipped' && main.status !== 'cancelled' ? STAGE_UK.shipped : STATUS_UK[main.status] || ''
    const more = openCount > 1 ? ` (+${openCount - 1})` : ''
    const parts = [head + more, state, main.boat, main.complaint].filter(Boolean)
    description = clip(parts.join(' · '), DESC_MAX)
    linkToCrmUrl = `${base}/service-request/${encodeURIComponent(main.id)}`
    linkToCrmTitle = clip(`Заявка${no ? ` №${no}` : ''}${total > 1 ? ` (усього ${total})` : ''}`, DESC_MAX)
  } else if (purchase) {
    const date = ddmmyyyy(purchase.soldAt)
    description = clip(`Купив кораблик${date ? ` ${date}` : ''}, ремонтів у базі немає`, DESC_MAX)
    if (purchase.id) {
      linkToCrmUrl = `${base}/boat-orders/${encodeURIComponent(purchase.id)}`
      linkToCrmTitle = 'Замовлення кораблика'
    }
  } else {
    // База порталу бачить лише з 2025-06: «новий» номер може бути давнім власником — тому «немає в базі».
    description = profile ? 'Звертався, заявок у базі немає' : 'Немає в базі порталу'
  }
  const cd = { name, description, linkToCrmUrl, linkToCrmTitle }
  if (assignedToEmployeeNumber) cd.assignedToEmployeeNumber = assignedToEmployeeNumber
  return cd
}

// Рішення: що відповісти на apiCallSettings. Повертає {response, decision, routeId, category}.
export function decideCallSettings({ fields, routing, lookup, siteUrl, nowMs = Date.now() }) {
  const phone = normPhone(str(fields.externalNumber))
  const requestType = str(fields.requestType)
  if (requestType && requestType !== 'apiCallSettings') return { response: {}, decision: 'not-call-settings' }
  if (!phone) return { response: {}, decision: 'no-phone' }
  if (!routing || !routing.enabled) return { response: {}, decision: routing?.missing ? 'no-routing-doc' : 'disabled' }
  const incoming = str(fields.callType).trim() !== '1'
  // Чужа лінія АТС (не з білого списку) — нічого не відповідаємо, навіть customerData.
  if (incoming && routing.lines.length && !routing.lines.includes(normPhone(str(fields.pbxNumber)))) return { response: {}, decision: 'bypass-line' }
  if (routing.scope === 'test' && !routing.testNumbers.includes(phone)) return { response: {}, decision: 'out-of-scope' }
  const response = {}
  if (routing.sendCustomerData && lookup) {
    response.customerData = buildCustomerData({
      phone, requests: lookup.requests, orders: lookup.orders, profile: lookup.profile, siteUrl,
      assignedToEmployeeNumber: routing.assignedToEmployeeNumber, nowMs, cfg: routing,
    })
  }
  let routeId = null
  let category = null
  // Пріоритет нашого routeData над Клиенты.Сценарий 1С: відповідь несе заголовок X-Runferry-Route-Priority, фрагмент 1С
  // тоді не підміняє маршрут своїм. Значення: 'override' (ручний виняток з force), 'discussion' (режим обговорення,
  // runferry-briefs/telephony/discussion-mode-2026-10-16.md, розділ 5.6 — його додасть сесія «Режим обговорення»).
  let priority = null
  let routeType = routing.routeType
  let decision = incoming ? 'passthrough' : 'outgoing'
  if (incoming) {
    const ov = routing.overrides[phone]
    if (ov) {
      routeId = ov.id
      routeType = ov.type
      decision = routeId ? 'override' : 'override-none'
      if (routeId && ov.force) priority = 'override'
    } else if (routing.mode === 'route' && routing.routeId) {
      routeId = routing.routeId
      decision = 'route'
    } else if (routing.mode === 'byClient') {
      category = clientCategory(lookup, nowMs, routing)
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
  return { response, decision, routeId, category, ...(priority && response.routeData ? { priority } : {}) }
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

  // Варіанти запису одного номера (+380…, 380…, 0…): заявки з вхідних менеджера і ручні замовлення корабликів
  // зберігають телефон як є. Один запит 'in' на колекцію, як у мобільному застосунку.
  const phoneVariants = (e164) => [e164, e164.slice(1), '0' + e164.slice(4)]
  const lookupClient = async (phone) => {
    const digits = phone.replace(/\D/g, '')
    const variants = phoneVariants(phone)
    const [srSnap, profSnap, orderSnap] = await Promise.all([
      adminDb.collection('serviceRequests').where('clientPhone', 'in', variants).limit(SR_SCAN_LIMIT).get(),
      adminDb.collection('clientProfiles').doc(digits).get(),
      adminDb.collection('boatOrders').where('clientPhone', 'in', variants).limit(ORDER_SCAN_LIMIT).get(),
    ])
    return {
      requests: srSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      profile: profSnap.exists ? profSnap.data() : null,
      orders: orderSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    }
  }
  const loadRouting = async () => {
    const s = await adminDb.collection('system').doc('binotelRouting').get()
    return normalizeRouting(s.exists ? s.data() : null)
  }
  // Прогрів gRPC-каналу Firestore на старті інстансу: перше читання після холодного старту ~0,5–1 с,
  // а 1С чекає нас ≤ 2 с — нехай цю ціну заплатить старт, а не перший дзвінок.
  if (adminDb) loadRouting().catch(() => {})

  // Тіло: зазвичай Buffer від express.raw. Якщо глобальний парсер усе ж з'їв тіло (шлях в іншому регістрі тощо) —
  // беремо req.rawBody (його зберігає глобальний express.json) або вже розібраний об'єкт.
  const readBody = (req) => {
    const ct = req.get('content-type') || ''
    if (Buffer.isBuffer(req.body)) return parseBinotelBody(req.body, ct)
    if (Buffer.isBuffer(req.rawBody)) return parseBinotelBody(req.rawBody, ct)
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return { raw: '', format: 'preparsed', data: req.body }
    return parseBinotelBody('', ct)
  }

  const handleCallSettings = async (req, reply) => {
    const started = Date.now()
    const parsed = readBody(req)
    const f = parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
    const phone = normPhone(str(f.externalNumber)) || null
    const requestType = str(f.requestType)
    let result = { response: {}, decision: 'error' }
    let routing = null
    let lookup = null
    if (!adminDb) {
      result = { response: {}, decision: 'no-db' }
    } else if (!phone || (requestType && requestType !== 'apiCallSettings')) {
      // Порожній, прихований, короткий номер або не apiCallSettings — {} одразу, без жодного читання Firestore.
      result = decideCallSettings({ fields: f, routing: null, lookup: null, siteUrl })
    } else {
      try {
        const [r, l] = await Promise.all([
          withBudget(loadRouting(), LOOKUP_BUDGET_MS),
          withBudget(lookupClient(phone), LOOKUP_BUDGET_MS),
        ])
        routing = r === TIMEOUT ? null : r
        lookup = l === TIMEOUT ? null : l
        result = routing ? decideCallSettings({ fields: f, routing, lookup, siteUrl }) : { response: {}, decision: 'routing-timeout' }
      } catch (e) {
        console.error('binotel/call-settings:', e.message)
        result = { response: {}, decision: 'error' }
      }
    }
    const latencyMs = Date.now() - started // час до рішення; журнал нижче — окремо

    // ---- журнал: запис стартує до відповіді, чекаємо його ≤ JOURNAL_BUDGET_MS ----
    let journalRef = null
    let main = null
    const at = nowIso()
    const field = (v, max = 64) => str(v).slice(0, max) || null
    if (adminDb) {
      try {
        journalRef = adminDb.collection('binotelEvents').doc()
        const nowMs = Date.now()
        main = lookup ? pickRequests(lookup.requests, nowMs, routing || DEFAULT_ROUTING).main : null
        const callTypeStr = str(f.callType).trim()
        const entry = {
          kind: 'call-settings',
          via: String(req.get('x-binotel-via') || 'direct').slice(0, 32),
          format: parsed.format,
          contentType: String(req.get('content-type') || '').slice(0, 100) || null,
          requestType: field(f.requestType),
          callType: /^\d+$/.test(callTypeStr) ? Number(callTypeStr) : null,
          externalNumber: phone,
          externalNumberRaw: field(f.externalNumber, 32),
          pbxNumber: field(f.pbxNumber, 32),
          internalNumber: field(f.internalNumber, 32),
          companyID: field(f.companyID, 32),
          generalCallID: field(f.generalCallID, 64),
          raw: parsed.raw.length > RAW_MAX_STORE ? parsed.raw.slice(0, RAW_MAX_STORE) : parsed.raw,
          rawTruncated: parsed.raw.length > RAW_MAX_STORE,
          parsed: parsed.raw.length <= RAW_MAX_STORE ? f : null,
          response: result.response,
          decision: result.decision,
          routingMode: routing?.mode || null,
          routeId: result.routeId || null,
          priority: result.priority || null,
          category: result.category || null,
          serviceRequestId: main?.id || null,
          latencyMs,
          at,
          expireAt: new Date(nowMs + JOURNAL_TTL_DAYS * DAY_MS),
        }
        // Ключі розібраного тіла — від АТС. Firestore відкидає порожні імена, __x__, вкладені масиви, глибину > 20 —
        // інколи синхронним винятком, тому перша спроба загорнута в then: запасний запис без parsed спрацює завжди.
        const write = Promise.resolve()
          .then(() => journalRef.set(entry))
          .catch(() => journalRef.set({ ...entry, parsed: null, parsedRejected: true }))
        write.catch((e) => console.error('binotel/call-settings journal:', e.message))
        await withBudget(write, JOURNAL_BUDGET_MS)
      } catch (e) {
        console.error('binotel/call-settings journal:', e.message)
      }
    }
    reply(result.response, result.priority && result.response.routeData ? { 'X-Runferry-Route-Priority': result.priority } : null)

    // Дзеркало в callEvents — некритичне, після відповіді; лише для вхідних, на які ми відповіли по суті (інакше
    // дублювали б картки старого бота).
    if (adminDb && journalRef && routing?.mirrorCallEvents && phone && str(f.callType).trim() !== '1' && Object.keys(result.response).length) {
      const callId = `binotel-cs-${journalRef.id}`
      await adminDb.collection('callEvents').doc(callId).set({
        callId, source: 'binotel-settings', kind: 'incoming', phone,
        clientName: result.response.customerData?.name || null,
        line: field(f.pbxNumber, 32),
        serviceRequestId: main?.id || null, routeId: result.routeId || null, binotelEventId: journalRef.id,
        direction: 'inbound', at, lastType: 'call.incoming', updatedAt: at,
      }, { merge: true }).catch((e) => console.error('binotel/call-settings mirror:', e.message))
    }
  }

  // Обгортка: будь-який виняток після авторизації → 200 {} (1С тоді відповідає по-старому), і ніколи не
  // необроблене відхилення промісу (Express 4 не ловить async-обробники, Node 20 на ньому завершує процес).
  app.post('/api/binotel/call-settings', guard, rawBody, async (req, res) => {
    let sent = false
    const reply = (body, headers = null) => {
      if (sent) return
      sent = true
      if (headers) res.set(headers)
      res.status(200).json(body)
    }
    try {
      await handleCallSettings(req, reply)
    } catch (e) {
      console.error('binotel/call-settings fatal:', e?.message || e)
      reply({})
    }
  })
}

export default registerBinotelWebhook
