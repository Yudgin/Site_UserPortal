// node --test (вбудований раннер Node ≥ 20): чисті функції stt.js/voiceTranscribe.js і сам маршрут
// /api/ai/transcribe з підмінами перевірки співробітника та рушія розшифровки (без мережі).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { normalizeKeyterms, shortLang, SttError } from './stt.js'
import { probeMp4DurationSec, probeWavDurationSec, registerVoiceTranscribe, BASE_KEYTERMS } from './voiceTranscribe.js'

// ---------- синтетичні файли ----------
const box = (type, payload) => {
  const b = Buffer.alloc(8 + payload.length)
  b.writeUInt32BE(8 + payload.length, 0)
  b.write(type, 4, 'latin1')
  payload.copy(b, 8)
  return b
}
const mp4 = (seconds, { version = 0, mdatBytes = 64 } = {}) => {
  const timescale = 1000
  let mvhdBody
  if (version === 1) {
    mvhdBody = Buffer.alloc(4 + 8 + 8 + 4 + 8 + 80)
    mvhdBody[0] = 1
    mvhdBody.writeUInt32BE(timescale, 20)
    mvhdBody.writeBigUInt64BE(BigInt(Math.round(seconds * timescale)), 24)
  } else {
    mvhdBody = Buffer.alloc(4 + 4 + 4 + 4 + 4 + 80)
    mvhdBody.writeUInt32BE(timescale, 12)
    mvhdBody.writeUInt32BE(Math.round(seconds * timescale), 16)
  }
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42isom', 'latin1'))
  const mdat = box('mdat', Buffer.alloc(mdatBytes, 7))
  const moov = box('moov', Buffer.concat([box('mvhd', mvhdBody), box('trak', Buffer.alloc(16))]))
  return Buffer.concat([ftyp, mdat, moov]) // як пише iOS: moov у кінці
}
const wav = (seconds, { sampleRate = 16000, channels = 1 } = {}) => {
  const byteRate = sampleRate * channels * 2
  const dataSize = Math.round(seconds * byteRate)
  const b = Buffer.alloc(44 + dataSize)
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'latin1')
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(byteRate, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'latin1'); b.writeUInt32LE(dataSize, 40)
  return b
}

test('probeMp4DurationSec reads mvhd v0 and v1, moov after mdat', () => {
  assert.equal(probeMp4DurationSec(mp4(12.345)), 12.345)
  assert.equal(probeMp4DurationSec(mp4(200, { version: 1 })), 200)
  assert.equal(probeMp4DurationSec(Buffer.from('not an mp4 file at all, really')), null)
  assert.equal(probeMp4DurationSec(mp4(5).subarray(0, 40)), null)
  assert.equal(probeMp4DurationSec(Buffer.alloc(4)), null)
})

test('probeWavDurationSec uses fmt byteRate and data size', () => {
  assert.equal(probeWavDurationSec(wav(3)), 3)
  assert.equal(probeWavDurationSec(wav(1.5, { sampleRate: 44100, channels: 2 })), 1.5)
  assert.equal(probeWavDurationSec(mp4(3)), null)
})

test('normalizeKeyterms dedupes, strips forbidden chars, drops long terms', () => {
  const out = normalizeKeyterms(['RunFerry', 'runferry', ' Solo <V3> ', 'a'.repeat(50), 'один два три чотири пять шість', '', null, 'ехолот'])
  assert.deepEqual(out, ['RunFerry', 'Solo V3', 'ехолот'])
  assert.equal(normalizeKeyterms(Array.from({ length: 500 }, (_, i) => `t${i}`), { max: 10 }).length, 10)
  assert.ok(BASE_KEYTERMS.includes('RunFerry'))
})

test('shortLang maps ISO-639-3 to 639-1', () => {
  assert.equal(shortLang('ukr'), 'uk')
  assert.equal(shortLang('rus'), 'ru')
  assert.equal(shortLang('uk'), 'uk')
  assert.equal(shortLang(''), null)
  assert.equal(shortLang('xyz'), 'xyz')
})

// ---------- маршрут ----------
// Лімітери rateLimit.js живуть у спільній Map процесу — кожному тестовому застосунку свій uid.
let uidSeq = 0
const startApp = async (opts = {}) => {
  const app = express()
  const calls = []
  const uid = `u${++uidSeq}`
  const staff = opts.staff === undefined ? { uid, email: 'm@runferry.test', role: 'master', centers: [] } : opts.staff
  const usage = []
  const adminDb = {
    collection: (name) => ({
      add: async (doc) => { usage.push({ name, doc }); return { id: 'x' } },
      doc: () => ({ get: async () => ({ exists: true, data: () => ({ boat: 'Solo V3' }) }) }),
    }),
  }
  registerVoiceTranscribe(app, {
    adminDb,
    verifyStaff: async () => staff,
    transcribe: opts.transcribe || (async (buf, o) => { calls.push({ bytes: buf.length, ...o }); return { engine: 'fake/stt', text: 'Привіт, світ', lang: 'uk', langProbability: 0.9, durationSec: 2.5, costUsd: 0.0002, keytermsUsed: o.keyterms.length } }),
    isConfigured: () => opts.configured ?? true,
    engineName: () => 'fake/stt',
    maxBytes: opts.maxBytes ?? 1024 * 1024,
    maxSec: 180,
    perMinute: opts.perMinute ?? 20,
    perDay: opts.perDay ?? 300,
  })
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, { type = 'audio/mp4', query = '' } = {}) => fetch(`${base}/api/ai/transcribe${query}`, { method: 'POST', headers: { 'content-type': type }, body }).then(async (r) => ({ status: r.status, json: await r.json() }))
  return { post, calls, usage, close: () => new Promise((r) => server.close(r)) }
}

