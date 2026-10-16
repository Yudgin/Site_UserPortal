// Файли шлюзу на диску: приватні теки (0700) і файли (0600), денні логи з ротацією за київською датою
// і прибирання старого (логи, кеш карток, журнал) — у них номери й імена клієнтів.
import fs from 'node:fs'
import path from 'node:path'
import { ymd } from './journal.mjs'
import { toneWav } from './tts.mjs'

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

// Створює теку (з батьками) лише для власника; уже наявну — звужує до 0700.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try { fs.chmodSync(dir, DIR_MODE) } catch { /* не наша тека — лишаємо як є */ }
  return dir
}

// Дописує у <dir>/<prefix>-YYYY-MM-DD.log; з новою добою (перевірка не частіше разу на хвилину) — у новий файл.
export function makeDailyLog({ dir, prefix, timeZone = 'Europe/Kyiv', now = () => new Date() }) {
  let day = null
  let ws = null
  let checkAt = 0
  let ended = false
  const open = () => {
    const d = ymd(now(), timeZone)
    if (d === day && ws) return
    if (ws) ws.end()
    day = d
    ensurePrivateDir(dir)
    ws = fs.createWriteStream(path.join(dir, `${prefix}-${d}.log`), { flags: 'a', mode: FILE_MODE })
    ws.on('error', () => {})
  }
  return {
    write(chunk) {
      if (ended) return
      const t = now().getTime()
      if (!ws || t >= checkAt) {
        checkAt = t + 60000
        open()
      }
      ws.write(chunk)
    },
    // Promise: файл дописано на диск (або писати нічого не було)
    end() {
      if (ended || !ws) {
        ended = true
        return Promise.resolve()
      }
      ended = true
      return new Promise((resolve) => ws.end(resolve))
    },
    get file() { return day ? path.join(dir, `${prefix}-${day}.log`) : null },
  }
}

// Видаляє файли, що відповідають re і не змінювались довше за days діб. Повертає кількість видалених.
export function pruneOld({ dir, re, days, now = Date.now }) {
  if (!(days > 0)) return 0
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const cutoff = now() - days * 86400000
  let n = 0
  for (const name of names) {
    if (!re.test(name)) continue
    const f = path.join(dir, name)
    try {
      const st = fs.statSync(f)
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(f)
        n++
      }
    } catch { /* уже немає */ }
  }
  return n
}

// Голосові повідомлення: <dataDir>/voicemail/YYYY-MM-DD/*.wav — файли старші за days діб, потім порожні денні теки.
function pruneVoicemail({ dataDir, days, now }) {
  if (!(days > 0)) return 0
  const root = path.join(dataDir, 'voicemail')
  let dirs
  try {
    dirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  } catch {
    return 0
  }
  let n = 0
  for (const d of dirs) {
    const dir = path.join(root, d)
    n += pruneOld({ dir, re: /\.wav$/, days, now })
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
    } catch { /* не тека або вже немає */ }
  }
  return n
}

// Прибирання всіх даних шлюзу за налаштуваннями retentionDays {logs, cache, journal, voicemail}.
export function pruneGatewayData({ dataDir, cacheDir, retentionDays, now = Date.now }) {
  const logs = path.join(dataDir, 'logs')
  return (
    pruneOld({ dir: logs, re: /^(engine|brain)-\d{4}-\d{2}-\d{2}\.log$/, days: retentionDays.logs, now }) +
    pruneOld({ dir: cacheDir, re: /^card-[0-9a-f]{40}\.wav$|\.tmp$/, days: retentionDays.cache, now }) +
    pruneOld({ dir: dataDir, re: /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/, days: retentionDays.journal, now }) +
    pruneVoicemail({ dataDir, days: retentionDays.voicemail, now })
  )
}

const hms = (date, timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date).replace(/\D/g, '')
  } catch {
    return date.toISOString().slice(11, 19).replace(/\D/g, '')
  }
}

