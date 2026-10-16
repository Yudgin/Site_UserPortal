// Действия над фактическим кошторисом для HTTP-маршрутов приложения сервиса (estimates.js) поверх ОБЩЕГО
// ядра server/estimateEngine.js (сессия «Telegram бот для заявок»; одна реализация расчётов и витрат на
// бота и приложение). Здесь только то, чего в ядре нет: создание факта по выбранному варианту
// (buildActualFromVariant) и тонкая обёртка над ops.addExtraExpense/removeExtraExpense — проверка, что
// :id — текущий факт заявки, идемпотентность по clientKey и приведение кодов ядра к кодам контракта
// (calculations-contract-2026-10-16.md). Результат: { ok:true, data } | { ok:false, status, code, message }.
//
// Поля оплаты (status 'paid', paymentId, paidAt, fopId при оплате, taxUrl, fiscalCode, payInitiatedAt) не трогаются.
import crypto from 'crypto'
import {
  createEstimateOps, round2, nowIso, requestVisible, canEditRequest, canEditEstimate, withLines, needsReapproval,
  estimate2goods, extraLine,
} from './estimateEngine.js'

// Ключи способов оплаты (src/types/pricing.ts PAY_METHOD_KEYS) — порядок важен для fopId «первого способа».
export const PAY_METHOD_KEYS = ['liqpayCard', 'liqpayPaypart', 'monoChast', 'monoAcquire', 'privatPaypart', 'cod']

// Id кошторису — capability-token публичной ссылки /estimate/:id (как secureId(16) на портале).
const newEstimateId = () => crypto.randomBytes(12).toString('base64url')
const fail = (status, code, message) => ({ ok: false, status, code, message })

