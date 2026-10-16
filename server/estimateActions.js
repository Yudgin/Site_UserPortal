// Серверные ДЕЙСТВИЯ над фактическим кошторисом — транспортно-нейтральное ядро (Firestore Admin SDK,
// транзакции) для HTTP-маршрутов приложения сервиса (estimates.js) и Telegram-бота сотрудников
// (staffBotCore.js). Возвращают структуру, а не текст: { ok:true, data } либо { ok:false, status, code, message }
// (message — украинский, можно показывать как есть). Расчёты — только через estimateEngine.js.
//
// Правила: поля оплаты (status 'paid', paymentId, paidAt, fopId при оплате, taxUrl, fiscalCode,
// payInitiatedAt) здесь не трогаются никогда; порог переутверждения — 10 %; history ≤ 20.
import crypto from 'crypto'
import { nowIso } from './messengerCore.js'
import {
  round2, requestVisible, canEditRequest, canEditEstimate, estimateBlock, estimatePatch, extraLine,
  validateExpense, payOptionsFromCenter, buildActualFromVariant,
} from './estimateEngine.js'

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url')
// Id кошторису — capability-token публичной ссылки /estimate/:id (как secureId(16) на портале).
const newEstimateId = () => crypto.randomBytes(12).toString('base64url')

const fail = (status, code, message) => ({ ok: false, status, code, message })

