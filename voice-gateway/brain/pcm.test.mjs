// Звук для ШІ: G.711 і ресемплер — точність кодування, частота тону після зміни частоти, потоковість, рівень.
import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeG711, decodeG711, Resampler, rms, tone, pcmMs } from './pcm.mjs'

// Потужність на частоті hz (Гьорцель) відносно загальної
function share(pcm, rate, hz) {
  const n = Math.floor(pcm.length / 2)
  const k = 2 * Math.cos((2 * Math.PI * hz) / rate)
  let s1 = 0, s2 = 0, e = 0
  for (let i = 0; i < n; i++) {
    const x = pcm.readInt16LE(i * 2)
    e += x * x
    const s0 = x + k * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n / 2) / (e / n)
}

test('G.711: μ-law і A-law — кодування й декодування з малою похибкою, знак і нуль', () => {
  const src = tone(8000, 0.1, 440, 12000)
  for (const law of ['ulaw', 'alaw']) {
    const enc = encodeG711(src, law)
    assert.equal(enc.length, src.length / 2)
    const dec = decodeG711(enc, law)
    let maxRel = 0
    for (let i = 0; i < src.length / 2; i++) {
      const a = src.readInt16LE(i * 2)
      const b = dec.readInt16LE(i * 2)
      if (Math.abs(a) > 500) maxRel = Math.max(maxRel, Math.abs(a - b) / Math.abs(a))
    }
    assert.ok(maxRel < 0.07, `${law}: відносна похибка ${maxRel}`)
  }
  // відомі значення μ-law: тиша → 0xFF, максимум → 0x80 / 0x00
  assert.equal(encodeG711(Buffer.from([0, 0]))[0], 0xff)
  const max = Buffer.alloc(2)
  max.writeInt16LE(32767)
  assert.equal(encodeG711(max)[0], 0x80)
  max.writeInt16LE(-32768)
  assert.equal(encodeG711(max)[0], 0x00)
  // A-law тиша: 0xD5
  assert.equal(encodeG711(Buffer.from([0, 0]), 'alaw')[0], 0xd5)
})

test('ресемплер: 8→24, 24→8, 8→16, 16→8, 24→16 — тон на місці, довжина відповідає частоті, рівень збережено', () => {
  for (const [from, to] of [[8000, 24000], [24000, 8000], [8000, 16000], [16000, 8000], [24000, 16000], [16000, 24000]]) {
    const src = tone(from, 1, 1000, 8000)
    const out = new Resampler(from, to).process(src)
    const n = out.length / 2
    assert.ok(Math.abs(n - to) <= 2, `${from}→${to}: ${n} семплів`)
    const body = out.subarray(Math.floor(to * 0.05) * 2) // без початку (фільтр «розганяється»)
    assert.ok(share(body, to, 1000) > 0.95, `${from}→${to}: частка 1 кГц ${share(body, to, 1000)}`)
    const r = rms(body)
    assert.ok(Math.abs(r - 8000 / Math.SQRT2) < 300, `${from}→${to}: rms ${r}`)
  }
})

test('ресемплер: 24→8 гасить частоти вище 4 кГц (без накладання спектра)', () => {
  const src = tone(24000, 0.5, 6000, 8000) // 6 кГц: на 8 кГц мав би накластися як 2 кГц
  const out = new Resampler(24000, 8000).process(src)
  assert.ok(rms(out.subarray(400)) < 400, `рівень після фільтра ${rms(out)}`)
})

test('ресемплер потоковий: шматки довільної довжини дають той самий результат, що й один шматок', () => {
  const src = tone(8000, 0.5, 700, 9000)
  const whole = new Resampler(8000, 24000).process(src)
  const r = new Resampler(8000, 24000)
  const parts = []
  for (let i = 0, step = 37; i < src.length; i += step * 2, step = (step * 7) % 113 + 1) parts.push(r.process(src.subarray(i, i + step * 2)))
  assert.deepEqual(Buffer.concat(parts), whole)
  assert.equal(new Resampler(16000, 16000).process(src), src) // однакова частота — без змін
})

test('pcmMs і rms', () => {
  assert.equal(pcmMs(16000, 8000), 1000)
  assert.equal(pcmMs(960, 24000), 20)
  assert.equal(rms(Buffer.alloc(0)), 0)
})
