// Голосова надиктовка з застосунку сервісу «RunFerry Сервіс» (рівень 2: запис на телефоні → наш
// сервер → хмарна розшифровка → текст у поле → далі існуючий /api/ai/improve-text, який НЕ чіпаємо).
//
//   POST /api/ai/transcribe?context=diagnostics|prompt|notify|note&serviceRequestId=…&lang=uk,ru&duration=12.3
//     Authorization: Bearer <Firebase ID-token співробітника>; тіло — сирий аудіофайл
//     (Content-Type audio/mp4 | audio/x-m4a | audio/wav | audio/webm | audio/ogg | audio/mpeg …),
//     ≤ 10 МБ і ≤ 180 с (тривалість читаємо з заголовка m4a/wav, інакше — з ?duration).
//     → { success, data: { text, lang, langProbability, durationSec, engine, elapsedMs, costUsd } }
//   Помилки (укр.): NO_AUDIO 400, UNSUPPORTED_TYPE 415, TOO_LARGE 413, TOO_LONG 400, EMPTY_TRANSCRIPT 422,
//     STT_* (див. stt.js) 422/429/502/503/504, RATE_LIMITED 429 (20/хв і 300/добу на співробітника).
//   Той самий маршрут потім бере Telegram-бот співробітників для голосових повідомлень.
//
// Тіло розбирає ОКРЕМИЙ express.raw на маршруті (глобальний express.json обмежений 100 КБ і аудіо не
// чіпає). Журнал витрат — колекція aiUsageLog (kind: 'stt') + рядок у логах Cloud Run.
import express from 'express'
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'
import { SttError, normalizeKeyterms, sttConfigured, sttEngineName, transcribeAudio } from './stt.js'

export const STT_MAX_BYTES = 10 * 1024 * 1024
export const STT_MAX_SEC = Number(process.env.STT_MAX_SEC || 180)
const CONTEXTS = new Set(['diagnostics', 'prompt', 'notify', 'note'])
const AUDIO_TYPES = ['audio/*', 'video/mp4', 'video/webm', 'application/octet-stream']

// Підказка словника: бренд, моделі корабликів, вузли, терміни сервісу (+ STT_KEYTERMS з env, + модель
// кораблика із заявки). Scribe v2 без цього пише «Runserio» замість Runferry.
export const BASE_KEYTERMS = [
  'RunFerry', 'Runferry', 'Ранферрі', 'кораблик', 'прикормочний кораблик', 'ехолот', 'Toslon', 'FlySky',
  'GPS', 'автопілот', 'акумулятор', 'бункер', 'гвинт', 'редуктор', 'регулятор', 'пульт', 'антена', 'плата',
  'Solo', 'Solo V2', 'Solo V3', 'R1', 'R3', 'RS', 'RM', 'Нова Пошта', 'ТТН', 'діагностика', 'запчастини',
  'кошторис', 'герметичність', 'прошивка', 'Bluetooth', 'Wi-Fi',
]
const ENV_KEYTERMS = String(process.env.STT_KEYTERMS || '').split(',').map((s) => s.trim()).filter(Boolean)

// ---------- тривалість без декодера: заголовки MP4 (m4a з iOS/Android) і WAV ----------
export const probeMp4DurationSec = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null
  const len = buf.length
  const readBox = (off, end) => {
    if (off + 8 > end) return null
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let hdr = 8
    if (size === 1) {
      if (off + 16 > end) return null
      size = Number(buf.readBigUInt64BE(off + 8))
      hdr = 16
    } else if (size === 0) size = end - off
    if (size < hdr) return null
    return { off, type, size, hdr }
  }
  const find = (type, off, end) => {
    while (off + 8 <= end) {
      const b = readBox(off, end)
      if (!b) return null
      if (b.type === type) return b
      off += b.size
    }
    return null
  }
  const first = readBox(0, len)
  if (!first || !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(first.type)) return null
  const moov = find('moov', 0, len)
  if (!moov) return null
  const mvhd = find('mvhd', moov.off + moov.hdr, Math.min(len, moov.off + moov.size))
  if (!mvhd) return null
  const p = mvhd.off + mvhd.hdr
  const version = buf[p]
  if (version === 1) {
    if (p + 32 > len) return null
    const ts = buf.readUInt32BE(p + 20)
    const d = Number(buf.readBigUInt64BE(p + 24))
    return ts ? d / ts : null
  }
  if (p + 20 > len) return null
  const ts = buf.readUInt32BE(p + 12)
  const d = buf.readUInt32BE(p + 16)
  return ts ? d / ts : null
}