// Шлях для запису голосової пошти: <dataDir>/voicemail/<YYYY-MM-DD>/<gcid або ГГХХСС>-<останні 4 цифри>.wav
// (дата й час — київські). Теки створює з правами 0700; файл не створює (його пише рушій, 0600), лише підбирає
// вільне ім'я. GCID приходить із заголовка SIP — у імені лише літери, цифри, «-» і «_».
// Шлях завжди абсолютний: рушій відкидає відносний («file must be an absolute path to .wav»).
export function makeVoicemailPath({ dataDir, gcid = null, number = null, timeZone = 'Europe/Kyiv', now = new Date() }) {
  const root = path.join(path.resolve(dataDir), 'voicemail')
  const dir = path.join(root, ymd(now, timeZone))
  ensurePrivateDir(root)
  ensurePrivateDir(dir)
  const digits = String(number ?? '').replace(/\D/g, '')
  const g = String(gcid ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40)
  const base = `${g || hms(now, timeZone)}-${digits ? digits.slice(-4) : 'anon'}`
  let file = path.join(dir, `${base}.wav`)
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.wav`)
  return file
}

// WAV голосового повідомлення після падіння рушія: pjmedia пише довжини в заголовок (RIFF і data) лише при
// закритті файла, до того там 0 — звук у файлі є, а плеєри показують 0:00. Довжину data рахуємо за розміром файла.
// Повертає true, якщо заголовок виправлено. Чіпає лише 8 байтів заголовка; файл, який ще пишеться, рушій однаково
// перепише при закритті.
export function repairWavHeader(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r+')
  } catch {
    return false
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= 44) return false
    const h = Buffer.alloc(Math.min(size, 4096))
    fs.readSync(fd, h, 0, h.length, 0)
    if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 8, 12) !== 'WAVE') return false
    let off = 12
    while (off + 8 <= h.length) {
      const id = h.toString('ascii', off, off + 4)
      const len = h.readUInt32LE(off + 4)
      if (id === 'data') {
        const start = off + 8
        if (len !== 0 || size <= start) return false // заголовок уже з довжиною (або звуку немає)
        const dataLen = (size - start) & ~1 // PCM 16 біт: ціла кількість відліків
        const b = Buffer.alloc(4)
        b.writeUInt32LE(start + dataLen - 8)
        fs.writeSync(fd, b, 0, 4, 4)
        b.writeUInt32LE(dataLen)
        fs.writeSync(fd, b, 0, 4, off + 4)
        return true
      }
      off += 8 + len + (len & 1)
    }
    return false
  } catch {
    return false
  } finally {
    fs.closeSync(fd)
  }
}

// Усі голосові повідомлення в <dataDir>/voicemail/<дата>/ із нульовою довжиною в заголовку (рушій упав під час
// запису). minAgeMs — не чіпати файли, змінені недавно (запис іще може йти). Повертає кількість виправлених.
export function repairVoicemailHeaders({ dataDir, minAgeMs = 0, now = Date.now }) {
  const root = path.join(dataDir, 'voicemail')
  let n = 0
  let dirs
  try {
    dirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  } catch {
    return 0
  }
  for (const d of dirs) {
    let names
    try {
      names = fs.readdirSync(path.join(root, d)).filter((x) => /\.wav$/i.test(x))
    } catch {
      continue
    }
    for (const name of names) {
      const f = path.join(root, d, name)
      try {
        if (minAgeMs > 0 && now() - fs.statSync(f).mtimeMs < minAgeMs) continue
      } catch {
        continue
      }
      if (repairWavHeader(f)) n++
    }
  }
  return n
}

// Корінь git-робочої копії, у якій лежить dir (є .git — тека або файл worktree), або null.
export function findGitRoot(dir) {
  let d = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

// Сигнал перед записом: <cacheDir>/beep-1000hz-400ms.wav, генеруємо один раз (атомарно, 0600). Повертає шлях.
export const BEEP_NAME = 'beep-1000hz-400ms.wav'
export function ensureBeep({ cacheDir }) {
  const file = path.join(cacheDir, BEEP_NAME)
  const wav = toneWav({ freq: 1000, ms: 400 })
  try {
    if (fs.statSync(file).size === wav.length) return file
  } catch { /* ще немає */ }
  ensurePrivateDir(cacheDir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, wav, { mode: FILE_MODE })
  fs.renameSync(tmp, file)
  return file
}
