#!/usr/bin/env node
// Пробний імпорт ІСТОРІЇ КОМУНІКАЦІЙ клієнта з 1С (регістр ИсторияКомуникаций) — ЛИШЕ ЧИТАННЯ.
// Етап 2 міграції ленти клієнта (записка runferry-briefs/onec/client-history-migration-*.md).
// Нічого НЕ пише ні в Firestore, ні в 1С: Firestore читає список відомих телефонів і наші
// власні копії коментарів (щоб виміряти часовий пояс дат 1С), 1С — лише POST repair_History.
//
// Креди: ADC (gcloud auth application-default login), проєкт droidmaps-runferry. Обліковка
// публікації 1С — з env (ONEC_BOT_USERNAME/ONEC_BOT_PASSWORD), інакше читається з env
// Cloud Run runferry-backend через Admin API. Значення НІКОЛИ не друкуються і не пишуться.
//
//   node scripts/onec-history-probe.mjs --out=<тека ПОЗА репозиторієм> [--limit=N] [--delay=350]
//        [--via=ad|facade] [--raw]
//   node scripts/onec-history-probe.mjs --out=<тека> --from-raw=<тека>/raw.jsonl   # повторний аналіз без 1С
//   --via=ad      (типово) https://portal.runferry.com/login/hs/ad + Basic — справжні коди відповіді
//   --via=facade  анонімний фасад /api/hs/facebook (той самий обробник, помилки як 200)
//   --raw         зберегти сирі відповіді (ПДн!) у <out>/raw.jsonl з правами 600 — для повторного
//                 аналізу без нових запитів до 1С; видалити після аналізу
//
// У звіт (stdout і <out>/report.json) потрапляють ЛИШЕ агрегати: кількості, діапазони дат,
// розподіли; жодних текстів записів і телефонів.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import { GoogleAuth } from 'google-auth-library'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry'
const REGION = 'europe-west3'
const SERVICE = 'runferry-backend'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))
const OUT = args.out ? path.resolve(String(args.out)) : ''
if (!OUT) { console.error('Потрібен --out=<тека поза репозиторієм>'); process.exit(2) }
if (OUT === REPO_ROOT || OUT.startsWith(REPO_ROOT + path.sep)) {
  console.error('--out всередині репозиторію заборонено: репозиторій ПУБЛІЧНИЙ, дані клієнтів сюди не кладемо')
  process.exit(2)
}
const LIMIT = args.limit ? Number(args.limit) : Infinity
const DELAY = args.delay ? Number(args.delay) : 350
const VIA = args.via === 'facade' ? 'facade' : 'ad'
const SAVE_RAW = !!args.raw && !args['from-raw']
const FROM_RAW = args['from-raw'] ? path.resolve(String(args['from-raw'])) : ''
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const digits = (v) => String(v ?? '').replace(/\D/g, '')
// Ключ 1С: останні 9 цифр (Клиенты.ОсновнийТелефон = Число(Прав(тел, 9))).
const key9 = (v) => { const d = digits(v); return d.length >= 9 ? d.slice(-9) : '' }
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n }

