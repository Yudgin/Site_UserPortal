// Розшифровка мовлення (speech-to-text) за ЄДИНИМ інтерфейсом для всіх споживачів: надиктовка у
// застосунку сервісу (/api/ai/transcribe, voiceTranscribe.js), голосові повідомлення бота
// співробітників, записи дзвінків (binotelCalls.js може перейти сюди). Провайдер обирається env
// STT_PROVIDER (поки лише `elevenlabs` — Scribe v2); ключі — тільки в env / Secret Manager.
//
//   transcribeAudio(buffer, { mime, filename, languages, keyterms, multiChannel, verbatim, timeoutMs })
//     → { engine, text, lang, langRaw, langProbability, durationSec, words, transcripts, channels,
//         keytermsUsed, costUsd, elapsedMs, transcriptionId }
//   SttError { code, status, message (укр.), detail } — коди: STT_PROVIDER_UNKNOWN, STT_NOT_CONFIGURED,
//     STT_TIMEOUT, STT_UNREACHABLE, STT_AUTH, STT_RATE_LIMITED, STT_BAD_REQUEST, STT_UNAVAILABLE,
//     STT_BAD_RESPONSE.
//
// ElevenLabs Scribe v2 (перевірено на суржику 2026-10-14): мову визначає сам, language_code — лише
// ОДИН код, тому для підказки uk+ru його не передаємо (авто) — русизми зберігає дослівно; keyterms —
// повторюване поле форми (≤ 1000 термінів, < 50 символів, ≤ 5 слів, без <>{}[]\); тариф API $0,22/год
// + $0,05/год за keyterms, кожен канал multi-channel тарифікується окремо; no_verbatim прибирає
// «е-е», повтори (лише scribe_v2). Обробка в США — EU-резидентність тільки для Enterprise.

const ELEVEN_BASE = (process.env.ELEVENLABS_API_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '')
const ELEVEN_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v2'
export const ELEVEN_PRICE = { usdPerHour: 0.22, keytermsUsdPerHour: 0.05 }

