// Telegram-бот СОТРУДНИКОВ по заявкам — транспорт (вебхук, отправка, кнопки подтверждения,
// привязка аккаунта). Бизнес-логика (поиск заявок, ИИ-разбор, применение изменений) — в
// staffBotCore.js. Отдельный бот (TELEGRAM_STAFF_BOT_TOKEN) — не клиентский агрегатор и не
// операторский бот звонков. Без токена модуль «спит» (безопасно деплоится).
//
// Поток: сотрудник в портале (Заявки → «Telegram-бот») получает ссылку t.me/<бот>?start=<токен>
// → бот привязывает его Telegram к users/{uid} (роль/центры берутся оттуда при КАЖДОМ сообщении)
// → пишет боту «найди заявку 067…», «включи туди доставку 560 грн» → ИИ ищет/готовит действие
// → бот показывает кнопки «Підтвердити / Скасувати» (или слово «так/ні») → запись в Firestore.
import axios from 'axios'
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'
import { createStaffBotCore, STAFF_ROLES, ROLE_LABELS } from './staffBotCore.js'
import { nowIso } from './messengerCore.js'

const YES_RE = /^\s*(так|да|ок|ok|окей|yes|підтверджую|подтверждаю|підтвердити|подтвердить|✅)[\s!.]*$/iu
const NO_RE = /^\s*(ні|нет|no|скасувати|скасуй|отмена|отменить|відміна|cancel|❌)[\s!.]*$/iu
const CB_RE = /^sb:(ok|no):([\w-]{4,32})$/
const AI_TURNS_PER_10MIN = 40
const TG_MAX = 4000
// Слово «так/ні» действует лишь на пропозицию из ПОСЛЕДНЕГО ответа бота и не старше 30 мин; кнопка с
// явным id — до 24 ч. Иначе забытая дія применилась бы ответом «так» на другой вопрос.
const WORD_CONFIRM_MS = 30 * 60 * 1000
const BUTTON_CONFIRM_MS = 24 * 60 * 60 * 1000
// Отказы, после которых ту же дію можно повторить позже (оплата идёт, параллельная правка, техошибка).
const RETRYABLE = (r) => r.code === 'CONFLICT' || (r.code === 'BLOCKED' && r.reason === 'PAYING') || !r.code

const HELP = [
  'Я помічник по заявках на обслуговування. Пишіть звичайною мовою, наприклад:',
  '• «знайди заявку від 067 383 3000»',
  '• «заявка Петренко» або «заявка 1234»',
  '• «включи туди додаткові витрати на доставку 560 грн»',
  '• «запиши діагностику: згорів регулятор ходу»',
  '• «постав ТТН 20450123456789» / «статус — в роботі»',
  'Будь-яку зміну я спочатку покажу і попрошу підтвердити кнопкою (або словом «так»/«ні»).',
  'Команди: /help — підказка, /cancel — скасувати очікувану дію, /me — хто я.',
].join('\n')

const NOT_LINKED = 'Цей бот — лише для співробітників сервісу RunFerry. Щоб підключитися: увійдіть у портал → «Заявки на обслуговування» → кнопка «Telegram-бот» і відкрийте посилання.'

