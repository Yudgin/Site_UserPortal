// node --test: работы по заявке и калькуляции мастера на фейковом Firestore (пути с под-коллекциями, транзакции) и
// HTTP-маршруты с подменой проверки сотрудника — без сети и firebase-admin.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createMasterEstimateActions, registerMasterEstimates, normalizeLines, clientAmountFor, WORK_KINDS } from './masterEstimates.js'
import { createEstimateActions } from './estimateActions.js'

// ---------- фейковый Firestore (хранение по полному пути) ----------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) { this.docs = {}; for (const [path, v] of Object.entries(seed)) this.docs[path] = clone(v) }
  get(path) { return this.docs[path] }
  collection(path) {
    const db = this
    return {
      doc(id) {
        const did = id || `auto${Math.random().toString(36).slice(2, 8)}`
        const full = `${path}/${did}`
        return {
          id: did, _path: full,
          collection: (sub) => db.collection(`${full}/${sub}`),
          async get() { const d = db.docs[full]; return { id: did, exists: !!d, data: () => clone(d) } },
          async set(v, opts) { db._set(full, v, opts) },
        }
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`fake where: ${op}`)
        return {
          async get() {
            const docs = db.list(path).filter((d) => d[field] === value).map(({ id, ...rest }) => ({ id, data: () => clone(rest) }))
            return { docs, empty: !docs.length, size: docs.length }
          },
        }
      },
    }
  }
  _set(full, v, opts) {
    if (opts && opts.merge && this.docs[full]) deepMerge(this.docs[full], v)
    else this.docs[full] = clone(v)
  }
  async runTransaction(fn) {
    const db = this
    let wrote = false
    const tx = {
      async get(ref) { if (wrote) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
      set(ref, v, opts) { wrote = true; db._set(ref._path, v, opts) },
    }
    return fn(tx)
  }
  list(prefix) { return Object.entries(this.docs).filter(([k]) => k.startsWith(prefix + '/') && k.slice(prefix.length + 1).indexOf('/') === -1).map(([k, v]) => ({ id: k.slice(prefix.length + 1), ...v })) }
}

const owner = { uid: 'u-o', email: 'o@x', role: 'owner', centers: [] }
const director = { uid: 'u-d', email: 'd@x', role: 'director', centers: [{ centerId: 'kat', perms: [] }] }
const master = { uid: 'u-m', email: 'm@kat', role: 'master', centers: [{ centerId: 'kat', perms: ['view'] }] }
const otherMaster = { uid: 'u-x', email: 'x@x', role: 'master', centers: [{ centerId: 'kyiv', perms: ['view', 'actual'] }] }
const seed = (extra = {}) => ({
  'serviceRequests/sr-1': { status: 'diagnostics', serviceCenterId: 'kat', complaint: 'кермо', specialists: [{ uid: 'u-m', name: 'Майстер Катрини' }], extraExpenses: [] },
  'serviceRequests/sr-k': { status: 'new', serviceCenterId: 'kyiv' },
  'serviceCenters/kat': { name: 'Катрина', markupPct: 30, defaultFopByMethod: { liqpayCard: 'fop-1' } },
  'serviceCenters/kyiv': { name: 'Київ' },
  'users/u-m': { role: 'master', active: true, displayName: 'Майстер Катрини', email: 'm@kat', centers: [{ centerId: 'kat', perms: ['view'] }] },
  'users/u-d': { role: 'director', active: true, email: 'd@x', centers: [{ centerId: 'kat', perms: [] }] },
  'users/u-x': { role: 'master', active: true, email: 'x@x', centers: [{ centerId: 'kyiv', perms: ['view'] }] },
  ...extra,
})
const lines = [{ title: 'Заміна сервоприводу', amount: 500 }, { title: 'Ремкомплект', amount: 200, qty: 2 }]