// ---------- обліковка 1С (без друку значень) ----------
const cloudRunEnv = async () => {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient()
  const url = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`
  const { data } = await client.request({ url })
  const env = {}
  for (const c of data?.template?.containers || []) for (const e of c.env || []) if ('value' in e) env[e.name] = e.value
  return env
}
const onecConfig = async () => {
  let env = process.env
  if (VIA === 'ad' && !process.env.ONEC_BOT_USERNAME) env = { ...(await cloudRunEnv()), ...process.env }
  if (VIA === 'facade') {
    return { base: (env.ONEC_PORTAL_API_BASE || 'https://portal.runferry.com/api/hs/facebook').replace(/\/+$/, ''), auth: null }
  }
  const base = (env.ONEC_AD_BASE_URL || 'https://portal.runferry.com/login/hs/ad').replace(/\/+$/, '')
  if (!env.ONEC_BOT_USERNAME) throw new Error('немає ONEC_BOT_USERNAME ні в env, ні в Cloud Run')
  return { base, auth: { username: env.ONEC_BOT_USERNAME, password: env.ONEC_BOT_PASSWORD || '' } }
}

// ---------- телефони, відомі нашій системі (лише читання) ----------
// [колекція, поля з телефоном]. Відсутні поля/колекції — просто пропускаються.
const PHONE_SOURCES = [
  ['serviceRequests', ['clientPhone', 'phone']],
  ['callEvents', ['phone']],
  ['callResults', ['phone']],
  ['clientProfiles', ['phone', 'id']],
  ['chatSessions', ['contact.phone']],
  ['notifications', ['phone']],
  ['binotelEvents', ['externalNumber', 'externalNumberRaw']],
  ['boatOrders', ['clientPhone']],
  ['group:calls', ['clientPhone']], // serviceRequests/{id}/calls — дзвінки із застосунку
  ['bot_callCards', ['phone']],
  ['bot_callResults', ['phone']],
  ['bot_clientLinks', ['phone']],
  ['bot_consultations', ['phone']],
]
const collectPhones = async (db) => {
  const byKey = new Map() // key9 -> {full: Set(digits), sources: Set}
  const perSource = {}
  for (const [coll, fields] of PHONE_SOURCES) {
    let n = 0
    try {
      const q = coll.startsWith('group:') ? db.collectionGroup(coll.slice(6)) : db.collection(coll)
      const snap = await q.select(...fields).get()
      for (const doc of snap.docs) {
        const d = doc.data()
        for (const f of fields) {
          const v = f === 'id' ? doc.id : f.split('.').reduce((o, p) => (o == null ? o : o[p]), d)
          const vals = Array.isArray(v) ? v : [v]
          for (const one of vals) {
            const k = key9(one)
            if (!k || /^0+$/.test(k)) continue
            if (!byKey.has(k)) byKey.set(k, { full: new Set(), sources: new Set() })
            const e = byKey.get(k)
            const dd = digits(one)
            // Повний номер для виявлення колізій за 9 цифрами (іноземні номери).
            e.full.add(dd.length === 9 ? '380' + dd : dd.length === 10 && dd.startsWith('0') ? '38' + dd : dd)
            e.sources.add(coll)
            n++
          }
        }
      }
      perSource[coll] = { docs: snap.size, phoneValues: n }
    } catch (e) {
      perSource[coll] = { error: e.code || e.message }
    }
  }
  return { byKey, perSource }
}

// Наші копії текстів, які ми відправляли в 1С через FastComment (для виміру часового поясу).
const collectOurMirrors = async (db) => {
  const byKey = new Map() // key9 -> [{text, at}]
  const add = (phone, text, at) => {
    const k = key9(phone); const t = String(text || '').trim()
    if (!k || !t || !at) return
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push({ text: t, at: String(at) })
  }
  const stat = {}
  try {
    const s = await db.collection('callEvents').select('phone', 'notes').get()
    let n = 0
    for (const doc of s.docs) for (const note of doc.data().notes || []) if (note?.sentTo1C) { add(doc.data().phone, note.text, note.at); n++ }
    stat.callEventsNotesSentTo1C = n
  } catch (e) { stat.callEvents = e.code || e.message }
  for (const coll of ['callResults', 'bot_callResults']) {
    try {
      const s = await db.collection(coll).select('phone', 'resultText', 'createdAt', 'sentTo1C').get()
      let n = 0
      for (const doc of s.docs) { const d = doc.data(); if (d.sentTo1C) { add(d.phone, d.resultText, d.createdAt); n++ } }
      stat[coll + 'SentTo1C'] = n
    } catch (e) { stat[coll] = e.code || e.message }
  }
  return { byKey, stat }
}

// ---------- класифікація записів 1С за текстом (типу регистратора repair_History не віддає) ----------
const KINDS = [
  ['incoming_call', /^входящий звонок\s*$/i],
  ['sms_code', /^отправлена смс\s+код/i],
  ['sms', /^отправлена смс/i],
  ['ttn', /^создана ттн/i],
  ['sale', /^продан\s/i],
  ['sales_import', /^из импорта/i],
]
const kindOf = (desc) => {
  const t = String(desc || '').trim()
  if (!t) return 'empty'
  for (const [k, re] of KINDS) if (re.test(t)) return k
  return 'other'
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

// ---------- запит до 1С ----------
const fetchHistory = async (cfg, k) => {
  const url = `${cfg.base}/repair/380${k}/repair_History`
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now()
    try {
      const r = await axios.post(url, '', {
        timeout: 30000,
        responseType: 'text',
        transformResponse: (x) => x,
        validateStatus: () => true,
        headers: { 'Content-Type': 'text/plain' },
        ...(cfg.auth ? { auth: cfg.auth } : {}),
      })
      const ms = Date.now() - t0
      let body = String(r.data ?? '')
      const bom = body.charCodeAt(0) === 0xfeff
      if (bom) body = body.slice(1)
      if (r.status >= 500 && attempt < 2) { lastErr = `HTTP ${r.status}`; await sleep(1500 * (attempt + 1)); continue }
      let json = null
      try { json = JSON.parse(body) } catch { /* не JSON */ }
      return { status: r.status, ms, bytes: body.length, bom, json, isJson: !!json }
    } catch (e) {
      lastErr = e.code || e.message
      await sleep(1500 * (attempt + 1))
    }
  }
  return { status: 0, error: lastErr }
}

// ---------- аналіз однієї відповіді ----------
const analyse = (list) => {
  const a = { n: list.length, kinds: {}, badDates: 0, emptyDates: 0, midnight: 0, inversions: 0, dups: 0, maxLen: 0, multiline: 0, urls: 0, years: {}, min: null, max: null, lens: [] }
  const seen = new Map()
  let prev = null
  for (const it of list) {
    const desc = String(it?.Desc ?? '')
    const date = String(it?.Date ?? '')
    inc(a.kinds, kindOf(desc))
    a.lens.push(desc.length)
    if (desc.length > a.maxLen) a.maxLen = desc.length
    if (/\n/.test(desc)) a.multiline++
    if (/https?:\/\//i.test(desc)) a.urls++
    const m = date.match(DATE_RE)
    if (!m) { a.badDates++ } else if (m[1] === '0001') { a.emptyDates++ } else {
      if (m[4] === '00' && m[5] === '00' && m[6] === '00') a.midnight++
      inc(a.years, m[1])
      if (!a.min || date < a.min) a.min = date
      if (!a.max || date > a.max) a.max = date
      if (prev && date < prev) a.inversions++
      prev = date
    }
    const dk = date + '\u0000' + desc
    seen.set(dk, (seen.get(dk) || 0) + 1)
  }
  for (const c of seen.values()) if (c > 1) a.dups += c - 1
  return a
}

// Дельта «дата 1С як UTC» − «наш UTC-час» у хвилинах = зсув локального часу 1С.
const tzDeltas = (list, mirrors) => {
  const out = []
  if (!mirrors?.length) return out
  for (const it of list) {
    const desc = String(it?.Desc ?? '').trim()
    const date = String(it?.Date ?? '')
    if (!DATE_RE.test(date)) continue
    for (const m of mirrors) {
      if (m.text !== desc) continue
      const d = (Date.parse(date + 'Z') - Date.parse(m.at)) / 60000
      if (Number.isFinite(d) && Math.abs(d) < 24 * 60) out.push({ d, month: date.slice(0, 7) })
    }
  }
  return out
}


// Зсув Europe/Kyiv (хв) на момент UTC — та сама логіка, що parse1cDate у server/onecSync.js.
const kyivOffsetMin = (probe) => {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' })
      .formatToParts(probe).find((p) => p.type === 'timeZoneName')
    const m = String(part?.value || '').match(/GMT([+-])(\d{2}):(\d{2})/)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180
  } catch { return 180 }
}
// Дата 1С (київський настінний час без поясу) → UTC ms.
const onecToUtcMs = (s) => {
  const g = Date.parse(s + 'Z')
  return Number.isFinite(g) ? g - kyivOffsetMin(new Date(g)) * 60000 : NaN
}
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim()

// Глибший аналіз: чи дійшли наші копії (FastComment) до 1С, і що лишається «чужим».
const deep = { mirrorsTotal: 0, mirrorsFound: 0, mirrorsNotFoundByMonth: {}, mirrorsFoundByMonth: {}, residualMin: {},
  otherOursMirror: 0, otherStaffOrManual: 0, otherDashPrefix: 0, otherRepairCmd: 0, otherLenBuckets: {},
  kindsByYear: {}, incomingByMonth: {}, smsByYear: {} }
const deepConsume = (k, list, mirrorsForKey) => {
  const entries = list.map((it) => ({ desc: normText(it?.Desc), date: String(it?.Date ?? ''), kind: kindOf(it?.Desc) }))
  const matched = new Set()
  for (const m of mirrorsForKey || []) {
    deep.mirrorsTotal++
    const atMs = Date.parse(m.at)
    const t = normText(m.text)
    let hit = -1
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.desc !== t || !DATE_RE.test(e.date)) continue
      const resid = (onecToUtcMs(e.date) - atMs) / 60000
      if (Math.abs(resid) <= 15) { hit = i; inc(deep.residualMin, String(Math.round(resid))); break }
    }
    const month = String(m.at).slice(0, 7)
    if (hit >= 0) { deep.mirrorsFound++; matched.add(hit); inc(deep.mirrorsFoundByMonth, month) } else inc(deep.mirrorsNotFoundByMonth, month)
  }
  entries.forEach((e, i) => {
    const y = e.date.slice(0, 4)
    deep.kindsByYear[y] ||= {}; inc(deep.kindsByYear[y], e.kind)
    if (e.kind === 'incoming_call') inc(deep.incomingByMonth, e.date.slice(0, 7))
    if (e.kind === 'sms' || e.kind === 'sms_code') inc(deep.smsByYear, y)
    if (e.kind !== 'other') return
    if (matched.has(i)) { deep.otherOursMirror++; return }
    deep.otherStaffOrManual++
    if (/^[-–—]/.test(e.desc)) deep.otherDashPrefix++
    if (/ремонт/i.test(e.desc) && /^[-–—]|нб-/i.test(e.desc)) deep.otherRepairCmd++
    const L = e.desc.length
    inc(deep.otherLenBuckets, L <= 20 ? '≤20' : L <= 100 ? '21-100' : L <= 500 ? '101-500' : '>500')
  })
}

const main = async () => {
  const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: PROJECT }))
  const cfg = FROM_RAW ? null : await onecConfig()
  if (FROM_RAW) console.log(`Повторний аналіз сирих відповідей: ${FROM_RAW} (1С не опитується)`)
  else console.log(`1С: ${VIA === 'ad' ? 'login/hs/ad (Basic з env)' : 'фасад /api/hs/facebook (анонімно)'}; затримка ${DELAY} мс`)
  const rawByKey = new Map()
  if (FROM_RAW) for (const line of fs.readFileSync(FROM_RAW, 'utf8').split('\n')) { if (line.trim()) { const o = JSON.parse(line); rawByKey.set(o.k, o.list) } }

  const { byKey, perSource } = await collectPhones(db)
  const mirrors = await collectOurMirrors(db)
  const keys = (FROM_RAW ? [...rawByKey.keys()].filter((k) => byKey.has(k)) : [...byKey.keys()]).sort().slice(0, LIMIT)
  console.log(`Телефонів (унікальних за 9 цифрами): ${byKey.size}; опитуємо ${keys.length}`)

  const rawFd = SAVE_RAW ? fs.openSync(path.join(OUT, 'raw.jsonl'), 'w', 0o600) : null
  const tot = {
    probed: 0, withEntries: 0, empty: 0, errors: {}, notJson: 0, bom: 0, entries: 0,
    kinds: {}, badDates: 0, emptyDates: 0, midnight: 0, inversionsPhones: 0, inversions: 0, dups: 0,
    multiline: 0, urls: 0, maxLen: 0, years: {}, min: null, max: null,
    perPhone: [], lens: [], ms: [], bytes: [], collisions9: 0, collisionEntries: 0, sourcesOfEmpty: {},
  }
  const tz = []
  const t0 = Date.now()
  for (const k of keys) {
    const r = FROM_RAW ? { status: 200, isJson: true, ms: 0, bytes: 0, json: { List: rawByKey.get(k) } } : await fetchHistory(cfg, k)
    tot.probed++
    if (r.status !== 200 || !r.isJson) {
      if (r.status !== 200) inc(tot.errors, String(r.status || r.error))
      else tot.notJson++
    } else {
      if (r.bom) tot.bom++
      tot.ms.push(r.ms); tot.bytes.push(r.bytes)
      const list = Array.isArray(r.json?.List) ? r.json.List : []
      const a = analyse(list)
      if (rawFd !== null) fs.writeSync(rawFd, JSON.stringify({ k, list }) + '\n')
      if (a.n) tot.withEntries++; else { tot.empty++; for (const s of byKey.get(k).sources) inc(tot.sourcesOfEmpty, s) }
      tot.entries += a.n; tot.perPhone.push(a.n); tot.lens.push(...a.lens)
      for (const [kk, v] of Object.entries(a.kinds)) inc(tot.kinds, kk, v)
      for (const [y, v] of Object.entries(a.years)) inc(tot.years, y, v)
      tot.badDates += a.badDates; tot.emptyDates += a.emptyDates; tot.midnight += a.midnight
      tot.inversions += a.inversions; if (a.inversions) tot.inversionsPhones++
      tot.dups += a.dups; tot.multiline += a.multiline; tot.urls += a.urls
      if (a.maxLen > tot.maxLen) tot.maxLen = a.maxLen
      if (a.min && (!tot.min || a.min < tot.min)) tot.min = a.min
      if (a.max && (!tot.max || a.max > tot.max)) tot.max = a.max
      // Колізія: різні повні номери з однаковими 9 цифрами — у 1С це ОДИН клієнт.
      if (byKey.get(k).full.size > 1) { tot.collisions9++; tot.collisionEntries += a.n }
      tz.push(...tzDeltas(list, mirrors.byKey.get(k)))
      deepConsume(k, list, mirrors.byKey.get(k))
    }
    if (FROM_RAW) continue
    if (tot.probed % 100 === 0) console.log(`  …${tot.probed}/${keys.length} (${Math.round((Date.now() - t0) / 1000)} с)`)
    await sleep(DELAY)
  }
  if (rawFd !== null) fs.closeSync(rawFd)

  // Часовий пояс: гістограма дельт, округлених до 15 хв, окремо по місяцях.
  const tzHist = {}; const tzByMonth = {}
  for (const { d, month } of tz) {
    inc(tzHist, String(Math.round(d / 15) * 15))
    ;(tzByMonth[month] ||= []).push(d)
  }
  const tzMonthMedian = Object.fromEntries(Object.entries(tzByMonth).sort().map(([m, arr]) => [m, { n: arr.length, median: pct(arr, 0.5) }]))

  const report = {
    generatedAt: new Date().toISOString(),
    via: VIA,
    phoneSources: perSource,
    ourMirrors: mirrors.stat,
    phonesKnown: byKey.size,
    probed: tot.probed,
    withEntries: tot.withEntries,
    emptyHistory: tot.empty,
    emptyHistoryBySource: tot.sourcesOfEmpty,
    errors: tot.errors,
    notJson: tot.notJson,
    bomResponses: tot.bom,
    entries: tot.entries,
    kinds: tot.kinds,
    perPhone: { p50: pct(tot.perPhone, 0.5), p90: pct(tot.perPhone, 0.9), p99: pct(tot.perPhone, 0.99), max: pct(tot.perPhone, 1) },
    textLen: { p50: pct(tot.lens, 0.5), p95: pct(tot.lens, 0.95), max: tot.maxLen, multiline: tot.multiline, withUrls: tot.urls },
    dates: { min: tot.min, max: tot.max, years: tot.years, bad: tot.badDates, empty0001: tot.emptyDates, midnight: tot.midnight },
    order: { phonesWithInversions: tot.inversionsPhones, inversions: tot.inversions },
    exactDuplicates: tot.dups,
    collisions9: { keys: tot.collisions9, entries: tot.collisionEntries },
    timezone: { matches: tz.length, histogramMin: tzHist, medianByMonth: tzMonthMedian, residualAfterKyivMin: deep.residualMin },
    deep,
    latencyMs: { p50: pct(tot.ms, 0.5), p95: pct(tot.ms, 0.95), max: pct(tot.ms, 1) },
    bytes: { p50: pct(tot.bytes, 0.5), max: pct(tot.bytes, 1), total: tot.bytes.reduce((s, x) => s + x, 0) },
    durationSec: Math.round((Date.now() - t0) / 1000),
  }
  fs.writeFileSync(path.join(OUT, FROM_RAW ? 'report-from-raw.json' : 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1) })