export class SttError extends Error {
  constructor(code, message, { status = 502, detail = '' } = {}) {
    super(message)
    this.name = 'SttError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const round4 = (n) => Math.round(n * 10000) / 10000

// Terміни для підказки моделі: прибираємо заборонені символи, дублікати, задовгі/багатослівні.
const KEYTERM_FORBIDDEN = /[<>{}[\]\\]/g
export const normalizeKeyterms = (list, { max = 200 } = {}) => {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw ?? '').replace(KEYTERM_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim()
    if (!t || t.length >= 50 || t.split(' ').length > 5) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

// ISO-639-3 → 639-1 для відповіді клієнтам (ElevenLabs віддає 'ukr'/'rus', інколи вже 'uk').
const ISO3_TO_1 = { ukr: 'uk', rus: 'ru', eng: 'en', deu: 'de', ger: 'de', pol: 'pl', bel: 'be' }
export const shortLang = (code) => {
  const c = String(code || '').toLowerCase().trim()
  if (!c) return null
  return ISO3_TO_1[c] || (c.length === 2 ? c : c.slice(0, 3))
}

const lastWordEnd = (words) => {
  let end = 0
  for (const w of words) if (typeof w?.end === 'number' && w.end > end) end = w.end
  return end
}

const elevenlabs = {
  name: () => `elevenlabs/${ELEVEN_MODEL}`,
  configured: () => !!process.env.ELEVENLABS_API_KEY,
  async transcribe(buffer, opts = {}) {
    const {
      mime = 'application/octet-stream', filename = 'audio', languages = [], keyterms = [],
      multiChannel = false, verbatim = true, timeoutMs = 120000,
    } = opts
    const form = new FormData()
    form.append('model_id', ELEVEN_MODEL)
    form.append('file', new Blob([buffer], { type: mime }), filename)
    const langs = languages.map((l) => String(l || '').trim()).filter(Boolean)
    if (langs.length === 1) form.append('language_code', langs[0])
    form.append('tag_audio_events', 'false')
    if (multiChannel) {
      form.append('use_multi_channel', 'true')
      form.append('multichannel_output_style', 'combined')
      form.append('timestamps_granularity', 'word')
    }
    if (!verbatim) form.append('no_verbatim', 'true')
    const terms = normalizeKeyterms(keyterms)
    for (const k of terms) form.append('keyterms', k)

    const t0 = Date.now()
    let res
    let body
    try {
      res = await fetch(`${ELEVEN_BASE}/v1/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
      body = await res.text()
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new SttError('STT_TIMEOUT', 'Розпізнавання триває надто довго — спробуйте коротший запис', { status: 504 })
      }
      throw new SttError('STT_UNREACHABLE', 'Сервіс розпізнавання не відповідає', { status: 502, detail: String(e?.message || e) })
    }
    if (!res.ok) {
      const detail = String(body || '').slice(0, 300)
      if (res.status === 401 || res.status === 403) throw new SttError('STT_AUTH', 'Сервіс розпізнавання відхилив ключ доступу', { status: 502, detail })
      if (res.status === 400 || res.status === 422) throw new SttError('STT_BAD_REQUEST', 'Формат запису не підтримується або запис пошкоджено', { status: 422, detail })
      if (res.status === 429) throw new SttError('STT_RATE_LIMITED', 'Сервіс розпізнавання перевантажений — спробуйте за хвилину', { status: 429, detail })
      throw new SttError('STT_UNAVAILABLE', `Сервіс розпізнавання тимчасово недоступний (${res.status})`, { status: 502, detail })
    }
    let json
    try { json = JSON.parse(body) } catch {
      throw new SttError('STT_BAD_RESPONSE', 'Сервіс розпізнавання повернув незрозумілу відповідь', { status: 502, detail: String(body || '').slice(0, 200) })
    }
    // multi-channel `separate` → { transcripts: [...] }; `combined` і звичайний режим → один об'єкт.
    const transcripts = Array.isArray(json.transcripts) ? json.transcripts : null
    const primary = transcripts ? (transcripts[0] || {}) : json
    let words = Array.isArray(json.words) ? json.words : []
    if (transcripts) {
      words = transcripts.flatMap((t, i) => (t.words || []).map((w) => ({ ...w, channel_index: w.channel_index ?? t.channel_index ?? i })))
      words.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    }
    const text = transcripts ? transcripts.map((t) => String(t.text || '').trim()).filter(Boolean).join('\n') : String(json.text || '')
    const durationSec = Number(json.audio_duration_secs ?? primary.audio_duration_secs ?? lastWordEnd(words) ?? 0) || 0
    const channels = transcripts
      ? transcripts.length
      : (multiChannel ? Math.max(1, new Set(words.map((w) => w.channel_index ?? 0)).size) : 1)
    const costUsd = round4((durationSec / 3600) * channels * (ELEVEN_PRICE.usdPerHour + (terms.length ? ELEVEN_PRICE.keytermsUsdPerHour : 0)))
    const langRaw = primary.language_code ?? json.language_code ?? null
    return {
      engine: elevenlabs.name(),
      text: text.trim(),
      lang: shortLang(langRaw),
      langRaw,
      langProbability: typeof primary.language_probability === 'number' ? primary.language_probability : (json.language_probability ?? null),
      durationSec,
      words,
      transcripts,
      channels,
      keytermsUsed: terms.length,
      costUsd,
      elapsedMs: Date.now() - t0,
      transcriptionId: json.transcription_id || null,
    }
  },
}

const PROVIDERS = { elevenlabs }

export const sttProviderName = () => String(process.env.STT_PROVIDER || 'elevenlabs').trim().toLowerCase()
export const getSttProvider = () => PROVIDERS[sttProviderName()] || null
export const sttConfigured = () => { const p = getSttProvider(); return !!(p && p.configured()) }
export const sttEngineName = () => { const p = getSttProvider(); return p ? p.name() : sttProviderName() }

export async function transcribeAudio(buffer, opts = {}) {
  const p = getSttProvider()
  if (!p) throw new SttError('STT_PROVIDER_UNKNOWN', `Невідомий провайдер розпізнавання: ${sttProviderName()}`, { status: 503 })
  if (!p.configured()) throw new SttError('STT_NOT_CONFIGURED', 'Розпізнавання мовлення не налаштоване', { status: 503 })
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new SttError('STT_BAD_REQUEST', 'Порожній аудіофайл', { status: 400 })
  return p.transcribe(buffer, opts)
}

export default transcribeAudio
