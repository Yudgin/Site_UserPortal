// Сокет потоку звуку між рушієм і мозком (ШІ-співрозмовник). Мозок слухає Unix-сокет у приватній теці (0700), рушій
// на команду audio_start під'єднується, шле рядок {"token","call","rate"}\n і далі кадри: 1 байт типу + u32 LE довжина
// + дані (див. engine.cpp, GwAudio):
//   від рушія: 'A' голос співрозмовника (PCM16LE, кадр 20 мс), 'M' u32 id + u32 відтворено, 'K' u32 відтворено + u32 скинуто
//   до рушія:  'A' PCM16LE для відтворення, 'C' скинути чергу, 'M' u32 id — мітка в кінці черги
// З'єднання зіставляємо з дзвінком за одноразовим токеном (expect(token)); чужий чи запізнілий токен — розриваємо.
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const HELLO_MAX = 512
const FRAME_MAX = 1 << 20
const HELLO_WAIT_MS = 3000
// macOS: sun_path — 104 байти разом із нулем
const SUN_PATH_MAX = 103

const frame = (type, data = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5)
  h[0] = type.charCodeAt(0)
  h.writeUInt32LE(data.length, 1)
  return Buffer.concat([h, data])
}

// Одне з'єднання рушія (один дзвінок). Події: 'audio' (Buffer PCM16LE), 'mark' ({id, played}), 'cleared' ({played,
// dropped}), 'close'. played — семплів відтворено від початку з'єднання (mod 2^32).
class AudioConn extends EventEmitter {
  constructor(sock, hello) {
    super()
    this.sock = sock
    this.call = hello.call
    this.rate = hello.rate
    this.closed = false
    // Номер наступного семпла, який мозок надішле на відтворення, — у лічильнику рушія «відтворено» (після кожного
    // скидання вирівнюємо: скинуте рушій не рахує). За ним мозок знає, скільки відповіді моделі прозвучало.
    this.sentSamples = 0
    this.clears = [] // скидання, на які рушій ще не відповів 'K'
  }

  play(pcm) {
    if (this.closed || !pcm?.length) return false
    this.sentSamples += Math.floor(pcm.length / 2)
    return this.sock.write(frame('A', pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm))
  }

  // Скинути чергу відтворення. cb(played, dropped, delta): played — скільки семплів прозвучало від початку з'єднання,
  // delta — на скільки зсунулись позиції семплів, надісланих після скидання (додати до збережених позицій).
  clear(cb = null) {
    if (this.closed) return
    this.clears.push({ sentAtClear: this.sentSamples, cb })
    this.sock.write(frame('C'))
  }

  // Відповідь рушія на скидання: вирівняти лічильник надісланого з лічильником рушія. Скидання, що ще чекають своєї 'K',
  // запам'ятали sentAtClear у координатах до цього вирівнювання — зсуваємо й їх (інакше друга 'K' вирівняє вдруге:
  // надіслано 1000, скидання при 200, ще +500, скидання при 300 → має стати 300, а не -500).
  onCleared(played, dropped) {
    const c = this.clears.shift()
    if (!c) return
    const delta = played - (c.sentAtClear >>> 0)
    this.sentSamples += delta
    for (const rest of this.clears) rest.sentAtClear += delta
    try { c.cb?.(played, dropped, delta) } catch { /* колбек мозку */ }
  }

  mark(id) {
    if (this.closed) return
    const b = Buffer.alloc(4)
    b.writeUInt32LE(id >>> 0)
    this.sock.write(frame('M', b))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.sock.destroy()
  }
}

// dir — приватна тека для сокета (типово mkdtemp у системній тимчасовій: шлях до теки даних задовгий для sun_path).
// Повертає {path, expect(token, ms) → Promise<AudioConn>, token(), close()}.
export async function startAudioServer({ dir = null, log = () => {} } = {}) {
  const base = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'rf-vg-'))
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  fs.chmodSync(base, 0o700)
  const sockPath = path.join(base, `ai-${process.pid}.sock`)
  if (Buffer.byteLength(sockPath) > SUN_PATH_MAX) throw new Error(`шлях сокета задовгий (${sockPath.length} > ${SUN_PATH_MAX})`)
  try { fs.unlinkSync(sockPath) } catch { /* старого немає */ }
  const waiting = new Map() // token → {resolve, reject, timer}

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    let conn = null
    const helloTimer = setTimeout(() => { if (!conn) sock.destroy() }, HELLO_WAIT_MS)
    sock.on('error', () => {})
    sock.on('close', () => {
      clearTimeout(helloTimer)
      if (!conn) return
      conn.closed = true
      conn.emit('close')
    })
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d
      if (!conn) {
        const nl = buf.indexOf(10)
        if (nl < 0) {
          if (buf.length > HELLO_MAX) sock.destroy()
          return
        }
        let hello = null
        try { hello = JSON.parse(buf.subarray(0, nl).toString('utf8')) } catch { /* нижче — розрив */ }
        buf = buf.subarray(nl + 1)
        const w = hello && typeof hello.token === 'string' ? waiting.get(hello.token) : null
        if (!w || !Number.isInteger(hello.call) || ![8000, 16000, 24000, 48000].includes(hello.rate)) {
          log('поток звука: чужое или запоздавшее соединение — закрываю')
          sock.destroy()
          return
        }
        waiting.delete(hello.token)
        clearTimeout(w.timer)
        clearTimeout(helloTimer)
        conn = new AudioConn(sock, hello)
        w.resolve(conn)
      }
      while (buf.length >= 5) {
        const len = buf.readUInt32LE(1)
        if (len > FRAME_MAX) {
          sock.destroy()
          return
        }
        if (buf.length < 5 + len) break
        const type = String.fromCharCode(buf[0])
        const data = buf.subarray(5, 5 + len)
        buf = buf.subarray(5 + len)
        if (type === 'A') conn.emit('audio', Buffer.from(data))
        else if (type === 'M' && len === 8) conn.emit('mark', { id: data.readUInt32LE(0), played: data.readUInt32LE(4) })
        else if (type === 'K' && len === 8) {
          const played = data.readUInt32LE(0)
          const dropped = data.readUInt32LE(4)
          conn.onCleared(played, dropped)
          conn.emit('cleared', { played, dropped })
        }
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  fs.chmodSync(sockPath, 0o600)

  return {
    path: sockPath,
    // Новий одноразовий токен для audio_start
    token: () => crypto.randomBytes(12).toString('hex'),
    // Чекати з'єднання рушія з цим токеном (рушій під'єднується одразу на audio_start)
    expect(token, ms = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(token)
          reject(new Error('рушій не під\'єднався до сокета звуку'))
        }, ms)
        waiting.set(token, { resolve, reject, timer })
      })
    },
    cancel(token) {
      const w = waiting.get(token)
      if (!w) return
      waiting.delete(token)
      clearTimeout(w.timer)
      w.reject(new Error('скасовано'))
    },
    close() {
      for (const [, w] of waiting) {
        clearTimeout(w.timer)
        w.reject(new Error('сервер звуку закрито'))
      }
      waiting.clear()
      server.close()
      try { fs.unlinkSync(sockPath) } catch { /* уже немає */ }
      if (!dir) try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* нічого */ }
    },
  }
}

export default startAudioServer
