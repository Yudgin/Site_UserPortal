// Гілка дзвінка в режимі «ШІ одразу» (черга B записки runferry-briefs/telephony/ai-first-discussion-join-2026-10-17.md,
// розд. 3, 6 і 11 — уточнення сесії «Режим обговорення»): чи в клієнта відкрите обговорення, хто ведучий, куди вести
// дзвінок. Чисті функції без I/O: дані (пошук клієнта, останні дзвінки заявки) читає flow.mjs / lookup.mjs.
//
// Звідки обговорення (VG_DS_SOURCE):
//   off (типово) — немає; test — VG_DS_TEST «номер=talked|called|general|pending» (лише локальний env, тестові номери);
//   calls — останні дзвінки з застосунку по головній відкритій заявці (serviceRequests/{id}/calls), поки поля немає;
//   field — поле serviceRequests/{id}.discussion (майбутній сервер режиму); auto — поле, якщо воно є, інакше calls.
// Правила calls (записка режиму обговорення 3.1, 5.0; розд. 11): документи kind 'ai', не binotel, не вихідні — не наші;
// failed і no_answer з failedParty 'employee' обговорення не відкривають (і вже відкрите не закривають — дивимось
// старіші); dialing / connected, почате ≤ pendingMin хв тому, — pending_call (ведучий зараз говорить: йому не дзвонимо,
// пропуск не рахуємо), старше — завислий запис, пропускаємо; розмова (disposition ANSWER/TRANSFER і durationSec > 0) —
// talked на talkedH год; коротка (skipped too_short) чи без другої ноги (legsIncomplete) — short_call; недодзвін
// (no_answer, failedParty 'client') — missed_our_call; сторона невідома (int2ext, failedParty null) — теж недодзвін, але
// фраза 15. Строк недодзвону — max(дзвінок + calledH, 18:00 другого робочого дня після дзвінка), щоб п'ятничний недодзвін
// не згорів у вихідні. Береться найсвіжіший значущий дзвінок; його строк минув — обговорення немає. Скасована заявка —
// обговорення немає.
// Фраза: 13 (talked) — лише якщо дзвінок молодший за talkedH; 14 (called) — лише підтверджений недодзвін клієнту,
// молодший за calledH; short_call та решта — 15 (general). Пряма вимога B2 суворіша за приклад у розд. 11 записки.
import { strictPhone, partyKey, managerGroupOf, managerKeyOf, clientDialUri, isInternalKey } from './callbacks.mjs'
import { parseHours, workdayEndAfter } from './hours.mjs'
import { DS_SOURCES, DS_KINDS, parseDsTest, parseDsStaff } from './config.mjs'

export { DS_SOURCES, DS_KINDS, parseDsTest, parseDsStaff }
import { pickRequestsForAi } from './card.mjs'

const H = 3600000
const REASON_OF_TEST = { talked: 'talked', called: 'missed_our_call', general: 'manual', pending: 'pending_call' }
const TALKED_DISP = new Set(['ANSWER', 'TRANSFER'])
const DEFAULT_HOURS = parseHours('mon-fri 09:00-18:00')
const VOICE_MAX = 150 // brief.voice — голосова картка ведучому (записка режиму 4.1: ≤ 150 знаків)
const msOf = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v || '')
  return Number.isFinite(t) && t > 0 ? t : null
}
// Строк недодзвону: max(дзвінок + calledH, 18:00 другого робочого дня після дзвінка) за київським часом. Розклад —
// робочі години шлюзу, а без них (VG_WORK_HOURS='' на пробі у вихідний) — пн–пт 09–18.
export function calledUntil(atMs, { calledH = 48, workHours = null, timeZone = 'Europe/Kyiv' } = {}) {
  const ranges = workHours?.length ? workHours : DEFAULT_HOURS
  const second = workdayEndAfter(ranges, atMs, 2, timeZone)
  return Math.max(atMs + calledH * H, second ?? 0)
}

const optsOf = (config = {}) => ({
  talkedH: Number(config.dsTalkedH) > 0 ? Number(config.dsTalkedH) : 24,
  calledH: Number(config.dsCalledH) > 0 ? Number(config.dsCalledH) : 48,
  pendingMin: Number(config.dsPendingMin) > 0 ? Number(config.dsPendingMin) : 30,
  workHours: config.workHours || null,
  timeZone: config.timeZone || 'Europe/Kyiv',
})

