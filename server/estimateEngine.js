// Серверное ЗЕРКАЛО движка кошторису (src/utils/pricing.ts) — чистые функции без Firestore.
// Единое ядро для всех серверных правок фактического кошторису: Telegram-бот сотрудников
// (staffBotCore.js) и HTTP-маршруты приложения сервиса (estimates.js). Любая правка строк обязана
// пройти через withLines/estimatePatch: «размотать» вшитую скидку → пересчитать итоги → переприменить
// скидку → перестроить позиции чека → пересчитать статус по порогу повторного согласования →
// положить снимок в history. Иначе Σ(строк) разойдётся с total/чеком и оплата упадёт AMOUNT_MISMATCH.
//
// Функции перенесены из server/staffBotCore.js (сессия «Telegram бот для заявок», 2026-10-14) без
// изменения семантики; staffBotCore.js должен импортировать их отсюда, а не держать копию.
import { nowIso } from './messengerCore.js'

export const NO_REAPPROVAL_DEVIATION_PCT = 10 // зеркало NO_REAPPROVAL_DEVIATION_PCT (src/types/chat.ts)
export const PAY_CLAIM_MS = 3 * 60 * 1000 // клиент начал оплату (payInitiatedAt) — окно блокировки правок
export const MAX_AMOUNT = 1_000_000
export const HISTORY_LIMIT = 20 // как pricingService.saveEstimate
// Ключи способов оплаты (src/types/pricing.ts PAY_METHOD_KEYS) — порядок важен для fopId «первого способа».
export const PAY_METHOD_KEYS = ['liqpayCard', 'liqpayPaypart', 'monoChast', 'monoAcquire', 'privatPaypart', 'cod']

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
export const clip = (v, n) => (v == null ? '' : String(v).slice(0, n))

// Локализованное имя строки: укр. → любое → строка как есть (порт tName с fallback).
export const tName = (name) => (name && typeof name === 'object' ? (name.uk || Object.values(name).find(Boolean) || '') : String(name || ''))
const sumBy = (lines, type) => round2(lines.filter((l) => l.type === type).reduce((a, l) => a + (Number(l.lineTotal) || 0), 0))

export const recomputeTotals = (est, lines) => {
  const laborTotal = sumBy(lines, 'labor')
  const materialsTotal = sumBy(lines, 'material')
  const addonsTotal = sumBy(lines, 'addon')
  return { ...est, lines, laborTotal, materialsTotal, addonsTotal, total: round2(laborTotal + materialsTotal + addonsTotal) }
}

