// Робочий час для ШІ-співрозмовника: VG_WORK_HOURS «mon-fri 09:00-18:00» (кілька проміжків — через «;»:
// «mon-fri 09:00-18:00; sat 10:00-14:00»), час — за config.timeZone (Europe/Kyiv). Свят не враховуємо.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_UK = { mon: 'понеділка', tue: 'вівторка', wed: 'середи', thu: 'четверга', fri: "п'ятниці", sat: 'суботи', sun: 'неділі' }
const DAY_UK_ONE = { mon: 'у понеділок', tue: 'у вівторок', wed: 'у середу', thu: 'у четвер', fri: "у п'ятницю", sat: 'у суботу', sun: 'у неділю' }

const hm = (s) => {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/)
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) return null
  return Number(m[1]) * 60 + Number(m[2])
}

// «mon-fri 09:00-18:00; sat 10:00-14:00» → [{days:Set(1..5), from:540, to:1080, text}], помилка — Error
export function parseHours(spec) {
  const out = []
  for (const part of String(spec || '').split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = part.toLowerCase().match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/)
    if (!m) throw new Error(`VG_WORK_HOURS: не разобрать «${part}» (нужно «mon-fri 09:00-18:00»)`)
    const a = DAYS.indexOf(m[1])
    const b = m[2] ? DAYS.indexOf(m[2]) : a
    const from = hm(m[3])
    const to = hm(m[4])
    if (a < 0 || b < 0 || from == null || to == null || to <= from) throw new Error(`VG_WORK_HOURS: неверный промежуток «${part}»`)
    const days = new Set()
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === b) break
    }
    const when = m[2] ? `з ${DAY_UK[m[1]]} до ${DAY_UK[m[2]]}` : DAY_UK_ONE[m[1]]
    out.push({ days, from, to, text: `${when}, з ${m[3]} до ${m[4]}` })
  }
  return out
}

// День тижня й хвилини від півночі в часовому поясі
function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const parts = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { day: DAYS.indexOf(parts.weekday.toLowerCase().slice(0, 3)), min: Number(parts.hour) * 60 + Number(parts.minute) }
}

// Чи зараз робочий час. Порожній розклад — завжди робочий (як було до ШІ).
export function inHours(ranges, date = new Date(), timeZone = 'Europe/Kyiv') {
  if (!ranges?.length) return true
  const { day, min } = localParts(date, timeZone)
  return ranges.some((r) => r.days.has(day) && min >= r.from && min < r.to)
}

// Для інструкцій моделі: «з понеділка до п'ятниці, з 09:00 до 18:00»
export const hoursText = (ranges) => (ranges || []).map((r) => r.text).join('; ')

// ---------- календар робочих днів (черга B: строки перезвону й недодзвону) ----------

// Місцеві рік / місяць / день / хвилини / день тижня в часовому поясі
function zonedParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), min: Number(p.hour) * 60 + Number(p.minute), wd: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) }
}

// Мілісекунди UTC для місцевого часу (день y-mo-d, хвилини від півночі) у часовому поясі; два наближення — на випадок
// переходу на літній / зимовий час між здогадом і відповіддю
export function zonedMs(y, mo, d, min, timeZone = 'Europe/Kyiv') {
  const want = Date.UTC(y, mo - 1, d, 0, min)
  const offset = (t) => { const p = zonedParts(t, timeZone); return Date.UTC(p.y, p.mo - 1, p.d, 0, p.min) - Math.floor(t / 60000) * 60000 }
  let t = want - offset(want)
  t = want - offset(t)
  return t
}

// Кінець робочого дня цього дня тижня (найпізніший кінець його проміжків, хвилини) або null — день неробочий
const dayEndMin = (ranges, wd) => {
  let m = null
  for (const r of ranges || []) if (r.days.has(wd)) m = Math.max(m ?? 0, r.to)
  return m
}
// Місцева дата через n календарних днів від дати ms (день тижня рахуємо від UTC-дати — він той самий)
const shiftDate = ({ y, mo, d }, n) => {
  const u = new Date(Date.UTC(y, mo - 1, d + n))
  return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), wd: u.getUTCDay() }
}