test('normalizeLines / clientAmountFor', () => {
  const n = normalizeLines([{ title: ' Робота ', amount: '500.555' }, { title: 'Деталь', amount: 300, qty: 3, note: 'НП' }])
  assert.deepEqual(n.lines[0], { title: 'Робота', qty: 1, amount: 500.56, unitPrice: 500.56 })
  assert.equal(n.lines[1].unitPrice, 100)
  assert.equal(n.total, 800.56)
  assert.ok(normalizeLines([]).error)
  assert.ok(normalizeLines([{ title: '', amount: 1 }]).error)
  assert.ok(normalizeLines([{ title: 'x', amount: 0 }]).error)
  assert.ok(normalizeLines([{ title: 'x', amount: 1, qty: 0 }]).error)
  assert.ok(normalizeLines(Array.from({ length: 51 }, () => ({ title: 'x', amount: 1 }))).error)
  assert.equal(clientAmountFor(500, 30), 650)
  assert.equal(clientAmountFor(500, 30, 700), 700)
  assert.equal(clientAmountFor(100, 0), 100)
  assert.equal(WORK_KINDS.water_test, 'Тест на воді')
})

test('works: a master takes a work for himself, a director assigns, a master of another centre is refused', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const w = await a.addWork(master, { requestId: 'sr-1', kind: 'water_test', clientKey: 'key-00000001' })
  assert.equal(w.ok, true, JSON.stringify(w))
  assert.equal(w.data.work.assigneeUid, 'u-m')
  assert.equal(w.data.work.title, 'Тест на воді')
  assert.equal((await a.addWork(master, { requestId: 'sr-1', kind: 'repair', assigneeUid: 'u-d' })).code, 'NO_PERM')
  const d = await a.addWork(director, { requestId: 'sr-1', kind: 'delivery_in', assigneeUid: 'u-m', title: 'Забрати з НП' })
  assert.equal(d.ok, true)
  assert.equal(d.data.work.assigneeName, 'Майстер Катрини')
  assert.equal((await a.addWork(director, { requestId: 'sr-1', kind: 'repair', assigneeUid: 'u-x' })).code, 'BAD_ASSIGNEE') // не має доступу до центру
  assert.equal((await a.addWork(otherMaster, { requestId: 'sr-1', kind: 'repair' })).code, 'OTHER_CENTER')
  assert.equal((await a.addWork(director, { requestId: 'sr-1', kind: 'weird' })).code, 'BAD_KIND')
  // повтор з тим самим ключем — та сама робота
  const again = await a.addWork(master, { requestId: 'sr-1', kind: 'water_test', clientKey: 'key-00000001' })
  assert.equal(again.data.created, false)
  // майстер: стан своєї роботи — так; назву — ні; чужу роботу — ні
  assert.equal((await a.updateWork(master, { requestId: 'sr-1', workId: w.data.work.id, status: 'done' })).ok, true)
  assert.equal((await a.updateWork(master, { requestId: 'sr-1', workId: w.data.work.id, title: 'інше' })).code, 'NO_PERM')
  const free = await a.addWork(director, { requestId: 'sr-1', kind: 'intake' })
  assert.equal((await a.updateWork(master, { requestId: 'sr-1', workId: free.data.work.id, assigneeUid: 'u-m' })).ok, true) // взяти вільну
  assert.equal(db.get(`serviceRequests/sr-1/works/${free.data.work.id}`).assigneeUid, 'u-m')
  assert.equal((await a.updateWork(director, { requestId: 'sr-1', workId: free.data.work.id, status: 'bogus' })).code, 'BAD_STATUS')
})

