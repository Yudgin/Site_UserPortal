// Последний результат «Перевірити ключі» по каждому ФОП (вручную или ежедневно) — для цветных меток на /fops, и
// ежедневная проверка всех активных ФОП (Cloud Scheduler) с сообщением владельцу в Telegram.
// Храним только то, что владелец и так видит в окне проверки, причём в урезанном виде (вердикт, текст, сроки):
// fopKeyChecks/{fopId} — последняя проверка ФОП, fopKeyCheckRuns/last — последний ежедневный запуск. Значений ключей
// в вердиктах нет. Обе коллекции клиентам закрыты общим запретом правил, читает и пишет только сервер.
import axios from 'axios'

export const CHECKS = 'fopKeyChecks'
export const RUNS = 'fopKeyCheckRuns'
export const PROVIDER_TITLES = {
  liqpay: 'LiqPay',
  monoAcquire: 'monobank еквайринг',
  monoChast: 'monobank Частини',
  checkbox: 'Checkbox (чеки)',
  novaPoshta: 'Нова Пошта',
}
const FOPS_PAGE = 'https://my.runferry.com/fops'

// Для меток в списке хватает вердикта, текста и сроков; касса, кассир и коды — только в окне проверки.
const slim = (r) => (r && typeof r === 'object' ? {
  status: r.status,
  message: r.message,
  ...(r.note ? { note: r.note } : {}),
  ...(r.subscriptionExp ? { subscriptionExp: r.subscriptionExp } : {}),
  ...(r.dateToBlock ? { dateToBlock: r.dateToBlock } : {}),
  ...(r.expiring?.length ? { soon: true } : {}), // скоро перестанет работать: метка оранжевая
} : null)

// startedAt — когда проверка началась. Ключи сохранили позже (resetAt новее) — результат уже не про них, не пишем.
export const saveKeyCheck = async (adminDb, fopId, results, source, at = new Date().toISOString(), startedAt = at) => {
  const ref = adminDb.collection(CHECKS).doc(fopId)
  const cur = await ref.get()
  const resetAt = cur.exists ? cur.data()?.resetAt : null
  if (resetAt && resetAt > startedAt) return false
  const slimmed = {}
  for (const [k, v] of Object.entries(results || {})) {
    const s = slim(v)
    if (s) slimmed[k] = s
  }
  await ref.set({ checkedAt: at, source, results: slimmed })
  return true
}

// Ключи или настройки ФОП поменялись: прежний результат стираем, а время сброса держим, чтобы не записала начатая раньше проверка.
export const forgetKeyCheck = (adminDb, fopId, at = new Date().toISOString()) => adminDb.collection(CHECKS).doc(fopId).set({ resetAt: at })

export const loadKeyChecks = async (adminDb) => {
  const snap = await adminDb.collection(CHECKS).get()
  const out = {}
  snap.forEach((d) => {
    const v = d.data() || {}
    if (v.results) out[d.id] = v // после сброса там только resetAt: метки серые
  })
  return out
}

// «Checkbox (чеки): Checkbox: Касу заблоковано» — второе название лишнее.
export const withoutProviderPrefix = (text) => String(text || '').replace(/^Checkbox:\s*/, '')

// Что сказать владельцу по одному ФОП: красные строки и то, что скоро перестанет работать. urgent — касса не выдаст
// чек (блок, конец подписки, подпись кассира): о таком напоминаем каждый день.
export const fopIssues = (fop, results) => {
  const out = []
  const name = fop.name || fop.id
  for (const [key, title] of Object.entries(PROVIDER_TITLES)) {
    const r = results?.[key]
    if (!r) continue
    const base = { fopId: fop.id, provider: key, fop: name, title }
    if (r.status === 'bad') out.push({ ...base, key: `${fop.id}:${key}:bad:${r.message}`, text: withoutProviderPrefix(r.message), urgent: !!r.urgent })
    for (const x of r.expiring || []) {
      out.push({ ...base, key: `${fop.id}:${key}:${x.what}:${x.date}`, text: x.text, urgent: true })
    }
  }
  return out
}

const MESSAGE_MAX = 3800 // предел Telegram — 4096 символов
const STALE = ' (сьогодні перевірити не вдалося, це результат минулої перевірки)'

export const dailyMessage = (issues) => {
  if (!issues.length) return '✅ RunFerry: щоденна перевірка ключів ФОП — усе в порядку, попередні проблеми зникли.'
  const byFop = new Map()
  for (const i of issues) {
    if (!byFop.has(i.fop)) byFop.set(i.fop, [])
    byFop.get(i.fop).push(i)
  }
  const tail = ['', `Деталі: ${FOPS_PAGE}`]
  const lines = ['⚠️ RunFerry: щоденна перевірка ключів ФОП']
  let omitted = 0
  // Не влезает — ФОП целиком, а не на полуслове; ссылка на страницу остаётся всегда.
  for (const [name, list] of byFop) {
    const block = ['', `${name}:`, ...list.map((i) => `• ${i.title}: ${i.text}${i.stale ? STALE : ''}`)]
    if ([...lines, ...block, ...tail].join('\n').length > MESSAGE_MAX) {
      omitted += list.length
      continue
    }
    lines.push(...block)
  }
  if (omitted) lines.push('', `…і ще ${omitted} — дивіться сторінку.`)
  return [...lines, ...tail].join('\n')
}

