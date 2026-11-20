// node --test: Telegram-бот СОТРУДНИКОВ по заявкам — ядро (staffBotCore.js) и транспорт (staffBot.js) на
// фейковом Firestore (в памяти, транзакции сериализуются, как в настоящей базе) с подменённым Claude и
// подменёнными запросами к Telegram (axios) — без сети и без firebase-admin.
import test from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import { createStaffBotCore, phoneVariants } from './staffBotCore.js'
import { registerStaffBot } from './staffBot.js'
import { normalizePhone } from './messengerCore.js'
import { extraLine, recomputeTotals, applyEstimateDiscount, round2 } from './estimateEngine.js'

// ---------- запросы к Telegram: никакой сети ----------
const tgSent = []
axios.post = async (url, payload) => { tgSent.push({ method: String(url).split('/').pop(), payload }); return { data: { ok: true, result: { message_id: 1 } } } }
axios.get = async () => ({ data: { ok: true, result: { username: 'rf_staff_bot' } } })
const lastText = () => (tgSent.filter((x) => x.method === 'sendMessage').pop() || {}).payload?.text || ''
const lastKeyboard = () => (tgSent.filter((x) => x.method === 'sendMessage').pop() || {}).payload?.reply_markup

// ---------- фейковый Firestore ----------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor() { this.data = {}; this.chain = Promise.resolve(); this.beforeTx = null }
  col(name) { if (!this.data[name]) this.data[name] = {}; return this.data[name] }
  set(name, id, v, opts) {
    const c = this.col(name)
    if (opts && opts.merge && c[id]) deepMerge(c[id], v)
    else c[id] = clone(v)
  }
  get(name, id) { return clone(this.col(name)[id]) }
  ref(name, id) {
    const db = this
    return {
      id, _col: name,
      async get() { const d = db.col(name)[id]; return { id, exists: !!d, ref: db.ref(name, id), data: () => clone(d) } },
      async set(v, opts) { db.set(name, id, v, opts) },
    }
  }
  collection(name) {
    const db = this
    const q = (filters = [], order = null, lim = null, sel = null) => ({
      where: (f, op, v) => q([...filters, { f, op, v }], order, lim, sel),
      orderBy: (f, dir) => q(filters, { f, dir }, lim, sel),
      limit: (n) => q(filters, order, n, sel),
      select: (...fields) => q(filters, order, lim, fields),
      doc: (id) => db.ref(name, id),
      async get() {
        let rows = Object.entries(db.col(name)).map(([id, d]) => ({ id, d }))
        for (const { f, op, v } of filters) rows = rows.filter(({ d }) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : false))
        // без orderBy Firestore отдаёт по id документа
        rows.sort((a, b) => (order ? String(a.d[order.f] || '').localeCompare(String(b.d[order.f] || '')) * (order.dir === 'desc' ? -1 : 1) : a.id.localeCompare(b.id)))
        if (lim) rows = rows.slice(0, lim)
        const docs = rows.map(({ id, d }) => ({
          id, exists: true, ref: db.ref(name, id),
          data: () => { const c = clone(d); if (!sel) return c; const o = {}; for (const k of sel) if (k in c) o[k] = c[k]; return o },
        }))
        return { empty: !docs.length, docs }
      },
    })
    return q()
  }
  async runTransaction(fn) {
    const prev = this.chain
    let release
    this.chain = new Promise((r) => { release = r })
    await prev
    try {
      // одноразовый хук: «параллельная запись» между чтением до транзакции и самой транзакцией
      if (this.beforeTx) { const h = this.beforeTx; this.beforeTx = null; h(this) }
      return await fn({ get: (ref) => ref.get(), set: (ref, v, opts) => this.set(ref._col, ref.id, v, opts) })
    } finally { release() }
  }
}

// ---------- подменённый Claude: очередь сценарных ответов ----------
const anthropic = { queue: [], messages: { create: async (req) => {
  const next = anthropic.queue.shift()
  if (!next) throw new Error('no scripted response')
  return typeof next === 'function' ? next(req) : next
} } }
const toolCall = (name, input, id = 't1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } })
const endTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } })
const buildUsage = (u = {}) => ({ model: 'test', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 })

