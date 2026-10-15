// Дзвінки з мобільного застосунку сервісу через АТС Binotel (API 4.0) + запис → розшифровка →
// резюме, прив'язані до заявки. Перевірено 2026-10-15 на тестових номерах власника (повний цикл).
//
// Як працює:
//   POST /api/calls/originate {serviceRequestId}  (owner/director/master; майстер — лише своя заявка/центр)
//     → номер клієнта беремо ІЗ ЗАЯВКИ, номер співробітника — з users/{uid}: pbxLine (внутрішня
//       лінія Binotel 90x/91x, пише лише власник → calls/internal-number-to-external-number) або
//       pbxPhone/fmcPhone (мобільний, пише сам співробітник → calls/external-number-to-external-number:
//       АТС спочатку набирає співробітника, після відповіді — клієнта). Відповідь АТС: generalCallID
//       першої ноги (= співробітник); друга нога (клієнт) — окремий запис у статистиці з тією ж міткою
//       internalNumber «Звонок NNNNNNN».
//     → документ serviceRequests/{srId}/calls/{callId}, status: dialing.
//   Далі конвеєр (таймер у процесі + /api/calls/reconcile від Cloud Scheduler як страховка):
//     dialing → connected → finished (розмова була) → recorded (mp3 у Cloud Storage) →
//     transcribed (ElevenLabs Scribe v2, стерео: канал = сторона) → summarized (Claude, укр.).
//     Невдачі: no_answer (хтось не відповів/зайнято), failed (АТС/оператор), skipped (надто коротка
//     розмова — без розшифровки), no_recording (АТС не віддала запис), error (крок упав 5 разів поспіль).
//   GET /api/calls/:srId/:callId/recording — mp3 (з Range) для кнопки «прослухати» (staff).
//
// Binotel: ≤ 1 запит на 3 с (код 106) — усі виклики йдуть через одну чергу з паузою, originate має
// пріоритет перед фоновим опитуванням; посилання на запис живе ~1 год, тому файл одразу копіюємо у
// бакет. Для external-number-to-external-number потрібна лінія з двома каналами (0443338049; у
// 0679278039 друга нога одразу BUSY). Секрети лише в env/Secret Manager (див. .env.example).
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { getStorage } from 'firebase-admin/storage'
import { verifyFirebaseStaff, verifyFirebaseAdmin } from './adminAuth.js'
import { normPhone } from './phone.js'
import { rateLimit } from './rateLimit.js'

const nowIso = () => new Date().toISOString()
const addSec = (s) => new Date(Date.now() + s * 1000).toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- конфігурація ----------
const BINOTEL_API = 'https://api.binotel.com/api/4.0/'
const PBX_NUMBER = String(process.env.BINOTEL_PBX_NUMBER || '0443338049') // лінія з двома каналами (ext2ext = два одночасні вихідні)
const PLAYBACK_WAITING = /^(false|0)$/i.test(process.env.BINOTEL_PLAYBACK_WAITING || '') ? 'FALSE' : 'TRUE'
const LIMIT_CALL_SEC = Number(process.env.CALLS_LIMIT_SEC || 1800)
const CALL_TIME_TO_EXT = Number(process.env.CALLS_RING_SEC || 40) // скільки дзвонити внутрішній лінії
const STT_MIN_SEC = Number(process.env.CALLS_STT_MIN_SEC || 8) // коротше — не розшифровуємо
const STT_MODEL = 'scribe_v2'
const STT_USD_PER_HOUR_PER_CHANNEL = 0.22
const AI_MODEL = process.env.CALLS_AI_MODEL || 'claude-opus-5-5'
const AI_PRICE = { input: 4, output: 20 } // $/млн токенів, claude-opus-5-5
const WATCH_MAX_MIN = Number(process.env.CALLS_WATCH_MAX_MIN || 45) // скільки таймер у процесі стежить за дзвінком
const RECORDING_WAIT_MAX_MIN = Number(process.env.CALLS_RECORDING_WAIT_MIN || 120)
const KEYTERMS = String(process.env.CALLS_STT_KEYTERMS || '').split(',').map((s) => s.trim()).filter(Boolean)
const LOCK_SEC = 600 // довше за найдовший крок (скачування 60 с + STT 180 с + черга Binotel)
const MAX_ATTEMPTS = 5 // поспіль невдалих спроб одного кроку → status error
const SECOND_LEG_CHECKS = 4 // скільки разів шукати другу ногу, поки її немає у статистиці

// Відповідність каналів запису сторонам розмови. ПЕРЕВІРЕНО 2026-10-15: у дзвінках з внутрішньої
// лінії канал 0 = співробітник, канал 1 = зовнішній абонент; у записі першої ноги external-number-
// to-external-number канал 0 = те, що чує співробітник (підказка АТС + клієнт), канал 1 = його голос.
const CHANNEL_MAP = {
  int2ext: { 0: 'employee', 1: 'client' },
  ext2ext: { 0: 'client', 1: 'employee' },
}

