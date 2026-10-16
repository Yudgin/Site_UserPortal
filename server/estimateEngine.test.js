// node --test: чистые функции зеркала движка кошторису (без Firestore и сети).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  round2, tName, recomputeTotals, applyEstimateDiscount, estimate2goods, needsReapproval, extraLine, withLines,
  estimateSig, requestVisible, canEditRequest, canEditEstimate, estimateBlocked, estimatePatch,
  validateExpense, NO_REAPPROVAL_DEVIATION_PCT,
} from './estimateEngine.js'
import { payOptionsFromCenter, buildActualFromVariant, mapCoreFailure } from './estimateActions.js'

const line = (refId, lineTotal, extra = {}) => ({ type: 'labor', refId, code: refId.toUpperCase(), name: { uk: `Робота ${refId}` }, qty: 1, unitPrice: lineTotal, seasonApplied: false, lineTotal, ...extra })
const est = (lines, extra = {}) => recomputeTotals({ id: 'e1', title: 'T', discount: null, ...extra }, lines)
const staff = (role, centers = []) => ({ uid: 'u1', email: 'm@x', role, centers })

test('round2/tName', () => {
  assert.equal(round2(0.1 + 0.2), 0.3)
  assert.equal(round2(1234.5678), 1234.57)
  assert.equal(tName({ uk: 'Укр', en: 'En' }), 'Укр')
  assert.equal(tName({ en: 'En' }), 'En')
  assert.equal(tName('plain'), 'plain')
  assert.equal(tName(null), '')
})

test('recomputeTotals sums by type', () => {
  const e = est([line('w', 1000), line('m', 200, { type: 'material' }), line('a', 50, { type: 'addon' })])
  assert.equal(e.laborTotal, 1000)
  assert.equal(e.materialsTotal, 200)
  assert.equal(e.addonsTotal, 50)
  assert.equal(e.total, 1250)
})

test('applyEstimateDiscount: pct embeds into lines in kopecks, last line takes the remainder, Σ == total', () => {
  const e = applyEstimateDiscount(est([line('a', 33.33), line('b', 33.33), line('c', 33.34)]), { value: 10, kind: 'pct' })
  assert.equal(e.total, 90)
  assert.equal(e.discount.amount, 10)
  assert.equal(e.discount.grossTotal, 100)
  assert.equal(round2(e.lines.reduce((s, l) => s + l.lineTotal, 0)), 90)
  assert.equal(e.lines[0].grossLineTotal, 33.33)
  // uah
  const u = applyEstimateDiscount(est([line('a', 500)]), { value: 120, kind: 'uah' })
  assert.equal(u.total, 380)
  assert.equal(u.discount.kind, 'uah')
  // no-op cases
  assert.equal(applyEstimateDiscount(est([line('a', 500)]), null).discount, null)
  assert.equal(applyEstimateDiscount(est([line('a', 500)]), { value: 0, kind: 'pct' }).total, 500)
})

test('estimate2goods: one line per item, Σ(goods) == total, qty in the name for labor', () => {
  const e = applyEstimateDiscount(est([line('w', 1000, { qty: 2 }), line('m', 700, { type: 'material', qty: 2, unitPrice: 350 }), line('z', 0)]), { value: 10, kind: 'pct' })
  const g = estimate2goods(e)
  assert.equal(g.length, 2) // нулевая строка не идёт в чек
  assert.match(g[0].name, /×2$/)
  assert.equal(g[0].qty, 1)
  // материал после скидки: unitPrice (350) × 2 ≠ 630 → одна позиция qty=1, количество в названии
  assert.equal(g[1].qty, 1)
  assert.equal(g[1].price, 630)
  assert.match(g[1].name, /\(2 шт\)$/)
  // без скидки цена за единицу совпадает — qty остаётся
  const plain = estimate2goods(est([line('m', 700, { type: 'material', qty: 2, unitPrice: 350 })]))
  assert.deepEqual(plain, [{ name: 'Робота m', price: 350, qty: 2 }])
  const sumKop = g.reduce((s, x) => s + Math.round((Math.round(x.price * 100) * Math.round(x.qty * 1000)) / 1000), 0)
  assert.equal(sumKop, Math.round(e.total * 100))
})

test('needsReapproval: 10 % threshold, zero plan, decrease', () => {
  assert.equal(needsReapproval({ total: 1000 }, { total: 1100 }).required, false)
  assert.equal(needsReapproval({ total: 1000 }, { total: 1100.01 }).required, true)
  assert.equal(needsReapproval({ total: 1000 }, { total: 900 }).required, false)
  assert.deepEqual(needsReapproval({ total: 0 }, { total: 10 }), { required: true, diffPercent: 100, thresholdPct: 0 })
  assert.equal(needsReapproval({ total: 1000 }, { total: 1250 }).diffPercent, 25)
  assert.equal(NO_REAPPROVAL_DEVIATION_PCT, 10)
})