test('route: happy path returns text, passes context/keyterms/boat to the engine, logs usage', async () => {
  const t = await startApp()
  try {
    const r = await t.post(mp4(12), { query: '?context=diagnostics&serviceRequestId=sr-1&lang=uk,ru&duration=11.9' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.success, true)
    assert.deepEqual(Object.keys(r.json.data).sort(), ['costUsd', 'durationSec', 'elapsedMs', 'engine', 'lang', 'langProbability', 'text'])
    assert.equal(r.json.data.text, 'Привіт, світ')
    assert.equal(r.json.data.lang, 'uk')
    assert.equal(r.json.data.engine, 'fake/stt')
    assert.equal(t.calls.length, 1)
    assert.deepEqual(t.calls[0].languages, ['uk', 'ru'])
    assert.equal(t.calls[0].verbatim, false)
    assert.equal(t.calls[0].mime, 'audio/mp4')
    assert.ok(t.calls[0].keyterms.includes('RunFerry'))
    assert.ok(t.calls[0].keyterms.includes('Solo V3'))
    assert.equal(t.usage.length, 1)
    assert.equal(t.usage[0].name, 'aiUsageLog')
    assert.equal(t.usage[0].doc.kind, 'stt')
    assert.equal(t.usage[0].doc.uid, 'u1', 'перший застосунок у файлі')
    assert.equal(t.usage[0].doc.context, 'diagnostics')
    assert.equal(t.usage[0].doc.ok, true)
  } finally { await t.close() }
})

test('route: rejects without staff, without audio, with wrong type, too long, too large', async () => {
  const anon = await startApp({ staff: null })
  try {
    const r = await anon.post(mp4(3))
    assert.equal(r.status, 403)
    assert.equal(r.json.error.code, 'FORBIDDEN')
  } finally { await anon.close() }
  const t = await startApp()
  try {
    let r = await t.post(Buffer.alloc(0))
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'NO_AUDIO')
    r = await t.post(JSON.stringify({ a: 1 }), { type: 'application/json' })
    assert.equal(r.status, 415)
    assert.equal(r.json.error.code, 'UNSUPPORTED_TYPE')
    r = await t.post(mp4(181.5))
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'TOO_LONG')
    assert.equal(r.json.error.durationSec, 182)
    r = await t.post(Buffer.alloc(100), { type: 'audio/webm', query: '?duration=400' })
    assert.equal(r.status, 400, 'declared duration counts when the header cannot be read')
    assert.equal(r.json.error.code, 'TOO_LONG')
    r = await t.post(Buffer.alloc(2 * 1024 * 1024), { type: 'audio/mp4' })
    assert.equal(r.status, 413)
    assert.equal(r.json.error.code, 'TOO_LARGE')
    assert.match(r.json.error.message, /МБ/)
    assert.equal(t.calls.length, 0, 'engine is never called for rejected requests')
  } finally { await t.close() }
})

test('route: empty transcript → 422, engine errors keep their code and status, not configured → 503', async () => {
  const empty = await startApp({ transcribe: async () => ({ engine: 'fake/stt', text: '  ', durationSec: 1 }) })
  try {
    const r = await empty.post(mp4(2))
    assert.equal(r.status, 422)
    assert.equal(r.json.error.code, 'EMPTY_TRANSCRIPT')
    assert.equal(empty.usage[0].doc.ok, false)
  } finally { await empty.close() }
  const timeout = await startApp({ transcribe: async () => { throw new SttError('STT_TIMEOUT', 'Розпізнавання триває надто довго', { status: 504 }) } })
  try {
    const r = await timeout.post(mp4(2))
    assert.equal(r.status, 504)
    assert.equal(r.json.error.code, 'STT_TIMEOUT')
    assert.match(r.json.error.message, /надто довго/)
    assert.equal(timeout.usage[0].doc.errorCode, 'STT_TIMEOUT')
  } finally { await timeout.close() }
  const boom = await startApp({ transcribe: async () => { throw new Error('socket hang up') } })
  try {
    const r = await boom.post(mp4(2))
    assert.equal(r.status, 502)
    assert.equal(r.json.error.code, 'STT_FAILED')
  } finally { await boom.close() }
  const off = await startApp({ configured: false })
  try {
    const r = await off.post(mp4(2))
    assert.equal(r.status, 503)
    assert.equal(r.json.error.code, 'STT_NOT_CONFIGURED')
  } finally { await off.close() }
})

test('route: per-minute and per-day limits are per staff uid', async () => {
  const t = await startApp({ perMinute: 2 })
  try {
    assert.equal((await t.post(mp4(1))).status, 200)
    assert.equal((await t.post(mp4(1))).status, 200)
    const r = await t.post(mp4(1))
    assert.equal(r.status, 429)
    assert.equal(r.json.error.code, 'RATE_LIMITED')
    assert.match(r.json.error.message, /хвилину/)
  } finally { await t.close() }
  const d = await startApp({ perDay: 1 })
  try {
    assert.equal((await d.post(mp4(1))).status, 200)
    const r = await d.post(mp4(1))
    assert.equal(r.status, 429)
    assert.match(r.json.error.message, /Денний ліміт/)
  } finally { await d.close() }
})
