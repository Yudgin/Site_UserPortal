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
