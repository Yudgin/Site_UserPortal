// Простой in-memory rate-limit (скользящее окно) для публичных эндпоинтов.
// ВАЖНО: стор в памяти процесса — на Cloud Run с несколькими инстансами защита делится по
// инстансам (каждый считает свои запросы), но абьюз всё равно резко ограничивается. Для строгого
// распределённого лимита нужен общий стор (Redis/Firestore) — оставлено на потом.
const buckets = new Map() // key -> number[] (таймстемпы попаданий)

const clientIp = (req) => {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

// keyFn(req) -> строка ключа (по умолчанию IP). name — префикс, чтобы разные лимитеры не пересекались.
export function rateLimit({ name = 'rl', windowMs, max, keyFn, message = 'Забагато запитів. Спробуйте трохи пізніше.' }) {
  return (req, res, next) => {
    const now = Date.now()
    const key = `${name}:${keyFn ? keyFn(req) : clientIp(req)}`
    let arr = buckets.get(key)
    if (!arr) { arr = []; buckets.set(key, arr) }
    while (arr.length && now - arr[0] > windowMs) arr.shift()
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
      return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message } })
    }
    arr.push(now)
    next()
  }
}

// Комбинированный лимитер: запрос проходит, только если все под-лимитеры пропустили.
export const combine = (...mws) => (req, res, next) => {
  let i = 0
  const run = () => (i >= mws.length ? next() : mws[i++](req, res, run))
  run()
}

export { clientIp }

// Периодическая очистка пустых/старых ключей, чтобы Map не рос бесконечно.
const CLEAN_EVERY_MS = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [key, arr] of buckets) {
    while (arr.length && now - arr[0] > 60 * 60 * 1000) arr.shift()
    if (!arr.length) buckets.delete(key)
  }
}, CLEAN_EVERY_MS).unref?.()

export default rateLimit