// Один документ serviceRequests/{id}/calls/{callId} → що він означає для обговорення: {skip: чому} або
// {kind, reason, sideUnknown, at, until}
export function classifyCall(c, nowMs, o = optsOf()) {
  if (!c || typeof c !== 'object') return { skip: 'bad' }
  if (c.kind === 'ai') return { skip: 'ai' }
  if (c.provider !== 'binotel') return { skip: 'provider' }
  if (c.direction !== 'outbound') return { skip: 'direction' }
  const at = msOf(c.createdAt) ?? msOf(c.startedAt)
  if (at == null) return { skip: 'no_time' }
  if (at > nowMs) return { skip: 'future' }
  const st = String(c.status || '')
  if (st === 'failed') return { skip: 'failed' }
  if (c.failedParty === 'employee') return { skip: 'employee' }
  if (st === 'dialing' || st === 'connected') return nowMs - at <= o.pendingMin * 60000 ? { kind: 'pending', reason: 'pending_call', sideUnknown: false, at, until: at + o.pendingMin * 60000 } : { skip: 'stale' }
  const called = (reason, sideUnknown = false) => ({
    kind: reason === 'missed_our_call' && !sideUnknown && nowMs - at < o.calledH * H ? 'called' : 'general', reason, sideUnknown, at, until: calledUntil(at, o),
  })
  if (st === 'no_answer') {
    if (c.failedParty === 'employee') return { skip: 'employee' }
    return called('missed_our_call', c.failedParty !== 'client')
  }
  if (TALKED_DISP.has(String(c.disposition || '')) && Number(c.durationSec) > 0) {
    if ((st === 'skipped' && c.skipReason === 'too_short') || c.legsIncomplete === true) return called('short_call')
    return { kind: 'talked', reason: 'talked', sideUnknown: false, at, until: at + o.talkedH * H }
  }
  return { skip: 'no_talk' }
}

// Головна відкрита заявка клієнта (як у приймача Binotel: незакрита з найсвіжішою дією) — лише вона може мати
// обговорення; скасована — ні
export function dsRequestFor(lookup, nowMs) {
  if (!lookup) return null
  const { main, mainOpen } = pickRequestsForAi(lookup.requests || [], nowMs)
  return mainOpen && main && main.status !== 'cancelled' ? main : null
}

const dsOf = (o) => ({ kind: null, reason: null, sideUnknown: false, srId: null, callId: null, at: null, until: null, ownerUid: null, snapshotKey: null, voice: null, suspendedUntil: null, source: null, ...o })

// Обговорення за дзвінками заявки → {ds, why}
export function discussionFromCalls({ calls, sr, nowMs, config = {} }) {
  if (!sr) return { ds: null, why: 'no_request' }
  if (sr.status === 'cancelled') return { ds: null, why: 'cancelled' }
  if (!Array.isArray(calls)) return { ds: null, why: 'no_calls' }
  const o = optsOf(config)
  const list = calls.filter((c) => c && typeof c === 'object')
    .map((c) => ({ c, t: msOf(c.createdAt) ?? msOf(c.startedAt) ?? 0 }))
    .sort((a, b) => b.t - a.t)
  for (const { c } of list) {
    const r = classifyCall(c, nowMs, o)
    if (r.skip) continue
    if (r.until != null && (r.kind === 'pending' ? nowMs > r.until : nowMs >= r.until)) return { ds: null, why: 'expired' }
    return {
      ds: dsOf({
        kind: r.kind, reason: r.reason, sideUnknown: r.sideUnknown, srId: sr.id ?? null, callId: c.id ?? null, at: r.at, until: r.until,
        ownerUid: c.employeeUid ?? null, snapshotKey: partyKey(c.employeeLine) || strictPhone(c.employeePhone) || null, source: 'calls',
      }),
      why: null,
    }
  }
  return { ds: null, why: 'none' }
}