// Кінець n-го робочого дня ПІСЛЯ дня nowMs (n = 1 — наступний робочий день) — «18:00 другого робочого дня після дзвінка»
// (записка режиму обговорення, 3.1: вівторок 14:20 → четвер 18:00; п'ятниця → вівторок 18:00). Немає розкладу — null.
export function workdayEndAfter(ranges, nowMs, n = 1, timeZone = 'Europe/Kyiv') {
  if (!ranges?.length || !(n >= 1)) return null
  const today = zonedParts(nowMs, timeZone)
  let count = 0
  for (let i = 1; i <= 31; i++) {
    const day = shiftDate(today, i)
    const end = dayEndMin(ranges, day.wd)
    if (end == null) continue
    if (++count === n) return zonedMs(day.y, day.mo, day.d, end, timeZone)
  }
  return null
}

// Кінець найближчого робочого дня, що ще не скінчився: сьогодні до 18:00 — сьогодні 18:00, інакше наступний робочий
// день 18:00 (п'ятниця 20:00 → понеділок 18:00). Так живе перезвін, поставлений уночі або з обіцянкою «у робочий час».
export function nextWorkEndMs(ranges, nowMs, timeZone = 'Europe/Kyiv') {
  if (!ranges?.length) return null
  const today = zonedParts(nowMs, timeZone)
  for (let i = 0; i <= 31; i++) {
    const day = i === 0 ? today : shiftDate(today, i)
    const end = dayEndMin(ranges, day.wd)
    if (end == null) continue
    const t = zonedMs(day.y, day.mo, day.d, end, timeZone)
    if (t > nowMs) return t
  }
  return null
}

// Додати лише робочий час, пропускаючи ніч, вихідні та перерви. Проміжки, які перекриваються, спочатку об'єднуємо:
// одна й та сама година не може скоротити обіцянку вдвічі. Порожній розклад, як у inHours, означає роботу цілодобово.
export function addWorkHours(ranges, nowMs, hours = 8, timeZone = 'Europe/Kyiv') {
  let left = Number(hours) * 3600000
  if (!Number.isFinite(nowMs) || !Number.isFinite(left) || left < 0) return null
  if (!ranges?.length || left === 0) return nowMs + left
  const today = zonedParts(nowMs, timeZone)
  for (let i = 0; i < 3660; i++) {
    const day = i === 0 ? today : shiftDate(today, i)
    const spans = ranges.filter((r) => r.days.has(day.wd)).map((r) => [r.from, r.to]).sort((a, b) => a[0] - b[0])
    const merged = []
    for (const span of spans) {
      const prev = merged.at(-1)
      if (prev && span[0] <= prev[1]) prev[1] = Math.max(prev[1], span[1])
      else merged.push(span.slice())
    }
    for (const [from, to] of merged) {
      const start = Math.max(nowMs, zonedMs(day.y, day.mo, day.d, from, timeZone))
      const end = zonedMs(day.y, day.mo, day.d, to, timeZone)
      const available = Math.max(0, end - start)
      if (left <= available) return start + left
      left -= available
    }
  }
  return null
}

// Перезвін живе щонайменше вісім робочих годин. Уночі та після обіцянки «у робочий час» — також до кінця найближчого
// робочого дня; звичайний TTL у callbacks може лишити його ще довше. Це правило спільне для старого і нового режиму.
export function callbackUntilMs(ranges, nowMs, timeZone = 'Europe/Kyiv', promisedWorkHours = false) {
  const eight = addWorkHours(ranges, nowMs, 8, timeZone)
  const end = promisedWorkHours || !inHours(ranges, new Date(nowMs), timeZone) ? nextWorkEndMs(ranges, nowMs, timeZone) : null
  return Math.max(eight || 0, end || 0) || null
}
