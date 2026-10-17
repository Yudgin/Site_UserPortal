// Маршрути обговорення: лише чисті дані й підроблений Firestore, без мережі.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calledUntil, classifyCall, discussionFor, discussionFromCalls, discussionFromField, dsRequestFor, dsNeedsCalls, resolveLead, routeFor, dsJournal, parseDsTest, parseDsStaff } from './route.mjs'
import { makeLookup, APP_CALLS_LIMIT } from './lookup.mjs'

const H = 3600000
const NOW = Date.parse('2026-10-16T12:00:00Z') // п'ятниця, 15:00 Київ
const SR = { id: 'sr-fictional', status: 'new', createdAt: '2026-10-01T10:00:00Z' }
const LOOKUP = { requests: [SR] }
const PHONE = '+380500000001'
const config = { dsSource: 'calls', managerUri: 'sip:907@127.0.0.1', sipServer: '127.0.0.1', allowedCallers: [PHONE] }
const call = (over = {}) => ({ id: 'call-fictional', provider: 'binotel', direction: 'outbound', employeeUid: 'fictional-owner', employeeLine: '908', createdAt: new Date(NOW - H).toISOString(), status: 'summarized', disposition: 'ANSWER', durationSec: 20, ...over })
const from = (calls, nowMs = NOW) => discussionFromCalls({ calls, sr: SR, nowMs })
const field = (over = {}) => ({ ...SR, discussion: { state: 'open', ownerUid: 'fictional-owner', reason: 'talked', lastCallStartedAt: new Date(NOW - H).toISOString(), until: new Date(NOW + 3 * H).toISOString(), hardUntil: new Date(NOW + 7 * 24 * H).toISOString(), ...over } })

test('calls: ANSWER/TRANSFER із durationSec > 0 відкриває talked лише до межі 24 год', () => {
  for (const disposition of ['ANSWER', 'TRANSFER']) assert.equal(from([call({ disposition })]).ds.kind, 'talked')
  assert.equal(from([call({ createdAt: new Date(NOW - 24 * H + 1).toISOString() })]).ds.kind, 'talked')
  assert.deepEqual(from([call({ createdAt: new Date(NOW - 24 * H).toISOString() })]), { ds: null, why: 'expired' })
  assert.equal(from([call({ durationSec: 0 })]).ds, null)
  assert.equal(from([call({ disposition: 'NOANSWER' })]).ds, null)
})

test('calls: недодзвін у п’ятницю живе до вівторка 18:00 Київ; після 48 год — 15, а не 14', () => {
  const at = NOW
  assert.equal(calledUntil(at), Date.parse('2026-10-20T15:00:00Z'))
  assert.equal(calledUntil(Date.parse('2026-10-27T12:00:00Z')), Date.parse('2026-10-29T16:00:00Z'), 'зимовий час Києва')
  const c = call({ status: 'no_answer', failedParty: 'client', createdAt: new Date(at).toISOString() })
  assert.equal(from([c], at + 48 * H - 1).ds.kind, 'called')
  assert.equal(from([c], at + 48 * H).ds.kind, 'general')
  assert.equal(from([c], Date.parse('2026-10-20T14:59:59Z')).ds.kind, 'general')
  assert.equal(from([c], Date.parse('2026-10-20T15:00:00Z')).ds, null)
})

test('calls: int2ext із failedParty null — загальна 15; employee/failed/ai не відкривають і не стирають старіше обговорення', () => {
  assert.equal(from([call({ method: 'int2ext', status: 'no_answer', failedParty: null })]).ds.kind, 'general')
  for (const over of [{ kind: 'ai' }, { status: 'failed' }, { failedParty: 'employee', status: 'no_answer' }, { provider: 'other' }, { provider: undefined }, { direction: 'inbound' }, { direction: undefined }]) {
    assert.equal(from([call(over)]).ds, null)
    assert.equal(from([call(over), call({ id: 'older', createdAt: new Date(NOW - 2 * H).toISOString() })]).ds.callId, 'older')
  }
  assert.equal(discussionFromCalls({ sr: { ...SR, status: 'cancelled' }, calls: [call()], nowMs: NOW }).ds, null)
})

