// Передзвін менеджера: хто з менеджерів дзвонить на шлюз, кому з клієнтів він має передзвонити і кого йому
// пропонували востаннє. Файли на диску шлюзу — особисті дані клієнтів (номер, текст картки з ім'ям), лише власнику:
// тека 0700, файли 0600, запис атомарний (тимчасовий файл поруч + rename), прострочене відкидається при кожному
// зверненні; тимчасові файли, що лишились після падіння процесу між записом і rename, прибирає prune().
//   <dataDir>/callbacks.json     {v:1, pending:[{id, managerKey, clientNumber, gcid, serviceRequestId, card, ts,
//                                  attempts?, lastTriedAt?, missed?}], dials:{<E.164>:[ts…]}}
//                                — pending: клієнт не дочекався менеджера («лінія зайнята, передзвонить») або поклав
//                                  трубку, поки менеджеру дзвонили (missed); TTL callbackTtlHours (24). attempts /
//                                  lastTriedAt — невдалі передзвони (клієнт не взяв); після maxAttempts запис знімається.
//                                — dials: коли шлюз набирав цей номер на передзвоні (за 24 год, для ліміту maxDialsPerDay)
//   <dataDir>/last-clients.json  {v:1, managers:{<managerKey>:{number, gcid, srId, ts}}}
//                                — останній клієнт, якого менеджеру пропонували (дзвінок дійшов до картки); TTL 30 діб
// Ключ менеджера — перший номер його групи з VG_MANAGERS, але шукаємо записи за ВСІЄЮ групою: переставили номери
// («907=0676575085» ↔ «0676575085=907») — записи не губляться.
// Без dataDir (тести) — те саме в пам'яті.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, FILE_MODE } from './storage.mjs'

export const CALLBACKS_FILE = 'callbacks.json'
export const LAST_CLIENTS_FILE = 'last-clients.json'
const TMP_RE = /^(callbacks|last-clients)\.json\.\d+\.[0-9a-f]+\.tmp$/
const TMP_MAX_AGE_MS = 5 * 60000 // тимчасовий файл старший — його запис точно не йде
const DAY_MS = 86400000

// user-частина SIP URI: «sip:907@sip14.binotel.com;transport=udp» → «907»; не URI — як є
export function uriUser(v) {
  const s = String(v ?? '').trim()
  const m = s.match(/^(?:sips?|tel):([^@;>]*)/i)
  return m ? m[1] : s
}

// Український номер ЦІЛКОМ — +380XXXXXXXXX, 380XXXXXXXXX або 0XXXXXXXXX (пробіли, дужки, дефіси, крапки
// дозволені) → «+380XXXXXXXXX»; інакше null. Без пошуку підрядка, як у normPhone: «+49 30 380676575085» чи
// «+1380676575085» — НЕ +380676575085 (інакше чужий іноземний номер із цими цифрами всередині пройшов би за
// менеджера чи за дозволеного клієнта).
export function strictPhone(v) {
  const s = String(v ?? '').trim().replace(/[\s().-]/g, '')
  let m = s.match(/^\+?380(\d{9})$/)
  if (m) return `+380${m[1]}`
  m = s.match(/^0(\d{9})$/)
  return m ? `+380${m[1]}` : null
}

export const isInternalKey = (k) => /^\d{3,4}$/.test(String(k ?? ''))

// Ключ абонента для порівняння: внутрішня лінія (3–4 цифри) — як є, інакше телефон у E.164 (strictPhone); не номер —
// null. «0676575085», «380676575085», «sip:0676575085@sip14…» → «+380676575085».
export function partyKey(v) {
  const s = uriUser(v).trim()
  if (isInternalKey(s)) return s
  return strictPhone(s)
}

// VG_MANAGERS: менеджери через кому; номери однієї людини (внутрішня лінія й мобільний) — через «=»:
// «907=0676575085,905» → [['907', '+380676575085'], ['905']]. Ключ менеджера — перший номер його групи.
export function parseManagers(spec) {
  return String(spec ?? '')
    .split(/[,;\s]+/)
    .map((g) => g.split('=').map(partyKey).filter(Boolean))
    .filter((g) => g.length)
}

