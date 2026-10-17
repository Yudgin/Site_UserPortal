// Звук для ШІ-співрозмовника: PCM16LE моно ↔ G.711 (μ-law, A-law) і зміна частоти (8 ↔ 16 ↔ 24 кГц).
// Рушій віддає й приймає PCM16 на частоті порту (audio_start rate); голосові моделі хочуть свої формати: OpenAI —
// pcm16 24 кГц або G.711 8 кГц, Gemini Live — pcm16 16 кГц на вхід і 24 кГц на вихід, ElevenLabs — pcm 8/16 кГц або
// μ-law 8 кГц. Усе тут — чисті функції й потокові перетворювачі без залежностей.

// ---------- G.711 ----------

const BIAS = 0x84
const CLIP = 32635

function ulawByte(sample) {
  let s = sample
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exp = 7
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--
  const mant = (s >> (exp + 3)) & 0x0f
  return ~(sign | (exp << 4) | mant) & 0xff
}

function ulawSample(byte) {
  const u = ~byte & 0xff
  const sign = u & 0x80
  const exp = (u >> 4) & 0x07
  const mant = u & 0x0f
  const s = (((mant << 3) + BIAS) << exp) - BIAS
  return sign ? -s : s
}

function alawByte(sample) {
  let s = sample
  const sign = s >= 0 ? 0x80 : 0
  if (!sign) s = -s - 1
  if (s > 32767) s = 32767
  let out
  if (s < 256) out = s >> 4
  else {
    let exp = 1
    while (exp < 7 && s >= (256 << exp)) exp++
    out = (exp << 4) | ((s >> (exp + 3)) & 0x0f)
  }
  return (out | sign) ^ 0x55
}

function alawSample(byte) {
  const a = byte ^ 0x55
  const exp = (a >> 4) & 0x07
  const mant = a & 0x0f
  let s = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1)
  return a & 0x80 ? s : -s
}

const ULAW_DEC = Int16Array.from({ length: 256 }, (_, b) => ulawSample(b))
const ALAW_DEC = Int16Array.from({ length: 256 }, (_, b) => alawSample(b))

// PCM16LE Buffer → G.711 Buffer (байт на семпл)
export function encodeG711(pcm, law = 'ulaw') {
  const n = Math.floor(pcm.length / 2)
  const out = Buffer.alloc(n)
  const enc = law === 'alaw' ? alawByte : ulawByte
  for (let i = 0; i < n; i++) out[i] = enc(pcm.readInt16LE(i * 2))
  return out
}

// G.711 Buffer → PCM16LE Buffer
export function decodeG711(buf, law = 'ulaw') {
  const t = law === 'alaw' ? ALAW_DEC : ULAW_DEC
  const out = Buffer.alloc(buf.length * 2)
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(t[buf[i]], i * 2)
  return out
}

// ---------- зміна частоти ----------

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

// Потоковий раціональний ресемплер (поліфазний, вікно Блекмана): from → to, будь-які цілі частоти. Стан між
// шматками зберігається, тож потік можна різати як завгодно. taps — довжина фільтра на одну фазу (якість/затримка).
export class Resampler {
  constructor(from, to, { taps = 24 } = {}) {
    this.from = from
    this.to = to
    this.pass = from === to
    if (this.pass) return
    const g = gcd(from, to)
    this.L = to / g // інтерполяція
    this.M = from / g // децимація
    this.taps = taps
    const K = taps * this.L
    // Зріз — нижча з двох частот Найквіста, із запасом 0,9; нормовано до частоти після інтерполяції
    const fc = (0.5 / Math.max(this.L, this.M)) * 0.9
    const h = new Float64Array(K)
    const mid = (K - 1) / 2
    for (let k = 0; k < K; k++) {
      const x = k - mid
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (K - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (K - 1))
      h[k] = sinc * w * this.L
    }
    // Поліфазне розкладання: фаза p бере h[p], h[p+L], …
    this.phases = Array.from({ length: this.L }, (_, p) => Float64Array.from({ length: taps }, (_, j) => h[p + j * this.L] || 0))
    this.hist = new Float64Array(taps) // останні вхідні семпли (hist[0] — найсвіжіший)
    this.inCount = 0 // скільки вхідних семплів уже прийнято
    this.outPos = 0 // номер наступного вихідного семпла
  }

  // PCM16LE Buffer → PCM16LE Buffer
  process(pcm) {
    if (this.pass) return pcm
    const n = Math.floor(pcm.length / 2)
    const out = []
    const { L, M, taps } = this
    for (let i = 0; i < n; i++) {
      this.hist.copyWithin(1, 0, taps - 1)
      this.hist[0] = pcm.readInt16LE(i * 2)
      this.inCount++
      // вихідні семпли, для яких останній потрібний вхідний — цей: floor(outPos*M/L) === inCount-1
      for (;;) {
        const up = this.outPos * M
        const idx = Math.floor(up / L)
        if (idx > this.inCount - 1) break
        const ph = this.phases[up % L]
        const lag = this.inCount - 1 - idx // семпл idx лежить у hist[lag]
        let acc = 0
        for (let j = 0; j + lag < taps; j++) acc += ph[j] * this.hist[j + lag]
        out.push(acc)
        this.outPos++
      }
    }
    const buf = Buffer.alloc(out.length * 2)
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), i * 2)
    return buf
  }
}

// ---------- дрібниці ----------

// Середньоквадратичний рівень PCM16LE (для тестів і «чи говорить хтось»)
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2)
  if (!n) return 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2)
    s += v * v
  }
  return Math.sqrt(s / n)
}

// Тривалість PCM16LE у мс
export const pcmMs = (bytes, rate) => (Math.floor(bytes / 2) * 1000) / rate

// Синусоїда PCM16LE (тести, сигнали)
export function tone(rate, sec, hz = 1000, amp = 8000) {
  const n = Math.round(rate * sec)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2)
  return b
}