test('master estimate from a master: create (auto work), edit, submit, return with comment, resubmit, accept', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const c = await a.createFromMaster(master, { requestId: 'sr-1', kind: 'actual', lines, comment: 'по кермо', clientKey: 'key-00000002' })
  assert.equal(c.ok, true, JSON.stringify(c))
  const me = c.data.masterEstimate
  assert.equal(me.id, 'me-key-00000002')
  assert.equal(me.direction, 'from_master')
  assert.equal(me.performerUid, 'u-m')
  assert.equal(me.total, 700)
  assert.equal(me.status, 'draft')
  const work = db.get(`serviceRequests/sr-1/works/${me.workId}`)
  assert.equal(work.kind, 'repair')
  assert.equal(work.assigneeUid, 'u-m')
  // повтор — той самий документ
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', kind: 'actual', lines, comment: 'по кермо', clientKey: 'key-00000002' })).data.created, false)
  // правка: історія версій
  const u = await a.updateMasterEstimate(master, { id: me.id, lines: [{ title: 'Заміна сервоприводу', amount: 600 }] })
  assert.equal(u.ok, true)
  assert.equal(db.get('masterEstimates/me-key-00000002').total, 600)
  assert.equal(db.get('masterEstimates/me-key-00000002').history.length, 1)
  // інший майстер не може
  assert.equal((await a.updateMasterEstimate(otherMaster, { id: me.id, comment: 'x' })).code, 'OTHER_CENTER')
  // майстер не приймає
  assert.equal((await a.submitMasterEstimate(master, { id: me.id })).ok, true)
  assert.equal((await a.reviewMasterEstimate(master, { id: me.id, decision: 'accept' })).code, 'NO_PERM')
  assert.equal((await a.updateMasterEstimate(master, { id: me.id, comment: 'x' })).code, 'NOT_EDITABLE')
  assert.equal((await a.reviewMasterEstimate(director, { id: me.id, decision: 'return' })).code, 'NEED_COMMENT')
  const ret = await a.reviewMasterEstimate(director, { id: me.id, decision: 'return', comment: 'розпиши деталь' })
  assert.equal(ret.data.masterEstimate.status, 'returned')
  assert.equal((await a.updateMasterEstimate(master, { id: me.id, lines })).ok, true)
  assert.equal((await a.submitMasterEstimate(master, { id: me.id })).ok, true)
  const acc = await a.reviewMasterEstimate(owner, { id: me.id, decision: 'accept' })
  assert.equal(acc.data.masterEstimate.status, 'accepted')
  assert.equal((await a.cancelMasterEstimate(master, { id: me.id })).code, 'IN_USE')
})

test('owner records a master invoice on his behalf; master cannot act for someone else', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const c = await a.createFromMaster(owner, { requestId: 'sr-1', kind: 'preliminary', lines, performerUid: 'u-m', clientKey: 'key-00000003' })
  assert.equal(c.ok, true)
  assert.equal(c.data.masterEstimate.performerUid, 'u-m')
  assert.equal(c.data.masterEstimate.kind, 'preliminary')
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', lines, performerUid: 'u-d', clientKey: 'key-00000004' })).code, 'NO_PERM')
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', lines: [], clientKey: 'key-00000005' })).code, 'BAD_LINES')
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', lines })).code, 'BAD_CLIENT_KEY')
})

const submitted = async (a, who = master, key = 'key-00000010', ls = lines, kind = 'actual') => {
  const c = await a.createFromMaster(who, { requestId: 'sr-1', kind, lines: ls, clientKey: key })
  await a.submitMasterEstimate(who, { id: c.data.masterEstimate.id })
  return c.data.masterEstimate.id
}