// ---------- данные ----------
const now = new Date().toISOString()
const line = (refId, type, total, qty = 1) => ({ type, refId, code: refId.toUpperCase(), name: { uk: `Робота ${refId}` }, qty, unitPrice: round2(total / qty), seasonApplied: false, lineTotal: total })
const db = new FakeDb()
const seedDoc = (name, id, d) => db.set(name, id, { id, ...d })
const users = {
  'u-owner': { email: 'owner@x', displayName: 'Власник', role: 'owner', active: true, centers: [], telegramUserId: 111 },
  'u-master': { email: 'master@x', displayName: 'Майстер А', role: 'master', active: true, centers: [{ centerId: 'cA', perms: ['view', 'actual'] }], telegramUserId: 222 },
  'u-view': { email: 'view@x', displayName: 'Майстер Б', role: 'master', active: true, centers: [{ centerId: 'cA', perms: ['view'] }], telegramUserId: 333 },
  'u-acc': { email: 'acc@x', displayName: 'Бухгалтер', role: 'accountant', active: true, centers: [], telegramUserId: 444 },
  'u-old': { email: 'old@x', displayName: 'Старий', role: 'master', active: false, centers: [], telegramUserId: 555 },
  'u-op': { email: 'op@x', displayName: 'Оператор', role: 'operator', active: true, centers: [], telegramUserId: 666 },
  'u-new': { email: 'new@x', displayName: 'Новий', role: 'master', active: true, centers: [{ centerId: 'cA', perms: ['view'] }] },
}
for (const [id, u] of Object.entries(users)) seedDoc('users', id, u)
seedDoc('priceEstimates', 'est-prelim', { ...recomputeTotals({}, [line('w1', 'labor', 1000)]), kind: 'preliminary', stage: 'proposed' })
seedDoc('priceEstimates', 'est-act', { ...recomputeTotals({}, [line('w1', 'labor', 700), line('m1', 'material', 300, 2)]), kind: 'actual', status: 'approved', parentEstimateId: 'est-prelim', serviceRequestId: 'sr-1', history: [] })
seedDoc('serviceRequests', 'sr-1', { createdAt: '2026-10-01T10:00:00.000Z', clientName: 'Петренко Іван', clientPhone: '+380673833000', boat: 'Solo V3', complaint: 'не працює мотор', status: 'in_work', serviceCenterId: 'cA', actualEstimateId: 'est-act', onec: { number: '0001234' } })
seedDoc('serviceRequests', 'sr-2', { createdAt: '2026-09-01T10:00:00.000Z', clientName: 'Сидоренко Олег', clientPhone: '380 50 111 22 33', boat: 'R3', status: 'new', serviceCenterId: 'cB' })
seedDoc('serviceRequests', 'sr-3', { createdAt: '2026-09-15T10:00:00.000Z', clientName: 'Петренко Марія', clientPhone: '0501112233', boat: 'Mini', status: 'new', serviceCenterId: 'cA' })
seedDoc('serviceRequests', 'sr-paid', { createdAt: '2026-08-01T10:00:00.000Z', clientName: 'Оплачений', status: 'done', serviceCenterId: 'cA', actualEstimateId: 'est-paid', paymentId: 'pay1' })
seedDoc('priceEstimates', 'est-paid', { ...recomputeTotals({}, [line('w1', 'labor', 500)]), kind: 'actual', status: 'paid', paymentId: 'pay1' })

