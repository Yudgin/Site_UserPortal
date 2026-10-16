// Файли шлюзу на диску: приватні теки (0700) і файли (0600), денні логи з ротацією за київською датою
// і прибирання старого (логи, кеш карток, журнал) — у них номери й імена клієнтів.
import fs from 'node:fs'
import path from 'node:path'
import { ymd } from './journal.mjs'

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

// Прибирання всіх даних шлюзу за налаштуваннями retentionDays {logs, cache, journal}.
export function pruneGatewayData({ dataDir, cacheDir, retentionDays, now = Date.now }) {
  const logs = path.join(dataDir, 'logs')
  return (
    pruneOld({ dir: logs, re: /^(engine|brain)-\d{4}-\d{2}-\d{2}\.log$/, days: retentionDays.logs, now }) +
    pruneOld({ dir: cacheDir, re: /^card-[0-9a-f]{40}\.wav$|\.tmp$/, days: retentionDays.cache, now }) +
    pruneOld({ dir: dataDir, re: /^calls-\d{4}-\d{2}-\d{2}\.jsonl$/, days: retentionDays.journal, now })
  )
}