// Коды ядра → HTTP-статус и код контракта (коды блокировок — как у /api/estimates/pay).
const CORE_CODES = {
  NOT_FOUND: [404, 'NO_SR'], FORBIDDEN: [403, 'OTHER_CENTER'], NO_EDIT: [403, 'NO_PERM'], NO_ESTIMATE_PERM: [403, 'NO_PERM_ACTUAL'],
  INVALID: [400, 'BAD_EXPENSE'], NOT_FOUND_EXPENSE: [404, 'NO_EXPENSE'], NOTHING: [400, 'NOTHING'], PAID_STATUS: [409, 'PAID'],
}
const BLOCK_REASONS = { PAID: 'PAID', REJECTED: 'REJECTED', PAYING: 'PAY_IN_PROGRESS' }
export const mapCoreFailure = (r) => {
  if (r.code === 'BLOCKED') return fail(409, BLOCK_REASONS[r.data && r.data.reason] || 'BLOCKED', r.message)
  const m = CORE_CODES[r.code]
  return m ? fail(m[0], m[1], r.message) : fail(500, r.code || 'FAILED', r.message || 'Не вдалося виконати дію')
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

export function createEstimateActions({ adminDb }) {
  const ops = createEstimateOps({ adminDb })
  const col = (name) => adminDb.collection(name)
  const getDoc = ops.getDoc

  // ---- Создать фактический кошторис из варианта пропозиції ----
  // p: { requestId, parentEstimateId?, clientKey? }; opts: { via }
  // Идемпотентность: повтор с тем же clientKey (двойной тап/ретрай) возвращает уже созданный факт.
  const createActualFromVariant = async (staff, p, { via = 'app' } = {}) => {
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    if (!canEditRequest(staff, sr0)) return fail(403, 'NO_PERM', 'Немає права змінювати заявки.')
    if (!canEditEstimate(staff, sr0)) return fail(403, 'NO_PERM_ACTUAL', 'Немає права «фактична калькуляція» для центру цієї заявки.')
    if (sr0.status === 'cancelled') return fail(409, 'CANCELLED', 'Заявку скасовано — факт не складається.')
    const clientKey = p.clientKey ? String(p.clientKey) : null
    if (sr0.actualEstimateId) {
      const cur = await getDoc('priceEstimates', sr0.actualEstimateId)
      if (cur && clientKey && cur.createdWithKey === clientKey) {
        return { ok: true, data: { estimateId: cur.id, total: round2(cur.total || 0), status: cur.status || 'approved', reapproval: cur.createdReapproval || null, created: false } }
      }
      return fail(409, 'ALREADY_EXISTS', 'Фактичний кошторис уже складено — відкрийте його.')
    }
    // Родитель: явный вариант или выбранный клиентом вариант пропозиції.
    let parentId = p.parentEstimateId ? String(p.parentEstimateId) : null
    const offer = sr0.offerId ? await getDoc('estimateOffers', sr0.offerId) : null
    if (!parentId) parentId = offer && offer.selectedVariantId ? String(offer.selectedVariantId) : null
    if (!parentId) return fail(404, 'NO_VARIANT', 'Клієнт ще не обрав варіант пропозиції — складіть факт у порталі.')
    const parent = await getDoc('priceEstimates', parentId)
    if (!parent) return fail(404, 'NO_VARIANT', 'Варіант пропозиції не знайдено.')
    if (parent.kind === 'actual' || parent.stage === 'actual') return fail(400, 'BAD_PARENT', 'Батьківський кошторис має бути варіантом пропозиції.')
    const belongs = (parent.serviceRequestId && parent.serviceRequestId === sr0.id) || (parent.offerId && sr0.offerId && parent.offerId === sr0.offerId)
    if (!belongs) return fail(400, 'BAD_PARENT', 'Варіант не належить цій заявці.')
    // Способы оплаты + ФОП — из дефолтов центра заявки (сервер подставляет сам).
    const center = sr0.serviceCenterId ? await getDoc('serviceCenters', sr0.serviceCenterId) : null
    const payOptions = payOptionsFromCenter(center)
    if (!payOptions.length) return fail(409, 'NO_FOP', 'Для центру не налаштовано ФОП за способами оплати — складіть факт у порталі.')

    const estId = newEstimateId()
    const estRef = col('priceEstimates').doc(estId)
    const srRef = col('serviceRequests').doc(String(sr0.id))
    return adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const cur = srS.exists ? srS.data() : null
      if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
      if (cur.actualEstimateId) return fail(409, 'ALREADY_EXISTS', 'Фактичний кошторис уже складено — відкрийте його.')
      if (cur.status === 'cancelled') return fail(409, 'CANCELLED', 'Заявку скасовано — факт не складається.')
      const now = nowIso()
      const pending = (cur.extraExpenses || []).filter((x) => x && x.id && !x.appliedToEstimateId)
      const { estimate, reapproval } = buildActualFromVariant({ parent, sr: { ...cur, id: sr0.id }, pendingExpenses: pending, payOptions, staff, via, now })
      tx.set(estRef, { ...estimate, id: estId, ...(clientKey ? { createdWithKey: clientKey, createdReapproval: reapproval } : {}) })
      const srPatch = { actualEstimateId: estId, updatedAt: now, lastEditedBy: staff.email || null, lastEditedVia: via }
      // Политика статуса (1): как редактор факта — заявка → «в роботі», но не воскрешаем
      // скасовану/виконану и не откатываем оплаченную.
      if (cur.status !== 'cancelled' && cur.status !== 'done' && !cur.paymentId) srPatch.status = 'in_work'
      if (pending.length) srPatch.extraExpenses = (cur.extraExpenses || []).map((x) => (x && x.id && !x.appliedToEstimateId ? { ...x, appliedToEstimateId: estId } : x))
      tx.set(srRef, srPatch, { merge: true })
      // Факт собран по выбранному варианту → «замораживаем» пропозицію (переизбор клиентом запрещён).
      if (parent.offerId) tx.set(col('estimateOffers').doc(String(parent.offerId)), { status: 'locked', updatedAt: now }, { merge: true })
      return { ok: true, data: { estimateId: estId, total: estimate.total, status: estimate.status, reapproval, created: true, appliedExpenses: pending.length, offerLocked: !!parent.offerId } }
    })
  }

  // Ответ ядра add/remove → форма контракта.
  const lineData = (r, extra = {}) => ({
    expenseId: r.data.expense.id, refId: `extra:${r.data.expense.id}`, applied: !!r.data.applied,
    estimateId: r.data.estimateId || null, prevTotal: r.data.prevTotal ?? null, total: r.data.total ?? null,
    status: r.data.status || null, reapproval: r.data.reapproval || null, ...extra,
  })

  // ---- Витрата поза прайсом в текущий факт заявки ----
  // p: { requestId, estimateId?, title, amount, note?, clientKey? }; opts: { via }
  // estimateId (из HTTP-маршрута) должен совпадать с текущим фактом заявки — иначе NOT_CURRENT.
  // Идемпотентность по clientKey: повтор не добавляет второй расход.
  const addExtraExpense = async (staff, p, { via = 'app' } = {}) => {
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    if (p.estimateId && String(p.estimateId) !== String(sr0.actualEstimateId || '')) return fail(409, 'NOT_CURRENT', 'Це не поточний фактичний кошторис заявки.')
    const clientKey = p.clientKey ? String(p.clientKey) : null
    if (clientKey) {
      const dup = (sr0.extraExpenses || []).find((x) => x && x.clientKey === clientKey)
      if (dup) {
        const e = dup.appliedToEstimateId ? await getDoc('priceEstimates', dup.appliedToEstimateId) : null
        return { ok: true, data: { expenseId: dup.id, refId: `extra:${dup.id}`, applied: !!dup.appliedToEstimateId, estimateId: dup.appliedToEstimateId || null, total: e ? round2(e.total || 0) : null, prevTotal: null, status: e ? e.status : null, reapproval: null, duplicate: true } }
      }
    }
    const r = await ops.addExtraExpense(staff, { requestId: sr0.id, title: p.title, amount: p.amount, note: p.note, ...(clientKey ? { clientKey } : {}) }, { source: via, via })
    if (!r.ok) return mapCoreFailure(r)
    return { ok: true, data: lineData(r) }
  }

  // ---- Вилучити витрату (из заявки и, если применена, из факта) ----
  // p: { requestId, expenseId, estimateId? }; opts: { via }
  const removeExtraExpense = async (staff, p, { via = 'app' } = {}) => {
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    const exp = (sr0.extraExpenses || []).find((x) => x && x.id === String(p.expenseId || ''))
    if (!exp) return fail(404, 'NO_EXPENSE', 'Таку витрату в заявці не знайдено.')
    if (p.estimateId && exp.appliedToEstimateId && String(p.estimateId) !== String(exp.appliedToEstimateId)) return fail(409, 'NOT_CURRENT', 'Витрата належить іншому кошторису.')
    const r = await ops.removeExtraExpense(staff, { requestId: sr0.id, expenseId: exp.id }, { via })
    if (!r.ok) return mapCoreFailure(r)
    return { ok: true, data: lineData(r) }
  }

  return { createActualFromVariant, addExtraExpense, removeExtraExpense, ops }
}

export default createEstimateActions