const core = createStaffBotCore({ adminDb: db, anthropic, AI_MODEL: 'test', buildUsage, siteUrl: 'https://my.runferry.com' })
const ops = core.ops
const S = {}
test('setup: staff resolved by Telegram id', async () => {
  S.owner = await core.resolveStaffByTelegram(111)
  S.master = await core.resolveStaffByTelegram(222)
  S.viewer = await core.resolveStaffByTelegram(333)
  S.acc = await core.resolveStaffByTelegram(444)
  assert.equal(S.owner.role, 'owner'); assert.equal(S.master.role, 'master'); assert.equal(S.acc.role, 'accountant')
  assert.equal(await core.resolveStaffByTelegram(555), null, 'деактивований')
  assert.equal(await core.resolveStaffByTelegram(666), null, 'оператор дзвінків — не персонал')
  assert.equal(await core.resolveStaffByTelegram(999), null)
})

test('phoneVariants covers the stored formats; normalizePhone', () => {
  assert.equal(normalizePhone('067383 3000'), '380673833000')
  const v = phoneVariants('380673833000')
  for (const x of ['380673833000', '+380673833000', '0673833000', '+380 67 383 30 00', '067 383 30 00']) assert.ok(v.includes(x), x)
  assert.ok(v.length <= 30, 'ліміт in-запиту Firestore')
})

test('findRequests: phone in any format, name, 1C number, center visibility', async () => {
  assert.deepEqual((await core.findRequests(S.owner, { phone: '067383 3000' })).requests.map((r) => r.id), ['sr-1'])
  assert.deepEqual((await core.findRequests(S.owner, { phone: '+38 (050) 111-22-33' })).requests.map((r) => r.id).sort(), ['sr-2', 'sr-3'])
  assert.deepEqual((await core.findRequests(S.owner, { name: 'петренко' })).requests.map((r) => r.id).sort(), ['sr-1', 'sr-3'])
  assert.deepEqual((await core.findRequests(S.owner, { number: '1234' })).requests.map((r) => r.id), ['sr-1'])
  const m = await core.findRequests(S.master, { phone: '0501112233' })
  assert.deepEqual(m.requests.map((r) => r.id), ['sr-3']); assert.equal(m.hiddenByAccess, 1)
  assert.ok((await core.findRequests(S.owner, {})).error)
})

test('findRequests: an exact hit does not hide the same client stored in another format', async () => {
  seedDoc('serviceRequests', 'sr-old15', { createdAt: '2025-01-01T00:00:00.000Z', clientName: 'К', clientPhone: '+380671112299', status: 'done', serviceCenterId: 'cA' })
  seedDoc('serviceRequests', 'sr-new15', { createdAt: '2026-10-01T00:00:00.000Z', clientName: 'К', clientPhone: '+38 067 111 2299', status: 'in_work', serviceCenterId: 'cA' })
  assert.deepEqual((await core.findRequests(S.owner, { phone: '0671112299' })).requests.map((r) => r.id), ['sr-new15', 'sr-old15'])
})

test('getRequestDetails: estimate and permissions by role and center', async () => {
  const d = await core.getRequestDetails(S.master, 'sr-1')
  assert.equal(d.actualEstimate.total, 1000); assert.equal(d.permissions.canEditEstimate, true)
  assert.equal((await core.getRequestDetails(S.viewer, 'sr-1')).permissions.canEditEstimate, false)
  assert.equal((await core.getRequestDetails(S.acc, 'sr-1')).permissions.canEditRequest, false)
  assert.ok((await core.getRequestDetails(S.master, 'sr-2')).error, 'чужий центр')
})