export function registerStaffBot(app, deps) {
  const { adminDb } = deps
  const TOKEN = process.env.TELEGRAM_STAFF_BOT_TOKEN || ''
  const SECRET = process.env.TELEGRAM_STAFF_WEBHOOK_SECRET || ''
  const core = createStaffBotCore(deps)
  // Fail closed: личность сотрудника берётся из from.id апдейта, поэтому без секрета вебхука любой мог бы
  // прислать апдейт «от владельца». Без токена ИЛИ секрета вебхук/настройка не регистрируются; маршрут
  // ссылки привязки остаётся и честно отвечает 503 (кнопка в портале показывает причину).
  const ENABLED = !!(TOKEN && SECRET)
  if (!TOKEN) console.log('staffBot: TELEGRAM_STAFF_BOT_TOKEN не задано — бот співробітників вимкнено (див. .env.example)')
  else if (!SECRET) console.error('staffBot: потрібен TELEGRAM_STAFF_WEBHOOK_SECRET — бот співробітників вимкнено')

  const api = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`
  const tg = async (method, payload) => {
    if (!TOKEN) return null
    try {
      const r = await axios.post(api(method), payload, { timeout: 15000 })
      return r.data
    } catch (e) {
      console.error(`staffBot tg ${method}:`, (e.response && e.response.data) || e.message)
      return null
    }
  }
  // Длинные ответы режем по 4000 символов (лимит Telegram 4096); кнопки — к последнему куску.
  const send = async (chatId, text, extra = {}) => {
    const s = String(text || '')
    const parts = []
    for (let i = 0; i < s.length; i += TG_MAX) parts.push(s.slice(i, i + TG_MAX))
    if (!parts.length) parts.push('…')
    let last = null
    for (let i = 0; i < parts.length; i++) {
      last = await tg('sendMessage', { chat_id: chatId, text: parts[i], ...(i === parts.length - 1 ? extra : {}) })
    }
    return last
  }
  const confirmKeyboard = (actionId) => ({
    reply_markup: { inline_keyboard: [[
      { text: '✅ Підтвердити', callback_data: `sb:ok:${actionId}` },
      { text: '❌ Скасувати', callback_data: `sb:no:${actionId}` },
    ]] },
  })

  let cachedUsername = process.env.TELEGRAM_STAFF_BOT_USERNAME || ''
  const botUsername = async () => {
    if (cachedUsername || !TOKEN) return cachedUsername
    try {
      const { data } = await axios.get(api('getMe'), { timeout: 10000 })
      cachedUsername = (data && data.result && data.result.username) || ''
    } catch (e) {
      console.error('staffBot getMe:', e.message)
    }
    return cachedUsername
  }

  // ---- Привязка из портала: POST /api/staff-bot/link (любой активный сотрудник) ----
  const linkLimiter = rateLimit({ name: 'staff-bot-link', windowMs: 10 * 60 * 1000, max: 20 })
  app.post('/api/staff-bot/link', linkLimiter, async (req, res) => {
    const staff = await verifyFirebaseStaff(req, STAFF_ROLES)
    if (!staff) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для співробітників сервісу' } })
    if (!adminDb) return res.status(503).json({ success: false })
    if (!ENABLED) return res.status(503).json({ success: false, error: { code: 'NO_BOT', message: 'Бот співробітників не налаштовано (TELEGRAM_STAFF_BOT_TOKEN / TELEGRAM_STAFF_WEBHOOK_SECRET)' } })
    try {
      const username = await botUsername()
      if (!username) return res.status(503).json({ success: false, error: { code: 'NO_USERNAME', message: 'Не вдалося отримати імʼя бота (getMe)' } })
      const token = await core.createLinkToken(staff)
      const prof = await adminDb.collection('users').doc(staff.uid).get()
      const connected = !!(prof.exists && prof.data().telegramUserId)
      return res.json({ success: true, data: { url: `https://t.me/${username}?start=${token}`, connected, expiresInMin: 30 } })
    } catch (e) {
      console.error('staffBot link:', e && e.message)
      res.status(500).json({ success: false, error: { code: 'LINK_FAILED', message: 'Не вдалося створити посилання' } })
    }
  })

  // ---- Очередь на чат: сообщения одного чата обрабатываем строго по порядку (сессия в Firestore) ----
  const chains = new Map()
  const enqueue = (chatId, fn) => {
    const prev = chains.get(chatId) || Promise.resolve()
    const next = prev.then(fn, fn).catch((e) => console.error('staffBot handler:', e && e.message))
    chains.set(chatId, next)
    next.finally(() => { if (chains.get(chatId) === next) chains.delete(chatId) })
    return next
  }

  // Лимит ИИ-ходов на чат (защита бюджета Anthropic): скользящее окно 10 минут.
  const aiHits = new Map()
  const aiAllowed = (chatId) => {
    const now = Date.now()
    const arr = (aiHits.get(chatId) || []).filter((t) => now - t < 10 * 60 * 1000)
    if (arr.length >= AI_TURNS_PER_10MIN) { aiHits.set(chatId, arr); return false }
    arr.push(now); aiHits.set(chatId, arr)
    return true
  }
  setInterval(() => { const now = Date.now(); for (const [k, arr] of aiHits) { const a = arr.filter((t) => now - t < 10 * 60 * 1000); if (a.length) aiHits.set(k, a); else aiHits.delete(k) } }, 10 * 60 * 1000).unref?.()

  const pushMsg = (session, role, text) => {
    session.messages = [...(session.messages || []), { role, text: String(text || '').slice(0, 4000), at: nowIso() }]
  }

  // Выполнить ожидающее действие (после кнопки/слова «так»). Действие забирается атомарно (claimPending):
  // двойное нажатие или параллельный инстанс получат null и ничего не применят.
  const applyPending = async (chatId, staff, session, actionId, maxAgeMs) => {
    const action = await core.claimPending(chatId, actionId, maxAgeMs)
    session.pendingAction = null
    session.awaitingActionId = null
    if (!action) { await send(chatId, 'Ця дія вже виконана, застаріла або неактуальна. Опишіть зміну ще раз — я підготую нову.'); return }
    const r = await core.applyAction(staff, action)
    pushMsg(session, 'assistant', r.text)
    if (r.ok) session.currentRequestId = action.requestId
    // Повторяемый отказ — возвращаем ту же дію с кнопками (тот же id → тот же clientKey, без дубля).
    const restored = !r.ok && RETRYABLE(r) && await core.restorePending(chatId, action)
    if (restored) session.awaitingActionId = action.id
    await core.saveSession(session)
    if (restored) await send(chatId, `${r.text}\n\n🔸 ${action.summary}\nМожна повторити тією ж кнопкою.`, confirmKeyboard(action.id))
    else await send(chatId, r.text)
  }
  const cancelPending = async (chatId, session, actionId) => {
    session.awaitingActionId = null
    const action = await core.claimPending(chatId, actionId)
    session.pendingAction = null
    if (!action) { await send(chatId, 'Немає дій, що очікують підтвердження.'); return }
    pushMsg(session, 'assistant', 'Дію скасовано.')
    await core.saveSession(session)
    await send(chatId, 'Скасовано. Нічого не змінено.')
  }

  const handleMessage = async (m) => {
    const chat = m.chat
    if (!chat || chat.type !== 'private' || !m.from) return
    const chatId = chat.id
    const text = (m.text || '').trim()
    if (!text) { await send(chatId, 'Надішліть, будь ласка, текстове повідомлення.'); return }

    // /start <токен> — привязка сотрудника из портала.
    if (/^\/start\s+\S+/.test(text)) {
      const token = text.split(/\s+/)[1]
      const r = await core.consumeLinkToken(token, m.from, chatId)
      if (r.ok) {
        await send(chatId, `✅ Підключено: ${r.staff.name} (${ROLE_LABELS[r.staff.role] || r.staff.role}).\n\n${HELP}`)
      } else {
        const why = r.reason === 'expired' ? 'посилання прострочене (діє 30 хв)' : r.reason === 'used' ? 'посилання вже використане' : r.reason === 'inactive' ? 'профіль співробітника неактивний' : 'посилання недійсне'
        await send(chatId, `⛔ Не вдалося підключити: ${why}. Отримайте нове посилання в порталі (Заявки → «Telegram-бот»).`)
      }
      return
    }

    const staff = await core.resolveStaffByTelegram(m.from.id)
    if (!staff) { await send(chatId, NOT_LINKED); return }

    if (text === '/start' || text === '/help') { await send(chatId, HELP); return }
    if (text === '/me') { await send(chatId, `${staff.name} — ${ROLE_LABELS[staff.role] || staff.role}${staff.centers.length ? `, центри: ${staff.centers.length}` : ''}`); return }

    const session = await core.loadSession(chatId)
    session.staffUid = staff.uid
    session.staffEmail = staff.email

    if (text === '/cancel') { await cancelPending(chatId, session, null); return }
    // Ожидающее действие: «так» → виконати, «ні» → скасувати — только если пропозиция была в ПОСЛЕДНЕМ
    // ответе бота (awaitingActionId) и свежая; иначе слово уходит в ИИ, а кнопки работают по явному id.
    let prevPending = session.pendingAction || null
    // Просроченная пропозиция (кнопка уже не сработает) — снимаем, чтобы ИИ не просил её подтвердить.
    if (prevPending && await core.expirePending(chatId, prevPending, BUTTON_CONFIRM_MS)) {
      session.pendingAction = null; session.awaitingActionId = null; prevPending = null
    }
    if (prevPending && session.awaitingActionId === prevPending.id) {
      const pid = prevPending.id
      if (YES_RE.test(text)) { pushMsg(session, 'user', text); await applyPending(chatId, staff, session, pid, WORD_CONFIRM_MS); return }
      if (NO_RE.test(text)) { pushMsg(session, 'user', text); await cancelPending(chatId, session, pid); return }
    }

    if (!aiAllowed(chatId)) { await send(chatId, 'Забагато запитів поспіль. Зачекайте кілька хвилин.'); return }
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

    const { reply, pendingAction, usage } = await core.aiTurn({ session, staff, text })
    pushMsg(session, 'user', text)
    pushMsg(session, 'assistant', reply)
    if (usage) session.aiUsage = { calls: (session.aiUsage?.calls || 0) + usage.calls, inputTokens: (session.aiUsage?.inputTokens || 0) + usage.inputTokens, outputTokens: (session.aiUsage?.outputTokens || 0) + usage.outputTokens, costUsd: Math.round(((session.aiUsage?.costUsd || 0) + usage.costUsd) * 10000) / 10000 }
    // «так/ні» после этого ответа относится только к пропозиции из него (или ни к чему).
    session.awaitingActionId = pendingAction ? pendingAction.id : null
    await core.saveSession(session)
    if (pendingAction) await core.setPending(chatId, pendingAction) // новая пропозиция заменяет прежнюю (её кнопки устаревают)
    if (pendingAction) {
      const replaced = prevPending && prevPending.id !== pendingAction.id
        ? `\n\n⚠️ Попередню дію «${prevPending.summary}» НЕ виконано — її замінено цією.` : ''
      await send(chatId, `${reply}\n\n🔸 ${pendingAction.summary}${replaced}`, confirmKeyboard(pendingAction.id))
    } else {
      await send(chatId, reply)
    }
  }

  // Нажатие уже подтверждено Telegram и кнопки сняты в вебхуке (до очереди чата — без «висящего» спиннера),
  // поэтому результат сообщаем обычным сообщением.
  const handleCallback = async (cq) => {
    const msg = cq.message
    const chatId = msg && msg.chat && msg.chat.id
    const mt = CB_RE.exec(String(cq.data || ''))
    if (!chatId || !mt || !cq.from) return
    const [, verb, actionId] = mt
    const staff = await core.resolveStaffByTelegram(cq.from.id)
    if (!staff) { await send(chatId, NOT_LINKED); return }
    const session = await core.loadSession(chatId)
    // Сверка id и срока — внутри claimPending (атомарно).
    if (verb === 'ok') await applyPending(chatId, staff, session, actionId, BUTTON_CONFIRM_MS)
    else await cancelPending(chatId, session, actionId)
  }

  if (!ENABLED) return { core, handleMessage, handleCallback }

  app.post('/api/staff-bot/webhook', async (req, res) => {
    // Отвечаем 200 сразу, чтобы Telegram не ретраил доставку.
    res.sendStatus(200)
    try {
      if (req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) { console.warn('staffBot webhook: bad secret token'); return }
      if (!adminDb) return
      const u = req.body || {}
      if (u.callback_query) {
        const cq = u.callback_query
        const chatId = cq.message && cq.message.chat && cq.message.chat.id
        // Сразу: ответ на нажатие и снятие кнопок (повторные нажатия всё равно отсечёт claimPending).
        tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})
        if (chatId && cq.message.message_id) tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
        if (chatId && cq.message.chat.type === 'private') enqueue(chatId, () => handleCallback(cq))
        return
      }
      if (u.message && u.message.chat) enqueue(u.message.chat.id, () => handleMessage(u.message))
    } catch (e) {
      console.error('staffBot webhook error:', e.message)
    }
  })

  // Разовая настройка вебхука. Секрет — в ЗАГОЛОВКЕ (query попадал бы в логи Cloud Run):
  // curl -H "X-Setup-Secret: <TELEGRAM_STAFF_WEBHOOK_SECRET>" "https://<бэкенд>/api/staff-bot/setup?url=https://<бэкенд>/api/staff-bot/webhook"
  const setupAuthorized = (req) => req.get('X-Setup-Secret') === SECRET
  app.get('/api/staff-bot/setup', async (req, res) => {
    if (!setupAuthorized(req)) return res.status(403).json({ error: 'bad secret' })
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'pass ?url=https://<домен>/api/staff-bot/webhook' })
    try {
      const r = await axios.post(api('setWebhook'), { url, secret_token: SECRET || undefined, allowed_updates: ['message', 'callback_query'] })
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })

  app.get('/api/staff-bot/info', async (req, res) => {
    if (!setupAuthorized(req)) return res.status(403).json({ error: 'bad secret' })
    try {
      const r = await axios.get(api('getWebhookInfo'))
      res.json(r.data)
    } catch (e) {
      res.status(500).json({ error: (e.response && e.response.data) || e.message })
    }
  })

  return { core, handleMessage, handleCallback }
}

export default registerStaffBot
