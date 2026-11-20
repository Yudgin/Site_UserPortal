// Ядро Telegram-бота СОТРУДНИКОВ по заявкам (без транспорта): привязка сотрудника, поиск заявок,
// детали, диалог с ИИ, который разбирает свободный текст («найди заявку от 067…», «включи туда
// доставку 560 грн») в вызовы инструментов, и тексты ответов. Любое ИЗМЕНЕНИЕ данных — двухфазное:
// ИИ лишь ПРЕДЛАГАЕТ действие (propose_*), сотрудник подтверждает кнопкой/словом, и только тогда
// applyAction пишет в Firestore — через ОБЩЕЕ ядро estimateEngine.js (его же используют HTTP-маршруты
// приложения сотрудников): расчёты кошторису, права и транзакции живут там, здесь — только Telegram.
import crypto from 'crypto'
import { normalizePhone, accumulateUsage, nowIso } from './messengerCore.js'
import {
  STAFF_ROLES, STATUS_LABELS, DIAG_MAX, round2, clip, newId, displayNo, tName, normTtn, validateExpense,
  staffFromProfile, requestVisible, canEditRequest, canEditEstimate, createEstimateOps,
} from './estimateEngine.js'

export { STAFF_ROLES, STATUS_LABELS, round2, displayNo }

const SCAN_LIMIT = 2000 // fallback-поиск по последним заявкам (телефон в свободном формате / ПІБ / номер)
const MAX_RESULTS = 10
const LINK_TTL_MS = 30 * 60 * 1000
const HISTORY_MSGS = 16 // сколько последних реплик диалога отдаём ИИ
const AI_ITERATIONS = 6 // максимум вызовов модели на одно сообщение
const VIA = 'telegram-bot' // source записей extraExpenses и lastEditedVia
const DIAG_SHOWN = 1500 // сколько символов диагностики видит ИИ

export const ROLE_LABELS = { owner: 'власник', director: 'директор сервісу', accountant: 'бухгалтер', master: 'майстер' }

export const fmtMoney = (n) => `${round2(n).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} грн`

// Варианты записи украинского номера, как его могли сохранить в clientPhone (форма клиента пишет
// «+380…», синхронизация 1С — «380…», мастер в карточке — как угодно). Для точного запроса `in`.
export const phoneVariants = (norm) => {
  if (!/^380\d{9}$/.test(norm)) return norm ? [norm] : []
  const op = norm.slice(3, 5), a = norm.slice(5, 8), b = norm.slice(8, 10), c = norm.slice(10)
  const local = `0${op}${a}${b}${c}`
  return [...new Set([
    norm, `+${norm}`, local,
    `+380 ${op} ${a} ${b} ${c}`, `380 ${op} ${a} ${b} ${c}`, `+380${op} ${a} ${b} ${c}`,
    `0${op} ${a} ${b} ${c}`, `0${op}-${a}-${b}-${c}`, `0${op} ${a} ${b}${c}`, `0${op} ${a}${b}${c}`,
    `+38 0${op} ${a} ${b} ${c}`, `+38 (0${op}) ${a}-${b}-${c}`, `+38(0${op})${a}-${b}-${c}`, `(0${op}) ${a}-${b}-${c}`,
    `38 0${op} ${a} ${b} ${c}`, `8 0${op} ${a} ${b} ${c}`,
  ])]
}