// Групи менеджерів = VG_MANAGERS + обов'язково та лінія, якій шлюз дзвонить (managerUri): її дзвінок на шлюз ніколи
// не вважається клієнтом (інакше шлюз набрав би менеджера йому ж самому), а записи передзвонів шукаються за групою.
// Чи ПРИЙМАТИ дзвінок із зовнішнього номера як передзвін — вирішує flow.mjs (лише VG_MANAGERS_EXTERNAL=1 + PIN).
export function resolveManagers(spec, managerUri) {
  const groups = parseManagers(spec)
  const k = partyKey(managerUri)
  if (k && !groups.some((g) => g.includes(k))) groups.push([k])
  return groups
}

// Група менеджера (усі його номери) для номера чи URI, або null — це не менеджер
export function managerGroupOf(v, managers = []) {
  const k = partyKey(v)
  if (!k) return null
  return (managers || []).find((x) => x.includes(k)) || null
}

// Ключ менеджера (перший номер групи) для номера чи URI, або null — це не менеджер
export function managerKeyOf(v, managers = []) {
  const g = managerGroupOf(v, managers)
  return g ? g[0] : null
}

// URI для набору клієнта: {national} — 0XXXXXXXXX, {e164} — +380XXXXXXXXX, {digits} — 380XXXXXXXXX, {server} — сервер
// лінії. Лише справжній номер (strictPhone), тож у URI потрапляють тільки цифри.
export function clientDialUri(number, template, server) {
  const p = strictPhone(number)
  if (!p) return null
  const v = { national: `0${p.slice(4)}`, e164: p, digits: p.slice(1), server: String(server ?? '') }
  return String(template || 'sip:{national}@{server};transport=udp').replace(/\{(national|e164|digits|server)\}/g, (_, k) => v[k])
}

// Набір ключів (рядок, масив або null — «будь-хто») → предикат
const keyTest = (keys) => {
  if (keys == null) return () => true
  const set = new Set([].concat(keys).filter(Boolean))
  return (k) => set.has(k)
}