// Обговорення з поля serviceRequests/{id}.discussion (записка режиму 4.1; умови кандидата — 5.4, крок 4) → {ds, why} або
// undefined — поля в заявці немає
export function discussionFromField({ sr, nowMs, config = {} }) {
  if (!sr || !('discussion' in sr) || sr.discussion === undefined) return undefined
  const d = sr.discussion
  if (!d || typeof d !== 'object') return { ds: null, why: 'closed' }
  if (sr.status === 'cancelled') return { ds: null, why: 'cancelled' }
  if (d.state !== 'open' && d.state !== 'closing') return { ds: null, why: 'closed' }
  const until = msOf(d.until)
  const hard = msOf(d.hardUntil)
  const closingAt = msOf(d.closing?.at)
  if ((until != null && nowMs >= until) || (hard != null && nowMs >= hard) || (d.state === 'closing' && closingAt != null && nowMs >= closingAt)) return { ds: null, why: 'expired' }
  const o = optsOf(config)
  const last = msOf(d.lastCallStartedAt)
  let kind = 'general'
  if (d.reason === 'pending_call') {
    if (last == null || last > nowMs || nowMs - last > o.pendingMin * 60000) return { ds: null, why: 'stale_pending' }
    kind = 'pending'
  }
  else if (d.reason === 'talked') kind = last != null && last <= nowMs && nowMs - last < o.talkedH * H ? 'talked' : 'general'
  else if (d.reason === 'missed_our_call') kind = !d.sideUnknown && last != null && last <= nowMs && nowMs - last < o.calledH * H ? 'called' : 'general'
  const voice = typeof d.brief?.voice === 'string' ? d.brief.voice.replace(/\s+/g, ' ').trim().slice(0, VOICE_MAX) || null : null
  return {
    ds: dsOf({
      kind, reason: d.reason ?? null, sideUnknown: !!d.sideUnknown, srId: sr.id ?? null, callId: d.lastCallId ?? null, at: last, until,
      ownerUid: d.ownerUid ?? null, voice, suspendedUntil: msOf(d.suspendedUntil), source: 'field',
    }),
    why: null,
  }
}

// Обговорення для дзвінка: lookup — пошук клієнта (null — не встиг); appCalls — дзвінки головної відкритої заявки (null —
// не прочитано за бюджет VG_DS_CALLS_BUDGET_MS, тоді «обговорення немає»); phone — E.164 того, хто дзвонить
export function discussionFor({ lookup = null, appCalls = null, phone = null, nowMs = Date.now(), config = {} }) {
  const src = DS_SOURCES.includes(config.dsSource) ? config.dsSource : 'off'
  if (src === 'off') return { ds: null, why: 'off' }
  // Вже прочитаний під час прогріву system/binotelRouting; нових читань тут немає.
  const routing = config.dsRouting
  if (routing?.enabled === false) return { ds: null, why: 'disabled' }
  if (routing?.scope === 'test' && !(config.allowedCallers || []).some((p) => strictPhone(p) === strictPhone(phone))) return { ds: null, why: 'outside_scope' }
  const sr = dsRequestFor(lookup, nowMs)
  if (src === 'test') {
    const normalized = strictPhone(phone)
    if (!(config.allowedCallers || []).some((p) => strictPhone(p) === normalized)) return { ds: null, why: 'not_allowed' }
    const kind = config.dsTest?.get?.(normalized) || null
    if (!kind) return { ds: null, why: 'not_test' }
    return { ds: dsOf({ kind, reason: REASON_OF_TEST[kind], srId: sr?.id ?? null, at: nowMs, ownerUid: 'test', source: 'test' }), why: null }
  }
  if (!lookup) return { ds: null, why: 'no_data' }
  if (!sr) return { ds: null, why: 'no_request' }
  if (src === 'field' || src === 'auto') {
    const f = discussionFromField({ sr, nowMs, config })
    if (f !== undefined) return f
    if (src === 'field') return { ds: null, why: 'no_field' }
  }
  if (appCalls == null) return { ds: null, why: 'timeout' }
  return discussionFromCalls({ calls: appCalls, sr, nowMs, config })
}

