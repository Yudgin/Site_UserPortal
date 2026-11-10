// Журнал посилок: синхронізація з Новою Поштою (docs/service-requirements.md §36).
//
// Джерела по кожному ключу НП (ФОП або особистий акаунт), перевірені живими запитами 2026-11-10:
//  • InternetDocument.getDocumentList — лише створене в кабінеті/через API (2045…), з чернетками. Вікно не більше
//    трьох місяців, сторінки по 100, після кожного виклику пауза (інакше «To many requests»).
//  • InternetDocument.getOutgoingDocumentsByPhone / getIncomingDocumentsByPhone — у відкритій документації немає.
//    Бачать оформлене на відділенні (5900…) і вхідні; період ігнорують і віддають лише останні ~2 тижні,
//    тому журнал накопичується в нас (колекція parcels). Відповідь: data[0].result[]; сторінки через Page/Limit.
//  • TrackingDocument.getStatusDocuments — статус незавершених посилок, які вже випали з вікон вище (до 100 за виклик).
//
// Документ parcels/{номер}: один на накладну, навіть якщо її бачать кілька акаунтів (accountDirs: акаунт → напрям).
// Особисті акаунти приватні: посилку, яку бачать ЛИШЕ приватні акаунти, сервер віддає тільки власнику.
import { npDateToIso } from './incomingRefresh.js'
import { normPhone } from './phone.js'

const clip = (v, n = 200) => (v == null ? '' : String(v).trim().slice(0, n))
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }
const digits = (v) => String(v ?? '').replace(/\D/g, '')
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
const DAY = 864e5

