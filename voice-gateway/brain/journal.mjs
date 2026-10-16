// Локальний журнал дзвінків шлюзу: один JSON-рядок на завершений дзвінок у <dataDir>/calls-YYYY-MM-DD.jsonl
// (дата за київським часом). Без аудіо і без секретів; у Firestore нічого не пишемо.
import fs from 'node:fs'
import path from 'node:path'

const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key/i

export const ymd = (date, timeZone = 'Europe/Kyiv') => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

// Страховка: поля з «секретними» назвами в журнал не потрапляють, навіть якщо хтось їх туди передасть.
const scrub = (v, depth = 0) => {
  if (depth > 6 || v == null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1))
  const out = {}
  for (const [k, x] of Object.entries(v)) if (!SECRET_KEYS.test(k)) out[k] = scrub(x, depth + 1)
  return out
}

export function makeJournal({ dataDir, timeZone = 'Europe/Kyiv', now = () => new Date() }) {
  return function write(entry) {
    const file = path.join(dataDir, `calls-${ymd(now(), timeZone)}.jsonl`)
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }) // у журналі номери клієнтів — лише власнику
    fs.appendFileSync(file, `${JSON.stringify(scrub(entry))}\n`, { mode: 0o600 })
    return file
  }
}

export default makeJournal