test('to client → NEW actual: markup from the centre, overrides, journal entries, request in_work, sources accepted', async () => {
  const db = new FakeDb(seed({ 'serviceRequests/sr-1': { status: 'diagnostics', serviceCenterId: 'kat', specialists: [{ uid: 'u-m', name: 'М' }], extraExpenses: [{ id: 'p1', title: 'Доставка', amount: 100, appliedToEstimateId: null }] } }))
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a)
  const draftId = (await a.createFromMaster(master, { requestId: 'sr-1', lines, clientKey: 'key-00000011' })).data.masterEstimate.id
  assert.equal((await a.toClient(director, { requestId: 'sr-1', sourceIds: [draftId], target: 'actual', clientKey: 'key-00000012' })).code, 'NOT_SUBMITTED')
  assert.equal((await a.toClient(master, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', clientKey: 'key-00000012' })).code, 'NO_PERM')
  const r = await a.toClient(director, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', amounts: { [`${meId}:1`]: 300 }, clientKey: 'key-00000013' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.created, true)
  // 500 × 1.3 = 650; рядок 2 — правка 300; + очікувана витрата 100
  assert.equal(r.data.total, 1050)
  const est = db.get(`priceEstimates/${r.data.estimateId}`)
  assert.equal(est.kind, 'actual')
  assert.equal(est.status, 'approved')
  assert.equal(est.parentEstimateId, null)
  assert.deepEqual(est.payOptions, [{ method: 'liqpayCard', fopId: 'fop-1' }])
  assert.equal(est.lines.length, 3)
  assert.equal(est.lines.every((l) => l.extra && l.refId.startsWith('extra:')), true)
  // у копіях (читає весь персонал) — лише id і індекс, без суми майстру й виконавця
  assert.deepEqual(est.lines[1].fromMaster, { masterEstimateId: meId, index: 0 })
  assert.equal(est.lines[2].name.uk, 'Ремкомплект (2 шт)')
  assert.equal(est.receiptGoods.length, 3)
  const sr = db.get('serviceRequests/sr-1')
  assert.equal(sr.actualEstimateId, r.data.estimateId)
  assert.equal(sr.status, 'in_work')
  assert.ok(sr.statusChangedAt)
  assert.equal(sr.extraExpenses.length, 3)
  assert.equal(sr.extraExpenses.every((x) => x.appliedToEstimateId === r.data.estimateId), true)
  assert.equal(sr.extraExpenses[1].source, 'master')
  assert.deepEqual(sr.extraExpenses[1].masterRef, { masterEstimateId: meId, index: 0 })
  const me = db.get(`masterEstimates/${meId}`)
  assert.equal(me.status, 'accepted')
  assert.equal(me.derived[0].type, 'actual')
  // повтор того самого запиту
  const again = await a.toClient(director, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', amounts: { [`${meId}:1`]: 300 }, clientKey: 'key-00000013' })
  assert.equal(again.ok, true)
  assert.equal(again.data.duplicate, true)
})

test('to client → APPEND to an existing actual (reapproval against the parent), blocked when paid', async () => {
  const db = new FakeDb(seed({
    'serviceRequests/sr-1': { status: 'in_work', serviceCenterId: 'kat', actualEstimateId: 'act-1', extraExpenses: [] },
    'priceEstimates/var-1': { kind: 'preliminary', stage: 'proposed', total: 1000, lines: [] },
    'priceEstimates/act-1': { kind: 'actual', status: 'approved', parentEstimateId: 'var-1', total: 1000, discount: null, lines: [{ type: 'labor', refId: 'w1', name: { uk: 'Робота' }, qty: 1, unitPrice: 1000, lineTotal: 1000 }], history: [], updatedAt: '2026-10-18T10:00:00.000Z' },
  }))
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a)
  const r = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', markupPct: 0, clientKey: 'key-00000020' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.created, false)
  assert.equal(r.data.appended, 2)
  assert.equal(r.data.total, 1700)
  assert.equal(r.data.status, 'pending_approval') // +70 % від варіанта
  assert.equal(db.get('priceEstimates/act-1').history.length, 1)
  assert.equal(db.get('priceEstimates/act-1').lastEditedVia, 'app')
  // оплачений факт
  db.docs['priceEstimates/act-1'].status = 'paid'
  const meId2 = await submitted(a, master, 'key-00000021')
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId2], target: 'actual', clientKey: 'key-00000022' })).code, 'PAID')
})