// Чи потрібні дзвінки заявки (calls) для цього джерела й цієї заявки — щоб flow.mjs не читав зайвого
export const dsNeedsCalls = (config = {}, sr = null) => !!sr && (config.dsSource === 'calls' || (config.dsSource === 'auto' && discussionFromField({ sr, nowMs: 0 }) === undefined))

// Ведучий: ключ — з VG_DS_STAFF за uid (рішення 7), інакше знімок employeeLine / employeePhone із дзвінка; тестове
// обговорення без VG_DS_STAFF test=… — лінія менеджера. Дзвонимо лише тому, чий ключ є в VG_MANAGERS (номер веде власник,
// а не pbxPhone співробітника). → {uid, key, group, uri, why}: why no_key / not_in_managers — дзвонити нікуди.
export function resolveLead({ ds, config = {}, managers = [] }) {
  if (!ds) return null
  const staff = config.dsStaff || {}
  const opKey = managerKeyOf(config.managerUri, managers) || partyKey(config.managerUri)
  let key = (ds.ownerUid && staff[ds.ownerUid]) || ds.snapshotKey || null
  if (!key && ds.source === 'test') key = opKey
  const uid = ds.ownerUid ?? null
  if (!key) return { uid, key: null, group: null, uri: null, why: 'no_key' }
  const group = managerGroupOf(key, managers)
  if (!group) return { uid, key, group: null, uri: null, why: 'not_in_managers' }
  // Лінія менеджера — як задано (у --local це повний URI); інший ключ: внутрішня — sip:NNN@сервер, мобільний — шаблон
  // VG_DS_LEAD_URI (типово як набір мобільного менеджера через тунель WireGuard)
  const server = config.sipServer || 'sip14.binotel.com'
  const uri = partyKey(config.managerUri) === key
    ? config.managerUri
    : isInternalKey(key) ? `sip:${key}@${server};transport=udp` : clientDialUri(key, config.dsLeadUriTemplate || 'sip:{national}@{server};transport=udp', server)
  return { uid, key: group[0], dialKey: key, group, uri, why: uri ? null : 'bad_uri' }
}

// Гілка (п. 3 записки, рішення 23 і В19): ніч — after_hours / discussion_after_hours; без обговорення — ai_first;
// pending_call, ведучий на паузі, зайнятий іншим дзвінком шлюзу, ключа немає / не в VG_MANAGERS — discussion_unavailable
// (ШІ з перезвоном, ведучому не дзвонимо); інакше — discussion (фраза 13/14/15 і дзвінок ведучому).
export function routeFor({ afterHours = false, ds = null, lead = null, paused = false, busy = false } = {}) {
  if (afterHours) return ds ? { branch: 'discussion_after_hours', aiKind: 'discussion_after_hours', why: null } : { branch: 'after_hours', aiKind: 'after_hours', why: null }
  if (!ds) return { branch: 'ai_first', aiKind: 'first', why: null }
  const unavailable = (why) => ({ branch: 'discussion_unavailable', aiKind: 'discussion_unavailable', why })
  if (ds.kind === 'pending') return unavailable('pending_call')
  if (!lead?.key) return unavailable('no_key')
  if (!lead.group) return unavailable('not_in_managers')
  if (!lead.uri) return unavailable('bad_uri')
  if (paused) return unavailable('paused')
  if (busy) return unavailable('owner_busy')
  return { branch: 'discussion', aiKind: null, opener: ds.kind === 'talked' || ds.kind === 'called' ? ds.kind : 'general', why: null }
}

// Для журналу — без номерів: вид, джерело, причина, вік останнього дзвінка (год), ключ ведучого (мобільний — маскою)
export function dsJournal(ds, lead, nowMs, why = null) {
  if (!ds) return why ? { kind: null, why } : null
  const k = lead?.key ?? null
  return {
    kind: ds.kind, source: ds.source, reason: ds.reason, ...(ds.sideUnknown ? { sideUnknown: true } : {}),
    ageH: ds.at != null ? Math.round(((nowMs - ds.at) / H) * 10) / 10 : null,
    managerKey: k ? (isInternalKey(k) ? k : `…${String(k).replace(/\D/g, '').slice(-4)}`) : null,
    ...(lead?.why ? { leadWhy: lead.why } : {}),
    ...(why ? { why } : {}),
  }
}