// ==== Фабрика ядра ====
// deps: { adminDb, anthropic, AI_MODEL, buildUsage, mergeConsecutiveMessages, siteUrl }
export function createStaffBotCore(deps) {
  const { adminDb, anthropic, AI_MODEL, buildUsage } = deps
  const siteUrl = String(deps.siteUrl || 'https://my.runferry.com').replace(/\/$/, '')
  const mergeConsecutive = deps.mergeConsecutiveMessages || ((msgs) => msgs.reduce((acc, m) => {
    const last = acc[acc.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else acc.push({ role: m.role, content: m.content })
    return acc
  }, []))
  const ops = createEstimateOps({ adminDb })
  const col = (name) => adminDb.collection(name)
  const getDoc = ops.getDoc
  const requestLink = (id) => `${siteUrl}/service-request/${id}`

  // ---- Сотрудники: привязка Telegram ↔ users/{uid} ----

  // Сотрудник по Telegram-id: активный профиль с ролью персонала. Оператор дзвінків — не персонал.
  const resolveStaffByTelegram = async (tgUserId) => {
    const id = Number(tgUserId)
    if (!id) return null
    const q = await col('users').where('telegramUserId', '==', id).limit(2).get()
    if (q.empty) return null
    // Один Telegram — один профиль. Два совпадения (гонка привязки, ручная правка) — не выбираем по
    // порядку документов (это дало бы чужие права), а отказываем и пишем в лог.
    if (q.docs.length > 1) { console.error('staffBot: telegramUserId привʼязано до кількох профілів:', q.docs.map((d) => d.id).join(',')); return null }
    const p = q.docs[0].data()
    if (p.active !== true || !STAFF_ROLES.includes(p.role)) return null
    return staffFromProfile(q.docs[0].id, p)
  }

  // Одноразовый токен привязки (выдаётся из портала залогиненному сотруднику).
  const createLinkToken = async (staff) => {
    const token = crypto.randomBytes(24).toString('base64url')
    const now = Date.now()
    await col('staffTgLinks').doc(token).set({
      uid: staff.uid, email: staff.email, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LINK_TTL_MS).toISOString(), usedAt: null,
    })
    return token
  }

  // /start <токен>: привязать Telegram-аккаунт к профилю сотрудника (и отвязать от других профилей).
  const consumeLinkToken = async (token, from, chatId) => {
    if (!token || !/^[\w-]{20,64}$/.test(token)) return { ok: false, reason: 'unknown' }
    const ref = col('staffTgLinks').doc(token)
    const s = await ref.get()
    if (!s.exists) return { ok: false, reason: 'unknown' }
    const L = s.data()
    if (L.usedAt) return { ok: false, reason: 'used' }
    if (!L.expiresAt || Date.parse(L.expiresAt) < Date.now()) return { ok: false, reason: 'expired' }
    const userRef = col('users').doc(String(L.uid))
    const us = await userRef.get()
    if (!us.exists) return { ok: false, reason: 'nouser' }
    const p = us.data()
    if (p.active !== true || !STAFF_ROLES.includes(p.role)) return { ok: false, reason: 'inactive' }
    const tgId = Number(from.id)
    const dup = await col('users').where('telegramUserId', '==', tgId).get()
    for (const d of dup.docs) {
      if (d.id !== String(L.uid)) await d.ref.set({ telegramUserId: null, telegramChatId: null, updatedAt: nowIso() }, { merge: true })
    }
    await userRef.set({
      telegramUserId: tgId, telegramChatId: String(chatId), telegramUsername: from.username || null,
      telegramLinkedAt: nowIso(), updatedAt: nowIso(),
    }, { merge: true })
    await ref.set({ usedAt: nowIso(), telegramUserId: tgId }, { merge: true })
    return { ok: true, staff: staffFromProfile(String(L.uid), p) }
  }

  // ---- Поиск и детали заявок ----

  const SUMMARY_FIELDS = ['clientPhone', 'clientName', 'status', 'createdAt', 'updatedAt', 'boat', 'serviceCenterId',
    'externalRequestId', 'onec', 'actualEstimateId', 'offerId', 'complaint', 'extraExpenses', 'waybillNumber', 'returnTtn', 'paymentId']

  const matchesNumber = (id, r, number) => {
    const n = String(number || '').trim().toLowerCase()
    if (!n) return false
    const nz = n.replace(/^0+/, '')
    const onecNo = String((r.onec && r.onec.number) || '').replace(/^0+/, '').toLowerCase()
    const lid = String(id).toLowerCase()
    return lid === n || (n.length >= 6 && lid.endsWith(n)) || String(r.externalRequestId || '').toLowerCase() === n || (!!nz && onecNo === nz)
  }

  const summarize = (id, r) => ({
    id,
    number: displayNo(id, r),
    clientName: r.clientName || '',
    clientPhone: r.clientPhone || '',
    boat: r.boat || '',
    status: r.status || 'new',
    statusLabel: STATUS_LABELS[r.status] || r.status || '',
    createdAt: String(r.createdAt || '').slice(0, 10),
    complaint: clip(r.complaint, 160),
    serviceCenterId: r.serviceCenterId || null,
    hasActualEstimate: !!r.actualEstimateId,
    paid: !!r.paymentId,
    extraExpensesCount: Array.isArray(r.extraExpenses) ? r.extraExpenses.length : 0,
  })

  // Поиск заявок: телефон (точный запрос по вариантам записи, затем скан последних заявок с
  // нормализацией), ПІБ (подстрока), номер (1С/внешний/наш id). Только видимые сотруднику.
  const findRequests = async (staff, { phone, name, number } = {}) => {
    const found = new Map()
    const push = (id, r) => { if (!found.has(id)) found.set(id, r) }
    const norm = phone ? normalizePhone(phone) : ''
    const nameQ = String(name || '').trim().toLowerCase()
    const numQ = String(number || '').trim()
    if (!norm && !nameQ && !numQ) return { error: 'Вкажіть телефон, ПІБ або номер заявки.' }

    if (norm) {
      const q = await col('serviceRequests').where('clientPhone', 'in', phoneVariants(norm).slice(0, 30)).limit(30).get()
      q.docs.forEach((d) => push(d.id, d.data()))
    }
    if (numQ && /^[\w-]{6,}$/.test(numQ)) {
      // Прямое попадание по нашему id / sr-ext-<guid>
      const direct = await getDoc('serviceRequests', numQ).catch(() => null)
      if (direct) push(direct.id, direct)
    }
    // Скан с нормализацией — всегда, когда есть телефон: точный запрос `in` ловит не все записи номера
    // («+38 067 383 3000», «+380 67 3833000»…), а одна старая находка не должна скрыть новую заявку.
    const needScan = !!norm || !!nameQ || !!numQ
    if (needScan) {
      const snap = await col('serviceRequests').orderBy('createdAt', 'desc').limit(SCAN_LIMIT).select(...SUMMARY_FIELDS).get()
      for (const d of snap.docs) {
        const r = d.data()
        const hit = (norm && normalizePhone(r.clientPhone) === norm)
          || (nameQ && String(r.clientName || '').toLowerCase().includes(nameQ))
          || (numQ && matchesNumber(d.id, r, numQ))
        if (hit) push(d.id, r)
      }
    }
    const visible = [...found.entries()].filter(([, r]) => requestVisible(staff, r))
    visible.sort((a, b) => String(b[1].createdAt || '').localeCompare(String(a[1].createdAt || '')))
    return {
      total: visible.length,
      hiddenByAccess: found.size - visible.length,
      requests: visible.slice(0, MAX_RESULTS).map(([id, r]) => summarize(id, r)),
    }
  }

  const estimateSummary = (e) => e ? ({
    id: e.id,
    total: round2(e.total || 0),
    status: e.status || 'approved',
    paid: e.status === 'paid' || !!e.paymentId,
    discount: e.discount || null,
    parentEstimateId: e.parentEstimateId || null,
    lines: (e.lines || []).slice(0, 40).map((l) => ({ name: tName(l.name), qty: l.qty, lineTotal: l.lineTotal, extra: !!l.extra, refId: l.refId })),
    linesCount: (e.lines || []).length,
    link: `${siteUrl}/estimate/${e.id}`,
  }) : null

  const getRequestDetails = async (staff, requestId) => {
    const sr = await getDoc('serviceRequests', requestId)
    if (!sr) return { error: 'Заявку не знайдено.' }
    if (!requestVisible(staff, sr)) return { error: 'Заявка належить іншому сервісному центру — доступу немає.' }
    const actual = sr.actualEstimateId ? await getDoc('priceEstimates', sr.actualEstimateId) : null
    return {
      request: {
        ...summarize(sr.id, sr),
        diagnostics: sr.diagnostics && sr.diagnostics.text ? {
          text: clip(sr.diagnostics.text, DIAG_SHOWN), at: sr.diagnostics.at || null,
          length: String(sr.diagnostics.text).length, truncated: String(sr.diagnostics.text).length > DIAG_SHOWN,
        } : null,
        waybillNumber: sr.waybillNumber || null,
        returnTtn: sr.returnTtn || null,
        clientCity: sr.clientCityName || null,
        clientWarehouse: sr.clientWarehouseName || null,
        specialists: (sr.specialists || []).map((s) => s.name).filter(Boolean),
        extraExpenses: (sr.extraExpenses || []).map((x) => ({ id: x.id, title: x.title, amount: x.amount, at: x.at, by: x.by, inEstimate: !!x.appliedToEstimateId })),
        link: requestLink(sr.id),
      },
      actualEstimate: estimateSummary(actual),
      permissions: { canEditRequest: canEditRequest(staff, sr), canEditEstimate: canEditEstimate(staff, sr) },
    }
  }

  // ---- Действия (после подтверждения сотрудником) → текст для Telegram ----

  const reqLabel = (req) => `№${req.number}${req.clientName ? ` (${req.clientName})` : ''}`

  const textForAdd = (r) => {
    const { request, expense, applied } = r.data
    if (r.code === 'DUPLICATE') return `ℹ️ Витрату «${expense.title}» (${fmtMoney(expense.amount)}) уже додано в заявку ${reqLabel(request)} — повторно не додаю.`
    if (!applied) {
      return `✅ Записано «${expense.title}» — ${fmtMoney(expense.amount)} у заявку ${reqLabel(request)}. Фактичного кошторису ще немає — витрата підставиться автоматично під час його складання.\n${requestLink(request.id)}`
    }
    let text = `✅ Додано «${expense.title}» — ${fmtMoney(expense.amount)} у фактичний кошторис заявки ${reqLabel(request)}.\nСума кошторису: ${fmtMoney(r.data.prevTotal)} → ${fmtMoney(r.data.total)}.`
    if (r.data.reapproval.required) text += `\n⚠️ Зростання ${r.data.reapproval.diffPercent}% перевищує поріг ${r.data.reapproval.thresholdPct}% від попереднього кошторису — статус «очікує погодження», клієнт має погодити перед оплатою.`
    else if (r.data.status === 'approved') text += '\nКошторис погоджено (у межах порогу).'
    return `${text}\n${siteUrl}/estimate/${r.data.estimateId}`
  }
  const textForRemove = (r) => {
    const { request, expense, applied } = r.data
    if (!applied) return `✅ Вилучено «${expense.title}» (${fmtMoney(expense.amount)}) із заявки ${reqLabel(request)}.`
    return `✅ Вилучено «${expense.title}» (${fmtMoney(expense.amount)}) із фактичного кошторису заявки ${reqLabel(request)}.\nСума кошторису: ${fmtMoney(r.data.prevTotal)} → ${fmtMoney(r.data.total)}.`
  }
  const textForUpdate = (r) => `✅ Заявку ${reqLabel(r.data.request)} оновлено:\n• ${r.data.changes.map((c) => c.label).join('\n• ')}\n${requestLink(r.data.request.id)}`

  // Применить подтверждённое действие. Все проверки — заново, по свежим данным (внутри ops).
  const applyAction = async (staff, action) => {
    try {
      let r
      switch (action && action.type) {
        // clientKey = id дії: повторне застосування тієї ж дії (подвійне натискання, інший інстанс) — DUPLICATE.
        case 'add_extra_expense': r = await ops.addExtraExpense(staff, { ...action.params, clientKey: `tg:${action.id}` }, { source: VIA, via: VIA }); break
        case 'remove_extra_expense': r = await ops.removeExtraExpense(staff, action.params, { via: VIA }); break
        case 'update_request': r = await ops.updateRequest(staff, action.params, { via: VIA }); break
        default: return { ok: false, text: '⛔ Невідома дія.' }
      }
      if (!r.ok) return { ok: false, code: r.code, reason: r.data && r.data.reason, text: `⛔ ${r.message}` }
      const text = action.type === 'add_extra_expense' ? textForAdd(r) : action.type === 'remove_extra_expense' ? textForRemove(r) : textForUpdate(r)
      return { ok: true, code: r.code, text }
    } catch (e) {
      console.error('staffBot applyAction:', e && e.message)
      return { ok: false, text: '⛔ Технічна помилка під час збереження. Спробуйте ще раз або внесіть зміни в порталі.' }
    }
  }

  // ---- Сессии диалога (staffBotSessions/{chatId}) ----

  const loadSession = async (chatId) => {
    const s = await getDoc('staffBotSessions', chatId)
    return s || { id: String(chatId), createdAt: nowIso(), messages: [], currentRequestId: null, pendingAction: null, aiUsage: null }
  }
  // Сессию пишем merge-ом БЕЗ pendingAction: ожидающее действие меняют только setPending/claimPending
  // (атомарно), иначе обработчик со старым снимком «воскресил» бы уже применённое действие.
  const saveSession = async (session) => {
    const { pendingAction: _pa, ...rest } = session
    void _pa
    const messages = (rest.messages || []).slice(-40)
    await col('staffBotSessions').doc(String(session.id)).set({ ...rest, messages, updatedAt: nowIso() }, { merge: true })
  }
  const setPending = async (chatId, action) => {
    await col('staffBotSessions').doc(String(chatId)).set({ pendingAction: action, updatedAt: nowIso() }, { merge: true })
  }
  // Атомарно «забрать» ожидающее действие: получит его ровно один обработчик (двойное нажатие кнопки,
  // другой инстанс Cloud Run, «так» вслед за кнопкой); остальные — null. actionId — сверка с кнопкой.
  // maxAgeMs — действие старше не применяется (устаревшая пропозиция), но и не снимается молча: вернёт null.
  const claimPending = async (chatId, actionId, maxAgeMs = 0) => adminDb.runTransaction(async (tx) => {
    const ref = col('staffBotSessions').doc(String(chatId))
    const snap = await tx.get(ref)
    const pa = snap.exists ? snap.data().pendingAction : null
    if (!pa || (actionId && pa.id !== actionId)) return null
    const since = pa.offeredAt || pa.createdAt
    if (maxAgeMs && since && Date.now() - Date.parse(since) > maxAgeMs) return null
    tx.set(ref, { pendingAction: null, awaitingActionId: null, updatedAt: nowIso() }, { merge: true })
    return pa
  })
  // Вернуть действие после повторяемого отказа (оплата идёт, CONFLICT, техошибка) — только если за это
  // время не появилось другое. Повтор пойдёт с тем же id, значит с тем же clientKey (без двойной витрати).
  const restorePending = async (chatId, action) => adminDb.runTransaction(async (tx) => {
    const ref = col('staffBotSessions').doc(String(chatId))
    const snap = await tx.get(ref)
    if (snap.exists && snap.data().pendingAction) return false
    // offeredAt — срок подтверждения словом отсчитывается от повторного предложения, не от первого.
    tx.set(ref, { pendingAction: { ...action, offeredAt: nowIso() }, awaitingActionId: action.id, updatedAt: nowIso() }, { merge: true })
    return true
  })

  // ---- ИИ: инструменты и цикл ----

  const TOOLS = [
    {
      name: 'find_requests',
      description: 'Пошук заявок на обслуговування за телефоном клієнта, ПІБ (частина імені) або номером заявки (номер ремонту 1С, зовнішній id чи наш id). Повертає до 10 збігів. Телефон передавай як написав співробітник — сервер нормалізує.',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          phone: { type: 'string', description: 'Телефон клієнта у будь-якому форматі' },
          name: { type: 'string', description: 'ПІБ або частина імені клієнта' },
          number: { type: 'string', description: 'Номер заявки / ремонту 1С / id' },
        },
      },
    },
    {
      name: 'get_request',
      description: 'Деталі заявки: клієнт, кораблик, скарга, статус, діагностика, ТТН, доп. витрати, фактичний кошторис (сума, статус, рядки) і права співробітника на зміни.',
      input_schema: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string' } }, required: ['requestId'] },
    },
    {
      name: 'propose_add_extra_expense',
      description: 'ЗАПРОПОНУВАТИ додати додаткову витрату (поза прайсом: доставка, запчастина, послуга третьої сторони тощо) у заявку. Якщо є фактичний кошторис — рядок додасться в нього (сума клієнту зросте, скидка/чек перерахуються); якщо ні — витрата запишеться на заявку і підставиться під час складання факту. Дія виконається лише після підтвердження співробітником.',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          title: { type: 'string', description: 'Коротка назва витрати українською, напр. «Доставка Новою Поштою»' },
          amount: { type: 'number', description: 'Сума у гривнях, > 0' },
          note: { type: 'string', description: 'Примітка (необов’язково)' },
        },
        required: ['requestId', 'title', 'amount'],
      },
    },
    {
      name: 'propose_remove_extra_expense',
      description: 'ЗАПРОПОНУВАТИ вилучити раніше додану додаткову витрату (id — з get_request → extraExpenses). Виконається після підтвердження.',
      input_schema: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string' }, expenseId: { type: 'string' } }, required: ['requestId', 'expenseId'] },
    },
    {
      name: 'propose_update_request',
      description: 'ЗАПРОПОНУВАТИ оновити поля заявки: діагностику (виявлені несправності — дописати diagnosticsAppend або замінити diagnostics), статус, номер ТТН до сервісу (waybillNumber) або клієнту (returnTtn), назву кораблика. Передавай лише ті поля, які треба змінити. Виконається після підтвердження.',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          requestId: { type: 'string' },
          diagnostics: { type: 'string', description: 'ЗАМІНИТИ діагностику цим повним текстом (українською). Лише якщо співробітник прямо просить переписати/замінити.' },
          diagnosticsAppend: { type: 'string', description: 'ДОПИСАТИ до наявної діагностики (новий абзац). Типовий випадок: «додай/запиши в діагностику …».' },
          status: { type: 'string', enum: Object.keys(STATUS_LABELS) },
          waybillNumber: { type: 'string', description: 'ТТН Нової Пошти: кораблик до сервісу' },
          returnTtn: { type: 'string', description: 'ТТН Нової Пошти: відправлення клієнту' },
          boat: { type: 'string', description: 'Модель/назва кораблика' },
        },
        required: ['requestId'],
      },
    },
  ]

  const systemPrompt = (staff, session) => [
    'Ти — асистент співробітників сервісного центру RunFerry (прикормочні рибальські кораблики) у Telegram. Допомагаєш знаходити заявки на обслуговування та вносити в них інформацію.',
    `Сьогодні ${new Date().toISOString().slice(0, 10)}. Співробітник: ${staff.name} (${ROLE_LABELS[staff.role] || staff.role}).`,
    session.currentRequestId
      ? `ПОТОЧНА ЗАЯВКА (контекст розмови): id=${session.currentRequestId}. Слова «туди», «в неї», «цю заявку», «йому» стосуються саме її — не шукай заново, якщо співробітник не назвав іншого клієнта.`
      : 'Поточної заявки в контексті ще немає.',
    session.pendingAction && session.pendingAction.summary
      ? `ОЧІКУЄ ПІДТВЕРДЖЕННЯ (ще НЕ виконано): «${session.pendingAction.summary}». Якщо співробітник виправляє її (інша сума, назва, заявка) — запропонуй нову дію через propose_*, вона замінить цю. Не став питань «так/ні» про щось інше, поки ця дія висить: відповідь «так» підтверджує саме нову пропозицію.`
      : null,
    'ПРАВИЛА:',
    '• Усі дані — лише з інструментів. Нічого не вигадуй і не обіцяй змін, яких не запропонував інструментом.',
    '• Щоб щось змінити, спершу потрібна конкретна заявка: якщо її немає в контексті — знайди через find_requests. Знайдено кілька — коротко перелічи (номер, клієнт, кораблик, статус, дата створення) і спитай, яку обрати; знайдено одну — працюй із нею.',
    '• Зміни робляться ТІЛЬКИ через propose_*: інструмент лише готує дію, а сервер покаже співробітнику кнопки підтвердження. Після виклику propose_* коротко підсумуй, що саме буде зроблено (заявка, клієнт, назва, сума), і попроси підтвердити кнопкою. Не більше однієї propose_* за одне повідомлення.',
    '• Суми — числа в гривнях («560 гривень» → amount 560). Назву витрати формулюй коротко українською. Якщо суму або назву не вказано — перепитай, не вигадуй.',
    '• Якщо інструмент повернув error або permissions забороняють дію — поясни це словами й нічого не пропонуй.',
    '• Відповідай стисло, звичайним текстом без markdown (Telegram показує сирий текст), мовою співробітника (українська або російська). Суми показуй у форматі «560 грн».',
    '• Діагностику за замовчуванням ДОПИСУЙ (diagnosticsAppend); замінюй (diagnostics) лише на пряме прохання переписати.',
  ].filter(Boolean).join('\n')

  const proposalSummary = (type, p, info) => {
    const req = info && info.request
    // Номер + клієнт + дата і статус — щоб дві заявки одного клієнта не сплутати при підтвердженні.
    const no = req ? `№${req.number}${req.clientName ? ` (${req.clientName})` : ''}${req.createdAt ? `, від ${req.createdAt}` : ''}${req.statusLabel ? `, ${req.statusLabel}` : ''}` : p.requestId
    if (type === 'add_extra_expense') {
      const where = info && info.actualEstimate ? 'у фактичний кошторис' : 'у заявку (факту ще немає)'
      return `Додати «${p.title}» — ${fmtMoney(p.amount)} ${where} заявки ${no}`
    }
    if (type === 'remove_extra_expense') {
      const exp = req && (req.extraExpenses || []).find((x) => x.id === p.expenseId)
      return `Вилучити витрату «${exp ? exp.title : p.expenseId}»${exp ? ` (${fmtMoney(exp.amount)})` : ''} із заявки ${no}`
    }
    const parts = []
    const d = req && req.diagnostics
    if (p.diagnosticsAppend != null) parts.push(`дописати до діагностики: «${clip(p.diagnosticsAppend, 160)}${String(p.diagnosticsAppend).length > 160 ? '…' : ''}»`)
    if (p.diagnostics != null) parts.push(`${d ? `ЗАМІНИТИ діагностику (${d.length} симв.) на` : 'діагностика:'} «${clip(p.diagnostics, 160)}${String(p.diagnostics || '').length > 160 ? '…' : ''}»`)
    if (p.status) parts.push(`статус → ${STATUS_LABELS[p.status] || p.status}`)
    if (p.waybillNumber) parts.push(`ТТН до сервісу ${p.waybillNumber}`)
    if (p.returnTtn) parts.push(`ТТН клієнту ${p.returnTtn}`)
    if (p.boat !== undefined) parts.push(`кораблик: ${p.boat}`)
    return `Оновити заявку ${no}: ${parts.join('; ')}`
  }

  // Выполнить инструмент. ctx: { staff, session, pending: {value} } — pending наполняет propose_*.
  const runTool = async (name, input, ctx) => {
    const { staff, session } = ctx
    const p = input || {}
    if (name === 'find_requests') {
      const r = await findRequests(staff, p)
      if (!r.error && r.requests.length === 1) session.currentRequestId = r.requests[0].id
      return r
    }
    if (name === 'get_request') {
      const r = await getRequestDetails(staff, String(p.requestId || ''))
      if (!r.error) session.currentRequestId = r.request.id
      return r
    }
    if (name.startsWith('propose_')) {
      if (ctx.pending.value) return { error: 'Інша дія вже очікує підтвердження. Спочатку підтвердіть або скасуйте її.' }
      const type = name.slice('propose_'.length)
      const info = await getRequestDetails(staff, String(p.requestId || ''))
      if (info.error) return { error: info.error }
      if (type === 'add_extra_expense') {
        const v = validateExpense(p)
        if (v.error) return { error: v.error }
        if (!info.permissions.canEditRequest) return { error: 'Немає права змінювати цю заявку.' }
        if (info.actualEstimate) {
          if (!info.permissions.canEditEstimate) return { error: 'Немає права «фактична калькуляція» для центру цієї заявки.' }
          if (info.actualEstimate.paid) return { error: 'Фактичний кошторис уже оплачено — зміни неможливі.' }
          if (info.actualEstimate.status === 'rejected') return { error: 'Клієнт відхилив кошторис — зміни через бота неможливі.' }
        }
        p.title = v.title; p.amount = v.amount; if (v.note) p.note = v.note; else delete p.note
      } else if (type === 'remove_extra_expense') {
        const exp = (info.request.extraExpenses || []).find((x) => x.id === String(p.expenseId || ''))
        if (!exp) return { error: 'Таку витрату в заявці не знайдено (див. extraExpenses у get_request).' }
        if (!info.permissions.canEditRequest) return { error: 'Немає права змінювати цю заявку.' }
        if (exp.inEstimate && !info.permissions.canEditEstimate) return { error: 'Немає права «фактична калькуляція» для центру цієї заявки.' }
        if (exp.inEstimate && info.actualEstimate && info.actualEstimate.paid) return { error: 'Фактичний кошторис уже оплачено — зміни неможливі.' }
      } else if (type === 'update_request') {
        if (!info.permissions.canEditRequest) return { error: 'Немає права змінювати цю заявку.' }
        if (p.status && !STATUS_LABELS[p.status]) return { error: 'Невідомий статус.' }
        if (p.status && info.request.paid) return { error: 'Заявку оплачено — статус зафіксовано.' }
        if (p.diagnostics != null && p.diagnosticsAppend != null) return { error: 'Або замінити діагностику, або дописати — не обидва.' }
        const diag = info.request.diagnostics
        if (p.diagnostics != null && diag && diag.truncated) return { error: `Діагностика довга (${diag.length} симв.), ви бачите лише початок — замінити її через бота не можна. Допишіть (diagnosticsAppend) або змініть у порталі.` }
        if (p.diagnosticsAppend != null) {
          const add = String(p.diagnosticsAppend).trim()
          if (!add) return { error: 'Порожній текст для доповнення діагностики.' }
          if ((diag ? diag.length + 1 : 0) + add.length > DIAG_MAX) return { error: `Діагностика перевищить ${DIAG_MAX} символів — допишіть її в порталі.` }
        }
        const touched = ['diagnostics', 'diagnosticsAppend', 'status', 'waybillNumber', 'returnTtn', 'boat'].filter((k) => p[k] !== undefined && p[k] !== null)
        if (!touched.length) return { error: 'Не вказано жодного поля для зміни.' }
        for (const k of ['waybillNumber', 'returnTtn']) if (p[k] && !normTtn(p[k])) return { error: `Номер ТТН (${k}) має містити 10–20 цифр.` }
        // Замена опирается на текущий текст: если до подтверждения его изменят — движок ответит STALE.
        if (p.diagnostics != null) p.expectDiagnostics = diag ? { at: diag.at || null, length: diag.length } : null
        else delete p.expectDiagnostics
      } else {
        return { error: 'Невідома дія.' }
      }
      const action = {
        id: newId(8), type, params: { ...p, requestId: info.request.id }, requestId: info.request.id,
        summary: proposalSummary(type, p, info), createdAt: nowIso(),
      }
      ctx.pending.value = action
      session.currentRequestId = info.request.id
      return { ok: true, pendingConfirmation: true, summary: action.summary, note: 'Дію підготовлено. Співробітник має підтвердити її кнопкою під повідомленням.' }
    }
    return { error: `Невідомий інструмент ${name}` }
  }

  // Один ход диалога: текст сотрудника → (инструменты) → ответ + возможная ожидающая подтверждения дія.
  const aiTurn = async ({ session, staff, text }) => {
    if (!anthropic) return { reply: 'ІІ не налаштовано на сервері (ANTHROPIC_API_KEY відсутній).', pendingAction: null, usage: null }
    const history = mergeConsecutive(
      (session.messages || []).slice(-HISTORY_MSGS).filter((m) => m && m.text).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text) }))
    )
    while (history.length && history[0].role !== 'user') history.shift()
    const messages = [...history, { role: 'user', content: text }]
    const ctx = { staff, session, pending: { value: null } }
    let usage = null
    let reply = ''
    try {
      for (let i = 0; i < AI_ITERATIONS; i++) {
        // Последняя итерация — без вызова инструментов: модель отвечает по уже полученным результатам.
        const msg = await anthropic.messages.create({
          model: AI_MODEL, max_tokens: 1500, system: systemPrompt(staff, session), tools: TOOLS, messages,
          ...(i === AI_ITERATIONS - 1 ? { tool_choice: { type: 'none' } } : {}),
        })
        if (buildUsage) usage = accumulateUsage(usage, buildUsage(msg.usage))
        const content = msg.content || []
        const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
        const toolUses = content.filter((b) => b.type === 'tool_use')
        if (msg.stop_reason !== 'tool_use' || !toolUses.length) { reply = texts; break }
        messages.push({ role: 'assistant', content })
        const results = []
        for (const tu of toolUses) {
          let r
          try { r = await runTool(tu.name, tu.input, ctx) } catch (e) { console.error('staffBot tool', tu.name, e && e.message); r = { error: 'Технічна помилка інструмента.' } }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r) })
        }
        messages.push({ role: 'user', content: results })
        reply = texts // на случай, если цикл упрётся в лимит итераций
      }
    } catch (e) {
      console.error('staffBot aiTurn:', e && e.message)
      return { reply: 'Вибачте, сталася технічна помилка ІІ. Спробуйте ще раз трохи пізніше.', pendingAction: null, usage }
    }
    if (!reply) reply = ctx.pending.value ? `Підготовлено: ${ctx.pending.value.summary}. Підтвердити?` : 'Не вдалося сформувати відповідь. Спробуйте переформулювати.'
    return { reply, pendingAction: ctx.pending.value, usage }
  }

  // Пропозиция старше срока кнопки — снять атомарно (если она всё ещё та же). Возвращает true, если сняли.
  const expirePending = async (chatId, action, maxAgeMs) => {
    if (!action) return false
    const since = action.offeredAt || action.createdAt
    if (!since || Date.now() - Date.parse(since) <= maxAgeMs) return false
    return !!(await claimPending(chatId, action.id))
  }

  return {
    resolveStaffByTelegram, createLinkToken, consumeLinkToken,
    requestVisible, canEditRequest, canEditEstimate,
    findRequests, getRequestDetails, applyAction, ops,
    loadSession, saveSession, setPending, claimPending, restorePending, expirePending, aiTurn, TOOLS,
  }
}

export default createStaffBotCore