test('to client → VARIANT: new offer, request offered, second variant appended; closed offer refused', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a, master, 'key-00000030', lines, 'preliminary')
  const r = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'variant', variantLabel: 'Ремонт керма', clientKey: 'key-00000031' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.newOffer, true)
  const v = db.get(`priceEstimates/${r.data.estimateId}`)
  assert.equal(v.stage, 'proposed')
  assert.equal(v.offerId, r.data.offerId)
  assert.equal(v.variantLabel, 'Ремонт керма')
  assert.equal(v.total, 910) // (500 + 200) × 1.3
  const sr = db.get('serviceRequests/sr-1')
  assert.equal(sr.offerId, r.data.offerId)
  assert.equal(sr.status, 'offered')
  const offer = db.get(`estimateOffers/${r.data.offerId}`)
  assert.equal(offer.status, 'pending_choice')
  assert.deepEqual(offer.variantIds, [r.data.estimateId])
  const me2 = await submitted(a, master, 'key-00000032', [{ title: 'Бюджетно', amount: 300 }], 'preliminary')
  const r2 = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [me2], target: 'variant', clientKey: 'key-00000033' })
  assert.equal(r2.data.newOffer, false)
  assert.equal(db.get(`estimateOffers/${r.data.offerId}`).variantIds.length, 2)
  assert.equal(db.get(`priceEstimates/${r2.data.estimateId}`).variantLabel, 'Варіант 2')
  db.docs[`estimateOffers/${r.data.offerId}`].status = 'chosen'
  const me3 = await submitted(a, master, 'key-00000034', lines, 'preliminary')
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [me3], target: 'variant', clientKey: 'key-00000035' })).code, 'OFFER_CLOSED')
})

test('to client: a source cancelled concurrently is caught inside the transaction', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a)
  const orig = db.runTransaction.bind(db)
  db.runTransaction = async (fn) => { db.docs[`masterEstimates/${meId}`].status = 'returned'; db.runTransaction = orig; return orig(fn) }
  const r = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', clientKey: 'key-00000040' })
  assert.equal(r.code, 'CONFLICT')
  assert.equal(db.get('serviceRequests/sr-1').actualEstimateId, undefined)
})

test('from client → calculation TO the master: selected lines, manual amounts, issued', async () => {
  const db = new FakeDb(seed({
    'priceEstimates/act-1': { kind: 'actual', serviceRequestId: 'sr-1', total: 1500, lines: [
      { type: 'labor', refId: 'w1', name: { uk: 'Ремонт керма' }, qty: 1, lineTotal: 1000 },
      { type: 'material', refId: 'm1', name: { uk: 'Сервопривід' }, qty: 1, lineTotal: 500 },
    ] },
  }))
  const a = createMasterEstimateActions({ adminDb: db })
  const r = await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 0, amount: 400, refId: 'w1' }], issue: false, clientKey: 'key-00000050' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const me = r.data.masterEstimate
  assert.equal(me.direction, 'to_master')
  assert.equal(me.kind, 'actual')
  assert.equal(me.status, 'submitted') // завжди виставлена, без чернетки (issue: false ігнорується)
  assert.equal(me.total, 400)
  assert.equal(me.lines[0].title, 'Ремонт керма')
  assert.deepEqual(me.lines[0].sourceLineRef, { estimateId: 'act-1', index: 0 })
  assert.deepEqual(me.basedOn, { type: 'clientEstimate', id: 'act-1' })
  assert.equal((await a.fromClient(master, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 0, amount: 1 }], clientKey: 'key-00000051' })).code, 'NO_PERM')
  assert.equal((await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-x', lines: [{ index: 0, amount: 1 }], clientKey: 'key-00000052' })).code, 'BAD_ASSIGNEE')
  assert.equal((await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 9, amount: 1 }], clientKey: 'key-00000053' })).code, 'BAD_LINES')
  // індекс з застарілого екрана: refId не збігається → CONFLICT, а не назва чужого рядка
  assert.equal((await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 0, amount: 1, refId: 'm1' }], clientKey: 'key-00000054' })).code, 'CONFLICT')
  // друга калькуляція майстру без workId — та сама робота «Ремонт» виконавця, без дубля
  const r2 = await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 1, amount: 100 }], clientKey: 'key-00000055' })
  assert.equal(r2.data.masterEstimate.workId, me.workId)
  assert.equal(db.list('serviceRequests/sr-1/works').length, 1)
  // повтор того самого ключа з іншими сумами — не «той самий запит»
  assert.equal((await a.fromClient(owner, { clientEstimateId: 'act-1', performerUid: 'u-m', lines: [{ index: 1, amount: 999 }], clientKey: 'key-00000055' })).code, 'CLIENT_KEY_REUSED')
  // калькуляцію ДО майстра майстер не редагує і не «приймає»
  assert.equal((await a.updateMasterEstimate(master, { id: me.id, comment: 'x' })).code, 'NO_PERM')
  assert.equal((await a.reviewMasterEstimate(owner, { id: me.id, decision: 'accept' })).code, 'BAD_DIRECTION')
})