export const probeWavDurationSec = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null
  let off = 12
  let byteRate = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16)
    if (id === 'data') return byteRate ? size / byteRate : null
    off += 8 + size + (size % 2)
  }
  return null
}

export const probeAudioDurationSec = (buf) => probeMp4DurationSec(buf) ?? probeWavDurationSec(buf)

const err = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra } })

export function registerVoiceTranscribe(app, deps = {}) {
  const {
    adminDb = null,
    verifyStaff = verifyFirebaseStaff,
    transcribe = transcribeAudio,
    isConfigured = sttConfigured,
    engineName = sttEngineName,
    maxBytes = STT_MAX_BYTES,
    maxSec = STT_MAX_SEC,
    perMinute = 20,
    perDay = 300,
    timeoutMs = 120000,
    usageCollection = 'aiUsageLog',
  } = deps

  const staffOnly = async (req, res, next) => {
    const staff = await verifyStaff(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для співробітників сервісу')
    req.staff = staff
    next()
  }
  const minuteLimiter = rateLimit({
    name: 'stt-min', windowMs: 60 * 1000, max: perMinute, keyFn: (req) => req.staff.uid,
    message: 'Забагато записів поспіль — зачекайте хвилину',
  })
  // Добова квота — власний лічильник: спільний чистильник rateLimit.js викидає позначки старші за годину.
  const daily = new Map() // uid → { day, count }
  const dayKey = () => new Date().toISOString().slice(0, 10)
  const dailyLimiter = (req, res, next) => {
    const uid = req.staff.uid
    const today = dayKey()
    const cur = daily.get(uid)
    const count = cur && cur.day === today ? cur.count : 0
    if (count >= perDay) {
      res.setHeader('Retry-After', String(3600))
      return err(res, 429, 'RATE_LIMITED', 'Денний ліміт розпізнавання вичерпано — спробуйте завтра')
    }
    daily.set(uid, { day: today, count: count + 1 })
    next()
  }
  setInterval(() => { const t = dayKey(); for (const [k, v] of daily) if (v.day !== t) daily.delete(k) }, 60 * 60 * 1000).unref?.()

  const audioBody = express.raw({ type: AUDIO_TYPES, limit: maxBytes })
  const bodyErrors = (e, _req, res, next) => {
    if (!e) return next()
    if (e.type === 'entity.too.large' || e.status === 413) return err(res, 413, 'TOO_LARGE', `Запис завеликий (максимум ${Math.round(maxBytes / 1024 / 1024)} МБ)`)
    return err(res, 400, 'BAD_BODY', 'Не вдалося прочитати аудіо')
  }

  const logUsage = (req, data) => {
    const line = `stt ${data.ok ? 'ok' : 'fail'} uid=${req.staff?.uid} ctx=${data.context} ${data.durationSec ?? '?'}s ${data.bytes}B ${data.elapsedMs}ms ${data.engine} lang=${data.lang ?? '-'} cost=$${data.costUsd ?? 0}${data.errorCode ? ' err=' + data.errorCode : ''}`
    console.log(line)
    if (!adminDb) return
    adminDb.collection(usageCollection).add({
      kind: 'stt', route: '/api/ai/transcribe', at: new Date().toISOString(),
      uid: req.staff?.uid || null, email: req.staff?.email || null, role: req.staff?.role || null,
      ...data,
    }).catch((e) => console.warn('stt usage log:', e.message))
  }

  app.post('/api/ai/transcribe', staffOnly, minuteLimiter, dailyLimiter, audioBody, bodyErrors, async (req, res) => {
    if (!isConfigured()) return err(res, 503, 'STT_NOT_CONFIGURED', 'Розпізнавання мовлення не налаштоване на сервері')
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const buf = Buffer.isBuffer(req.body) ? req.body : null
    if (!buf) return err(res, 415, 'UNSUPPORTED_TYPE', 'Надішліть аудіофайл (Content-Type audio/…)')
    if (!buf.length) return err(res, 400, 'NO_AUDIO', 'Порожній запис')
    const q = req.query || {}
    const context = CONTEXTS.has(String(q.context)) ? String(q.context) : 'generic'
    const languages = String(q.lang || 'uk,ru').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z]{2,3}$/.test(s))
    const declared = Number(q.duration)
    const declaredSec = Number.isFinite(declared) && declared > 0 ? declared : null
    const probedSec = probeAudioDurationSec(buf)
    const durationHint = probedSec ?? declaredSec
    if (durationHint !== null && durationHint > maxSec + 1) {
      return err(res, 400, 'TOO_LONG', `Запис задовгий (максимум ${maxSec} с) — розбийте на частини`, { durationSec: Math.round(durationHint) })
    }
    const srId = String(q.serviceRequestId || '').trim()
    const keyterms = [...BASE_KEYTERMS, ...ENV_KEYTERMS]
    if (adminDb && /^[\w-]{1,128}$/.test(srId)) {
      try {
        const s = await adminDb.collection('serviceRequests').doc(srId).get()
        const boat = s.exists ? String(s.data()?.boat || '').trim() : ''
        if (boat) keyterms.push(boat)
      } catch (e) { console.warn('stt keyterms sr:', e.message) }
    }
    const ext = mime.includes('wav') ? 'wav' : mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : 'm4a'
    const t0 = Date.now()
    let r
    try {
      r = await transcribe(buf, {
        mime: mime || 'application/octet-stream', filename: `dictation.${ext}`, languages,
        keyterms: normalizeKeyterms(keyterms), verbatim: false, timeoutMs,
      })
    } catch (e) {
      const code = e instanceof SttError ? e.code : 'STT_FAILED'
      const status = e instanceof SttError ? e.status : 502
      const message = e instanceof SttError ? e.message : 'Не вдалося розпізнати запис'
      console.error('stt transcribe:', code, e?.detail || e?.message || e)
      logUsage(req, { ok: false, context, serviceRequestId: srId || null, mime, bytes: buf.length, durationSec: durationHint, declaredSec, engine: engineName(), elapsedMs: Date.now() - t0, errorCode: code })
      return err(res, status, code, message)
    }
    const text = String(r.text || '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    const data = {
      text, lang: r.lang ?? null, langProbability: r.langProbability ?? null,
      durationSec: Math.round((r.durationSec || durationHint || 0) * 10) / 10,
      engine: r.engine, elapsedMs: Date.now() - t0, costUsd: r.costUsd ?? null,
    }
    logUsage(req, {
      ok: !!text, context, serviceRequestId: srId || null, mime, bytes: buf.length, durationSec: data.durationSec, declaredSec,
      engine: data.engine, lang: data.lang, langProbability: data.langProbability, textChars: text.length,
      keyterms: r.keytermsUsed ?? null, costUsd: data.costUsd, elapsedMs: data.elapsedMs, errorCode: text ? null : 'EMPTY_TRANSCRIPT',
    })
    if (!text) return err(res, 422, 'EMPTY_TRANSCRIPT', 'Нічого не розпізнано: запис порожній або надто тихий — спробуйте ближче до мікрофона', { durationSec: data.durationSec })
    return res.json({ success: true, data })
  })
}

export default registerVoiceTranscribe
