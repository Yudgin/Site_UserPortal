// ОБЩЕЕ серверное ядро правки заявок и фактического кошторису — без транспорта и без текстов.
// Используют: Telegram-бот сотрудников (staffBotCore.js) и HTTP-маршруты приложения «RunFerry Сервіс»
// (server/estimates.js, сессия «Калькуляции в приложении сервиса»). Одна реализация на всех, чтобы
// деньги клиенту считались одинаково, откуда бы ни пришла правка.
//
// Расчёты — ЗЕРКАЛО фронтового движка src/utils/pricing.ts: доп. расход поза прайсом — строка
// type='addon', refId 'extra:<id>', extra=true (редактор факта сохраняет такие строки при пересборке);
// скидка кошторису переприменяется (вшивается в lineTotal в копейках, последний ненулевой ряд забирает
// остаток), позиции чека (receiptGoods) перестраиваются построчно, порог повторного согласования
// клиентом — 10 % от предварительной (NO_REAPPROVAL_DEVIATION_PCT в src/types/chat.ts), history ≤ 20.
// Персистенция — firebase-admin (доверенный backend, минуя клиентские правила).
import crypto from 'crypto'
import { statusTimes } from './statusTimes.js'

export const STAFF_ROLES = ['owner', 'director', 'accountant', 'master']
export const NO_REAPPROVAL_DEVIATION_PCT = 10
export const PAY_CLAIM_MS = 3 * 60 * 1000 // клиент начал оплату (payInitiatedAt) — окно блокировки правок
export const MAX_AMOUNT = 1_000_000
export const HISTORY_LIMIT = 20
export const DIAG_MAX = 4000 // предел текста диагностики (clip в updateRequest)