// Знижка (відсотком або сумою) вшивається в lineTotal пропорційно, в копійках; останній ненульовий
// рядок забирає залишок — Σ(рядків) == total == чек. Точный порт applyEstimateDiscount.
export const applyEstimateDiscount = (est, d) => {
  const value = Number(d && d.value) || 0
  if (!d || value <= 0) return est
  const grossKop = Math.round(est.total * 100)
  if (grossKop <= 0) return est
  const offKop = Math.min(d.kind === 'pct' ? Math.round((grossKop * value) / 100) : Math.round(value * 100), grossKop)
  if (offKop <= 0) return est
  const targetKop = grossKop - offKop
  const idxs = est.lines.map((l, i) => ({ i, kop: Math.round(l.lineTotal * 100) })).filter((x) => x.kop > 0)
  const sumKop = idxs.reduce((acc, x) => acc + x.kop, 0)
  if (!idxs.length || sumKop <= 0) return est
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

// Строка кошторису для доп. расхода (вне прайса). extra=true — редактор факта сохраняет её при пересборке.
export const extraLine = (exp) => ({
  type: 'addon', refId: `extra:${exp.id}`, code: 'EXTRA', name: { uk: exp.title }, qty: 1,
  unitPrice: round2(exp.amount), seasonApplied: false, lineTotal: round2(exp.amount), extra: true,
})

// Пересобрать кошторис с новым набором строк: сначала «размотать» скидку (grossLineTotal → lineTotal),
// пересчитать итоги, затем переприменить ту же скидку — ровно так пересчитал бы редактор мастера.
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

// ---- Видимость и права (зеркало accessStore/firestore.rules) ----

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

// ---- Блокировки и патч факта ----

// Почему кошторис сейчас нельзя править: { code, message } или null.
export const estimateBlock = (e) => {
  if (!e) return null
  if (e.status === 'paid' || e.paymentId) return { code: 'PAID', message: 'Кошторис уже оплачено — зміни неможливі.' }
  if (e.status === 'rejected') return { code: 'REJECTED', message: 'Клієнт відхилив кошторис — зміни неможливі, відкрийте заявку в порталі.' }
  if (e.payInitiatedAt && Date.now() - Date.parse(e.payInitiatedAt) < PAY_CLAIM_MS) {
    return { code: 'PAY_IN_PROGRESS', message: 'Клієнт зараз оплачує цей кошторис — спробуйте за кілька хвилин.' }
  }
  return null
}
// Совместимость с staffBotCore.estimateBlocked: текст причины или null.
export const estimateBlocked = (e) => { const b = estimateBlock(e); return b ? b.message : null }

// Общая часть: переписать строки факта (с переприменением скидки, чеком, историей, статусом).
// via — кто правил ('telegram-bot' | 'app'), пишется в lastEditedVia.
export const estimatePatch = (e, nextLines, parent, staff, via = 'telegram-bot') => {
  const next = withLines(e, nextLines)
  const re = parent ? needsReapproval(parent, next) : { required: false, diffPercent: 0, thresholdPct: NO_REAPPROVAL_DEVIATION_PCT }
  const status = re.required ? 'pending_approval' : 'approved'
  let history = Array.isArray(e.history) ? e.history : []
  if (estimateSig(e) !== estimateSig(next)) {
    history = [...history, {
      at: e.updatedAt || e.createdAt || nowIso(), total: e.total, lines: e.lines || [],
      ...(e.sections ? { sections: e.sections } : {}), editedBy: staff.email || null,
    }].slice(-HISTORY_LIMIT)
  }
  return {
    patch: {
      lines: next.lines, laborTotal: next.laborTotal, materialsTotal: next.materialsTotal, addonsTotal: next.addonsTotal,
      total: next.total, discount: next.discount || null, status, receiptGoods: estimate2goods(next), history,
      updatedAt: nowIso(), lastEditedBy: staff.email || null, lastEditedVia: via,
    },
    next, reapproval: re, status,
  }
}

// Валидация доп. расхода (назва ≤120, сума 0.01–1 000 000, нотатка ≤300).
export const validateExpense = (p) => {
  const title = clip(p.title, 120).trim()
  const amount = round2(Number(p.amount))
  if (!title) return { error: 'Потрібна назва витрати.' }
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return { error: 'Сума має бути числом від 0.01 до 1 000 000 грн.' }
  return { title, amount, note: clip(p.note, 300).trim() || undefined }
}

// Способы оплаты из дефолтов центра (как префилл редактора факта: PAY_METHOD_KEYS.filter(def[m])).
export const payOptionsFromCenter = (center) => {
  const def = center && center.defaultFopByMethod
  if (!def || typeof def !== 'object') return []
  return PAY_METHOD_KEYS.filter((m) => def[m]).map((m) => ({ method: m, fopId: String(def[m]) }))
}

// Фактический кошторис из варианта пропозиції (как редактор факта «Скласти факт за обраним варіантом»
// без правок): копия строк/секций/скидки, пересчёт через withLines, статус по порогу, чек, выплаты
// с нулями из специалистов заявки, способы оплаты из центра. Ожидающие витрати заявки (extraExpenses
// без appliedToEstimateId) дописываются строками extra — как appendExtraLines в редакторе.
export const buildActualFromVariant = ({ parent, sr, pendingExpenses = [], payOptions, staff, via = 'app', now = nowIso() }) => {
  const base = {
    requestId: parent.requestId ?? null,
    title: parent.title || '',
    complaint: parent.complaint || '',
    ...(parent.sections ? { sections: parent.sections } : {}),
    ...(parent.excludedCommonCodes ? { excludedCommonCodes: parent.excludedCommonCodes } : {}),
    seasonId: parent.seasonId ?? null,
    seasonCoefficient: parent.seasonCoefficient ?? 1,
    seasonSurchargeApplied: !!parent.seasonSurchargeApplied,
    laborRatePerHour: parent.laborRatePerHour ?? 0,
    currency: parent.currency || 'UAH',
    source: 'manual',
    discount: parent.discount || null,
    lines: [],
    total: 0,
  }
  const lines = [...(parent.lines || []).map((l) => ({ ...l })), ...pendingExpenses.map(extraLine)]
  const next = withLines(base, lines)
  const re = needsReapproval(parent, next)
  return {
    estimate: {
      ...next,
      kind: 'actual',
      stage: 'actual',
      status: re.required ? 'pending_approval' : 'approved',
      parentEstimateId: parent.id,
      serviceRequestId: sr.id,
      receiptGoods: estimate2goods(next),
      specialistPayouts: (sr.specialists || []).filter((s) => s && s.uid).map((s) => ({ uid: s.uid, name: s.name || '', specialistAmount: 0, centerAdminAmount: 0 })),
      payOptions,
      fopId: payOptions[0].fopId,
      createdAt: now,
      updatedAt: now,
      createdBy: staff.email || null,
      lastEditedBy: staff.email || null,
      lastEditedVia: via,
      history: [],
      paymentId: null, paidAt: null, taxUrl: null, fiscalCode: null, payInitiatedAt: null,
    },
    reapproval: re,
  }
}