test('add extra expense: line into the actual, receipt and history rebuilt, 10 % re-approval, journal entry', async () => {
  const r = await core.applyAction(S.master, { id: 'a1', type: 'add_extra_expense', params: { requestId: 'sr-1', title: 'Доставка Новою Поштою', amount: 560 } })
  assert.ok(r.ok, r.text)
  const e = db.get('priceEstimates', 'est-act')
  assert.equal(e.total, 1560); assert.equal(e.addonsTotal, 560); assert.equal(e.status, 'pending_approval')
  assert.ok(e.lines[2].extra && e.lines[2].refId.startsWith('extra:'))
  assert.equal(round2(e.receiptGoods.reduce((s, g) => s + g.price * g.qty, 0)), 1560)
  assert.equal(e.history.length, 1); assert.equal(e.lastEditedVia, 'telegram-bot')
  const j = db.get('serviceRequests', 'sr-1').extraExpenses
  assert.equal(j.length, 1); assert.equal(j[0].appliedToEstimateId, 'est-act'); assert.equal(j[0].clientKey, 'tg:a1'); assert.equal(j[0].source, 'telegram-bot')
  assert.match(r.text, /очікує погодження/)
  // та сама дія вдруге (подвійне натискання, інший інстанс) — DUPLICATE, другої строки немає
  const again = await core.applyAction(S.master, { id: 'a1', type: 'add_extra_expense', params: { requestId: 'sr-1', title: 'Доставка Новою Поштою', amount: 560 } })
  assert.equal(again.code, 'DUPLICATE'); assert.match(again.text, /уже додано/)
  assert.equal(db.get('priceEstimates', 'est-act').lines.length, 3)
  // вилучення повертає суму і статус
  const rm = await core.applyAction(S.owner, { id: 'a2', type: 'remove_extra_expense', params: { requestId: 'sr-1', expenseId: j[0].id } })
  assert.ok(rm.ok, rm.text)
  const e2 = db.get('priceEstimates', 'est-act')
  assert.equal(e2.total, 1000); assert.equal(e2.status, 'approved'); assert.equal(db.get('serviceRequests', 'sr-1').extraExpenses.length, 0)
})

test('add extra expense: refusals and recording on the request when there is no actual yet', async () => {
  assert.match((await core.applyAction(S.viewer, { id: 'b1', type: 'add_extra_expense', params: { requestId: 'sr-1', title: 'Д', amount: 100 } })).text, /фактична калькуляція/)
  assert.match((await core.applyAction(S.owner, { id: 'b2', type: 'add_extra_expense', params: { requestId: 'sr-paid', title: 'Д', amount: 100 } })).text, /оплачено/)
  assert.equal((await core.applyAction(S.owner, { id: 'b3', type: 'add_extra_expense', params: { requestId: 'sr-1', title: 'x', amount: -5 } })).ok, false)
  const r = await core.applyAction(S.master, { id: 'b4', type: 'add_extra_expense', params: { requestId: 'sr-3', title: 'Доставка', amount: 250.5 } })
  assert.ok(r.ok); assert.match(r.text, /Фактичного кошторису ще немає/)
  assert.equal(db.get('serviceRequests', 'sr-3').extraExpenses[0].appliedToEstimateId, null)
})

test('update request: diagnostics move «new» to «diagnostics», TTN normalised; paid status fixed; accountant read-only', async () => {
  seedDoc('serviceRequests', 'sr-u', { createdAt: now, status: 'new', serviceCenterId: 'cA' })
  const r = await core.applyAction(S.master, { id: 'c1', type: 'update_request', params: { requestId: 'sr-u', diagnostics: 'Згорів регулятор ходу', waybillNumber: '20 4501 2345 6789' } })
  assert.ok(r.ok, r.text)
  const sr = db.get('serviceRequests', 'sr-u')
  assert.equal(sr.status, 'diagnostics'); assert.equal(sr.waybillNumber, '20450123456789'); assert.ok(sr.statusChangedAt)
  assert.equal((await core.applyAction(S.owner, { id: 'c2', type: 'update_request', params: { requestId: 'sr-paid', status: 'new' } })).ok, false)
  assert.equal((await core.applyAction(S.acc, { id: 'c3', type: 'update_request', params: { requestId: 'sr-u', boat: 'X' } })).ok, false)
})

test('diagnostics append is built from the fresh text inside the transaction', async () => {
  seedDoc('serviceRequests', 'sr-d1', { createdAt: now, status: 'diagnostics', serviceCenterId: 'cA', diagnostics: { text: 'D1', at: 'a1' } })
  db.beforeTx = (d) => d.set('serviceRequests', 'sr-d1', { diagnostics: { text: 'D1\nD2 (портал)', at: 'a2' } }, { merge: true })
  const r = await core.applyAction(S.owner, { id: 'd1', type: 'update_request', params: { requestId: 'sr-d1', diagnosticsAppend: 'D3 (бот)' } })
  assert.ok(r.ok, r.text); assert.match(r.text, /дописано до діагностики/)
  assert.equal(db.get('serviceRequests', 'sr-d1').diagnostics.text, 'D1\nD2 (портал)\nD3 (бот)')
})