export const STATUS_LABELS = {
  new: 'Нова', diagnostics: 'Діагностика', offered: 'Запропоновано', approved: 'Погоджено',
  in_work: 'В роботі', done: 'Виконано', cancelled: 'Скасовано',
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
export const clip = (v, n) => (v == null ? '' : String(v).slice(0, n))
export const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url')
export const nowIso = () => new Date().toISOString()
export const tName = (name) => (name && typeof name === 'object' ? (name.uk || Object.values(name).find(Boolean) || '') : String(name || ''))

// Номер заявки для показа: номер ремонта 1С → внешний id → наш id.
export const displayNo = (id, r) => (r && r.onec && r.onec.number) || (r && r.externalRequestId) || id

// ==== Расчёты кошторису ====

const sumBy = (lines, type) => round2(lines.filter((l) => l.type === type).reduce((a, l) => a + (Number(l.lineTotal) || 0), 0))

export const recomputeTotals = (est, lines) => {
  const laborTotal = sumBy(lines, 'labor')
  const materialsTotal = sumBy(lines, 'material')
  const addonsTotal = sumBy(lines, 'addon')
  return { ...est, lines, laborTotal, materialsTotal, addonsTotal, total: round2(laborTotal + materialsTotal + addonsTotal) }
}

// Точный порт applyEstimateDiscount (src/utils/pricing.ts).
export const applyEstimateDiscount = (est, d) => {
  const value = Number(d && d.value) || 0
  if (!d || value <= 0) return est
  const grossKop = Math.round(est.total * 100)
  // Нечего скидывать (итог 0, скидка < 1 коп., нет положительных строк) — строки не трогаем, но НАМЕРЕНИЕ
  // скидки храним (amount 0): иначе после того как итог побывал нулём, новая строка прошла бы без скидки.
  const keepIntent = () => ({ ...est, discount: { value, kind: d.kind, amount: 0, grossTotal: round2(grossKop / 100) } })
  if (grossKop <= 0) return keepIntent()
  const offKop = Math.min(d.kind === 'pct' ? Math.round((grossKop * value) / 100) : Math.round(value * 100), grossKop)
  if (offKop <= 0) return keepIntent()
  const targetKop = grossKop - offKop
  const idxs = est.lines.map((l, i) => ({ i, kop: Math.round(l.lineTotal * 100) })).filter((x) => x.kop > 0)
  const sumKop = idxs.reduce((acc, x) => acc + x.kop, 0)
  if (!idxs.length || sumKop <= 0) return keepIntent()
  const lines = est.lines.map((l) => ({ ...l }))
  let acc = 0
  idxs.forEach((x, n) => {
    const nk = n === idxs.length - 1 ? targetKop - acc : Math.floor((x.kop * targetKop) / sumKop)
    acc += nk
    lines[x.i].grossLineTotal = lines[x.i].lineTotal
    lines[x.i].lineTotal = nk / 100
  })
  return {
    ...est,
    lines,
    laborTotal: sumBy(lines, 'labor'),
    materialsTotal: sumBy(lines, 'material'),
    addonsTotal: sumBy(lines, 'addon'),
    total: round2(targetKop / 100),
    discount: { value, kind: d.kind, amount: round2(offKop / 100), grossTotal: round2(grossKop / 100) },
  }
}

// Позиции фискального чека построчно (порт estimate2goods): Σ(goods) == total копейка в копейку.
export const estimate2goods = (est) => {
  const goods = []
  const serverKop = (price, qty) => Math.round((Math.round(price * 100) * Math.round((qty || 1) * 1000)) / 1000)
  for (const l of est.lines || []) {
    if (!(l.lineTotal > 0)) continue
    const lineKop = Math.round(l.lineTotal * 100)
    const name = tName(l.name)
    if (l.type !== 'labor' && l.qty !== 1) {
      const unit = round2(l.unitPrice)
      if (serverKop(unit, l.qty) === lineKop) { goods.push({ name, price: unit, qty: l.qty }); continue }
    }
    const suffix = l.qty && l.qty !== 1 ? (l.type === 'labor' ? ` ×${l.qty}` : ` (${l.qty} шт)`) : ''
    goods.push({ name: name + suffix, price: round2(l.lineTotal), qty: 1 })
  }
  return goods
}

// Нужно ли повторное согласование клиентом при росте факта относительно предварительной
// (порт needsReapproval без заранее данных разрешений — так же вызывает редактор факта).
export const needsReapproval = (prelim, actual) => {
  const prelimTotal = round2(prelim.total)
  const actualTotal = round2(actual.total)
  if (prelimTotal <= 0) return { required: actualTotal > 0, diffPercent: actualTotal > 0 ? 100 : 0, thresholdPct: 0 }
  const rawPercent = ((actualTotal - prelimTotal) / prelimTotal) * 100
  const diffPercent = round2(rawPercent)
  if (rawPercent <= NO_REAPPROVAL_DEVIATION_PCT) return { required: false, diffPercent, thresholdPct: NO_REAPPROVAL_DEVIATION_PCT }
  return { required: true, diffPercent, thresholdPct: NO_REAPPROVAL_DEVIATION_PCT }
}

// Строка кошторису для доп. расхода (вне прайса).
export const extraLine = (exp) => ({
  type: 'addon', refId: `extra:${exp.id}`, code: 'EXTRA', name: { uk: exp.title }, qty: 1,
  unitPrice: round2(exp.amount), seasonApplied: false, lineTotal: round2(exp.amount), extra: true,
})

// Пересобрать кошторис с новым набором строк: «размотать» скидку (grossLineTotal → lineTotal),
// пересчитать итоги, переприменить ту же скидку — ровно так пересчитал бы редактор мастера.
export const withLines = (est, nextLines) => {
  const gross = nextLines.map((l) => {
    const g = { ...l }
    if (g.grossLineTotal != null) g.lineTotal = g.grossLineTotal
    delete g.grossLineTotal
    return g
  })
  const base = recomputeTotals({ ...est, discount: null }, gross)
  const d = est.discount
  if (d && Number(d.value) > 0) return applyEstimateDiscount(base, { value: Number(d.value), kind: d.kind === 'pct' ? 'pct' : 'uah' })
  return base
}

// Сигнатура содержания (как в pricingService.saveEstimate) — версию в history пишем только при изменении.
export const estimateSig = (e) => `${(e.lines || []).map((l) => `${l.refId}:${l.qty}:${l.lineTotal}`).sort().join('|')}#${e.total}`

// Почему кошторис сейчас нельзя править (null — можно). Код — для транспортов, message — укр. текст.
export const estimateBlocked = (e) => {
  if (!e) return null
  if (e.status === 'paid' || e.paymentId) return { code: 'PAID', message: 'Кошторис уже оплачено — зміни неможливі.' }
  if (e.status === 'rejected') return { code: 'REJECTED', message: 'Клієнт відхилив кошторис — зміни неможливі, відкрийте заявку в порталі.' }
  if (e.payInitiatedAt && Date.now() - Date.parse(e.payInitiatedAt) < PAY_CLAIM_MS) return { code: 'PAYING', message: 'Клієнт зараз оплачує цей кошторис — спробуйте за кілька хвилин.' }
  return null
}

// Патч факта под новый набор строк: итоги, скидка, чек, история (≤20), статус по порогу согласования
// (как редактор: required → pending_approval, иначе approved). via — источник правки (lastEditedVia).
export const estimatePatch = (e, nextLines, parent, staff, via = 'server') => {
  const next = withLines(e, nextLines)
  const re = parent ? needsReapproval(parent, next) : { required: false, diffPercent: 0, thresholdPct: NO_REAPPROVAL_DEVIATION_PCT }
  const status = re.required ? 'pending_approval' : 'approved'
  let history = Array.isArray(e.history) ? e.history : []
  if (estimateSig(e) !== estimateSig(next)) {
    history = [...history, {
      at: e.updatedAt || e.createdAt || nowIso(), total: e.total, lines: e.lines || [],
      ...(e.sections ? { sections: e.sections } : {}), editedBy: (staff && staff.email) || null,
    }].slice(-HISTORY_LIMIT)
  }
  return {
    patch: {
      lines: next.lines, laborTotal: next.laborTotal, materialsTotal: next.materialsTotal, addonsTotal: next.addonsTotal,
      total: next.total, discount: next.discount || null, status, receiptGoods: estimate2goods(next), history,
      updatedAt: nowIso(), lastEditedBy: (staff && staff.email) || null, lastEditedVia: via,
    },
    next, reapproval: re, status,
  }
}

export const validateExpense = (p) => {
  const title = clip(p && p.title, 120).trim()
  const amount = round2(Number(p && p.amount))
  if (!title) return { error: 'Потрібна назва витрати.' }
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return { error: 'Сума має бути числом від 0.01 до 1 000 000 грн.' }
  return { title, amount, note: clip(p && p.note, 300).trim() || undefined }
}

// ТТН Нової Пошти: 10–20 цифр (иначе '').
export const normTtn = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 && d.length <= 20 ? d : '' }