const TERMINAL = new Set(['summarized', 'skipped', 'no_answer', 'failed', 'no_recording', 'error'])
const RETRYABLE = new Set(['error', 'no_recording', 'skipped']) // з яких терміналів власник може повторити
const FINAL_DISPOSITIONS = new Set(['ANSWER', 'TRANSFER', 'BUSY', 'NOANSWER', 'CANCEL', 'CONGESTION', 'CHANUNAVAIL', 'VM', 'VM-SUCCESS'])
const SUCCESS_DISPOSITIONS = new Set(['ANSWER', 'TRANSFER'])
// Людський опис для картки (укр.)
const DISPOSITION_UK = {
  ANSWER: 'розмова не відбулася', TRANSFER: 'розмова не відбулася',
  BUSY: 'зайнято', NOANSWER: 'не відповідає', CANCEL: 'скасовано', CONGESTION: 'оператор відхилив дзвінок',
  CHANUNAVAIL: 'номер недоступний', VM: 'голосова пошта', 'VM-SUCCESS': 'голосова пошта',
}
const dispUk = (disp) => DISPOSITION_UK[disp] || `статус АТС ${disp || '?'}`

// Binotel чекає національний формат 0XXXXXXXXX.
const toNational = (raw) => {
  const e164 = normPhone(raw)
  return e164 ? '0' + e164.slice(4) : ''
}
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])
const callIdOf = (generalCallID) => `binotel-${generalCallID}`
const ID_RE = /^[\w-]{1,128}$/