test('withLines re-applies the embedded discount after adding an extra line', () => {
  const e = applyEstimateDiscount(est([line('a', 1000)]), { value: 10, kind: 'pct' })
  const next = withLines(e, [...e.lines, extraLine({ id: 'x1', title: 'Доставка', amount: 300 })])
  assert.equal(next.total, 1170) // (1000 + 300) − 10 %
  assert.equal(next.discount.grossTotal, 1300)
  assert.equal(next.lines[1].extra, true)
  assert.equal(next.lines[1].refId, 'extra:x1')
  assert.equal(next.lines[1].grossLineTotal, 300)
  assert.equal(next.lines[1].lineTotal, 270)
  // без скидки — просто пересчёт
  const plain = withLines(est([line('a', 100)]), [line('a', 100), line('b', 50)])
  assert.equal(plain.total, 150)
  assert.equal(plain.discount, null)
})

test('estimateSig ignores order and changes with qty/total', () => {
  assert.equal(estimateSig(est([line('a', 1), line('b', 2)])), estimateSig(est([line('b', 2), line('a', 1)])))
  assert.notEqual(estimateSig(est([line('a', 1)])), estimateSig(est([line('a', 1, { qty: 2 })])))
})

test('permissions mirror accessStore', () => {
  const sr = { serviceCenterId: 'c1' }
  assert.equal(requestVisible(staff('owner'), {}), true)
  assert.equal(requestVisible(staff('accountant'), {}), true)
  assert.equal(requestVisible(staff('master', [{ centerId: 'c1', perms: ['view'] }]), sr), true)
  assert.equal(requestVisible(staff('master', [{ centerId: 'c2', perms: ['view'] }]), sr), false)
  assert.equal(requestVisible(staff('director', [{ centerId: 'c1' }]), {}), false) // заявка без центра
  assert.equal(canEditRequest(staff('accountant'), sr), false)
  assert.equal(canEditEstimate(staff('owner'), {}), true)
  assert.equal(canEditEstimate(staff('director', [{ centerId: 'c1' }]), sr), true)
  assert.equal(canEditEstimate(staff('master', [{ centerId: 'c1', perms: ['view'] }]), sr), false)
  assert.equal(canEditEstimate(staff('master', [{ centerId: 'c1', perms: ['view', 'actual'] }]), sr), true)
  assert.equal(canEditEstimate(staff('accountant'), sr), false)
})

test('estimateBlocked: paid / rejected / pay claim → { code, message }', () => {
  assert.equal(estimateBlocked(null), null)
  assert.equal(estimateBlocked({ status: 'approved' }), null)
  assert.equal(estimateBlocked({ status: 'paid' }).code, 'PAID')
  assert.equal(estimateBlocked({ status: 'approved', paymentId: 'p' }).code, 'PAID')
  assert.equal(estimateBlocked({ status: 'rejected' }).code, 'REJECTED')
  assert.equal(estimateBlocked({ status: 'approved', payInitiatedAt: new Date().toISOString() }).code, 'PAYING')
  assert.equal(estimateBlocked({ status: 'approved', payInitiatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }), null)
  assert.match(estimateBlocked({ status: 'paid' }).message, /оплачено/)
})

test('mapCoreFailure: core codes → HTTP status and contract codes', () => {
  assert.deepEqual(mapCoreFailure({ ok: false, code: 'BLOCKED', message: 'm', data: { reason: 'PAYING' } }), { ok: false, status: 409, code: 'PAY_IN_PROGRESS', message: 'm' })
  assert.equal(mapCoreFailure({ ok: false, code: 'BLOCKED', message: 'm', data: { reason: 'PAID' } }).code, 'PAID')
  assert.deepEqual(mapCoreFailure({ ok: false, code: 'NO_ESTIMATE_PERM', message: 'm' }), { ok: false, status: 403, code: 'NO_PERM_ACTUAL', message: 'm' })
  assert.equal(mapCoreFailure({ ok: false, code: 'FORBIDDEN', message: 'm' }).code, 'OTHER_CENTER')
  assert.equal(mapCoreFailure({ ok: false, code: 'INVALID', message: 'm' }).status, 400)
  assert.equal(mapCoreFailure({ ok: false, code: 'NOT_FOUND_EXPENSE', message: 'm' }).code, 'NO_EXPENSE')
  assert.equal(mapCoreFailure({ ok: false, code: 'WEIRD', message: 'm' }).status, 500)
})