export function makeCallbackStore({ dataDir = null, callbackTtlHours = 24, lastClientTtlDays = 30, maxAttempts = 3, maxDialsPerDay = 5, now = Date.now, log = () => {} } = {}) {
  const files = dataDir ? { pending: path.join(dataDir, CALLBACKS_FILE), last: path.join(dataDir, LAST_CLIENTS_FILE) } : null
  const mem = { pending: { pending: [], dials: {} }, last: {} }
  // 0 (або менше) — не прострочувати / без ліміту
  const ttl = (v, unitMs) => (Number(v) > 0 ? Number(v) * unitMs : Infinity)
  const pendingTtl = () => ttl(callbackTtlHours, 3600000)
  const lastTtl = () => ttl(lastClientTtlDays, DAY_MS)
  const fresh = (ts, ttlMs) => Number.isFinite(Number(ts)) && now() - Number(ts) < ttlMs
  const limit = (v) => (Number(v) > 0 ? Number(v) : Infinity)

  const emptyOf = (kind) => (kind === 'pending' ? { pending: [], dials: {} } : {})
  function parse(kind, j) {
    if (kind === 'pending') {
      const pending = Array.isArray(j?.pending) ? j.pending.filter((x) => x && typeof x === 'object') : []
      const dials = j?.dials && typeof j.dials === 'object' && !Array.isArray(j.dials) ? j.dials : {}
      return { pending, dials }
    }
    return j?.managers && typeof j.managers === 'object' && !Array.isArray(j.managers) ? j.managers : {}
  }
  function read(kind) {
    if (!files) return kind === 'pending' ? { pending: mem.pending.pending.slice(), dials: { ...mem.pending.dials } } : { ...mem.last }
    let raw
    try {
      raw = fs.readFileSync(files[kind], 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') log(`передзвін: не прочитано ${path.basename(files[kind])}: ${e.code || e.message}`)
      return emptyOf(kind)
    }
    try {
      return parse(kind, JSON.parse(raw))
    } catch {
      // Зіпсований файл (ручна правка, обірваний запис старої версії): починаємо з порожнього, наступний запис перепише
      log(`передзвін: ${path.basename(files[kind])} не JSON — начинаю с пустого`)
      return emptyOf(kind)
    }
  }

  function write(kind, data) {
    if (!files) {
      if (kind === 'pending') mem.pending = { pending: data.pending.slice(), dials: { ...data.dials } }
      else mem.last = { ...data }
      return
    }
    ensurePrivateDir(dataDir)
    const file = files[kind]
    const body = kind === 'pending'
      ? { v: 1, pending: data.pending, ...(Object.keys(data.dials).length ? { dials: data.dials } : {}) }
      : { v: 1, managers: data }
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 1)}\n`, { mode: FILE_MODE })
      fs.renameSync(tmp, file) // атомарно: файл або старий, або новий цілий
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { /* не створився */ }
      throw e
    }
    try { fs.chmodSync(file, FILE_MODE) } catch { /* уже немає */ }
  }

  // Відкладені передзвони й історія наборів без простроченого (прострочене одразу прибираємо і з диска)
  function livePending() {
    const all = read('pending')
    const pending = all.pending.filter((x) => fresh(x.ts, pendingTtl()))
    const dials = {}
    let dropped = pending.length !== all.pending.length
    for (const [n, list] of Object.entries(all.dials)) {
      const ok = Array.isArray(list) ? list.filter((ts) => fresh(ts, DAY_MS)) : []
      if (ok.length) dials[n] = ok
      if (!Array.isArray(list) || ok.length !== list.length) dropped = true
    }
    const live = { pending, dials }
    if (dropped) write('pending', live)
    return live
  }
  function liveLast() {
    const all = read('last')
    const live = {}
    let dropped = false
    for (const [k, v] of Object.entries(all)) {
      if (v && typeof v === 'object' && fresh(v.ts, lastTtl())) live[k] = v
      else dropped = true
    }
    if (dropped) write('last', live)
    return live
  }

  const byNewest = (a, b) => Number(b.ts) - Number(a.ts)
  // Черга передзвонів: ще не пробувані — найсвіжіші першими (рішення власника); ті, кому вже дзвонили і хто не взяв, —
  // у кінець, найдавніше пробуваний першим. Так недосяжний клієнт не закриває чергу для решти.
  const queueOrder = (a, b) => {
    const ta = Number(a.attempts) > 0
    const tb = Number(b.attempts) > 0
    if (ta !== tb) return ta ? 1 : -1
    if (!ta) return byNewest(a, b)
    return (Number(a.lastTriedAt) || 0) - (Number(b.lastTriedAt) || 0) || byNewest(a, b)
  }

  const store = {
    // Новий відкладений передзвін. Той самий клієнт у того самого менеджера — лише один запис, найсвіжіший (і лічильник
    // невдалих спроб — з нуля: клієнт подзвонив знову).
    addPending({ managerKey, clientNumber, gcid = null, serviceRequestId = null, card = null, missed = false, ts = now() }) {
      const number = strictPhone(clientNumber)
      if (!managerKey || !number) throw new Error('callback: need managerKey and E.164 clientNumber')
      const entry = { id: `${Number(ts).toString(36)}-${crypto.randomBytes(3).toString('hex')}`, managerKey, clientNumber: number, gcid: gcid ?? null, serviceRequestId: serviceRequestId ?? null, card: card ?? null, ts: Number(ts), ...(missed ? { missed: true } : {}) }
      const live = livePending()
      live.pending = live.pending.filter((x) => !(x.managerKey === managerKey && x.clientNumber === number))
      live.pending.push(entry)
      write('pending', live)
      return entry
    },
    // Дописати те, що стало відомо пізніше (пошук клієнта закінчився вже після рішення «лінія зайнята»)
    updatePending(id, { gcid, serviceRequestId, card } = {}) {
      const live = livePending()
      const e = live.pending.find((x) => x.id === id)
      if (!e) return false
      if (gcid !== undefined) e.gcid = gcid
      if (serviceRequestId !== undefined) e.serviceRequestId = serviceRequestId
      if (card !== undefined) e.card = card
      write('pending', live)
      return true
    },
    removePending(id) {
      const live = livePending()
      const n = live.pending.length
      live.pending = live.pending.filter((x) => x.id !== id)
      if (live.pending.length === n) return false
      write('pending', live)
      return true
    },
    // Клієнта обслужено (з'єднано з менеджером — у звичайному дзвінку чи на передзвоні): прибрати всі його записи в
    // цієї групи менеджера. Повертає, скільки прибрано.
    removePendingFor(keys, clientNumber) {
      const number = strictPhone(clientNumber)
      if (!number) return 0
      const inGroup = keyTest(keys)
      const live = livePending()
      const n = live.pending.length
      live.pending = live.pending.filter((x) => !(inGroup(x.managerKey) && x.clientNumber === number))
      if (live.pending.length === n) return 0
      write('pending', live)
      return n - live.pending.length
    },
    // Передзвін не вдався (клієнт не взяв / зайнятий / помилка): спроба +1 і запис — у кінець черги; після maxAttempts
    // запис знімається (dropped). Повертає {attempts, dropped} або null — запису вже немає.
    markAttempt(id) {
      const live = livePending()
      const e = live.pending.find((x) => x.id === id)
      if (!e) return null
      e.attempts = (Number(e.attempts) || 0) + 1
      e.lastTriedAt = now()
      const dropped = e.attempts >= limit(maxAttempts)
      if (dropped) live.pending = live.pending.filter((x) => x !== e)
      write('pending', live)
      return { attempts: e.attempts, dropped }
    },
    // Черга передзвонів групи менеджера (keys — ключ, список ключів або null — усі): див. queueOrder
    listPending(keys = null) {
      const inGroup = keyTest(keys)
      return livePending().pending.filter((x) => inGroup(x.managerKey)).sort(queueOrder)
    },
    setLastClient(managerKey, { number, gcid = null, srId = null, ts = now() } = {}) {
      const n = strictPhone(number)
      if (!managerKey || !n) return false
      const all = liveLast()
      all[managerKey] = { number: n, gcid: gcid ?? null, srId: srId ?? null, ts: Number(ts) }
      write('last', all)
      return true
    },
    // Останній клієнт групи: найсвіжіший серед ключів групи
    getLastClient(keys) {
      const inGroup = keyTest(keys)
      const list = Object.entries(liveLast()).filter(([k]) => inGroup(k)).map(([, v]) => v).sort(byNewest)
      return list[0] || null
    },
    // Скільки разів за 24 год шлюз набирав цей номер на передзвоні, і чи можна ще (maxDialsPerDay; 0 — без ліміту)
    dialsToday(number) {
      const n = strictPhone(number)
      return n ? (livePending().dials[n] || []).length : 0
    },
    canDial(number) {
      return store.dialsToday(number) < limit(maxDialsPerDay)
    },
    noteDial(number) {
      const n = strictPhone(number)
      if (!n) return 0
      const live = livePending()
      live.dials[n] = [...(live.dials[n] || []), now()]
      write('pending', live)
      return live.dials[n].length
    },
    // Кому передзвонює менеджер: перший у черзі відкладених передзвонів групи, інакше останній клієнт, якого їй
    // пропонували. skip(number) → true — цей номер зараз не набирати (уже набирає інший передзвін, ліміт наборів…).
    pickTarget(keys, { skip = null } = {}) {
      const ok = (n) => !skip || !skip(n)
      const p = store.listPending(keys).find((x) => ok(x.clientNumber))
      if (p) return { source: 'pending', id: p.id, number: p.clientNumber, gcid: p.gcid ?? null, serviceRequestId: p.serviceRequestId ?? null, ts: p.ts, attempts: Number(p.attempts) || 0 }
      const l = store.getLastClient(keys)
      if (l && ok(l.number)) return { source: 'last', id: null, number: l.number, gcid: l.gcid ?? null, serviceRequestId: l.srId ?? null, ts: l.ts, attempts: 0 }
      return null
    },
    // Ключі менеджерів у файлах, яких немає серед поточних груп (VG_MANAGER / VG_MANAGERS змінили): шлюз попереджає
    orphanKeys(managers = []) {
      const known = new Set((managers || []).flat())
      const keys = new Set([...livePending().pending.map((x) => x.managerKey), ...Object.keys(liveLast())])
      return [...keys].filter((k) => k && !known.has(k))
    },
    // Прибрати прострочене (шлюз кличе на старті й раз на 6 год) і тимчасові файли, що лишились після падіння процесу
    // між записом і rename (у них ті самі номери й картки). Повертає кількість прибраних записів і файлів.
    prune() {
      const before = read('pending')
      const l = Object.keys(read('last')).length
      let n = before.pending.length - livePending().pending.length + l - Object.keys(liveLast()).length
      if (files) {
        let names = []
        try { names = fs.readdirSync(dataDir) } catch { /* теки ще немає */ }
        for (const name of names) {
          if (!TMP_RE.test(name)) continue
          const f = path.join(dataDir, name)
          try {
            if (now() - fs.statSync(f).mtimeMs < TMP_MAX_AGE_MS) continue // свіжий — його ще може писати інший процес
            fs.unlinkSync(f)
            n++
          } catch { /* уже немає */ }
        }
      }
      return n
    },
    files,
  }
  return store
}

export default makeCallbackStore