export function registerBinotelCalls(app, deps) {
  const { adminDb, anthropic } = deps
  const KEY = process.env.BINOTEL_KEY || ''
  const SECRET = process.env.BINOTEL_SECRET || ''
  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || ''
  const ADMIN_TOKEN = process.env.PAYMENTS_ADMIN_TOKEN || '' // той самий токен, що у Cloud Scheduler (pay-reconcile)
  const BUCKET = process.env.CALLS_RECORDINGS_BUCKET || `${process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry'}.firebasestorage.app`
  const configured = !!(KEY && SECRET)
  if (!configured) console.warn('⚠️  BINOTEL_KEY/BINOTEL_SECRET not set — /api/calls/originate (Binotel) disabled')
  if (configured && !ELEVEN_KEY) console.warn('⚠️  ELEVENLABS_API_KEY not set — call transcripts will fail (status error)')

  // ---------- Binotel: одна черга, пауза ≥ 3,2 с між запитами, повтор на 106, пріоритет originate ----------
  const pending = [] // {priority, run, resolve, reject}
  let draining = false
  let lastRequestAt = 0
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        pending.sort((a, b) => b.priority - a.priority)
        const job = pending.shift()
        const wait = lastRequestAt + 3200 - Date.now()
        if (wait > 0) await sleep(wait)
        lastRequestAt = Date.now()
        try { job.resolve(await job.run()) } catch (e) { job.reject(e) }
      }
    } finally {
      draining = false
    }
  }
  const binotel = (method, body = {}, { priority = 0 } = {}) => new Promise((resolve, reject) => {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) { const wait = lastRequestAt + 3200 - Date.now(); if (wait > 0) await sleep(wait); lastRequestAt = Date.now() }
        const r = await axios.post(`${BINOTEL_API}${method}.json`, { key: KEY, secret: SECRET, ...body }, { timeout: 20000, validateStatus: () => true })
        const j = r.data && typeof r.data === 'object' ? r.data : null
        if (!j) throw Object.assign(new Error(`Binotel ${method}: HTTP ${r.status}`), { code: 'HTTP', status: r.status })
        if (j.status === 'success') return j
        const m = /after (\d+) sec/.exec(j.message || '')
        if (String(j.code) === '106' && attempt < 3) { await sleep(((m && Number(m[1])) || 3) * 1000 + 500); continue }
        throw Object.assign(new Error(`Binotel ${method}: ${j.code || ''} ${j.message || j.status}`.trim()), { code: String(j.code || 'ERR'), binotel: true })
      }
      throw Object.assign(new Error(`Binotel ${method}: too many retries`), { code: '106', binotel: true })
    }
    pending.push({ priority, run, resolve, reject })
    drain().catch((e) => console.error('binotel queue:', e.message))
  })

  // ---------- helpers ----------
  const col = (srId) => adminDb.collection('serviceRequests').doc(String(srId)).collection('calls')
  const patch = (ref, data) => ref.set({ ...data, updatedAt: nowIso() }, { merge: true })
  const fail = (ref, status, code, message, extra = {}) =>
    patch(ref, { status, statusAt: nowIso(), nextCheckAt: null, error: { code, message, at: nowIso() }, ...extra })

  const callDetails = async (generalCallID) => {
    const d = await binotel('stats/call-details', { generalCallID: String(generalCallID) })
    return asList(d.callDetails)[0] || null
  }

  // Друга нога (клієнт) у external-number-to-external-number — окремий запис зі спільною міткою
  // internalNumber «Звонок NNNNNNN»; шукаємо її у списку дзвінків навколо старту першої ноги.
  const findSecondLeg = async (leg1, clientNat) => {
    const start = Number(leg1.startTime || 0)
    if (!start || !leg1.internalNumber) return null
    const list = await binotel('stats/list-of-calls-for-period', { startTime: start - 30, stopTime: Math.min(start + LIMIT_CALL_SEC + 300, start + 86000) })
    return asList(list.callDetails).find((c) => String(c.generalCallID) !== String(leg1.generalCallID)
      && String(c.internalNumber || '') === String(leg1.internalNumber)
      && String(c.externalNumber || '').replace(/\D/g, '').endsWith(clientNat.slice(-9))) || null
  }

  const legOf = (c, party) => ({
    party, generalCallID: String(c.generalCallID || ''), disposition: String(c.disposition || ''),
    waitSec: Number(c.waitsec || 0), billSec: Number(c.billsec || 0), recordingStatus: String(c.recordingStatus || ''),
    startedAt: c.startTime ? new Date(Number(c.startTime) * 1000).toISOString() : null,
  })

  // ---------- крок 1: стан дзвінка ----------
  const stepDial = async (ref, d) => {
    const c = await callDetails(d.generalCallID)
    if (!c) {
      const ageMin = (Date.now() - new Date(d.createdAt).getTime()) / 60000
      if (ageMin > 30) return fail(ref, 'failed', 'NOT_IN_STATS', 'АТС не повернула дані про дзвінок')
      return patch(ref, { nextCheckAt: addSec(10), checks: (d.checks || 0) + 1 })
    }
    const disp = String(c.disposition || '')
    const startedAt = c.startTime ? new Date(Number(c.startTime) * 1000).toISOString() : d.startedAt || null
    const base = { startedAt, disposition: disp, legLabel: c.internalNumber || d.legLabel || null, checks: (d.checks || 0) + 1 }
    if (!FINAL_DISPOSITIONS.has(disp)) {
      // CALLING — дзвонимо співробітнику; ONLINE — він відповів, набираємо клієнта.
      const status = disp === 'ONLINE' ? 'connected' : 'dialing'
      const ageMin = (Date.now() - new Date(d.createdAt).getTime()) / 60000
      if (ageMin > LIMIT_CALL_SEC / 60 + 10) return fail(ref, 'failed', 'STUCK', 'Дзвінок завис у АТС', base)
      return patch(ref, { ...base, status, ...(status === 'connected' && !d.answeredAt ? { answeredAt: nowIso() } : {}), statusAt: d.status === status ? d.statusAt : nowIso(), nextCheckAt: addSec(8) })
    }
    const billSec = Number(c.billsec || 0)
    const waitSec = Number(c.waitsec || 0)
    const legs = [legOf(c, d.method === 'ext2ext' ? 'employee' : 'call')] // ext2ext: перша нога = співробітник; int2ext: один запис на весь дзвінок
    if (!SUCCESS_DISPOSITIONS.has(disp) || billSec <= 0) {
      // int2ext: єдиний запис описує зовнішню ногу, хто саме не відповів — АТС не каже.
      const party = d.method === 'ext2ext' ? 'employee' : null
      return patch(ref, { ...base, legs, status: 'no_answer', failedParty: party, durationSec: 0, waitSec,
        finishedAt: nowIso(), statusAt: nowIso(), nextCheckAt: null,
        error: { code: `PBX_${disp}`, message: party ? `Співробітник: ${dispUk(disp)}` : `Дзвінок не відбувся: ${dispUk(disp)}`, at: nowIso() } })
    }
    // Перша нога відповіла. Для ext2ext дивимося другу ногу (клієнта): її може ще не бути у статистиці або
    // вона ще не фінальна — тоді перевіряємо знову; коротка перша нога + BUSY/NOANSWER другої = клієнт не відповів.
    let clientLeg = null
    let legsIncomplete = false
    if (d.method === 'ext2ext') {
      try { const c2 = await findSecondLeg(c, d.clientNat); if (c2) clientLeg = legOf(c2, 'client') } catch (e) { console.warn('calls second leg:', e.message) }
      const tries = (d.secondLegChecks || 0) + 1
      if (!clientLeg || !FINAL_DISPOSITIONS.has(clientLeg.disposition)) {
        if (tries < SECOND_LEG_CHECKS) return patch(ref, { ...base, legs: clientLeg ? [...legs, clientLeg] : legs, secondLegChecks: tries, nextCheckAt: addSec(8) })
        legsIncomplete = true // далі — за першою ногою
      }
      if (clientLeg) legs.push(clientLeg)
      if (clientLeg && FINAL_DISPOSITIONS.has(clientLeg.disposition) && !SUCCESS_DISPOSITIONS.has(clientLeg.disposition)) {
        return patch(ref, { ...base, legs, status: 'no_answer', failedParty: 'client', durationSec: 0, waitSec: clientLeg.waitSec,
          finishedAt: nowIso(), statusAt: nowIso(), nextCheckAt: null,
          error: { code: `PBX_${clientLeg.disposition}`, message: `Клієнт: ${dispUk(clientLeg.disposition)}`, at: nowIso() } })
      }
    }
    const talkSec = clientLeg && FINAL_DISPOSITIONS.has(clientLeg.disposition) ? Number(clientLeg.billSec || 0) : billSec
    const startMs = startedAt ? new Date(startedAt).getTime() : Date.now()
    return patch(ref, { ...base, legs, legsIncomplete, status: 'finished', durationSec: talkSec, waitSec,
      answeredAt: d.answeredAt || new Date(startMs + waitSec * 1000).toISOString(),
      finishedAt: startedAt ? new Date(startMs + (waitSec + billSec) * 1000).toISOString() : nowIso(),
      recordingStatus: String(c.recordingStatus || ''), statusAt: nowIso(), nextCheckAt: addSec(5) })
  }

  // ---------- крок 2: запис → Cloud Storage ----------
  const stepRecording = async (ref, d) => {
    let rs = d.recordingStatus
    if (rs !== 'uploaded') {
      const c = await callDetails(d.generalCallID)
      rs = String(c?.recordingStatus || '')
      if (rs !== 'uploaded') {
        const waitedMin = (Date.now() - new Date(d.finishedAt || d.createdAt).getTime()) / 60000
        if (waitedMin > RECORDING_WAIT_MAX_MIN) return fail(ref, 'no_recording', 'NO_RECORDING', 'АТС не віддала запис розмови')
        return patch(ref, { recordingStatus: rs, nextCheckAt: addSec(waitedMin < 2 ? 10 : 60), checks: (d.checks || 0) + 1 })
      }
    }
    const rec = await binotel('stats/call-record', { generalCallID: String(d.generalCallID) })
    const url = rec.url || rec.callRecord?.url || rec.link
    if (!url) throw new Error('stats/call-record без url')
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 })
    const buf = Buffer.from(r.data)
    const path = `call-recordings/${d.serviceRequestId}/${d.id}.mp3`
    await getStorage().bucket(BUCKET).file(path).save(buf, { contentType: 'audio/mpeg', resumable: false, metadata: { cacheControl: 'private, max-age=3600' } })
    return patch(ref, {
      status: 'recorded', statusAt: nowIso(), recordingStatus: 'uploaded',
      recording: { bucket: BUCKET, path, bytes: buf.length, contentType: 'audio/mpeg', readyAt: nowIso() },
      nextCheckAt: addSec(1),
    })
  }

  // ---------- крок 3: розшифровка (ElevenLabs Scribe v2, канал = сторона) ----------
  const stepTranscribe = async (ref, d) => {
    if (!ELEVEN_KEY) return fail(ref, 'error', 'STT_NOT_CONFIGURED', 'Розшифровка не налаштована (ELEVENLABS_API_KEY)')
    if (Number(d.durationSec || 0) < STT_MIN_SEC) {
      return patch(ref, { status: 'skipped', statusAt: nowIso(), nextCheckAt: null, skipReason: 'too_short' })
    }
    const [buf] = await getStorage().bucket(d.recording.bucket).file(d.recording.path).download()
    const form = new FormData()
    form.append('model_id', STT_MODEL)
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), `${d.id}.mp3`)
    form.append('timestamps_granularity', 'word')
    form.append('tag_audio_events', 'false')
    form.append('use_multi_channel', 'true')
    form.append('multichannel_output_style', 'combined')
    for (const k of KEYTERMS) form.append('keyterms', k)
    const t0 = Date.now()
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: form, signal: AbortSignal.timeout(180000) })
    const text = await res.text()
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${text.slice(0, 300)}`)
    const result = JSON.parse(text)
    const map = CHANNEL_MAP[d.method] || CHANNEL_MAP.int2ext
    let words = result.words || []
    if (Array.isArray(result.transcripts)) {
      words = result.transcripts.flatMap((t, i) => (t.words || []).map((w) => ({ ...w, channel_index: w.channel_index ?? t.channel_index ?? i })))
      words.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    }
    const turns = []
    for (const w of words) {
      if (w.type === 'spacing') continue
      const speaker = map[w.channel_index ?? 0] || 'client'
      const last = turns[turns.length - 1]
      if (last && last.speaker === speaker) { last.text += ` ${w.text}`; last.end = w.end ?? last.end }
      else turns.push({ speaker, start: Number(w.start ?? 0), end: Number(w.end ?? 0), text: String(w.text || '') })
    }
    for (const t of turns) t.text = t.text.replace(/\s+([,.!?…:;])/g, '$1').trim()
    const durationSec = Number(result.audio_duration_secs ?? result.transcripts?.[0]?.audio_duration_secs ?? d.durationSec ?? 0)
    const channels = Array.isArray(result.transcripts) ? result.transcripts.length : 2
    const costUsd = Math.round((durationSec / 3600) * STT_USD_PER_HOUR_PER_CHANNEL * channels * (KEYTERMS.length ? 1.2 : 1) * 10000) / 10000
    return patch(ref, {
      status: 'transcribed', statusAt: nowIso(),
      transcript: {
        engine: `elevenlabs/${STT_MODEL}`, lang: result.language_code ?? result.transcripts?.[0]?.language_code ?? null,
        langProbability: result.language_probability ?? null, durationSec, channels, channelMap: map, turns,
        text: turns.map((t) => `${t.speaker === 'employee' ? 'Співробітник' : 'Клієнт'}: ${t.text}`).join('\n'),
        costUsd, elapsedMs: Date.now() - t0, createdAt: nowIso(),
      },
      nextCheckAt: addSec(1),
    })
  }

  // ---------- крок 4: резюме (Claude, укр., за зразком improve-text) ----------
  const stepSummarize = async (ref, d) => {
    if (!anthropic) return fail(ref, 'error', 'AI_NOT_CONFIGURED', 'Резюме не налаштоване (ANTHROPIC_API_KEY)')
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    const dialog = (d.transcript?.turns || []).map((t) => `[${fmt(t.start)}] ${t.speaker === 'employee' ? 'Співробітник' : 'Клієнт'}: ${t.text}`).join('\n')
    if (!dialog.trim()) return patch(ref, { status: 'skipped', statusAt: nowIso(), nextCheckAt: null, skipReason: 'empty_transcript' })
    const system = [
      'Ти — асистент сервісного центру RunFerry (ремонт прикормочних рибальських корабликів).',
      'Тобі дають автоматичну розшифровку телефонної розмови майстра сервісу («Співробітник») з клієнтом («Клієнт»).',
      'Можливі помилки розпізнавання, суржик, російська мова — відновлюй зміст за контекстом.',
      'Напиши стисле резюме УКРАЇНСЬКОЮ мовою для картки заявки. Лише текст без markdown, три рядки:',
      '«Суть:» — 1–3 речення, про що розмова і що з\'ясували;',
      '«Домовилися:» — конкретні домовленості (що, хто, коли; суми, строки, адреси, номери — якщо звучали);',
      '«Далі:» — наступні кроки для сервісу або «немає».',
      'Не вигадуй того, чого не було в розмові. Якщо розмова не про ремонт/обслуговування — скажи це одним реченням.',
    ].join('\n')
    const ctx = [d.clientName ? `Клієнт у заявці: ${d.clientName}.` : '', d.serviceRequestId ? `Заявка: ${d.serviceRequestId}.` : ''].filter(Boolean).join(' ')
    const t0 = Date.now()
    // max_tokens включає і міркування моделі (thinking завжди увімкнений) — запас, а не 1024.
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: `${ctx ? ctx + '\n' : ''}Розшифровка розмови:\n"""\n${dialog}\n"""` }],
    })
    const text = message.stop_reason === 'refusal' ? '' : message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
    if (!text) return fail(ref, 'error', 'AI_EMPTY', `Модель не повернула резюме (${message.stop_reason})`)
    const u = message.usage || {}
    const costUsd = Math.round(((u.input_tokens || 0) * AI_PRICE.input + (u.output_tokens || 0) * AI_PRICE.output) / 1e6 * 10000) / 10000
    return patch(ref, {
      status: 'summarized', statusAt: nowIso(), nextCheckAt: null,
      summary: { text, lang: 'uk', model: message.model || AI_MODEL, truncated: message.stop_reason === 'max_tokens', usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 }, costUsd, elapsedMs: Date.now() - t0, createdAt: nowIso() },
      cost: { sttUsd: d.transcript?.costUsd || 0, aiUsd: costUsd, pbxLegs: d.method === 'ext2ext' ? 2 : 1 },
    })
  }

  // ---------- один крок конвеєра з блокуванням (кілька інстансів / таймер + reconcile) ----------
  // Блокування — токен у документі: знімає лише той, хто поставив; TTL довший за будь-який крок.
  // attempts рахує лише невдачі ПОСПІЛЬ: успішний крок скидає лічильник.
  const inflight = new Set()
  const processOnce = async (ref) => {
    const key = ref.path
    if (inflight.has(key)) return 'busy'
    inflight.add(key)
    const token = randomUUID()
    try {
      const claimed = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (!s.exists) return null
        const d = s.data()
        if (TERMINAL.has(d.status)) return null
        if (d.lockUntil && d.lockUntil > nowIso()) return 'locked'
        tx.set(ref, { lockUntil: addSec(LOCK_SEC), lockToken: token }, { merge: true })
        return d
      })
      if (!claimed) return 'skip'
      if (claimed === 'locked') return 'locked'
      const d = { ...claimed, id: ref.id }
      let ok = false
      try {
        if (d.status === 'dialing' || d.status === 'connected') await stepDial(ref, d)
        else if (d.status === 'finished') await stepRecording(ref, d)
        else if (d.status === 'recorded') await stepTranscribe(ref, d)
        else if (d.status === 'transcribed') await stepSummarize(ref, d)
        ok = true
      } catch (e) {
        console.error('calls pipeline', ref.path, d.status, e.message)
        const attempts = (d.attempts || 0) + 1
        if (attempts >= MAX_ATTEMPTS) await fail(ref, 'error', 'PIPELINE', `Крок «${d.status}» не вдався: ${String(e.message).slice(0, 160)}`, { attempts })
        else await patch(ref, { attempts, lastError: String(e.message).slice(0, 300), nextCheckAt: addSec(30 * attempts) })
      }
      // Знімаємо лише свій замок (інший інстанс міг перехопити документ після закінчення TTL).
      await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (s.exists && s.data().lockToken === token) tx.set(ref, { lockUntil: null, lockToken: null, ...(ok ? { attempts: 0, lastError: null } : {}), updatedAt: nowIso() }, { merge: true })
      })
      return 'done'
    } finally {
      inflight.delete(key)
    }
  }

  // Таймер у процесі: стежимо за дзвінком, поки не завершиться або не спливе WATCH_MAX_MIN.
  // Один спостерігач на документ (повторний виклик — no-op); Cloud Run без throttling CPU, але
  // інстанс може зникнути — тоді добере reconcile.
  const watchers = new Set()
  const watch = (ref) => {
    if (watchers.has(ref.path)) return
    watchers.add(ref.path)
    const until = Date.now() + WATCH_MAX_MIN * 60000
    const stop = () => watchers.delete(ref.path)
    const tick = async () => {
      if (Date.now() > until) return stop()
      try {
        const s = await ref.get()
        const d = s.exists ? s.data() : null
        if (!d || TERMINAL.has(d.status)) return stop()
        let r = 'wait'
        if (!d.nextCheckAt || d.nextCheckAt <= nowIso()) r = await processOnce(ref)
        if (r === 'locked' || r === 'busy') return setTimeout(tick, 10000)
        const s2 = await ref.get()
        const d2 = s2.exists ? s2.data() : null
        if (!d2 || TERMINAL.has(d2.status)) return stop()
        const delay = Math.max(1000, Math.min(30000, new Date(d2.nextCheckAt || nowIso()).getTime() - Date.now()))
        setTimeout(tick, delay)
      } catch (e) {
        console.error('calls watch', ref.path, e.message)
        setTimeout(tick, 15000)
      }
    }
    setTimeout(tick, 6000)
  }

  // ---------- доступ ----------
  const staffOnly = async (req, res, next) => {
    const staff = await verifyFirebaseStaff(req, ['owner', 'director', 'master'])
    if (!staff) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника, директора або майстра' } })
    req.staff = staff
    next()
  }
  const anyStaff = async (req, res, next) => {
    const staff = await verifyFirebaseStaff(req)
    if (!staff) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для персоналу' } })
    req.staff = staff
    next()
  }
  const ownRequest = (staff, sr) => staff.role === 'owner' || (!!sr.serviceCenterId && staff.centers.some((c) => c && c.centerId === sr.serviceCenterId))
  const limiter = rateLimit({ name: 'binotel-originate', windowMs: 60 * 1000, max: 6, keyFn: (req) => req.staff.uid, message: 'Забагато дзвінків поспіль — зачекайте хвилину' })
  // Один дзвінок за раз на співробітника (на інстанс): запис ставиться ДО запиту в АТС (подвійний тап),
  // тримається поки документ не термінальний (факт — зі статусу), але не довше за граничну тривалість.
  const activeByUid = new Map() // uid → { ref|null, until }
  const activeCall = async (uid) => {
    const a = activeByUid.get(uid)
    if (!a) return false
    if (a.until <= Date.now()) { activeByUid.delete(uid); return false }
    if (!a.ref) return true // ще чекаємо відповіді АТС
    const s = await a.ref.get().catch(() => null)
    const st = s && s.exists ? s.data().status : null
    if (!st || TERMINAL.has(st)) { activeByUid.delete(uid); return false }
    return true
  }

  // ---------- POST /api/calls/originate { serviceRequestId } ----------
  if (configured) app.post('/api/calls/originate', staffOnly, limiter, async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    const staff = req.staff
    let reserved = false
    try {
      const srId = String(req.body?.serviceRequestId || '').trim()
      if (!srId || !ID_RE.test(srId)) return res.status(400).json({ success: false, error: { code: 'NEED_REQUEST', message: 'Потрібна заявка' } })
      const [srSnap, userSnap] = await Promise.all([
        adminDb.collection('serviceRequests').doc(srId).get(),
        adminDb.collection('users').doc(staff.uid).get(),
      ])
      const sr = srSnap.exists ? srSnap.data() : null
      if (!sr) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
      if (!ownRequest(staff, sr)) return res.status(403).json({ success: false, error: { code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' } })
      const clientNat = toNational(sr.clientPhone)
      if (!clientNat) return res.status(400).json({ success: false, error: { code: 'NO_CLIENT_PHONE', message: 'У заявці немає телефону клієнта' } })
      const u = userSnap.exists ? userSnap.data() : {}
      const line = String(u.pbxLine || '').replace(/\D/g, '').slice(0, 4)
      const staffNat = toNational(u.pbxPhone || u.fmcPhone)
      if (!line && !staffNat) return res.status(400).json({ success: false, error: { code: 'NO_STAFF_PHONE', message: 'Вкажіть у профілі свій номер телефону для дзвінків через АТС' } })
      if (!line && staffNat === clientNat) return res.status(400).json({ success: false, error: { code: 'SAME_PHONE', message: 'Номер клієнта збігається з вашим' } })
      if (await activeCall(staff.uid)) return res.status(409).json({ success: false, error: { code: 'CALL_IN_PROGRESS', message: 'Попередній дзвінок ще триває' } })
      activeByUid.set(staff.uid, { ref: null, until: Date.now() + 30000 }) // резерв на час запиту в АТС
      reserved = true

      const method = line ? 'int2ext' : 'ext2ext'
      const body = line
        ? { internalNumber: line, externalNumber: clientNat, pbxNumber: PBX_NUMBER, limitCallTime: LIMIT_CALL_SEC, playbackWaiting: PLAYBACK_WAITING, callTimeToExt: CALL_TIME_TO_EXT }
        : { externalNumber1: staffNat, externalNumber2: clientNat, pbxNumber: PBX_NUMBER, limitCallTime: LIMIT_CALL_SEC, playbackWaiting: PLAYBACK_WAITING }
      let r
      try {
        r = await binotel(line ? 'calls/internal-number-to-external-number' : 'calls/external-number-to-external-number', body, { priority: 10 })
      } catch (e) {
        activeByUid.delete(staff.uid); reserved = false
        console.warn('binotel originate:', e.code, e.message)
        if (e.code === '106') return res.status(429).json({ success: false, error: { code: 'PBX_BUSY', message: 'АТС зайнята, спробуйте за кілька секунд' } })
        if (e.binotel) return res.status(502).json({ success: false, error: { code: 'PBX_REJECTED', message: 'АТС відхилила дзвінок (перевірте номери та лінію)' } })
        return res.status(502).json({ success: false, error: { code: 'PBX_UNREACHABLE', message: 'АТС Binotel не відповідає' } })
      }
      const generalCallID = String(r.generalCallID || r.callID || '')
      if (!generalCallID) { activeByUid.delete(staff.uid); return res.status(502).json({ success: false, error: { code: 'PBX_NO_ID', message: 'АТС не повернула ідентифікатор дзвінка' } }) }

      const callId = callIdOf(generalCallID)
      const ref = col(srId).doc(callId)
      const doc = {
        id: callId, provider: 'binotel', method, generalCallID, pbxNumber: PBX_NUMBER,
        serviceRequestId: srId, serviceCenterId: sr.serviceCenterId || null, clientPhone: normPhone(sr.clientPhone), clientNat, clientName: sr.clientName || null,
        employeeUid: staff.uid, employeeRole: staff.role, employeeEmail: staff.email || null, employeeName: u.displayName || null,
        employeePhone: line ? null : '+380' + staffNat.slice(1), employeeLine: line || null,
        direction: 'outbound', status: 'dialing', statusAt: nowIso(), createdAt: nowIso(),
        startedAt: null, answeredAt: null, finishedAt: null, durationSec: null, waitSec: null, disposition: null, failedParty: null, legs: [],
        recordingStatus: '', recording: null, transcript: null, summary: null, cost: null, error: null,
        nextCheckAt: addSec(6), checks: 0, attempts: 0, lockUntil: null, lockToken: null, updatedAt: nowIso(),
      }
      try {
        await ref.set(doc)
      } catch (e) {
        // АТС уже дзвонить, а сліду в базі немає — краще покласти дзвінок, ніж лишити його безхазяйним.
        console.error('calls/originate: doc write failed, hanging up', generalCallID, e.message)
        binotel('calls/hangup-call', { generalCallID }, { priority: 10 }).catch(() => {})
        activeByUid.delete(staff.uid)
        return res.status(500).json({ success: false, error: { code: 'ORIGINATE_FAILED', message: 'Не вдалося зберегти дзвінок, його скасовано' } })
      }
      activeByUid.set(staff.uid, { ref, until: Date.now() + (LIMIT_CALL_SEC + 120) * 1000 })
      watch(ref)
      // Слід у журналі дзвінків портала (операторська дошка бачить callEvents) — без e-mail співробітника.
      adminDb.collection('callEvents').doc(callId).set({
        callId, sourceCallId: generalCallID, source: 'binotel-originate', kind: 'originate', phone: doc.clientPhone,
        clientName: doc.clientName, employee: doc.employeeName || 'співробітник', employeeId: staff.uid, serviceRequestId: srId,
        direction: 'outbound', at: nowIso(), lastType: 'call.originate', updatedAt: nowIso(),
      }, { merge: true }).catch(() => {})
      return res.json({ success: true, data: { callId, serviceRequestId: srId, provider: 'binotel', method, status: 'dialing', employeePhone: doc.employeePhone, employeeLine: doc.employeeLine, clientPhone: doc.clientPhone } })
    } catch (e) {
      if (reserved) activeByUid.delete(staff.uid)
      console.error('calls/originate:', e.message)
      res.status(500).json({ success: false, error: { code: 'ORIGINATE_FAILED', message: 'Не вдалося ініціювати дзвінок' } })
    }
  })

  // ---------- GET /api/calls/:srId/:callId/recording — mp3 для «прослухати» (з Range для iOS/AVPlayer) ----------
  app.get('/api/calls/:srId/:callId/recording', anyStaff, async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const { srId, callId } = req.params
      if (!ID_RE.test(srId) || !/^[\w-]{1,64}$/.test(callId)) return res.status(400).json({ success: false })
      const [srSnap, snap] = await Promise.all([adminDb.collection('serviceRequests').doc(srId).get(), col(srId).doc(callId).get()])
      if (!srSnap.exists || !snap.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Запис не знайдено' } })
      if (!ownRequest(req.staff, srSnap.data()) && req.staff.role !== 'accountant') return res.status(403).json({ success: false, error: { code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' } })
      const d = snap.data()
      if (!d.recording?.path) return res.status(404).json({ success: false, error: { code: 'NO_RECORDING', message: 'Запис ще не готовий' } })
      const file = getStorage().bucket(d.recording.bucket || BUCKET).file(d.recording.path)
      let size = Number(d.recording.bytes || 0)
      if (!size) { const [meta] = await file.getMetadata(); size = Number(meta.size || 0) }
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Disposition', `inline; filename="${callId}.mp3"`)
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') || '')
      let opts = {}
      if (m && size) {
        let start = m[1] ? Number(m[1]) : null
        let end = m[2] ? Number(m[2]) : null
        if (start === null) { start = Math.max(0, size - (end || 0)); end = size - 1 } // suffix: bytes=-N
        else if (end === null || end >= size) end = size - 1
        if (start >= size || start > end) { res.setHeader('Content-Range', `bytes */${size}`); return res.status(416).end() }
        res.status(206)
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        res.setHeader('Content-Length', String(end - start + 1))
        opts = { start, end }
      } else if (size) {
        res.setHeader('Content-Length', String(size))
      }
      if (req.method === 'HEAD') return res.end()
      file.createReadStream(opts).on('error', (e) => { console.error('recording stream:', e.message); if (!res.headersSent) res.status(500).end(); else res.end() }).pipe(res)
    } catch (e) {
      console.error('calls/recording:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // ---------- POST /api/calls/reconcile — Cloud Scheduler / власник: добрати незавершені ----------
  // Обмежено часом (щоб не впертися в дедлайн планувальника) і паралельністю 3; наступний запуск добере решту.
  const reconcile = async ({ limit = 20, budgetMs = 120000, concurrency = 3 } = {}) => {
    const q = await adminDb.collectionGroup('calls').where('nextCheckAt', '<=', nowIso()).orderBy('nextCheckAt').limit(limit).get()
    const stats = { scanned: q.size, processed: 0, skipped: 0, deferred: 0 }
    const docs = q.docs.filter((doc) => doc.data().provider === 'binotel')
    const deadline = Date.now() + budgetMs
    let i = 0
    const worker = async () => {
      while (i < docs.length) {
        const doc = docs[i++]
        if (Date.now() > deadline) { stats.deferred++; continue }
        const r = await processOnce(doc.ref).catch((e) => { console.error('reconcile', doc.ref.path, e.message); return 'skip' })
        if (r === 'done') stats.processed++; else stats.skipped++
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, docs.length || 1) }, worker))
    return stats
  }
  app.post('/api/calls/reconcile', async (req, res) => {
    const ok = (ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN) || (await verifyFirebaseAdmin(req))
    if (!ok) return res.status(403).json({ success: false })
    if (!adminDb || !configured) return res.status(503).json({ success: false })
    try {
      res.json({ success: true, data: await reconcile() })
    } catch (e) {
      console.error('calls/reconcile:', e.message)
      res.status(500).json({ success: false, error: { code: 'RECONCILE_FAILED', message: 'Не вдалося виконати reconcile' } })
    }
  })

  // ---------- POST /api/calls/:srId/:callId/retry — власник: повторити крок після помилки ----------
  app.post('/api/calls/:srId/:callId/retry', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) return res.status(403).json({ success: false })
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const { srId, callId } = req.params
      if (!ID_RE.test(srId) || !/^[\w-]{1,64}$/.test(callId)) return res.status(400).json({ success: false })
      const ref = col(srId).doc(callId)
      const s = await ref.get()
      if (!s.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Дзвінок не знайдено' } })
      const d = s.data()
      if (TERMINAL.has(d.status) && !RETRYABLE.has(d.status)) {
        return res.status(409).json({ success: false, error: { code: 'NOT_RETRYABLE', message: `Дзвінок зі статусом «${d.status}» повторити не можна` } })
      }
      // Повертаємо на крок, з якого можна продовжити: що вже є — те не переробляємо; якщо стан у АТС так і не
      // визначено (помилка на кроці dialing) — починаємо з опитування стану.
      let resume = d.status
      if (RETRYABLE.has(d.status)) {
        const talked = SUCCESS_DISPOSITIONS.has(String(d.disposition || '')) && Number(d.durationSec || 0) > 0
        resume = d.transcript ? 'transcribed' : d.recording ? 'recorded' : talked ? 'finished' : 'dialing'
      }
      await patch(ref, { status: resume, statusAt: nowIso(), attempts: 0, error: null, lastError: null, skipReason: null, lockUntil: null, lockToken: null, nextCheckAt: nowIso() })
      watch(ref)
      res.json({ success: true, data: { status: resume } })
    } catch (e) {
      console.error('calls/retry:', e.message)
      res.status(500).json({ success: false, error: { code: 'RETRY_FAILED', message: 'Не вдалося повторити обробку' } })
    }
  })

  return { reconcile, processOnce }
}

export default registerBinotelCalls