test('calls: pending діє включно до 30 хв, не дає дзвонити; завислий і майбутній запис пропускаємо', () => {
  for (const status of ['dialing', 'connected']) {
    const c = call({ status, createdAt: new Date(NOW - 30 * 60000).toISOString() })
    const ds = from([c]).ds
    assert.equal(ds.kind, 'pending')
    assert.equal(routeFor({ ds }).why, 'pending_call')
    assert.equal(from([{ ...c, createdAt: new Date(NOW - 30 * 60000 - 1).toISOString() }]).ds, null)
  }
  assert.equal(from([call({ status: 'dialing', createdAt: new Date(NOW + 1).toISOString() })]).ds, null)
})

test('calls: найсвіжіший значущий дзвінок; коротка/неповна розмова — 15 зі строком обговорення недодзвону', () => {
  for (const over of [{ status: 'skipped', skipReason: 'too_short' }, { legsIncomplete: true }]) {
    const c = call(over)
    const ds = from([c]).ds
    assert.equal(ds.kind, 'general')
    assert.equal(ds.reason, 'short_call')
    assert.equal(ds.until, calledUntil(Date.parse(c.createdAt)))
  }
  const latest = call({ id: 'latest', createdAt: new Date(NOW - 500).toISOString(), employeeUid: 'fictional-other' })
  assert.equal(from([call(), latest]).ds.ownerUid, 'fictional-other')
})

test('field: свіжість 13/14, sideUnknown, closing/hardUntil/until, пауза та brief.voice ≤ 150', () => {
  const run = (over) => discussionFromField({ sr: field(over), nowMs: NOW })
  assert.equal(run({}).ds.kind, 'talked')
  assert.equal(run({ lastCallStartedAt: new Date(NOW - 24 * H).toISOString() }).ds.kind, 'general')
  assert.equal(run({ reason: 'missed_our_call' }).ds.kind, 'called')
  assert.equal(run({ reason: 'missed_our_call', sideUnknown: true }).ds.kind, 'general')
  assert.equal(run({ reason: 'short_call' }).ds.kind, 'general', '14 — лише підтверджений недодзвін клієнту')
  assert.equal(run({ reason: 'short_call', lastCallStartedAt: new Date(NOW - 48 * H).toISOString() }).ds.kind, 'general')
  for (const reason of ['manual', 'callback_client', 'callback_staff', 'call_me_message', 'waiting_client', 'waiting_staff']) assert.equal(run({ reason }).ds.kind, 'general')
  for (const over of [{ state: 'closed' }, { until: new Date(NOW).toISOString() }, { hardUntil: new Date(NOW).toISOString() }, { state: 'closing', closing: { at: new Date(NOW).toISOString() } }]) assert.equal(run(over).ds, null)
  assert.ok(run({ state: 'closing', closing: { at: new Date(NOW + 1).toISOString() } }).ds)
  const d = run({ brief: { voice: ' а '.repeat(200), text: 'НЕ ЧИТАТИ' }, suspendedUntil: new Date(NOW + H).toISOString() }).ds
  assert.equal(d.voice.length, 150)
  assert.equal(d.suspendedUntil, NOW + H)
  assert.equal(run({ reason: 'pending_call', lastCallStartedAt: new Date(NOW - 31 * 60000).toISOString() }).why, 'stale_pending')
  assert.equal(run({ reason: 'pending_call', lastCallStartedAt: new Date(NOW - 10 * 60000).toISOString() }).ds.kind, 'pending')
})

test('discussionFor: джерела off/calls/field/auto, лише головна відкрита заявка, таймаут даних', () => {
  assert.equal(discussionFor({ config: {} }).why, 'off')
  assert.equal(discussionFor({ config }).why, 'no_data')
  assert.equal(discussionFor({ config, lookup: LOOKUP, nowMs: NOW }).why, 'timeout')
  assert.equal(discussionFor({ config, lookup: LOOKUP, appCalls: [call()], nowMs: NOW }).ds.source, 'calls')
  assert.equal(discussionFor({ config: { ...config, dsSource: 'field' }, lookup: LOOKUP, nowMs: NOW }).why, 'no_field')
  assert.equal(discussionFor({ config: { ...config, dsSource: 'auto' }, lookup: LOOKUP, appCalls: [call()], nowMs: NOW }).ds.source, 'calls')
  const closed = { requests: [field({ state: 'closed' })] }
  assert.equal(discussionFor({ config: { ...config, dsSource: 'auto' }, lookup: closed, appCalls: [call()], nowMs: NOW }).why, 'closed', 'наявне закрите поле не перевідкриваємо calls')
  assert.equal(dsNeedsCalls({ dsSource: 'auto' }, SR), true)
  assert.equal(dsNeedsCalls({ dsSource: 'auto' }, field()), false)
  const newest = { ...SR, id: 'newest', createdAt: new Date(NOW - H).toISOString() }
  assert.equal(dsRequestFor({ requests: [{ ...newest, status: 'cancelled' }, SR] }, NOW).id, SR.id)
  assert.equal(dsRequestFor({ requests: [SR, newest] }, NOW).id, newest.id)
})