export function createEstimateActions({ adminDb }) {
  const col = (name) => adminDb.collection(name)
  const getDoc = async (name, id) => {
    if (!id) return null
    const s = await col(name).doc(String(id)).get()
    return s.exists ? { id: s.id, ...s.data() } : null
  }
  // Общие проверки доступа к заявке для правки факта.
  const gateEstimate = (staff, sr) => {
    if (!requestVisible(staff, sr)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    if (!canEditRequest(staff, sr)) return fail(403, 'NO_PERM', 'Немає права змінювати заявки.')
    if (!canEditEstimate(staff, sr)) return fail(403, 'NO_PERM_ACTUAL', 'Немає права «фактична калькуляція» для центру цієї заявки.')
    return null
  }

  // ---- Создать фактический кошторис из варианта пропозиції ----
  // p: { requestId, parentEstimateId?, clientKey? }; opts: { via }
  // Идемпотентность: повтор с тем же clientKey (двойной тап/ретрай) возвращает уже созданный факт.
  const createActualFromVariant = async (staff, p, { via = 'app' } = {}) => {
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    const gate = gateEstimate(staff, sr0)
    if (gate) return gate
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
    let offer = sr0.offerId ? await getDoc('estimateOffers', sr0.offerId) : null
    if (!parentId) parentId = offer && offer.selectedVariantId ? String(offer.selectedVariantId) : null
    if (!parentId) return fail(404, 'NO_VARIANT', 'Клієнт ще не обрав варіант пропозиції — складіть факт у порталі.')
    const parent = await getDoc('priceEstimates', parentId)
    if (!parent) return fail(404, 'NO_VARIANT', 'Варіант пропозиції не знайдено.')
    if (parent.kind === 'actual' || parent.stage === 'actual') return fail(400, 'BAD_PARENT', 'Батьківський кошторис має бути варіантом пропозиції.')
    const belongs = (parent.serviceRequestId && parent.serviceRequestId === sr0.id) || (parent.offerId && parent.offerId === sr0.offerId)
    if (!belongs) return fail(400, 'BAD_PARENT', 'Варіант не належить цій заявці.')
    if (parent.offerId && (!offer || offer.id !== parent.offerId)) offer = await getDoc('estimateOffers', parent.offerId)
    // Способы оплаты + ФОП — из дефолтов центра заявки (сервер подставляет сам).
    const center = sr0.serviceCenterId ? await getDoc('serviceCenters', sr0.serviceCenterId) : null
    const payOptions = payOptionsFromCenter(center)
    if (!payOptions.length) return fail(409, 'NO_FOP', 'Для центру не налаштовано ФОП за способами оплати — складіть факт у порталі.')

    const estId = newEstimateId()
    const estRef = col('priceEstimates').doc(estId)
    const srRef = col('serviceRequests').doc(String(sr0.id))
    const r = await adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const cur = srS.exists ? srS.data() : null
      if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
      if (cur.actualEstimateId) return fail(409, 'ALREADY_EXISTS', 'Фактичний кошторис уже складено — відкрийте його.')
      if (cur.status === 'cancelled') return fail(409, 'CANCELLED', 'Заявку скасовано — факт не складається.')
      const now = nowIso()
      const pending = (cur.extraExpenses || []).filter((x) => x && x.id && !x.appliedToEstimateId)
      const { estimate, reapproval } = buildActualFromVariant({ parent, sr: { ...cur, id: sr0.id }, pendingExpenses: pending, payOptions, staff, via, now })
      tx.set(estRef, { ...estimate, id: estId, ...(clientKey ? { createdWithKey: clientKey, createdReapproval: reapproval } : {}) })
      const srPatch = { actualEstimateId: estId, updatedAt: now }
      // Политика статуса (1): как редактор факта — заявка → «в роботі», но не воскрешаем
      // скасовану/виконану и не откатываем оплаченную.
      if (cur.status !== 'cancelled' && cur.status !== 'done' && !cur.paymentId) srPatch.status = 'in_work'
      if (pending.length) srPatch.extraExpenses = (cur.extraExpenses || []).map((x) => (x && x.id && !x.appliedToEstimateId ? { ...x, appliedToEstimateId: estId } : x))
      tx.set(srRef, srPatch, { merge: true })
      // Факт собран по выбранному варианту → «замораживаем» пропозицію (переизбор клиентом запрещён).
      if (parent.offerId) tx.set(col('estimateOffers').doc(String(parent.offerId)), { status: 'locked', updatedAt: now }, { merge: true })
      return { ok: true, data: { estimateId: estId, total: estimate.total, status: estimate.status, reapproval, created: true, appliedExpenses: pending.length, offerLocked: !!parent.offerId } }
    })
    return r
  }

  // ---- Добавить витрату поза прайсом ----
  // p: { requestId, estimateId?, title, amount, note?, clientKey? }; opts: { via }
  // estimateId (из HTTP-маршрута) должен совпадать с текущим фактом заявки — иначе NOT_CURRENT.
  // Идемпотентность по clientKey: повтор не добавляет второй расход.
  const addExtraExpense = async (staff, p, { via = 'telegram-bot' } = {}) => {
    const v = validateExpense(p)
    if (v.error) return fail(400, 'BAD_EXPENSE', v.error)
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    if (!canEditRequest(staff, sr0)) return fail(403, 'NO_PERM', 'Немає права змінювати заявки.')
    if (p.estimateId && String(p.estimateId) !== String(sr0.actualEstimateId || '')) return fail(409, 'NOT_CURRENT', 'Це не поточний фактичний кошторис заявки.')
    const clientKey = p.clientKey ? String(p.clientKey) : null
    if (clientKey) {
      const dup = (sr0.extraExpenses || []).find((x) => x && x.clientKey === clientKey)
      if (dup) {
        const e = dup.appliedToEstimateId ? await getDoc('priceEstimates', dup.appliedToEstimateId) : null
        return { ok: true, data: { expenseId: dup.id, refId: `extra:${dup.id}`, applied: !!dup.appliedToEstimateId, total: e ? round2(e.total || 0) : null, prevTotal: null, status: e ? e.status : null, reapproval: null, duplicate: true } }
      }
    }
    const exp = {
      id: newId(), title: v.title, amount: v.amount, ...(v.note ? { note: v.note } : {}),
      at: nowIso(), by: staff.email || null, byUid: staff.uid, source: via, appliedToEstimateId: null,
      ...(clientKey ? { clientKey } : {}),
    }
    const srRef = col('serviceRequests').doc(String(sr0.id))

    if (sr0.actualEstimateId) {
      if (!canEditEstimate(staff, sr0)) return fail(403, 'NO_PERM_ACTUAL', 'Немає права «фактична калькуляція» для центру цієї заявки.')
      const estRef = col('priceEstimates').doc(String(sr0.actualEstimateId))
      const est0 = await getDoc('priceEstimates', sr0.actualEstimateId)
      const parent = est0 && est0.parentEstimateId ? await getDoc('priceEstimates', est0.parentEstimateId) : null
      const r = await adminDb.runTransaction(async (tx) => {
        const srS = await tx.get(srRef)
        const eS = await tx.get(estRef)
        const cur = srS.exists ? srS.data() : null
        if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
        const e = eS.exists ? { id: eS.id, ...eS.data() } : null
        if (!e) {
          // Ссылка на факт «висит» — пишем расход только на заявку.
          tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), exp], updatedAt: nowIso() }, { merge: true })
          return { ok: true, data: { expenseId: exp.id, refId: `extra:${exp.id}`, applied: false, total: null, prevTotal: null, status: null, reapproval: null } }
        }
        const blocked = estimateBlock(e)
        if (blocked) return fail(409, blocked.code, blocked.message)
        const { patch, next, reapproval, status } = estimatePatch(e, [...(e.lines || []), extraLine(exp)], parent, staff, via)
        tx.set(estRef, patch, { merge: true })
        tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), { ...exp, appliedToEstimateId: e.id }], updatedAt: nowIso() }, { merge: true })
        return { ok: true, data: { expenseId: exp.id, refId: `extra:${exp.id}`, applied: true, estimateId: e.id, prevTotal: round2(e.total || 0), total: next.total, reapproval, status } }
      })
      return r
    }

    await adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const cur = srS.exists ? srS.data() : {}
      tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), exp], updatedAt: nowIso() }, { merge: true })
    })
    return { ok: true, data: { expenseId: exp.id, refId: `extra:${exp.id}`, applied: false, total: null, prevTotal: null, status: null, reapproval: null } }
  }

  // ---- Удалить витрату (из заявки и, если применена, из факта) ----
  // p: { requestId, expenseId, estimateId? }; opts: { via }
  const removeExtraExpense = async (staff, p, { via = 'telegram-bot' } = {}) => {
    const sr0 = await getDoc('serviceRequests', p.requestId)
    if (!sr0) return fail(404, 'NO_SR', 'Заявку не знайдено.')
    if (!requestVisible(staff, sr0)) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    if (!canEditRequest(staff, sr0)) return fail(403, 'NO_PERM', 'Немає права змінювати заявки.')
    const exp = (sr0.extraExpenses || []).find((x) => x && x.id === String(p.expenseId))
    if (!exp) return fail(404, 'NO_EXPENSE', 'Таку витрату в заявці не знайдено.')
    const estId = exp.appliedToEstimateId || null
    if (p.estimateId && estId && String(p.estimateId) !== String(estId)) return fail(409, 'NOT_CURRENT', 'Витрата належить іншому кошторису.')
    const srRef = col('serviceRequests').doc(String(sr0.id))
    if (estId) {
      if (!canEditEstimate(staff, sr0)) return fail(403, 'NO_PERM_ACTUAL', 'Немає права «фактична калькуляція» для центру цієї заявки.')
      const estRef = col('priceEstimates').doc(String(estId))
      const est0 = await getDoc('priceEstimates', estId)
      const parent = est0 && est0.parentEstimateId ? await getDoc('priceEstimates', est0.parentEstimateId) : null
      return adminDb.runTransaction(async (tx) => {
        const srS = await tx.get(srRef)
        const eS = await tx.get(estRef)
        const cur = srS.exists ? srS.data() : {}
        const e = eS.exists ? { id: eS.id, ...eS.data() } : null
        const rest = (cur.extraExpenses || []).filter((x) => x && x.id !== exp.id)
        if (e) {
          const blocked = estimateBlock(e)
          if (blocked) return fail(409, blocked.code, blocked.message)
          const nextLines = (e.lines || []).filter((l) => l.refId !== `extra:${exp.id}`)
          const { patch, next, reapproval, status } = estimatePatch(e, nextLines, parent, staff, via)
          tx.set(estRef, patch, { merge: true })
          tx.set(srRef, { extraExpenses: rest, updatedAt: nowIso() }, { merge: true })
          return { ok: true, data: { expenseId: exp.id, applied: true, estimateId: e.id, prevTotal: round2(e.total || 0), total: next.total, reapproval, status } }
        }
        tx.set(srRef, { extraExpenses: rest, updatedAt: nowIso() }, { merge: true })
        return { ok: true, data: { expenseId: exp.id, applied: false, total: null, prevTotal: null, status: null, reapproval: null } }
      })
    }
    await adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const cur = srS.exists ? srS.data() : {}
      tx.set(srRef, { extraExpenses: (cur.extraExpenses || []).filter((x) => x && x.id !== exp.id), updatedAt: nowIso() }, { merge: true })
    })
    return { ok: true, data: { expenseId: exp.id, applied: false, total: null, prevTotal: null, status: null, reapproval: null } }
  }

  return { createActualFromVariant, addExtraExpense, removeExtraExpense }
}

export default createEstimateActions
