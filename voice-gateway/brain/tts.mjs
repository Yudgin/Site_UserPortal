// Синтез картки ElevenLabs → WAV PCM 16 біт, моно, 8 кГц (формат, який грає рушій і приймає Binotel у G.711).
// Відповідь pcm_8000 — сирі семпли, загортаємо їх у заголовок WAV. Кеш на диску за sha1(тексту): та сама картка
// (той самий клієнт, та сама заявка) вдруге не синтезується. Ключ API — з Secret Manager, у логи не потрапляє.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const VOICE_SETTINGS = { stability: 0.55, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.0 }
const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech'
const RATE = 8000
const MIN_PCM_BYTES = RATE * 2 * 0.2 // < 0,2 с — це не мова, а збій

export const sha1 = (s) => createHash('sha1').update(String(s), 'utf8').digest('hex')

// Заголовок WAV (44 байти) + PCM 16 біт LE.
export function wavFromPcm16(pcm, rate = RATE, channels = 1) {
  const data = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

// Формат WAV-файлу з диска: {format, channels, rate, bits} або null, якщо це не RIFF/WAVE. Чанки йдуть у будь-якому
// порядку (LIST перед data тощо) — шукаємо 'fmt '.
export function readWavInfo(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 24 <= buf.length) {
      return { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    }
    off += 8 + size + (size % 2)
  }
  return null
}
export const isTelephonyWav = (info) => !!info && info.format === 1 && info.channels === 1 && info.rate === RATE && info.bits === 16

// getApiKey — async () => ключ (кешує той, хто передає). Повертає async (text) => {file, cached}; помилка — виняток
// (сценарій тоді бере genericCardFile або обходиться без картки).
export function makeTts({ cacheDir, getApiKey, voiceId, model, timeoutMs = 6000, fetchImpl = globalThis.fetch, now = Date.now }) {
  const inflight = new Map()

  async function synth(text, file) {
    const deadline = now() + timeoutMs
    const key = await getApiKey()
    const url = `${ENDPOINT}/${encodeURIComponent(voiceId)}?output_format=pcm_8000`
    const call = (withLang) => {
      const left = deadline - now()
      if (left <= 0) throw new Error('tts timeout')
      const body = { text, model_id: model, voice_settings: VOICE_SETTINGS, ...(withLang ? { language_code: 'uk' } : {}) }
      return fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(left),
      })
    }
    let r = await call(true)
    // Модель може не приймати language_code — повторюємо без нього
    if (r.status === 400 || r.status === 422) r = await call(false)
    if (!r.ok) {
      let detail = ''
      try { detail = String((await r.json())?.detail?.status || '').slice(0, 40) } catch { /* тіло не JSON */ }
      throw new Error(`tts HTTP ${r.status}${detail ? ` ${detail}` : ''}`)
    }
    const pcm = Buffer.from(await r.arrayBuffer())
    if (pcm.length < MIN_PCM_BYTES) throw new Error(`tts: замало аудіо (${pcm.length} Б)`)
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 }) // у картці ім'я клієнта голосом — лише власнику
    const tmp = `${file}.${process.pid}.${now()}.tmp`
    await fs.writeFile(tmp, wavFromPcm16(pcm), { mode: 0o600 })
    await fs.rename(tmp, file) // атомарно: рушій ніколи не побачить недописаний файл
    return { file, cached: false }
  }

  return async function tts(text) {
    const t = String(text ?? '').trim()
    if (!t) throw new Error('tts: порожній текст')
    const file = path.join(cacheDir, `card-${sha1(t)}.wav`)
    try {
      const st = await fs.stat(file)
      if (st.size > 44) return { file, cached: true }
    } catch { /* немає в кеші */ }
    if (inflight.has(file)) return inflight.get(file)
    const p = synth(t, file).finally(() => inflight.delete(file))
    inflight.set(file, p)
    return p
  }
}

export default makeTts