test('estimatePatch: recomputes, sets status by threshold, snapshots history, marks via', () => {
  const parent = est([line('a', 1000)])
  const e = { ...est([line('a', 1000)]), status: 'approved', updatedAt: '2026-10-10T10:00:00.000Z', history: [] }
  const r = estimatePatch(e, [...e.lines, extraLine({ id: 'x', title: 'Деталь', amount: 500 })], parent, staff('master'), 'app')
  assert.equal(r.patch.total, 1500)
  assert.equal(r.status, 'pending_approval') // +50 %
  assert.equal(r.reapproval.required, true)
  assert.equal(r.patch.history.length, 1)
  assert.equal(r.patch.history[0].total, 1000)
  assert.equal(r.patch.history[0].at, '2026-10-10T10:00:00.000Z')
  assert.equal(r.patch.history[0].editedBy, 'm@x')
  assert.equal(r.patch.lastEditedVia, 'app')
  assert.equal(r.patch.receiptGoods.length, 2)
  // без изменения содержания history не растёт; via по умолчанию — 'server'
  const same = estimatePatch(e, e.lines, parent, staff('master'))
  assert.equal(same.patch.history.length, 0)
  assert.equal(same.patch.lastEditedVia, 'server')
  assert.equal(same.status, 'approved')
  // без родителя — approved
  assert.equal(estimatePatch(e, [...e.lines, extraLine({ id: 'y', title: 'Y', amount: 9000 })], null, staff('owner')).status, 'approved')
})

test('validateExpense', () => {
  assert.deepEqual(validateExpense({ title: ' Доставка ', amount: '560.556', note: '' }), { title: 'Доставка', amount: 560.56, note: undefined })
  assert.ok(validateExpense({ title: '', amount: 1 }).error)
  assert.ok(validateExpense({ title: 'x', amount: 0 }).error)
  assert.ok(validateExpense({ title: 'x', amount: 1_000_001 }).error)
  assert.ok(validateExpense({ title: 'x', amount: 'abc' }).error)
  assert.equal(validateExpense({ title: 'x'.repeat(200), amount: 1 }).title.length, 120)
})

test('payOptionsFromCenter keeps the PAY_METHOD_KEYS order and skips empty methods', () => {
  assert.deepEqual(payOptionsFromCenter({ defaultFopByMethod: { cod: 'f2', liqpayCard: 'f1', monoChast: '' } }), [
    { method: 'liqpayCard', fopId: 'f1' }, { method: 'cod', fopId: 'f2' },
  ])
  assert.deepEqual(payOptionsFromCenter(null), [])
  assert.deepEqual(payOptionsFromCenter({}), [])
})

test('buildActualFromVariant copies the variant, appends pending expenses, re-applies the discount', () => {
  const parent = { ...applyEstimateDiscount(est([line('a', 1000, { complaintIndex: 0 })]), { value: 10, kind: 'pct' }),
    id: 'var-2', title: 'Повний', complaint: 'кермо', sections: [{ complaint: 'Кермо', serviceKind: 'repair' }], offerId: 'off', variantLabel: 'Повний', variantOrder: 1,
    seasonId: 's', seasonCoefficient: 1.2, seasonSurchargeApplied: true, laborRatePerHour: 500, currency: 'UAH', requestId: null }
  const sr = { id: 'sr-1', specialists: [{ uid: 'u2', name: 'Ігор' }, { name: 'без uid' }] }
  const { estimate: a, reapproval } = buildActualFromVariant({
    parent, sr, pendingExpenses: [{ id: 'x1', title: 'Доставка', amount: 100 }],
    payOptions: [{ method: 'liqpayCard', fopId: 'f1' }], staff: staff('master'), now: '2026-10-16T00:00:00.000Z',
  })
  assert.equal(a.kind, 'actual')
  assert.equal(a.stage, 'actual')
  assert.equal(a.parentEstimateId, 'var-2')
  assert.equal(a.serviceRequestId, 'sr-1')
  assert.equal(a.total, 990) // (1000 + 100) − 10 %
  assert.equal(a.discount.grossTotal, 1100)
  assert.equal(a.status, 'approved') // 900 → 990 = ровно +10 % — в пределах порога
  assert.equal(reapproval.required, false)
  assert.equal(reapproval.diffPercent, 10)
  assert.equal(a.lines.length, 2)
  assert.equal(a.lines[1].extra, true)
  assert.equal(a.receiptGoods.length, 2)
  assert.deepEqual(a.specialistPayouts, [{ uid: 'u2', name: 'Ігор', specialistAmount: 0, centerAdminAmount: 0 }])
  assert.equal(a.fopId, 'f1')
  assert.equal(a.lastEditedVia, 'app')
  assert.equal(a.createdBy, 'm@x')
  assert.equal(a.paymentId, null)
  assert.equal('offerId' in a, false) // поля варианта на факт не переносятся
  assert.equal('variantLabel' in a, false)
  assert.equal(a.seasonCoefficient, 1.2)
})