// Telegram владельцу тем же ботом и чатом, что и «гроші є, чек ні» в payments.js (OWNER_TELEGRAM_CHAT_ID).
// Токен бота в журнал не попадает: пишем только код ответа.
export const ownerTelegram = (env = process.env, http = axios) => {
  const token = env.TELEGRAM_BOT_TOKEN || ''
  const chat = env.OWNER_TELEGRAM_CHAT_ID || ''
  return {
    configured: !!(token && chat),
    send: async (text) => {
      if (!token || !chat) return false
      try {
        await http.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text, disable_web_page_preview: true }, { timeout: 8000 })
        return true
      } catch (e) {
        console.error('fop daily check: Telegram:', e?.response?.status || e?.code || 'помилка')
        return false
      }
    },
  }
}

// Один запуск за раз: плановый и кнопка «Перевірити всі» иначе прочли бы один и тот же прошлый итог и написали бы дважды.
// create() атомарен; зависшую блокировку (упавший запуск) забираем по истечении срока.
const LOCK_MS = 5 * 60 * 1000
const takeLock = async (adminDb, now) => {
  const ref = adminDb.collection(RUNS).doc('lock')
  const until = new Date(now().getTime() + LOCK_MS).toISOString()
  try {
    await ref.create({ until })
    return true
  } catch {
    const snap = await ref.get()
    if (snap.exists && String(snap.data()?.until || '') > now().toISOString()) return false
    await ref.set({ until })
    return true
  }
}

// Все активные ФОП параллельно: у каждого свои кабинеты, мешать друг другу нечему. Срочное — каждый день, остальное —
// когда список проблем изменился; все проблемы ушли — одно «✅». ФОП или провайдер сегодня не ответил — его прошлые
// проблемы не считаем решёнными: переносим с пометкой. Не доставили (нет чата, сбой Telegram) — список не считаем
// отправленным, завтра попробуем снова.
export const runDailyKeyCheck = async ({ adminDb, loadFop, checkKeys, notify, now = () => new Date() }) => {
  if (!(await takeLock(adminDb, now))) return { busy: true }
  try {
    const at = now().toISOString()
    const metaSnap = await adminDb.collection('fops').get()
    const ids = metaSnap.docs.filter((d) => (d.data() || {}).active !== false).map((d) => d.id)
    const rows = await Promise.all(ids.map(async (id) => {
      try {
        const fop = await loadFop(adminDb, id)
        if (!fop) return null
        const startedAt = now().toISOString()
        const results = await checkKeys(fop)
        await saveKeyCheck(adminDb, id, results, 'daily', now().toISOString(), startedAt)
        const unknown = Object.keys(PROVIDER_TITLES).filter((k) => results?.[k]?.status === 'unknown')
        return { id, unknown, issues: fopIssues(fop, results) }
      } catch (e) {
        console.error(`fop daily check ${id}:`, e?.message)
        return { id, failed: true, unknown: [], issues: [] }
      }
    }))
    const done = rows.filter(Boolean)
    const runRef = adminDb.collection(RUNS).doc('last')
    const prev = await runRef.get()
    const prevList = prev.exists ? (prev.data()?.issueList || []) : []
    const fresh = done.flatMap((r) => r.issues)
    const freshKeys = new Set(fresh.map((i) => i.key))
    const failedIds = new Set(done.filter((r) => r.failed).map((r) => r.id))
    const unknownKeys = new Set(done.flatMap((r) => r.unknown.map((p) => `${r.id}:${p}`)))
    const carried = prevList
      .filter((i) => !freshKeys.has(i.key) && (failedIds.has(i.fopId) || unknownKeys.has(`${i.fopId}:${i.provider}`)))
      .map((i) => ({ ...i, stale: true }))
    const issues = [...fresh, ...carried]
    const list = issues.map(({ key, fopId, provider, fop, title, text, urgent }) => ({ key, fopId, provider, fop, title, text, urgent: !!urgent }))
    const keys = [...new Set(list.map((i) => i.key))].sort()
    const prevKeys = [...new Set(prevList.map((i) => i.key))].sort()
    const changed = keys.join('\n') !== prevKeys.join('\n')
    const shouldSend = issues.some((i) => i.urgent) || changed
    const sent = shouldSend ? await notify.send(dailyMessage(issues)) : null
    const run = {
      at,
      checked: done.filter((r) => !r.failed).length,
      failed: failedIds.size,
      issueList: sent === false ? prevList : list,
      issues: issues.length,
      sent,
      telegram: notify.configured,
    }
    await runRef.set(run)
    return run
  } finally {
    await adminDb.collection(RUNS).doc('lock').delete().catch((e) => console.error('fop daily check: блокування:', e?.message))
  }
}