test('to client → APPEND: lines of a master estimate already in the actual are refused (no double money)', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const meA = await submitted(a)
  const first = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meA], target: 'actual', clientKey: 'key-00000070' })
  assert.equal(first.ok, true, JSON.stringify(first))
  const total = db.get(`priceEstimates/${first.data.estimateId}`).total
  const meB = await submitted(a, master, 'key-00000071', [{ title: 'Тест на воді', amount: 300 }])
  // А вже «прийнята» і в факті — разом з Б дописати не можна
  const again = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meA, meB], target: 'actual', clientKey: 'key-00000072' })
  assert.equal(again.code, 'ALREADY_IN_ACTUAL')
  assert.equal(db.get(`priceEstimates/${first.data.estimateId}`).total, total)
  // лише Б — дописується
  const onlyB = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meB], target: 'actual', clientKey: 'key-00000073' })
  assert.equal(onlyB.ok, true, JSON.stringify(onlyB))
  assert.equal(onlyB.data.appended, 1)
})

test('to client → NEW actual when the client chose a variant: child of that variant, reapproval, offer locked; open offer refused', async () => {
  const db = new FakeDb(seed({
    'serviceRequests/sr-1': { status: 'approved', serviceCenterId: 'kat', offerId: 'off-1', extraExpenses: [] },
    'estimateOffers/off-1': { serviceRequestId: 'sr-1', variantIds: ['var-1'], selectedVariantId: null, status: 'pending_choice' },
    'priceEstimates/var-1': { kind: 'preliminary', stage: 'proposed', offerId: 'off-1', serviceRequestId: 'sr-1', title: 'Ремонт керма', total: 1000, lines: [] },
  }))
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a)
  // клієнт ще не обрав — факт «напряму» не складаємо
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', clientKey: 'key-00000080' })).code, 'NO_CHOICE')
  Object.assign(db.docs['estimateOffers/off-1'], { selectedVariantId: 'var-1', status: 'chosen' })
  // 500 × 2 + 200 × 2 = 1400 → +40 % від погоджених 1000
  const r = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', markupPct: 100, clientKey: 'key-00000081' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.data.total, 1400)
  assert.equal(r.data.status, 'pending_approval')
  assert.equal(r.data.reapproval.required, true)
  const est = db.get(`priceEstimates/${r.data.estimateId}`)
  assert.equal(est.parentEstimateId, 'var-1')
  assert.equal(est.status, 'pending_approval')
  assert.equal(est.title, 'Ремонт керма')
  assert.equal(db.get('estimateOffers/off-1').status, 'locked')
})

test('to client → NEW actual: the client re-chose concurrently → PATH_CHANGED', async () => {
  const db = new FakeDb(seed({
    'serviceRequests/sr-1': { status: 'approved', serviceCenterId: 'kat', offerId: 'off-1', extraExpenses: [] },
    'estimateOffers/off-1': { serviceRequestId: 'sr-1', variantIds: ['var-1', 'var-2'], selectedVariantId: 'var-1', status: 'chosen' },
    'priceEstimates/var-1': { kind: 'preliminary', stage: 'proposed', offerId: 'off-1', total: 1000, lines: [] },
    'priceEstimates/var-2': { kind: 'preliminary', stage: 'proposed', offerId: 'off-1', total: 900, lines: [] },
  }))
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a)
  const orig = db.runTransaction.bind(db)
  db.runTransaction = async (fn) => { db.docs['estimateOffers/off-1'].selectedVariantId = 'var-2'; db.runTransaction = orig; return orig(fn) }
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', clientKey: 'key-00000082' })).code, 'PATH_CHANGED')
  assert.equal(db.get('serviceRequests/sr-1').actualEstimateId, undefined)
})