test('test: підміна тільки для VG_ALLOWED_CALLERS; вимикач і scope з уже прочитаної конфігурації', () => {
  const parsed = parseDsTest(`${PHONE}=talked,+380500000002=pending,bad=oops`)
  assert.equal(parsed.map.size, 2)
  assert.equal(parsed.bad.length, 1)
  assert.deepEqual(parseDsStaff('fictional=908').map, { fictional: '908' })
  const c = { ...config, dsSource: 'test', dsTest: parsed.map }
  assert.equal(discussionFor({ config: c, phone: PHONE, nowMs: NOW }).ds.kind, 'talked')
  assert.equal(discussionFor({ config: c, phone: '+380500000002' }).why, 'not_allowed')
  assert.equal(discussionFor({ config: { ...c, dsRouting: { enabled: false } }, phone: PHONE }).why, 'disabled')
  assert.equal(discussionFor({ config: { ...c, dsRouting: { scope: 'test' } }, phone: '+380500000002' }).why, 'outside_scope')
})

test('lead/route: VG_MANAGERS обов’язковий; uid override, мобільний, пауза, зайнятість і ніч', () => {
  const ds = from([call()]).ds
  const lead = resolveLead({ ds, config, managers: [['907'], ['908']] })
  assert.equal(lead.uri, 'sip:908@127.0.0.1;transport=udp')
  assert.equal(routeFor({ ds, lead }).branch, 'discussion')
  assert.equal(routeFor({ ds, lead, paused: true }).why, 'paused')
  assert.equal(routeFor({ ds, lead, busy: true }).why, 'owner_busy')
  assert.equal(routeFor({ ds, lead: resolveLead({ ds, config, managers: [['907']] }) }).why, 'not_in_managers')
  assert.equal(routeFor({ ds, lead: resolveLead({ ds: { ...ds, snapshotKey: null }, config }) }).why, 'no_key')
  assert.equal(routeFor({ ds, lead, afterHours: true }).aiKind, 'discussion_after_hours')
  assert.equal(routeFor({ afterHours: true }).aiKind, 'after_hours')
  const mobile = '+380500000003'
  const m = resolveLead({ ds, config: { ...config, dsStaff: { 'fictional-owner': mobile } }, managers: [[mobile]] })
  assert.equal(m.uri, 'sip:0500000003@127.0.0.1;transport=udp')
  assert.equal(dsJournal(ds, m, NOW).managerKey, '…0003')
})

test('recentAppCalls: лише query read limit 10, бюджет 600 мс за замовчуванням; підробка/помилка/таймаут', async () => {
  const seen = []
  const fake = (get) => ({ collection(name) { seen.push(name); return { doc(id) { seen.push(id); return { collection(sub) { seen.push(sub); return { orderBy(key, direction) { seen.push([key, direction]); return { limit(n) { seen.push(n); return { get } } } } } } } } } } })
  const lookup = makeLookup({ db: fake(async () => ({ docs: [{ id: 'call-fictional', data: () => ({ status: 'dialing' }) }] })) })
  assert.deepEqual(await lookup.recentAppCalls(SR.id), [{ id: 'call-fictional', status: 'dialing' }])
  assert.deepEqual(seen, ['serviceRequests', SR.id, 'calls', ['createdAt', 'desc'], APP_CALLS_LIMIT])
  const logs = []
  const timed = makeLookup({ db: fake(() => new Promise(() => {})), callsBudgetMs: 5, log: (s) => logs.push(s) })
  assert.equal(await timed.recentAppCalls(SR.id), null)
  assert.match(logs[0], /не уложились.*обсуждения нет/)
  const failed = makeLookup({ db: fake(async () => { throw new Error('fake-read-error') }), log: (s) => logs.push(s) })
  assert.equal(await failed.recentAppCalls(SR.id), null)
  assert.match(logs[1], /fake-read-error/)
})