// ---- Дати НП (київський час) ----
// «2026-11-05 17:18:58», «09.11.2026 11:11:02», «05-11-2026 18:54:07»; «0001-01-01 …» = порожньо.
export const npDate = (s) => {
  const v = String(s ?? '').trim()
  if (!v || v.startsWith('0001')) return null
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})(.*)$/)
  return npDateToIso(m ? `${m[1]}.${m[2]}.${m[3]}${m[4]}` : v)
}
// Лише день (перший день платного зберігання): «2026-11-14» → те саме; «14.11.2026» → «2026-11-14».
export const npDay = (s) => {
  const v = String(s ?? '').trim()
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return m[1] === '0001' ? null : `${m[1]}-${m[2]}-${m[3]}`
  m = v.match(/^(\d{2})[.-](\d{2})[.-](\d{4})/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}
// Дата для запиту НП: дд.мм.рррр за київським календарем.
export const npReqDate = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.day}.${p.month}.${p.year}`
}

// ---- Статуси ----
// Коди НП: 1 створена, не передана; 2 видалена; 3 не знайдено; 4/41/5/6/101 у дорозі; 7/8 прибула (відділення/поштомат);
// 9/10/11/106 отримана; 102/103 відмова; 105 припинено зберігання; 111 невдала спроба; 104/112 змінено адресу/дату.
const GROUP_BY_CODE = {
  1: 'draft', 2: 'deleted', 3: 'deleted',
  4: 'transit', 41: 'transit', 5: 'transit', 6: 'transit', 12: 'transit', 101: 'transit', 104: 'transit', 112: 'transit',
  7: 'arrived', 8: 'arrived',
  9: 'received', 10: 'received', 11: 'received', 106: 'received',
  102: 'problem', 103: 'problem', 105: 'problem', 111: 'problem',
}
export const statusGroup = (code, name = '') => {
  const g = GROUP_BY_CODE[String(code ?? '')]
  if (g) return g
  const s = String(name || '').toLowerCase()
  if (/відмов|повернен|припинено|невдал/.test(s)) return 'problem'
  if (/отриман|вручен/.test(s)) return 'received'
  if (/прибу/.test(s)) return 'arrived'
  if (/видален|не знайдено/.test(s)) return 'deleted'
  if (/створ|обробці/.test(s)) return 'draft'
  return s ? 'transit' : 'other'
}
export const DRAFT_TTL_DAYS = 14 // чернетка, яку так і не передали: перестаємо опитувати
export const TRANSFER_DRAFT_TTL_DAYS = 45 // чернетка, віддана водієві: чекаємо довше
export const STALE_DAYS = 60 // будь-яка посилка без кінцевого статусу: перестаємо опитувати
export const isFinal = (p, now) => {
  if (p.group === 'received' || p.group === 'deleted') return true
  const born = Date.parse(p.createdAt || p.firstSeenAt || '') || 0
  if (!born) return false
  const age = (Date.parse(now) - born) / DAY
  if (p.group === 'draft') return age > (p.transfer ? TRANSFER_DRAFT_TTL_DAYS : DRAFT_TTL_DAYS)
  return age > STALE_DAYS
}

// ---- Розкладка відповідей НП у спільний вигляд ----
const party = (name, company, phone, city, address) => ({
  name: clip(name, 160), company: clip(company, 160), phone: normPhone(phone) || clip(digits(phone), 20), city: clip(city, 120), address: clip(address, 240),
})

// Запис getDocumentList.
export const fromList = (d) => ({
  src: 'list',
  number: digits(d.IntDocNumber),
  ref: clip(d.Ref, 64),
  statusCode: String(d.StateId ?? ''),
  statusName: clip(d.StateName, 160),
  createdAt: npDate(d.DateTime),
  scheduledAt: npDate(d.ScheduledDeliveryDate) || npDate(d.EstimatedDeliveryDate),
  receivedAt: npDate(d.RecipientDateTime),
  statusAt: npDate(d.DateLastUpdatedStatus),
  sender: party(d.SenderContactPerson || d.SenderDescription, d.SenderDescription, d.SendersPhone, d.CitySenderDescription, d.SenderAddressDescription),
  recipient: party(d.RecipientContactPerson || d.RecipientDescription, d.RecipientDescription, d.RecipientContactPhone || d.RecipientsPhone, d.CityRecipientDescription, d.RecipientAddressDescription),
  description: clip(d.Description, 300),
  declaredCost: num(d.Cost),
  deliveryCost: num(d.CostOnSite),
  cod: num(d.AfterpaymentOnGoodsCost) || num(d.BackwardDeliveryMoney),
  payer: clip(d.PayerType, 20),
  paymentMethod: clip(d.PaymentMethod, 20),
  weight: num(d.CheckWeight) || num(d.Weight),
  seats: num(d.SeatsAmount),
  serviceType: clip(d.ServiceType, 40),
  senderRef: clip(d.Sender, 64),
})

// Запис getOutgoingDocumentsByPhone / getIncomingDocumentsByPhone (src: 'out' | 'in').
export const fromPhone = (d, src) => ({
  src,
  number: digits(d.Number),
  ref: clip(d.RefEW, 64),
  statusCode: String(d.TrackingStatusCode ?? ''),
  statusName: clip(d.TrackingStatusName, 160),
  createdAt: npDate(d.DateTime),
  scheduledAt: npDate(d.AdjustedDate) || npDate(d.ScheduledDeliveryDate),
  arrivedAt: npDate(d.ArrivalDateTime),
  receivedAt: npDate(d.ReceivingDateTime),
  statusAt: npDate(d.TrackingUpdateDate),
  autoReturnAt: npDate(d.CargoAutoReturnDate),
  storageFrom: npDay(d.FirstDayStorage),
  sender: party(d.SenderName, d.CounterpartySenderDescription, d.PhoneSender, d.CitySenderDescription, d.SenderAddressDescription),
  recipient: party(d.RecipientFullName || d.RecipientName, d.CounterpartyRecipientDescription, d.PhoneRecipient, d.CityRecipientDescription, d.RecipientAddressDescription),
  description: clip(d.CargoDescription, 300),
  declaredCost: num(d.Cost),
  deliveryCost: num(d.DocumentCost),
  cod: num(d.AfterpaymentOnGoodsCost) || num(d.RedeliverySum),
  payer: clip(d.PayerType, 20),
  paymentMethod: clip(d.PaymentMethod, 20),
  payStatus: clip(d.ExpressWaybillPaymentStatus, 20),
  weight: num(d.CheckWeight) || num(d.FactualWeight) || num(d.DocumentWeight),
  seats: num(d.SeatsAmount),
  serviceType: clip(d.ServiceType, 40),
  can: {
    redirect: d.possibilityCreateRedirecting === true, changeEW: d.possibilityChangeEW === true, return: d.possibilityCreateReturn === true,
    extend: d.possibilityTermExtension === true, refuse: d.possibilityCreateRefusal === true,
  },
  senderRef: clip(d.CounterpartySender, 64),
})

// Запис TrackingDocument.getStatusDocuments: лише статус і дати (решту вже знаємо).
export const fromTrack = (d) => ({
  src: 'track',
  number: digits(d.Number),
  statusCode: String(d.StatusCode ?? ''),
  statusName: clip(d.Status, 160),
  scheduledAt: npDate(d.ScheduledDeliveryDate),
  arrivedAt: npDate(d.ActualDeliveryDate),
  receivedAt: npDate(d.RecipientDateTime),
  statusAt: npDate(d.TrackingUpdateDate),
  storageFrom: npDay(d.DateFirstDayStorage),
  payStatus: clip(d.ExpressWaybillPaymentStatus, 20),
  can: {
    redirect: d.PossibilityCreateRedirecting === true, changeEW: d.PossibilityChangeEW === true, return: d.PossibilityCreateReturn === true,
    refuse: d.PossibilityCreateRefusal === true, trustee: d.PossibilityTrusteeRecipient === true,
  },
})

const empty = (v) => v == null || v === '' || v === 0
const overlay = (base, add) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(add || {})) {
    if (empty(v)) continue
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && (k === 'sender' || k === 'recipient') ? overlay(base?.[k] || {}, v) : v
  }
  return out
}
// Кілька джерел однієї накладної → одна свіжа картина. Пізніше джерело перекриває непорожнім: list → out → in → track.
const SRC_ORDER = { list: 0, out: 1, in: 2, track: 3 }
export const mergeParts = (parts) => {
  const sorted = [...parts].sort((a, b) => SRC_ORDER[a.src] - SRC_ORDER[b.src])
  let fresh = {}
  for (const p of sorted) { const { src, ...rest } = p; fresh = overlay(fresh, rest) }
  fresh.srcs = [...new Set(sorted.map((p) => p.src))]
  return fresh
}

// Напрям з погляду акаунта: бачимо у «вхідних за телефоном» або одержувач — наш номер → вхідна, інакше вихідна.
export const directionOf = (fresh, ownPhones) => (fresh.srcs.includes('in') || (fresh.recipient?.phone && ownPhones.has(fresh.recipient.phone)) ? 'in' : 'out')

const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v)
export const sameDoc = (a, b) => {
  const strip = ({ updatedAt, seenAt, ...rest }) => rest
  return JSON.stringify(stable(strip(a || {}))) === JSON.stringify(stable(strip(b || {})))
}

const KEEP = ['ref', 'statusCode', 'statusName', 'createdAt', 'scheduledAt', 'arrivedAt', 'receivedAt', 'statusAt', 'autoReturnAt', 'storageFrom',
  'description', 'declaredCost', 'deliveryCost', 'cod', 'payer', 'paymentMethod', 'payStatus', 'weight', 'seats', 'serviceType']

// Свіжа картина + те, що вже лежить у журналі → новий документ. ctx: { accountId, private, dir, now }.
export function applyFresh(prev, fresh, ctx) {
  const { accountId, now } = ctx
  const next = { ...(prev || {}) }
  next.number = fresh.number || prev?.number
  next.method = 'np'
  for (const k of KEEP) if (!empty(fresh[k])) next[k] = fresh[k]
  next.sender = overlay(prev?.sender || {}, fresh.sender || {})
  next.recipient = overlay(prev?.recipient || {}, fresh.recipient || {})
  if (fresh.can) next.can = { ...(prev?.can || {}), ...fresh.can }
  next.sources = [...new Set([...(prev?.sources || []), ...(fresh.srcs || [])])].sort()
  if (accountId) {
    next.accountDirs = { ...(prev?.accountDirs || {}), [accountId]: ctx.dir }
    next.privBy = { ...(prev?.privBy || {}), [accountId]: ctx.private === true }
  }
  next.accountIds = Object.keys(next.accountDirs || {}).sort()
  next.directions = [...new Set(Object.values(next.accountDirs || {}))].sort()
  next.private = next.accountIds.length > 0 && next.accountIds.every((id) => next.privBy?.[id] === true)
  next.selfSender = ctx.selfSender === true
  const fopAcc = next.accountIds.find((id) => id.startsWith('fop:'))
  next.fopId = fopAcc ? fopAcc.slice(4) : null
  next.group = statusGroup(next.statusCode, next.statusName)
  next.firstSeenAt = prev?.firstSeenAt || now
  next.sortAt = next.createdAt || next.firstSeenAt
  next.final = isFinal(next, now)
  next.phones = [...new Set([next.sender?.phone, next.recipient?.phone].filter(Boolean))]
  const at = fresh.statusAt || (prev ? now : next.createdAt || now)
  if (!prev) next.history = [{ at, code: next.statusCode, name: next.statusName }]
  else if (prev.statusCode !== next.statusCode) next.history = [...(prev.history || []), { at, code: next.statusCode, name: next.statusName }].slice(-30)
  else next.history = prev.history || []
  next.link = prev?.link || null
  next.linkTry = prev ? prev.linkTry === true : !next.private
  if (next.private) next.linkTry = false
  next.transfer = prev?.transfer || null
  next.updatedAt = now
  return next
}

// ---- Виклики НП з повтором при «To many requests» ----
export const makeNp = (call, { gapMs = 1200, tries = 5 } = {}) => async (apiKey, model, method, props) => {
  for (let i = 0; ; i++) {
    const r = await call(apiKey, model, method, props)
    const limited = r && r.success === false && (r.errors || []).some((e) => /many requests/i.test(String(e)))
    if (!limited || i >= tries) return r
    await sleep(gapMs * (i + 1))
  }
}
const npFail = (r, what) => new Error(`${what}: ${(r && [...(r.errors || []), ...(r.warnings || [])].filter(Boolean).join('; ')) || 'немає відповіді'}`)

// Вікна getDocumentList (новіші першими): звичайний прохід — останні regularDays; перший — історія вікнами по step днів.
export const listWindows = (nowMs, { backfill = false, regularDays = 14, backfillDays = 365, step = 85 } = {}) => {
  const to = nowMs + DAY // «по завтра»: сьогоднішні накладні точно потрапляють
  if (!backfill) return [[to - (regularDays + 1) * DAY, to]]
  const out = []
  for (let end = to; end > nowMs - backfillDays * DAY; end -= step * DAY) out.push([end - step * DAY, end])
  return out
}

async function fetchList(np, apiKey, windows, gapMs) {
  const docs = []
  let emptyRun = 0
  for (const [from, to] of windows) {
    let got = 0
    for (let page = 1; page <= 40; page++) {
      const r = await np(apiKey, 'InternetDocument', 'getDocumentList', { DateTimeFrom: npReqDate(new Date(from)), DateTimeTo: npReqDate(new Date(to)), GetFullList: '0', Page: String(page) })
      if (!r || r.success !== true) throw npFail(r, 'getDocumentList')
      const data = Array.isArray(r.data) ? r.data : []
      docs.push(...data); got += data.length
      await sleep(gapMs)
      if (data.length < 100) break
    }
    emptyRun = got ? 0 : emptyRun + 1
    if (emptyRun >= 2) break // два порожні вікна поспіль: глибше історії немає
  }
  return docs
}

async function fetchByPhone(np, apiKey, method, nowMs) {
  const docs = []
  for (let page = 1; page <= 10; page++) {
    const r = await np(apiKey, 'InternetDocument', method, { DateTimeFrom: npReqDate(new Date(nowMs - 30 * DAY)), DateTimeTo: npReqDate(new Date(nowMs + DAY)), Limit: '100', Page: String(page) })
    if (!r || r.success !== true) throw npFail(r, method)
    const res = r.data && r.data[0] && Array.isArray(r.data[0].result) ? r.data[0].result : []
    docs.push(...res)
    if (res.length < 100) break
  }
  return docs
}

// Акаунт серед тих, що ділять один ключ: за контрагентом-відправником (senderRef ФОП), інакше перший.
const pickAccount = (group, senderRef) => group.find((a) => senderRef && a.senderRef && a.senderRef === senderRef) || group[0]

// Синхронізація одного ключа НП (один або кілька акаунтів з тим самим ключем). Повертає підсумок; помилки джерел
// не зупиняють решту. deps: { adminDb, np, now, gapMs, sigCache, active } — active: незавершені посилки журналу.
export async function syncKey(group, state, deps) {
  const { adminDb, np, now, gapMs = 1200, sigCache = new Map(), active = [] } = deps
  const nowMs = Date.parse(now)
  const apiKey = group[0].apiKey
  const errors = []
  const parts = new Map() // номер → [частини]
  const put = (p) => { if (p.number) parts.set(p.number, [...(parts.get(p.number) || []), p]) }

  const backfill = !state?.backfilledAt
  let listed = 0, out = 0, inc = 0
  try {
    const docs = await fetchList(np, apiKey, listWindows(nowMs, { backfill, ...(deps.windows || {}) }), gapMs)
    listed = docs.length
    for (const d of docs) if (String(d.DeletionMark) !== '1' && d.DeletionMark !== true) put(fromList(d))
  } catch (e) { errors.push(e.message) }
  // Телефони акаунта: вивчені з відповідей «за телефоном» (зберігаються у стані) + задані (ФОП, шаблони, «наші телефони»).
  const learned = new Set((state?.phones || []).filter(Boolean))
  try {
    const docs = await fetchByPhone(np, apiKey, 'getOutgoingDocumentsByPhone', nowMs)
    out = docs.length
    for (const d of docs) { const p = fromPhone(d, 'out'); put(p); if (p.sender.phone) learned.add(p.sender.phone) }
  } catch (e) { errors.push(e.message) }
  try {
    const docs = await fetchByPhone(np, apiKey, 'getIncomingDocumentsByPhone', nowMs)
    inc = docs.length
    for (const d of docs) { const p = fromPhone(d, 'in'); put(p); if (p.recipient.phone) learned.add(p.recipient.phone) }
  } catch (e) { errors.push(e.message) }
  const ownPhones = new Set([...learned, ...group.flatMap((a) => a.phones || [])].filter(Boolean))

  const col = adminDb.collection('parcels')
  const groupIds = new Set(group.map((a) => a.id))
  let written = 0, created = 0
  const save = async (number, fresh, account) => {
    const trackOnly = fresh.srcs.length === 1 && fresh.srcs[0] === 'track'
    const freshDir = trackOnly ? '' : directionOf(fresh, ownPhones)
    // Відправник — теж ми: клієнт здає кораблик за нашою накладною, тож справжнього відправника в накладній немає.
    const freshSelf = !trackOnly && !!(fresh.sender?.phone && ownPhones.has(fresh.sender.phone))
    const sig = `${JSON.stringify(stable(fresh))}|${freshDir}|${freshSelf}` // напрям теж у підписі: зміна «наших телефонів» має дійти до журналу
    const cacheKey = `${account.id}|${number}`
    if (sigCache.get(cacheKey) === sig) return
    const ref = col.doc(number)
    const snap = await ref.get()
    const prev = snap.exists ? snap.data() : null
    const dir = trackOnly ? prev?.accountDirs?.[account.id] || 'out' : freshDir
    const next = applyFresh(prev, fresh, { accountId: account.id, private: account.private === true, dir, selfSender: trackOnly ? prev?.selfSender === true : freshSelf, now })
    if (!prev || !sameDoc(prev, next)) { await ref.set(next); written++; if (!prev) created++ }
    sigCache.set(cacheKey, sig)
  }
  for (const [number, list] of parts) {
    const fresh = mergeParts(list)
    try { await save(number, fresh, pickAccount(group, fresh.senderRef)) } catch (e) { errors.push(`${number}: ${e.message}`) }
  }

  // Незавершені посилки цього ключа, яких уже немає у вікнах: статус за номером.
  const stale = active.filter((p) => !parts.has(p.number) && p.method === 'np' && (p.accountIds || []).some((id) => groupIds.has(id)))
  let tracked = 0
  const phone = digits([...ownPhones][0] || '')
  for (let i = 0; i < stale.length; i += 100) {
    const batch = stale.slice(i, i + 100)
    try {
      const r = await np(apiKey, 'TrackingDocument', 'getStatusDocuments', { Documents: batch.map((p) => ({ DocumentNumber: p.number, ...(phone ? { Phone: phone } : {}) })) })
      if (!r || r.success !== true) throw npFail(r, 'getStatusDocuments')
      const byNumber = new Map((r.data || []).filter(Boolean).map((d) => [digits(d.Number), d]))
      for (const p of batch) {
        const d = byNumber.get(p.number)
        const account = group.find((a) => (p.accountIds || []).includes(a.id)) || group[0]
        // Немає відповіді за номером: все одно перерахувати «завершена за віком» (applyFresh), щоб не опитувати вічно.
        await save(p.number, d ? mergeParts([fromTrack(d)]) : { number: p.number, srcs: ['track'], _tick: now.slice(0, 10) }, account)
        tracked++
      }
    } catch (e) { errors.push(e.message) }
  }

  return {
    listed, out, inc, tracked, written, created, errors,
    phones: [...learned].sort(),
    backfilled: backfill && !errors.some((e) => e.startsWith('getDocumentList')),
  }
}

// Перерахунок напряму вже збережених посилок після зміни «наших телефонів». Лише посилки одного акаунта:
// у спільних (ФОП шле на особистий номер) напрям кожного акаунта свій і від цього списку не залежить.
export async function recomputeDirections(adminDb, ownPhones, now) {
  const own = new Set(ownPhones)
  const snap = await adminDb.collection('parcels').where('method', '==', 'np').get()
  let changed = 0
  for (const d of snap.docs) {
    const p = d.data()
    if ((p.accountIds || []).length !== 1) continue
    const dir = (p.sources || []).includes('in') || (p.recipient?.phone && own.has(p.recipient.phone)) ? 'in' : 'out'
    const selfSender = !!(p.sender?.phone && own.has(p.sender.phone))
    if (p.accountDirs?.[p.accountIds[0]] === dir && (p.selfSender === true) === selfSender) continue
    await d.ref.update({ accountDirs: { [p.accountIds[0]]: dir }, directions: [dir], selfSender, updatedAt: now })
    changed++
  }
  return { checked: snap.docs.length, changed }
}

// Привʼязка до заявок і замовлень кораблика: посилки з linkTry (перші LINK_DAYS днів після появи).
export const LINK_DAYS = 21
export async function linkPass(adminDb, now) {
  const snap = await adminDb.collection('parcels').where('linkTry', '==', true).get()
  const todo = snap.docs.map((d) => ({ ref: d.ref, p: d.data() })).filter(({ p }) => p.number)
  let linked = 0, dropped = 0
  for (let i = 0; i < todo.length; i += 30) {
    const batch = todo.slice(i, i + 30)
    const numbers = batch.map(({ p }) => p.number)
    const [ret, incoming, orders] = await Promise.all([
      adminDb.collection('serviceRequests').where('returnTtn', 'in', numbers).get(),
      adminDb.collection('serviceRequests').where('waybillNumber', 'in', numbers).get(),
      adminDb.collection('boatOrders').where('ttn', 'in', numbers).get(),
    ])
    const found = new Map()
    for (const d of orders.docs) found.set(digits(d.data().ttn), { kind: 'order', boatOrderId: d.id, serviceRequestId: null, serviceCenterId: null, title: clip(d.data().clientName, 120) })
    for (const d of incoming.docs) found.set(digits(d.data().waybillNumber), { kind: 'incoming', serviceRequestId: d.id, boatOrderId: null, serviceCenterId: d.data().serviceCenterId || null, title: clip(d.data().clientName, 120) })
    for (const d of ret.docs) found.set(digits(d.data().returnTtn), { kind: 'return', serviceRequestId: d.id, boatOrderId: null, serviceCenterId: d.data().serviceCenterId || null, title: clip(d.data().clientName, 120) })
    for (const { ref, p } of batch) {
      const link = found.get(p.number)
      if (link) { await ref.update({ link, linkTry: false, updatedAt: now }); linked++ }
      else if ((Date.parse(now) - (Date.parse(p.firstSeenAt || '') || 0)) / DAY > LINK_DAYS) { await ref.update({ linkTry: false }); dropped++ }
    }
  }
  return { checked: todo.length, linked, dropped }
}

// Повний прохід: усі акаунти (згруповані за ключем), стан у npSyncState/{акаунт}, раз на годину — привʼязка до заявок.
// deps: { adminDb, np, now, gapMs, sigCache, only (id акаунта), windows }.
export async function syncAll(accounts, deps) {
  const { adminDb, now, only } = deps
  const stateCol = adminDb.collection('npSyncState')
  const groups = new Map()
  for (const a of accounts) {
    if (!a.apiKey || a.active === false) continue
    groups.set(a.apiKey, [...(groups.get(a.apiKey) || []), a])
  }
  const activeSnap = await adminDb.collection('parcels').where('final', '==', false).get()
  const active = activeSnap.docs.map((d) => d.data())
  const summary = []
  for (const group of groups.values()) {
    if (only && !group.some((a) => a.id === only)) continue
    const stRef = stateCol.doc(group[0].id)
    const stSnap = await stRef.get()
    const state = stSnap.exists ? stSnap.data() : null
    let res
    try { res = await syncKey(group, state, { ...deps, active }) } catch (e) { res = { listed: 0, out: 0, inc: 0, tracked: 0, written: 0, created: 0, errors: [e.message], phones: state?.phones || [], backfilled: false } }
    const ok = res.errors.length === 0
    const patch = {
      accountIds: group.map((a) => a.id),
      lastSyncAt: now,
      ...(ok ? { lastOkAt: now } : {}),
      lastError: ok ? null : res.errors.slice(0, 5).join(' | ').slice(0, 600),
      counts: { listed: res.listed, out: res.out, inc: res.inc, tracked: res.tracked, written: res.written, created: res.created },
      phones: res.phones,
      ...(res.backfilled ? { backfilledAt: now } : {}),
    }
    for (const a of group) await stateCol.doc(a.id).set(patch, { merge: true })
    summary.push({ accounts: group.map((a) => a.id), ...patch.counts, ok, error: patch.lastError })
  }
  let link = null
  try {
    const metaRef = stateCol.doc('_meta')
    const meta = await metaRef.get()
    const last = Date.parse((meta.exists && meta.data().lastLinkAt) || '') || 0
    if (deps.forceLink || Date.parse(now) - last > 3600e3) {
      link = await linkPass(adminDb, now)
      await metaRef.set({ lastLinkAt: now }, { merge: true })
    }
  } catch (e) { link = { error: e.message } }
  return { accounts: summary, link }
}