test('replacing diagnostics proposed on a stale snapshot → STALE; a long text cannot be replaced through the bot', async () => {
  seedDoc('serviceRequests', 'sr-d2', { createdAt: now, status: 'diagnostics', serviceCenterId: 'cA', diagnostics: { text: 'Короткий', at: 'b1' } })
  const session = await core.loadSession('chat-d2')
  anthropic.queue.push(toolCall('propose_update_request', { requestId: 'sr-d2', diagnostics: 'Новий текст' }), endTurn('Підтвердіть.'))
  const pr = await core.aiTurn({ session, staff: S.owner, text: 'перепиши діагностику' })
  assert.deepEqual(pr.pendingAction.params.expectDiagnostics, { at: 'b1', length: 8 })
  assert.match(pr.pendingAction.summary, /ЗАМІНИТИ діагностику \(8 симв\.\)/)
  db.set('serviceRequests', 'sr-d2', { diagnostics: { text: 'Короткий + дописав майстер', at: 'b2' } }, { merge: true })
  const r = await core.applyAction(S.owner, pr.pendingAction)
  assert.equal(r.code, 'STALE'); assert.match(db.get('serviceRequests', 'sr-d2').diagnostics.text, /майстер/)

  seedDoc('serviceRequests', 'sr-d3', { createdAt: now, status: 'diagnostics', serviceCenterId: 'cA', diagnostics: { text: 'А'.repeat(2486), at: now } })
  const s2 = await core.loadSession('chat-d3')
  anthropic.queue.push(toolCall('propose_update_request', { requestId: 'sr-d3', diagnostics: 'нове' }), (req) => {
    assert.match(JSON.parse(req.messages[req.messages.length - 1].content[0].content).error, /замінити її через бота не можна/)
    return endTurn('Можу лише дописати.')
  })
  assert.equal((await core.aiTurn({ session: s2, staff: S.owner, text: 'заміни діагностику' })).pendingAction, null)
})

test('aiTurn: search sets the current request; a proposal writes nothing until applied; one proposal per turn', async () => {
  const session = await core.loadSession('chat1')
  anthropic.queue.push(toolCall('find_requests', { phone: '067383 3000' }), endTurn('Знайшов заявку №0001234.'))
  const r1 = await core.aiTurn({ session, staff: S.master, text: 'найди заявку от 067383 3000' })
  assert.equal(session.currentRequestId, 'sr-1'); assert.equal(r1.pendingAction, null); assert.equal(r1.usage.calls, 2)
  session.messages.push({ role: 'user', text: 'найди заявку', at: now }, { role: 'assistant', text: r1.reply, at: now })
  anthropic.queue.push({ stop_reason: 'tool_use', usage: {}, content: [
    { type: 'tool_use', id: 'p1', name: 'propose_add_extra_expense', input: { requestId: 'sr-1', title: 'Доставка Новою Поштою', amount: 560 } },
    { type: 'tool_use', id: 'p2', name: 'propose_update_request', input: { requestId: 'sr-1', boat: 'Y' } },
  ] }, (req) => {
    const results = req.messages[req.messages.length - 1].content
    assert.equal(JSON.parse(results[0].content).pendingConfirmation, true)
    assert.match(JSON.parse(results[1].content).error, /очікує підтвердження/)
    assert.equal(req.messages[0].role, 'user')
    return endTurn('Додаю 560 грн. Підтвердіть.')
  })
  const r2 = await core.aiTurn({ session, staff: S.master, text: 'включи туда расходы на доставку 560 гривень' })
  assert.equal(r2.pendingAction.type, 'add_extra_expense'); assert.equal(r2.pendingAction.params.amount, 560)
  assert.match(r2.pendingAction.summary, /Доставка Новою Поштою.*560 грн.*фактичний кошторис/)
  assert.equal(db.get('priceEstimates', 'est-act').total, 1000, 'до підтвердження нічого не записано')
  anthropic.queue.push(() => { throw new Error('boom') })
  const r3 = await core.aiTurn({ session, staff: S.master, text: 'ще' })
  assert.match(r3.reply, /технічна помилка/i); assert.equal(r3.pendingAction, null)
})

