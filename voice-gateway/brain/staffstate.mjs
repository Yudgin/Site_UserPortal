// Пропуски й пауза ведучого в режимі обговорення — ПО СПІВРОБІТНИКУ, не по заявці (записка режиму обговорення, 5.0;
// уточнення сесії «Режим обговорення» 17.10 у runferry-briefs/telephony/ai-first-discussion-join-2026-10-17.md, розд. 11).
// Поки сервера режиму немає, правило «missMax пропусків поспіль → пауза pauseMin хв» шлюз веде сам:
//   <dataDir>/staff-state.json  {v:1, staff:{<uid або ключ менеджера>:{misses, lastMissAt, pausedUntil, lastAnswerAt, uid?}}}
// Ідентичність — uid, якщо відомий, інакше перший номер групи VG_MANAGERS. Зміна номера не скидає паузу співробітника.
// Пропуск — ведучий не взяв, «2», без «1», клієнт чекав
// після фрази довше VG_DS_MAX_WAIT_SEC; відмова 486 (зайнятий іншою розмовою) — НЕ пропуск (рахує flow.mjs). Ведучий
// узяв (з'єднано / приєднався) — лічильник з нуля. Пауза настала — лічильник теж з нуля: після паузи все спочатку.
// Номерів клієнтів тут немає, але ключ буває мобільним менеджера — файл лише власнику: тека 0700, файл 0600, запис
// атомарний (тимчасовий файл поруч + rename). Без dataDir (тести) — у пам'яті.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, FILE_MODE } from './storage.mjs'

export const STAFF_FILE = 'staff-state.json'

export function makeStaffState({ dataDir = null, missMax = 2, pauseMin = 120, now = Date.now, log = () => {} } = {}) {
  const file = dataDir ? path.join(dataDir, STAFF_FILE) : null
  let mem = {}

  function read() {
    if (!file) return JSON.parse(JSON.stringify(mem))
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') log(`пропуски ведущих: не прочитан ${STAFF_FILE}: ${e.code || e.message}`)
      return {}
    }
    try {
      const j = JSON.parse(raw)
      return j?.staff && typeof j.staff === 'object' && !Array.isArray(j.staff) ? j.staff : {}
    } catch {
      log(`пропуски ведущих: ${STAFF_FILE} не JSON — начинаю с пустого`)
      return {}
    }
  }

  function write(staff) {
    if (!file) {
      mem = JSON.parse(JSON.stringify(staff))
      return
    }
    ensurePrivateDir(dataDir)
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, staff }, null, 1)}\n`, { mode: FILE_MODE })
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* не створився */ }
      throw e
    }
    try { fs.chmodSync(file, FILE_MODE) } catch { /* уже немає */ }
  }

  const limit = () => (Number(missMax) > 0 ? Number(missMax) : Infinity)
  const pauseMs = () => Math.max(0, Number(pauseMin) || 0) * 60000
  const entryKey = (all, key, uid) => {
    if (uid) return Object.keys(all).find((k) => all[k]?.uid === uid) || (all[key] && !all[key].uid ? key : `uid:${uid}`)
    return Object.hasOwn(all, key) ? key : Object.keys(all).find((k) => all[k]?.keys?.includes(key)) || key
  }
  const identify = (entry, key, uid) => {
    if (uid) entry.uid = uid
    entry.keys = [...new Set([...(Array.isArray(entry.keys) ? entry.keys : []), key])]
    return entry
  }

  const store = {
    // Пауза ще триває — до коли (мс), інакше null
    pausedUntil(key, { uid = null } = {}) {
      if (!key) return null
      const all = read()
      const until = Number(all[entryKey(all, key, uid)]?.pausedUntil) || 0
      return until > now() ? until : null
    },
    isPaused(key, options) {
      return store.pausedUntil(key, options) != null
    },
    // Пропуск ведучого: +1; набралось missMax поспіль — пауза pauseMin хв (лічильник з нуля). → {misses, pausedUntil, paused}
    miss(key, { uid = null, code = null } = {}) {
      if (!key) return null
      if (Number(code) === 486) return null
      const all = read()
      const id = entryKey(all, key, uid)
      const e = identify({ misses: 0, ...(all[id] || {}) }, key, uid)
      e.misses = (Number(e.misses) || 0) + 1
      e.lastMissAt = now()
      if (uid) e.uid = uid
      let paused = false
      if (e.misses >= limit() && pauseMs() > 0) {
        e.pausedUntil = now() + pauseMs()
        e.misses = 0
        paused = true
      }
      all[id] = e
      write(all)
      return { misses: e.misses, pausedUntil: Number(e.pausedUntil) > now() ? Number(e.pausedUntil) : null, paused }
    },
    // Ведучий узяв (клієнта з'єднано або він приєднався): пропуски — з нуля (пауза, якщо є, лишається до свого строку)
    answered(key, { uid = null } = {}) {
      if (!key) return false
      const all = read()
      const id = entryKey(all, key, uid)
      const e = identify({ ...(all[id] || {}) }, key, uid)
      e.misses = 0
      e.lastAnswerAt = now()
      if (uid) e.uid = uid
      all[id] = e
      write(all)
      return true
    },
    get(key, { uid = null } = {}) {
      const all = read()
      return key ? all[entryKey(all, key, uid)] || null : null
    },
    file,
  }
  return store
}

export default makeStaffState
