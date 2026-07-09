// Общее ядро агрегатора мессенджеров (Telegram, Viber, …).
// Транспорт у каждого канала свой (webhook-формат, подпись, отправка), а бизнес-логика
// одна: собрать прайс-контекст, найти/создать сессию chatSessions (channel=…),
// ответить тем же CHAT_SYSTEM-ИИ, привязать профиль по телефону, эскалировать в инбокс.
// Персистенция — через firebase-admin (доверенный backend, минуя клиентские правила).
import { FieldValue } from 'firebase-admin/firestore'

const round2 = (n) => Math.round(n * 100) / 100
export const nowIso = () => new Date().toISOString()
export const genMsgId = () => Math.random().toString(36).slice(2, 10)
export const genSessionId = (prefix = 'ms') => `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

// Нормализация телефона (зеркало src/utils/phone.ts) — ключ профиля клиента
export const normalizePhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('80')) d = '380' + d.slice(2)
  else if (d.length === 10 && d.startsWith('0')) d = '38' + d
  else if (d.length === 9) d = '380' + d
  return d
}

// Извлечь украинский телефон из свободного текста (когда клиент присылает номер сообщением —
// для Viber и Telegram Business, где кнопки «поділитися контактом» нет). Возвращает '' если нет.
export const extractPhone = (text) => {
  const candidates = String(text || '').match(/[+\d][\d\s()\-]{7,}\d/g) || []
  for (const c of candidates) {
    const norm = normalizePhone(c)
    if (norm.length === 12 && norm.startsWith('380')) return norm
  }
  return ''
}

// Просьба прислать телефон (один раз на сессию), пока номера ещё нет.
const PHONE_ASK = 'Підкажіть, будь ласка, ваш номер телефону для зв’язку (наприклад +380XX XXX XX XX) — щоб ми могли з вами зв’язатися.'

// Ссылка на клиентскую форму оформления заявки на сервис (/repair/new). Для мессенджера —
// прикрепляется к ответу, когда клиент хочет отдать кораблик в сервис (wantsServiceRequest).
const SITE_URL = (process.env.SITE_URL || 'https://my.runferry.com').replace(/\/$/, '')
export const serviceRequestLink = (session) =>
  `${SITE_URL}/repair/new${session && session.id ? `?chat=${session.id}` : ''}`

// Менеджер упомянул/позвал бота в своём сообщении → сигнал вернуть бота в диалог. Требуем
// границу СЛЕВА (не-буква), чтобы «бот» не совпал с «работа»/«робота», но разрешаем окончания
// СПРАВА (\p{L}*), чтобы ловить падежные формы: бота/боту/ботів, клода, помічника, асистенте.
const BOT_MENTION_RE = /(?<![\p{L}])(клод|claude|бот|помічник|асистент|ассистент)\p{L}*/iu
export const mentionsBot = (text) => BOT_MENTION_RE.test(String(text || ''))

// Ставка нормо-часа из расшифровки (зеркало computeLaborRate в src/utils/pricing.ts)
const computeRate = (breakdown) => {
  const comps = (breakdown && breakdown.components) || []
  const salary = comps.filter((c) => c.kind === 'amount').reduce((a, c) => a + c.value, 0)
  let cumulative = salary
  for (const c of comps.filter((c) => c.kind === 'percent' && c.base !== 'revenue')) {
    const from = c.base === 'salary' ? salary : cumulative
    cumulative = round2(cumulative + (from * c.value) / 100)
  }
  const revPct = Math.min(
    comps.filter((c) => c.kind === 'percent' && c.base === 'revenue').reduce((a, c) => a + c.value, 0) / 100,
    0.99
  )
  let rate = cumulative
  if (revPct > 0) rate = round2(cumulative / (1 - revPct))
  return rate
}

// Накопление usage по сессии (зеркало accumulateUsage в ClientChatPage)
export const accumulateUsage = (prev, u) => {
  if (!u) return prev
  const base = prev || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  return {
    calls: base.calls + 1,
    inputTokens: base.inputTokens + (u.inputTokens || 0),
    outputTokens: base.outputTokens + (u.outputTokens || 0),
    costUsd: round2(base.costUsd + (u.costUsd || 0)) || base.costUsd,
  }
}

// Срок ответа менеджера при эскалации — приблизительно 48 часов (MVP)
export const escalationDue = () => new Date(Date.now() + 48 * 3600 * 1000).toISOString()

// Фабрика ядра. deps: { adminDb, anthropic, AI_MODEL, CHAT_SYSTEM, mergeConsecutiveMessages, buildUsage }
export function createMessengerCore(deps) {
  const { adminDb, anthropic, AI_MODEL, CHAT_SYSTEM, mergeConsecutiveMessages, buildUsage } = deps

  // Компактный прайс-контекст для ИИ из priceList/current
  const buildPriceContext = async () => {
    if (!adminDb) return ''
    try {
      const snap = await adminDb.doc('priceList/current').get()
      if (!snap.exists) return ''
      const pl = snap.data()
      const s = pl.settings || {}
      const rate = s.rateBreakdown ? computeRate(s.rateBreakdown) : s.laborRatePerHour || 0
      const mats = new Map((pl.materials || []).map((m) => [m.id, m]))
      return (pl.works || [])
        .filter((w) => w.active && w.publicVisible)
        .map((w) => {
          const labor = Math.round((w.laborHours || 0) * rate)
          const matCost = Math.round(
            (w.materials || []).reduce((a, r) => a + ((mats.get(r.materialId) || {}).price || 0) * (r.qty || 1), 0)
          )
          const name = (w.name && w.name.uk) || w.code
          return `${w.code} — ${name}: ~${labor + matCost} грн${matCost ? ` (робота ~${labor}, матеріали ~${matCost})` : ''}`
        })
        .join('\n')
    } catch (e) {
      console.error('core buildPriceContext:', e.message)
      return ''
    }
  }

  // Компактная выжимка базы знаний (самопомощь/консультации) из knowledgeArticles.
  // Зеркало buildKnowledgeContext в src/utils/aiContext.ts: статьи «для мастеров» не включаем.
  const buildKnowledgeContext = async () => {
    if (!adminDb) return ''
    try {
      const snap = await adminDb.collection('knowledgeArticles').limit(300).get()
      const arts = snap.docs.map((d) => d.data()).filter((a) => a.active && !a.forMasters)
      if (!arts.length) return ''
      const lines = []
      for (const a of arts) {
        const flags = [a.forConsultation ? 'консультація' : '', a.forSelfService ? 'самодопомога' : ''].filter(Boolean).join('/')
        lines.push(`### ${(a.title && a.title.uk) || ''} (${flags})`)
        lines.push((a.body && a.body.uk) || '')
        if (Array.isArray(a.videos) && a.videos.length) lines.push('Відео: ' + a.videos.map((v) => `${v.title} — ${v.url}`).join('; '))
        if (Array.isArray(a.links) && a.links.length) lines.push('Посилання: ' + a.links.join('; '))
        lines.push('')
      }
      return lines.join('\n')
    } catch (e) {
      console.error('core buildKnowledgeContext:', e.message)
      return ''
    }
  }

  const newSession = (channel, channelUserId, name) => ({
    id: genSessionId(channel.slice(0, 3)),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'active',
    lang: 'uk',
    requestId: null,
    contact: name ? { name } : null,
    messages: [],
    escalation: null,
    reminders: [],
    channel,
    channelUserId: String(channelUserId),
  })

  const findSession = async (channel, channelUserId) => {
    const q = await adminDb
      .collection('chatSessions')
      .where('channel', '==', channel)
      .where('channelUserId', '==', String(channelUserId))
      .limit(1)
      .get()
    return q.empty ? null : q.docs[0].data()
  }

  const saveSession = async (session) => {
    await adminDb.collection('chatSessions').doc(session.id).set({ ...session, updatedAt: nowIso() })
  }

  // Транзакционная ДОЗАПИСЬ сообщений: перечитывает актуальный документ и добавляет newMsgs к
  // ТЕКУЩЕМУ messages (а не к устаревшему снимку), + патч полей. Так параллельное сообщение
  // клиента, пришедшее во время медленного вызова ИИ, не теряется (не last-writer-wins).
  const appendMessages = async (sessionId, newMsgs, patch = {}) =>
    adminDb.runTransaction(async (tx) => {
      const ref = adminDb.collection('chatSessions').doc(String(sessionId))
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      const cur = snap.data()
      const merged = { ...cur, ...patch, messages: [...(cur.messages || []), ...(newMsgs || [])], updatedAt: nowIso() }
      tx.set(ref, merged, { merge: true })
      return merged
    })

  const upsertProfile = async (phone, { name, sessionId } = {}) => {
    const id = normalizePhone(phone)
    if (!id) return
    await adminDb
      .collection('clientProfiles')
      .doc(id)
      .set(
        {
          id,
          phone: id,
          updatedAt: nowIso(),
          ...(name ? { name } : {}),
          ...(sessionId ? { sessionIds: FieldValue.arrayUnion(sessionId) } : {}),
        },
        { merge: true }
      )
  }

  // Захват телефона из текста клиента (если ещё не сохранён) + привязка профиля. true, если захвачен.
  const captureContactPhone = async (session, text) => {
    if (session.contact && session.contact.phone) return false
    const phone = extractPhone(text)
    if (!phone) return false
    session.contact = { ...(session.contact || {}), phone }
    await upsertProfile(phone, { name: session.contact && session.contact.name, sessionId: session.id })
    return true
  }

  // Вернуть строку-просьбу прислать телефон, если его ещё нет и ещё не просили (ставит phoneAsked).
  const phoneAskLine = (session) => {
    if (session.contact && session.contact.phone) return ''
    if (session.phoneAsked) return ''
    session.phoneAsked = true
    return PHONE_ASK
  }

  const ESCALATION_REASON = {
    service: 'Автоматичний помічник передав сервісний запит менеджеру',
    sales: 'Питання щодо купівлі/продажу кораблика — потрібен менеджер з продажу',
    other: 'Автоматичний помічник передав запит менеджеру',
  }
  const applyEscalation = (session, intent = 'service') => {
    if (session.status !== 'active') return
    session.status = 'escalated'
    session.escalation = {
      escalatedAt: nowIso(),
      reason: ESCALATION_REASON[intent] || ESCALATION_REASON.service,
      dueAt: escalationDue(),
      resolvedAt: null,
      managerEmail: null,
    }
  }

  // Ответ ИИ по истории сессии (тот же CHAT_SYSTEM, что и в веб-чате).
  // opts.managerDirective — указание менеджера боту (Telegram Business: менеджер позвал бота).
  const aiReply = async (session, opts = {}) => {
    const history = mergeConsecutiveMessages(
      session.messages
        .filter((m) => !m.internal && m.text)
        .map((m) => ({ role: m.role === 'client' ? 'user' : 'assistant', content: String(m.text) }))
    )
    // Модель должна отвечать на последнее сообщение КЛИЕНТА → убираем хвостовые assistant-реплики
    // (в т.ч. ручную реплику менеджера, которой он позвал бота — её смысл идёт через директиву).
    while (history.length && history[history.length - 1].role === 'assistant') history.pop()
    if (!history.length || history[0].role !== 'user') {
      return { reply: 'Опишіть, будь ласка, вашу проблему з корабликом.', needsManager: false, intent: 'service' }
    }
    const [priceContext, knowledgeContext] = await Promise.all([buildPriceContext(), buildKnowledgeContext()])
    const selfHelp = knowledgeContext
      ? `\n\nСАМОДОПОМОГА (безкоштовні рішення з бази знань). ЯКЩО проблема клієнта збігається з якимось матеріалом — СПЕРШУ доброзичливо запропонуй це безкоштовне рішення (стисло, по кроках), і лише потім платний ремонт:\n${knowledgeContext}`
      : ''
    const directive = opts.managerDirective
      ? `\n\nМЕНЕДЖЕР попросив тебе підключитися до діалогу і допомогти клієнту. Вказівка менеджера: «${String(opts.managerDirective).trim()}». Продовж діалог з клієнтом українською, виконуючи цю вказівку (звертайся до клієнта, не до менеджера).`
      : ''
    const system =
      CHAT_SYSTEM +
      (priceContext ? `\n\nПРАЙС (лише ці позиції можна використовувати для оцінки):\n${priceContext}` : '') +
      selfHelp +
      directive
    try {
      const msg = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 1500,
        system,
        messages: history,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reply: { type: 'string' },
                needsManager: { type: 'boolean' },
                intent: { type: 'string', enum: ['service', 'sales', 'other'], description: 'Тема звернення: сервіс/ремонт, купівля/продаж, інше' },
                wantsServiceRequest: { type: 'boolean', description: 'true, якщо клієнт хоче віддати кораблик у сервіс / оформити заявку на ремонт (тоді додамо посилання на оформлення)' },
              },
              required: ['reply', 'needsManager', 'intent', 'wantsServiceRequest'],
            },
          },
        },
      })
      const raw = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = { reply: raw, needsManager: false, intent: 'service' }
      }
      return {
        reply: parsed.reply || 'Вибачте, не вдалося сформувати відповідь.',
        needsManager: !!parsed.needsManager,
        intent: ['service', 'sales', 'other'].includes(parsed.intent) ? parsed.intent : 'service',
        wantsServiceRequest: !!parsed.wantsServiceRequest,
        usage: buildUsage(msg.usage),
      }
    } catch (e) {
      console.error('core aiReply error:', e.message)
      return { reply: 'Вибачте, сталася технічна помилка. Спробуйте, будь ласка, ще раз трохи пізніше.', needsManager: false, intent: 'service' }
    }
  }

  return { buildPriceContext, newSession, findSession, saveSession, appendMessages, upsertProfile, applyEscalation, aiReply, captureContactPhone, phoneAskLine }
}

export default createMessengerCore