test('aiTurn: the last iteration is sent with tool_choice none', async () => {
  const session = await core.loadSession('chat-iter')
  for (let i = 0; i < 5; i++) anthropic.queue.push(toolCall('find_requests', { name: `x${i}` }, `t${i}`))
  anthropic.queue.push((req) => { assert.deepEqual(req.tool_choice, { type: 'none' }); return endTurn('Нічого не знайшов.') })
  assert.equal((await core.aiTurn({ session, staff: S.owner, text: 'шукай' })).reply, 'Нічого не знайшов.')
})

test('link tokens: create, consume once, expiry, inactive profile, one Telegram per profile', async () => {
  const token = await core.createLinkToken({ uid: 'u-new', email: 'new@x' })
  const r = await core.consumeLinkToken(token, { id: 777, username: 'newbie' }, 777)
  assert.ok(r.ok); assert.equal(db.get('users', 'u-new').telegramUserId, 777)
  assert.equal((await core.resolveStaffByTelegram(777)).uid, 'u-new')
  assert.equal((await core.consumeLinkToken(token, { id: 777 }, 777)).reason, 'used')
  assert.equal((await core.consumeLinkToken('nope', { id: 777 }, 777)).reason, 'unknown')
  const t2 = await core.createLinkToken({ uid: 'u-view', email: 'view@x' })
  assert.ok((await core.consumeLinkToken(t2, { id: 777 }, 777)).ok)
  assert.equal(db.get('users', 'u-new').telegramUserId, null, 'старий профіль відвʼязано')
  assert.equal((await core.consumeLinkToken(await core.createLinkToken({ uid: 'u-old', email: 'old@x' }), { id: 888 }, 888)).reason, 'inactive')
  db.set('staffTgLinks', 'expired-token-aaaaaaaaaaaa', { uid: 'u-new', expiresAt: '2020-01-01T00:00:00.000Z', usedAt: null })
  assert.equal((await core.consumeLinkToken('expired-token-aaaaaaaaaaaa', { id: 1 }, 1)).reason, 'expired')
  // два профілі з одним Telegram id (гонка, ручна правка) — нікого, а не «перший за id документа»
  db.set('users', 'a-dup', { email: 'd@x', role: 'master', active: true, centers: [], telegramUserId: 4242 })
  db.set('users', 'b-dup', { email: 'd2@x', role: 'owner', active: true, centers: [], telegramUserId: 4242 })
  assert.equal(await core.resolveStaffByTelegram(4242), null)
  // повернути u-view його власний Telegram для наступних тестів
  db.set('users', 'u-view', { telegramUserId: 333 }, { merge: true })
})