test('to client → VARIANT: an offer created concurrently is not overwritten (CONFLICT)', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a, master, 'key-00000090', lines, 'preliminary')
  const orig = db.runTransaction.bind(db)
  db.runTransaction = async (fn) => { db.docs['serviceRequests/sr-1'].offerId = 'off-parallel'; db.runTransaction = orig; return orig(fn) }
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'variant', clientKey: 'key-00000091' })).code, 'CONFLICT')
  assert.equal(db.get('serviceRequests/sr-1').offerId, 'off-parallel')
})

test('same clientKey with different content → CLIENT_KEY_REUSED (estimate, variant, work)', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const c1 = await a.createFromMaster(master, { requestId: 'sr-1', lines, clientKey: 'key-00000100' })
  assert.equal(c1.data.created, true)
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', lines, clientKey: 'key-00000100' })).data.created, false)
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', lines: [{ title: 'Інше', amount: 1 }], clientKey: 'key-00000100' })).code, 'CLIENT_KEY_REUSED')
  // друга калькуляція майстра без роботи — той самий «Ремонт», без дубля
  const c2 = await a.createFromMaster(master, { requestId: 'sr-1', lines, clientKey: 'key-00000101' })
  assert.equal(c2.data.masterEstimate.workId, c1.data.masterEstimate.workId)
  await a.submitMasterEstimate(master, { id: c1.data.masterEstimate.id })
  const v = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [c1.data.masterEstimate.id], target: 'variant', variantLabel: 'А', clientKey: 'key-00000102' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [c1.data.masterEstimate.id], target: 'variant', variantLabel: 'А', clientKey: 'key-00000102' })).data.created, false)
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [c1.data.masterEstimate.id], target: 'variant', variantLabel: 'Б', clientKey: 'key-00000102' })).code, 'CLIENT_KEY_REUSED')
  const w = await a.addWork(master, { requestId: 'sr-1', kind: 'water_test', clientKey: 'key-00000103' })
  assert.equal(w.data.created, true)
  assert.equal((await a.addWork(master, { requestId: 'sr-1', kind: 'packing', clientKey: 'key-00000103' })).code, 'CLIENT_KEY_REUSED')
  // ключ і id роботи потрапляють у шлях документа — «/» та інше відхиляються
  assert.equal((await a.addWork(master, { requestId: 'sr-1', kind: 'packing', clientKey: 'a/b/c/d/e/f' })).code, 'BAD_CLIENT_KEY')
  assert.equal((await a.createFromMaster(master, { requestId: 'sr-1', workId: 'x/y', lines, clientKey: 'key-00000104' })).code, 'BAD_ID')
  const viaDoc = await a.createFromMaster(master, { requestId: 'sr-1', lines, via: '<script>', clientKey: 'key-00000105' })
  assert.equal(viaDoc.data.masterEstimate.via, 'app')
})

test('variant from masters → client chooses → actual from that variant: master lines journaled, removable', async () => {
  const db = new FakeDb(seed())
  const a = createMasterEstimateActions({ adminDb: db })
  const meId = await submitted(a, master, 'key-00000110', lines, 'preliminary')
  const v = await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'variant', clientKey: 'key-00000111' })
  assert.equal(v.ok, true, JSON.stringify(v))
  Object.assign(db.docs[`estimateOffers/${v.data.offerId}`], { selectedVariantId: v.data.estimateId, status: 'chosen' })
  const ea = createEstimateActions({ adminDb: db })
  const act = await ea.createActualFromVariant(owner, { requestId: 'sr-1', clientKey: 'key-00000112' })
  assert.equal(act.ok, true, JSON.stringify(act))
  const est = db.get(`priceEstimates/${act.data.estimateId}`)
  assert.equal(est.lines.length, 2)
  const sr = db.get('serviceRequests/sr-1')
  assert.equal(sr.extraExpenses.length, 2)
  assert.deepEqual(sr.extraExpenses.map((x) => `extra:${x.id}`), est.lines.map((l) => l.refId))
  assert.equal(sr.extraExpenses.every((x) => x.source === 'master' && x.appliedToEstimateId === act.data.estimateId), true)
  assert.equal(sr.extraExpenses[0].masterRef.masterEstimateId, meId)
  // ті самі рядки дописати у факт удруге не можна
  assert.equal((await a.toClient(owner, { requestId: 'sr-1', sourceIds: [meId], target: 'actual', clientKey: 'key-00000113' })).code, 'ALREADY_IN_ACTUAL')
  // рядок майстра з факту вилучається (раніше — NO_EXPENSE)
  const rm = await ea.removeExtraExpense(owner, { requestId: 'sr-1', expenseId: sr.extraExpenses[1].id })
  assert.equal(rm.ok, true, JSON.stringify(rm))
  assert.equal(db.get(`priceEstimates/${act.data.estimateId}`).lines.length, 1)
})