// ==== Права (зеркало accessStore / firestore.rules) ====

// Сотрудник из документа users/{uid}: { uid, email, name, role, centers[] }.
export const staffFromProfile = (uid, p) => ({
  uid, email: p.email || '', name: p.displayName || p.email || uid, role: p.role,
  centers: Array.isArray(p.centers) ? p.centers.filter(Boolean) : [],
})

export const requestVisible = (staff, sr) => {
  if (staff.role === 'owner' || staff.role === 'accountant') return true
  return !!sr.serviceCenterId && staff.centers.some((c) => c && c.centerId === sr.serviceCenterId)
}
// Поля заявки (диагностика, статус, ТТН, доп. расход на заявке): персонал сервиса своего центра; бухгалтер — только чтение.
export const canEditRequest = (staff, sr) => staff.role !== 'accountant' && requestVisible(staff, sr)
// Правка ФАКТИЧЕСКОГО кошторису: владелец; директор — в своих центрах; мастер — с правом «actual» по центру.
export const canEditEstimate = (staff, sr) => {
  if (staff.role === 'owner') return true
  if (staff.role === 'director') return requestVisible(staff, sr)
  if (staff.role === 'master') {
    const c = staff.centers.find((x) => x && x.centerId === sr.serviceCenterId)
    return !!c && Array.isArray(c.perms) && c.perms.includes('actual')
  }
  return false
}