test('pending actions: one atomic claim wins; saveSession never touches the pending action; restore refreshes the word TTL', async () => {
  const chat = 'chat-claim'
  await core.saveSession(await core.loadSession(chat))
  const action = { id: 'act-1', type: 'update_request', params: { requestId: 'sr-3', boat: 'Solo' }, requestId: 'sr-3', summary: 's', createdAt: now }
  await core.setPending(chat, action)
  const [a, b] = await Promise.all([core.claimPending(chat, 'act-1'), core.claimPending(chat, 'act-1')])
  assert.equal([a, b].filter(Boolean).length, 1)
  await core.setPending(chat, { ...action, id: 'act-2' })
  const s = await core.loadSession(chat); s.pendingAction = null; s.messages.push({ role: 'user', text: 'x', at: now })
  await core.saveSession(s)
  assert.equal(db.get('staffBotSessions', chat).pendingAction.id, 'act-2')
  assert.equal(await core.claimPending(chat, 'wrong-id'), null)
  assert.ok(await core.claimPending(chat, 'act-2'))
  const old = { ...action, id: 'act-3', createdAt: new Date(Date.now() - 29 * 60 * 1000).toISOString() }
  assert.ok(await core.restorePending(chat, old))
  assert.equal((await core.claimPending(chat, 'act-3', 30 * 60 * 1000)).id, 'act-3', 'offeredAt оновлено')
  await core.setPending(chat, { ...action, id: 'act-4', createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
  assert.equal(await core.claimPending(chat, 'act-4', 30 * 60 * 1000), null)
})

// ---------- транспорт: маршруты і повідомлення ----------
const fakeApp = () => { const routes = []; return { routes, post: (p, ...h) => routes.push(p), get: (p, ...h) => routes.push(p) } }
const msg = (chatId, fromId, text) => ({ chat: { id: chatId, type: 'private' }, from: { id: fromId }, text })
const cb = (chatId, fromId, data) => ({ id: `cb-${Math.random()}`, from: { id: fromId }, data, message: { message_id: 5, chat: { id: chatId, type: 'private' } } })

test('fail closed: without the webhook secret only /api/staff-bot/link is registered', () => {
  const env = { ...process.env }
  try {
    process.env.TELEGRAM_STAFF_BOT_TOKEN = 'tok'; delete process.env.TELEGRAM_STAFF_WEBHOOK_SECRET
    const a1 = fakeApp(); registerStaffBot(a1, { adminDb: db, anthropic, AI_MODEL: 'test', buildUsage })
    assert.deepEqual(a1.routes, ['/api/staff-bot/link'])
    delete process.env.TELEGRAM_STAFF_BOT_TOKEN
    const a0 = fakeApp(); registerStaffBot(a0, { adminDb: db, anthropic, AI_MODEL: 'test', buildUsage })
    assert.deepEqual(a0.routes, ['/api/staff-bot/link'])
    process.env.TELEGRAM_STAFF_BOT_TOKEN = 'tok'; process.env.TELEGRAM_STAFF_WEBHOOK_SECRET = 'sec'
    const a2 = fakeApp(); registerStaffBot(a2, { adminDb: db, anthropic, AI_MODEL: 'test', buildUsage })
    assert.deepEqual(a2.routes.sort(), ['/api/staff-bot/info', '/api/staff-bot/link', '/api/staff-bot/setup', '/api/staff-bot/webhook'])
  } finally { process.env = env }
})

const makeBot = () => {
  const env = { ...process.env }
  process.env.TELEGRAM_STAFF_BOT_TOKEN = 'tok'; process.env.TELEGRAM_STAFF_WEBHOOK_SECRET = 'sec'
  try { return registerStaffBot(fakeApp(), { adminDb: db, anthropic, AI_MODEL: 'test', buildUsage, siteUrl: 'https://my.runferry.com' }) } finally { process.env = env }
}

test('unlinked Telegram users get the onboarding text, not the AI', async () => {
  const bot = makeBot()
  await bot.handleMessage(msg(9100, 123456, 'привіт'))
  assert.match(lastText(), /лише для співробітників/)
})

test('«так» answers only the proposal from the latest reply; a replaced proposal is announced', async () => {
  const bot = makeBot()
  seedDoc('serviceRequests', 'sr-f2', { createdAt: now, clientName: 'Ф2', status: 'in_work', serviceCenterId: 'cA' })
  const chat = 9002
  anthropic.queue.push(toolCall('propose_add_extra_expense', { requestId: 'sr-f2', title: 'Доставка', amount: 560 }), endTurn('Додаю 560. Підтвердіть.'))
  await bot.handleMessage(msg(chat, 111, 'додай доставку 560'))
  assert.match(lastKeyboard().inline_keyboard[0][0].callback_data, /^sb:ok:/)
  anthropic.queue.push((req) => { assert.match(req.system, /ОЧІКУЄ ПІДТВЕРДЖЕННЯ/); return endTurn('Тобто 650 замість 560 — правильно?') })
  await bot.handleMessage(msg(chat, 111, 'ні, не 560, а 650'))
  anthropic.queue.push(endTurn('Уточніть суму ще раз.'))
  await bot.handleMessage(msg(chat, 111, 'так'))
  assert.equal((db.get('serviceRequests', 'sr-f2').extraExpenses || []).length, 0, 'старе 560 не застосовано')
  anthropic.queue.push(toolCall('propose_add_extra_expense', { requestId: 'sr-f2', title: 'Доставка', amount: 650 }), endTurn('Додаю 650. Підтвердіть.'))
  await bot.handleMessage(msg(chat, 111, 'додай 650'))
  assert.match(lastText(), /НЕ виконано — її замінено/)
  await bot.handleMessage(msg(chat, 111, 'так'))
  const j = db.get('serviceRequests', 'sr-f2').extraExpenses
  assert.equal(j.length, 1); assert.equal(j[0].amount, 650)
})

test('a retryable refusal (client is paying) restores the same action with the same buttons; it then applies once', async () => {
  const bot = makeBot()
  seedDoc('priceEstimates', 'est-f4', { ...recomputeTotals({}, [line('w1', 'labor', 1000)]), kind: 'actual', status: 'approved', payInitiatedAt: new Date().toISOString(), history: [] })
  seedDoc('serviceRequests', 'sr-f4', { createdAt: now, clientName: 'Ф4', status: 'in_work', serviceCenterId: 'cA', actualEstimateId: 'est-f4' })
  const chat = 9004
  anthropic.queue.push(toolCall('propose_add_extra_expense', { requestId: 'sr-f4', title: 'Запчастина', amount: 100 }), endTurn('Підтвердіть.'))
  await bot.handleMessage(msg(chat, 111, 'запчастина 100'))
  const pa = db.get('staffBotSessions', String(chat)).pendingAction
  await bot.handleCallback(cb(chat, 111, `sb:ok:${pa.id}`))
  assert.match(lastText(), /оплачує[\s\S]*Можна повторити/)
  assert.equal(lastKeyboard().inline_keyboard[0][0].callback_data, `sb:ok:${pa.id}`)
  db.set('priceEstimates', 'est-f4', { payInitiatedAt: null }, { merge: true })
  await bot.handleCallback(cb(chat, 111, `sb:ok:${pa.id}`))
  await bot.handleCallback(cb(chat, 111, `sb:ok:${pa.id}`))
  assert.equal(db.get('priceEstimates', 'est-f4').total, 1100)
  assert.equal(db.get('serviceRequests', 'sr-f4').extraExpenses.length, 1)
})

test('an expired (>24 h) proposal is cleared and kept out of the AI prompt', async () => {
  const bot = makeBot()
  const chat = 9010
  await core.saveSession(await core.loadSession(chat))
  await core.setPending(chat, { id: 'exp-1', type: 'update_request', params: { requestId: 'sr-f2', boat: 'X' }, requestId: 'sr-f2', summary: 'Дуже стара дія', createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() })
  anthropic.queue.push((req) => { assert.doesNotMatch(req.system, /ОЧІКУЄ ПІДТВЕРДЖЕННЯ/); return endTurn('Привіт!') })
  await bot.handleMessage(msg(chat, 111, 'привіт'))
  assert.equal(db.get('staffBotSessions', String(chat)).pendingAction, null)
})

test('discount intent survives a zero total, so a later bot line gets the same discount', () => {
  const zero = applyEstimateDiscount(recomputeTotals({}, [line('w1', 'labor', 0)]), { value: 10, kind: 'pct' })
  assert.deepEqual(zero.discount, { value: 10, kind: 'pct', amount: 0, grossTotal: 0 })
  assert.ok(extraLine({ id: 'z', title: 'Доставка', amount: 500 }).extra)
})
