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

// Проверка окна БЕЗ коммита: возвращает { ok, commit() }. commit() фиксирует попадание.
const check = (key, windowMs, max) => {
  const now = Date.now()
  let arr = buckets.get(key)
  if (!arr) { arr = []; buckets.set(key, arr) }
  while (arr.length && now - arr[0] > windowMs) arr.shift()
  return { ok: arr.length < max, commit: () => arr.push(now) }
}

const DEFAULT_MSG = 'Забагато запитів. Спробуйте трохи пізніше.'

// keyFn(req) -> строка ключа (по умолчанию IP). name — префикс, чтобы разные лимитеры не пересекались.
export function rateLimit({ name = 'rl', windowMs, max, keyFn, message = DEFAULT_MSG }) {
  const keyOf = (req) => `${name}:${keyFn ? keyFn(req) : clientIp(req)}`
  const mw = (req, res, next) => {
    const r = check(keyOf(req), windowMs, max)
    if (!r.ok) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000))
      return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message } })
    }
    r.commit()
    next()
  }
  // Для combine: проверить без коммита (чтобы заблокированный запрос не «сжигал» слоты других лимитеров).
  mw._peek = (req) => check(keyOf(req), windowMs, max)
  mw._meta = { windowMs, message }
  return mw
}

// Комбинированный лимитер: ДВУХФАЗНО — сначала проверяем все под-лимитеры, и только если ВСЕ
// прошли, фиксируем попадание в каждом. Иначе ранний лимитер записал бы попадание даже когда
// поздний отклонил (заблокированные ретраи «сжигали» бы, например, IP-квоту).
export const combine = (...mws) => (req, res, next) => {
  const checks = mws.map((mw) => mw._peek(req))
  const failedIdx = checks.findIndex((c) => !c.ok)
  if (failedIdx >= 0) {
    const mw = mws[failedIdx]
    res.setHeader('Retry-After', Math.ceil(mw._meta.windowMs / 1000))
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: mw._meta.message || DEFAULT_MSG } })
  }
  checks.forEach((c) => c.commit())
  next()
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