// ==== Операции над Firestore (транспортно-нейтральные) ====
//
// Каждая возвращает { ok:true, code, data } либо { ok:false, code, message }. Тексты для Telegram/HTTP
// транспорты строят сами из data. Коды ошибок: NOT_FOUND, FORBIDDEN (чужой центр), NO_EDIT (нет права
// менять заявки), NO_ESTIMATE_PERM (нет права «факт»), BLOCKED (оплачен/отклонён/оплата идёт; data.reason),
// INVALID (валидация), NOT_FOUND_EXPENSE, NOTHING (нечего менять), PAID_STATUS (статус оплаченной заявки),
// CONFLICT (заявку дважды подряд изменили параллельно — повторить запрос), CLIENT_KEY_REUSED (тот же clientKey
// уже записан для витраты с другой назвою/сумою), STALE (замена диагностики по устаревшему снимку). Успех addExtraExpense с тем же clientKey и теми же назвою/сумою,
// что уже записаны, — { ok:true, code:'DUPLICATE', data:{ ...existing, duplicate:true } }.
export function createEstimateOps({ adminDb }) {
  const col = (name) => adminDb.collection(name)
  const getDoc = async (name, id) => {
    if (!id) return null
    const s = await col(name).doc(String(id)).get()
    return s.exists ? { id: s.id, ...s.data() } : null
  }
  const reqInfo = (sr) => ({ id: sr.id, number: displayNo(sr.id, sr), clientName: sr.clientName || '', actualEstimateId: sr.actualEstimateId || null })
  const fail = (code, message, data) => ({ ok: false, code, message, ...(data ? { data } : {}) })
  // Повтор с тем же ключом клиента (приложение/бот): возвращаем уже записанный расход, второй строки нет.
  // Проверяется ВНУТРИ транзакции — два одновременных запроса с одним ключом дают одну запись.
  const findDup = (cur, p) => (p && p.clientKey ? (cur.extraExpenses || []).find((x) => x && x.clientKey === String(p.clientKey)) || null : null)
  // Тот же ключ, но другая витрата (назва/сума после validateExpense) — не «уже додано», а ошибка клиента.
  const dupCheck = (cur, p, v) => {
    const dup = findDup(cur, p)
    if (!dup) return null
    return dup.title !== v.title || round2(dup.amount) !== v.amount ? { reused: true } : { duplicate: dup }
  }
  const REUSED_MSG = 'Ключ запиту вже використано для іншої витрати — спробуйте ще раз.'
  const dupResult = (sr0, d) => ({ ok: true, code: 'DUPLICATE', data: { request: reqInfo(sr0), expense: d, applied: !!d.appliedToEstimateId, duplicate: true } })
  const CONFLICT_MSG = 'Заявку щойно змінили паралельно — спробуйте ще раз.'

  const loadEditable = async (staff, requestId, { needEstimate = false } = {}) => {
    const sr = await getDoc('serviceRequests', requestId)
    if (!sr) return { err: fail('NOT_FOUND', 'Заявку не знайдено.') }
    if (!requestVisible(staff, sr)) return { err: fail('FORBIDDEN', 'Заявка іншого сервісного центру.') }
    if (!canEditRequest(staff, sr)) return { err: fail('NO_EDIT', 'Немає права змінювати заявки.') }
    if (needEstimate && !canEditEstimate(staff, sr)) return { err: fail('NO_ESTIMATE_PERM', 'Немає права «фактична калькуляція» для центру цієї заявки.') }
    return { sr }
  }

  // Добавить доп. расход: в факт (если есть и правим) или на заявку (appliedToEstimateId=null).
  // opts.source — 'telegram-bot' | 'app' | 'portal'; opts.via — lastEditedVia кошторису/заявки.
  const addExtraExpense = async (staff, p, opts = {}) => {
    const source = opts.source || 'server'
    const via = opts.via || source
    const v = validateExpense(p)
    if (v.error) return fail('INVALID', v.error)
    const sr0 = await getDoc('serviceRequests', p && p.requestId)
    if (!sr0) return fail('NOT_FOUND', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail('FORBIDDEN', 'Заявка іншого сервісного центру.')
    if (!canEditRequest(staff, sr0)) return fail('NO_EDIT', 'Немає права змінювати заявки.')
    const srRef = col('serviceRequests').doc(String(sr0.id))
    const exp = {
      id: newId(), title: v.title, amount: v.amount, ...(v.note ? { note: v.note } : {}),
      at: nowIso(), by: staff.email || null, byUid: staff.uid, source, appliedToEstimateId: null,
      // Ключ идемпотентности клиента (приложение сервиса): повтор с тем же ключом не добавляет второй расход.
      ...(p && p.clientKey ? { clientKey: String(p.clientKey) } : {}),
    }

    if (sr0.actualEstimateId) {
      if (!canEditEstimate(staff, sr0)) return fail('NO_ESTIMATE_PERM', 'Немає права «фактична калькуляція» для центру цієї заявки.')
      const estRef = col('priceEstimates').doc(String(sr0.actualEstimateId))
      const est0 = await getDoc('priceEstimates', sr0.actualEstimateId)
      const parent = est0 && est0.parentEstimateId ? await getDoc('priceEstimates', est0.parentEstimateId) : null
      const r = await adminDb.runTransaction(async (tx) => {
        const srS = await tx.get(srRef)
        const eS = await tx.get(estRef)
        const cur = srS.exists ? srS.data() : null
        if (!cur) return { blocked: { code: 'NOT_FOUND', message: 'Заявку не знайдено.' } }
        const dc = dupCheck(cur, p, v)
        if (dc) return dc
        // Факт заявки сменился между чтением и транзакцией (пересоздан) — повторить с новым состоянием.
        if ((cur.actualEstimateId || null) !== sr0.actualEstimateId) return { retry: true }
        const e = eS.exists ? { id: eS.id, ...eS.data() } : null
        // Запись собираем заново на каждой попытке транзакции (Firestore может повторить колбэк).
        if (!e) {
          // Ссылка на факт «висит» — пишем расход только на заявку.
          const rec = { ...exp, appliedToEstimateId: null }
          tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), rec], updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
          return { applied: false, rec }
        }
        const blocked = estimateBlocked(e)
        if (blocked) return { blocked }
        const rec = { ...exp, appliedToEstimateId: e.id }
        const { patch, next, reapproval, status } = estimatePatch(e, [...(e.lines || []), extraLine(rec)], parent, staff, via)
        tx.set(estRef, patch, { merge: true })
        tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), rec], updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
        return { applied: true, rec, prevTotal: round2(e.total || 0), total: next.total, reapproval, status, estimateId: e.id }
      })
      if (r.reused) return fail('CLIENT_KEY_REUSED', REUSED_MSG)
      if (r.duplicate) return dupResult(sr0, r.duplicate)
      if (r.retry) return opts._retried ? fail('CONFLICT', CONFLICT_MSG) : addExtraExpense(staff, p, { ...opts, _retried: true })
      if (r.blocked) return fail(r.blocked.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'BLOCKED', r.blocked.message, { reason: r.blocked.code })
      return { ok: true, code: r.applied ? 'APPLIED' : 'RECORDED', data: { request: reqInfo(sr0), expense: r.rec, applied: !!r.applied, ...(r.applied ? { estimateId: r.estimateId, prevTotal: r.prevTotal, total: r.total, status: r.status, reapproval: r.reapproval } : {}) } }
    }

    const r = await adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      if (!srS.exists) return { notFound: true }
      const cur = srS.data()
      const dc = dupCheck(cur, p, v)
      if (dc) return dc
      // Пока решали, у заявки появился факт (создан в приложении/портале) — повторить: пойдёт ветка с фактом.
      if (cur.actualEstimateId) return { retry: true }
      const rec = { ...exp, appliedToEstimateId: null }
      tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), rec], updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
      return { rec }
    })
    if (r.notFound) return fail('NOT_FOUND', 'Заявку не знайдено.')
    if (r.reused) return fail('CLIENT_KEY_REUSED', REUSED_MSG)
    if (r.duplicate) return dupResult(sr0, r.duplicate)
    if (r.retry) return opts._retried ? fail('CONFLICT', CONFLICT_MSG) : addExtraExpense(staff, p, { ...opts, _retried: true })
    return { ok: true, code: 'RECORDED', data: { request: reqInfo(sr0), expense: r.rec, applied: false } }
  }

  // Вилучити доп. расход (и его строку из факта, если она там есть). Кошторис, из которого убирать строку, —
  // тот, к которому привязана запись, а если запись ещё не привязана — текущий факт заявки (редактор или
  // застосунок мог уже записать строку, но ещё не перепривязать журнал). Всё решается по СВЕЖЕМУ состоянию
  // внутри транзакции; если кошторис-цель сменился между чтением и транзакцией — один повтор, затем CONFLICT.
  const removeExtraExpense = async (staff, p, opts = {}) => {
    const via = opts.via || opts.source || 'server'
    const { sr: sr0, err } = await loadEditable(staff, p && p.requestId)
    if (err) return err
    const exp = (sr0.extraExpenses || []).find((x) => x && x.id === String(p.expenseId || ''))
    if (!exp) return fail('NOT_FOUND_EXPENSE', 'Таку витрату в заявці не знайдено.')
    if (exp.appliedToEstimateId && !canEditEstimate(staff, sr0)) return fail('NO_ESTIMATE_PERM', 'Немає права «фактична калькуляція» для центру цієї заявки.')
    const srRef = col('serviceRequests').doc(String(sr0.id))
    const lineRef = `extra:${exp.id}`
    const estId = exp.appliedToEstimateId || sr0.actualEstimateId || null
    const estRef = estId ? col('priceEstimates').doc(String(estId)) : null
    const est0 = estId ? await getDoc('priceEstimates', estId) : null
    const parent = est0 && est0.parentEstimateId ? await getDoc('priceEstimates', est0.parentEstimateId) : null
    const r = await adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const eS = estRef ? await tx.get(estRef) : null
      if (!srS.exists) return { blocked: { code: 'NOT_FOUND', message: 'Заявку не знайдено.' } }
      const cur = srS.data()
      const curExp = (cur.extraExpenses || []).find((x) => x && x.id === exp.id)
      // Уже вилучено параллельно (двойное нажатие, другой сотрудник) — ничего не пишем.
      if (!curExp) return { gone: true }
      // Кошторис-цель по свежему состоянию сменился (перепривязали запись / пересоздали факт) — повторить.
      if ((curExp.appliedToEstimateId || cur.actualEstimateId || null) !== estId) return { retry: true }
      const e = eS && eS.exists ? { id: eS.id, ...eS.data() } : null
      const rest = (cur.extraExpenses || []).filter((x) => x && x.id !== exp.id)
      // Строка есть в кошторисі — убираем и её (с пересчётом скидки/чека/статуса); нет (редактор уже убрал,
      // либо запись не дошла до факта) — правим только журнал заявки, кошторис не трогаем.
      if (e && (e.lines || []).some((l) => l.refId === lineRef)) {
        if (!canEditEstimate(staff, sr0)) return { blocked: { code: 'NO_ESTIMATE_PERM', message: 'Немає права «фактична калькуляція» для центру цієї заявки.' } }
        const blocked = estimateBlocked(e)
        if (blocked) return { blocked }
        const nextLines = (e.lines || []).filter((l) => l.refId !== lineRef)
        const { patch, next, reapproval, status } = estimatePatch(e, nextLines, parent, staff, via)
        tx.set(estRef, patch, { merge: true })
        tx.set(srRef, { extraExpenses: rest, updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
        return { applied: true, prevTotal: round2(e.total || 0), total: next.total, reapproval, status, estimateId: e.id }
      }
      tx.set(srRef, { extraExpenses: rest, updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
      return { applied: false }
    })
    if (r.gone) return fail('NOT_FOUND_EXPENSE', 'Таку витрату в заявці не знайдено (уже вилучено).')
    if (r.retry) return opts._retried ? fail('CONFLICT', CONFLICT_MSG) : removeExtraExpense(staff, p, { ...opts, _retried: true })
    if (r.blocked) {
      const code = r.blocked.code === 'NOT_FOUND' || r.blocked.code === 'NO_ESTIMATE_PERM' ? r.blocked.code : 'BLOCKED'
      return fail(code, r.blocked.message, code === 'BLOCKED' ? { reason: r.blocked.code } : undefined)
    }
    return { ok: true, code: 'REMOVED', data: { request: reqInfo(sr0), expense: exp, applied: !!r.applied, ...(r.applied ? { estimateId: r.estimateId, prevTotal: r.prevTotal, total: r.total, status: r.status, reapproval: r.reapproval } : {}) } }
  }

  // Поля заявки: diagnostics (заменить текстом; пусто → null) ИЛИ diagnosticsAppend (дописать новым абзацем
  // к ТЕКУЩЕМУ тексту — собирается внутри транзакции, параллельная правка не теряется), status,
  // waybillNumber, returnTtn, boat. expectDiagnostics ({at,length} | null) — снимок диагностики, на который
  // опиралась пропозиция замены: если текст с тех пор изменили — STALE (не затираем чужое).
  // Первая диагностика двигает «нова» → «діагностика» (как в карточке), если статус не задан явно.
  const updateRequest = async (staff, p, opts = {}) => {
    const via = opts.via || opts.source || 'server'
    const { sr: sr0, err } = await loadEditable(staff, p && p.requestId)
    if (err) return err
    const fields = {}
    const changes = []
    if (p.diagnostics != null && p.diagnosticsAppend != null) return fail('INVALID', 'Або замінити діагностику, або дописати — не обидва.')
    const append = p.diagnosticsAppend != null ? String(p.diagnosticsAppend).trim() : null
    if (append !== null) {
      if (!append) return fail('INVALID', 'Порожній текст для доповнення діагностики.')
      changes.push({ field: 'diagnostics', label: `дописано до діагностики: «${clip(append, 200)}${append.length > 200 ? '…' : ''}»`, value: append })
    }
    if (p.diagnostics !== undefined && p.diagnostics !== null) {
      const text = clip(p.diagnostics, DIAG_MAX).trim()
      fields.diagnostics = text ? { text, at: nowIso(), by: staff.email || null } : null
      changes.push({ field: 'diagnostics', label: text ? `діагностика: «${clip(text, 200)}${text.length > 200 ? '…' : ''}»` : 'діагностику очищено', value: text })
      if (text && sr0.status === 'new' && !sr0.paymentId && !p.status) fields.status = 'diagnostics'
    }
    if (p.status) {
      if (!STATUS_LABELS[p.status]) return fail('INVALID', 'Невідомий статус.')
      if (sr0.paymentId) return fail('PAID_STATUS', 'Заявку оплачено — статус зафіксовано.')
      fields.status = p.status
      changes.push({ field: 'status', label: `статус: ${STATUS_LABELS[p.status]}`, value: p.status })
    }
    for (const [key, label] of [['waybillNumber', 'ТТН (до сервісу)'], ['returnTtn', 'ТТН (клієнту)']]) {
      if (p[key] === undefined || p[key] === null) continue
      const t = normTtn(p[key])
      if (!t) return fail('INVALID', 'Номер ТТН має містити 10–20 цифр.')
      fields[key] = t
      changes.push({ field: key, label: `${label}: ${t}`, value: t })
    }
    if (p.boat !== undefined && p.boat !== null) {
      fields.boat = clip(p.boat, 120).trim()
      changes.push({ field: 'boat', label: `кораблик: ${fields.boat || '—'}`, value: fields.boat })
    }
    if (!changes.length) return fail('NOTHING', 'Немає що змінювати.')
    // Проверки, зависящие от состояния (оплата, авто-«діагностика», время статуса), — по СВЕЖЕМУ документу
    // в транзакции: оплата, пришедшая между чтением и записью, не откатывается статусом бота/застосунку.
    const srRef = col('serviceRequests').doc(String(sr0.id))
    const r = await adminDb.runTransaction(async (tx) => {
      const s = await tx.get(srRef)
      if (!s.exists) return { notFound: true }
      const cur = s.data()
      const out = { ...fields }
      if (p.status && cur.paymentId) return { paid: true }
      const cd = cur.diagnostics && cur.diagnostics.text ? cur.diagnostics : null
      if (p.expectDiagnostics !== undefined) {
        const curSig = cd ? { at: cd.at || null, length: String(cd.text).length } : null
        const exp = p.expectDiagnostics ? { at: p.expectDiagnostics.at || null, length: Number(p.expectDiagnostics.length) || 0 } : null
        if (JSON.stringify(curSig) !== JSON.stringify(exp)) return { stale: true }
      }
      const now = nowIso()
      if (append !== null) {
        const text = cd ? `${String(cd.text).trimEnd()}\n${append}` : append
        if (text.length > DIAG_MAX) return { tooLong: true }
        out.diagnostics = { text, at: now, by: staff.email || null }
        if (cur.status === 'new' && !cur.paymentId && !p.status) out.status = 'diagnostics'
      }
      if (out.status === 'diagnostics' && !p.status && !(cur.status === 'new' && !cur.paymentId)) delete out.status
      // Час зміни статусу (doneAt при «Виконано») — для правила входящих Binotel; той самий статус нічого не ставить.
      Object.assign(out, statusTimes(cur.status, out.status, now))
      tx.set(srRef, { ...out, updatedAt: now, lastEditedBy: staff.email || null, lastEditedVia: via }, { merge: true })
      return { out }
    })
    if (r.notFound) return fail('NOT_FOUND', 'Заявку не знайдено.')
    if (r.paid) return fail('PAID_STATUS', 'Заявку оплачено — статус зафіксовано.')
    if (r.stale) return fail('STALE', 'Діагностику змінили після пропозиції — опишіть зміну ще раз.')
    if (r.tooLong) return fail('INVALID', `Діагностика перевищить ${DIAG_MAX} символів — допишіть її в порталі.`)
    return { ok: true, code: 'UPDATED', data: { request: reqInfo(sr0), fields: r.out, changes } }
  }

  return { addExtraExpense, removeExtraExpense, updateRequest, getDoc }
}

export default createEstimateOps