// ---------- HTTP ----------
const makeApp = (db, staff, notifyClient) => {
  const app = express()
  app.use(express.json())
  registerMasterEstimates(app, { adminDb: db, notifyClient, verifyStaff: async () => staff })
  return app
}
const call = (app, method, url, body) => new Promise((resolve) => {
  const server = app.listen(0, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      resolve({ status: res.status, json: await res.json() })
    } finally { server.close() }
  })
})

test('HTTP: full path master → owner → client actual, with one notification', async () => {
  const db = new FakeDb(seed())
  const notified = []
  const nf = async (p) => { notified.push(p.event); return { status: 'sent', channel: 'sms' } }
  const asMaster = makeApp(db, master, nf)
  const asOwner = makeApp(db, owner, nf)
  const w = await call(asMaster, 'POST', '/api/service-requests/sr-1/works', { kind: 'repair', clientKey: 'key-00000060' })
  assert.equal(w.status, 201, JSON.stringify(w.json))
  const c = await call(asMaster, 'POST', '/api/master-estimates', { serviceRequestId: 'sr-1', workId: w.json.data.work.id, kind: 'actual', lines, clientKey: 'key-00000061' })
  assert.equal(c.status, 201, JSON.stringify(c.json))
  const id = c.json.data.masterEstimate.id
  assert.equal((await call(asMaster, 'PATCH', `/api/master-estimates/${id}`, { comment: 'готово' })).status, 200)
  assert.equal((await call(asMaster, 'POST', `/api/master-estimates/${id}/submit`)).status, 200)
  const t = await call(asOwner, 'POST', '/api/master-estimates/to-client', { serviceRequestId: 'sr-1', sourceIds: [id], target: 'actual', clientKey: 'key-00000062' })
  assert.equal(t.status, 201, JSON.stringify(t.json))
  assert.equal(t.json.data.total, 910)
  assert.deepEqual(t.json.data.notify, { status: 'sent', channel: 'sms', skipped: false })
  assert.deepEqual(notified, ['actual'])
  const again = await call(asOwner, 'POST', '/api/master-estimates/to-client', { serviceRequestId: 'sr-1', sourceIds: [id], target: 'actual', clientKey: 'key-00000062' })
  assert.equal(again.status, 200)
  assert.deepEqual(notified, ['actual'])
  const toM = await call(asOwner, 'POST', '/api/master-estimates/from-client', { clientEstimateId: t.json.data.estimateId, performerUid: 'u-m', lines: [{ index: 0, amount: 450 }], clientKey: 'key-00000063' })
  assert.equal(toM.status, 201, JSON.stringify(toM.json))
  assert.equal((await call(makeApp(db, null), 'POST', '/api/master-estimates', { serviceRequestId: 'sr-1' })).status, 403)
  assert.equal((await call(asMaster, 'POST', '/api/master-estimates', { serviceRequestId: 'bad id!' })).json.error.code, 'NEED_REQUEST')
  assert.equal((await call(asMaster, 'POST', '/api/master-estimates/nope/review', { decision: 'accept' })).status, 404)
})
