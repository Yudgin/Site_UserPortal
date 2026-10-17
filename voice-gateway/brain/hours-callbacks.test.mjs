import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHours, addWorkHours, callbackUntilMs, workdayEndAfter } from './hours.mjs'
import { makeCallbackStore } from './callbacks.mjs'

const hours = parseHours('mon-fri 09:00-18:00')
const at = (iso) => Date.parse(iso)
const iso = (ms) => new Date(ms).toISOString()

test('8 робочих годин: вечір п’ятниці, вихідні, точна межа та секунди', () => {
  assert.equal(iso(addWorkHours(hours, at('2026-10-16T14:00:00Z'))), '2026-10-19T13:00:00.000Z')
  assert.equal(iso(addWorkHours(hours, at('2026-10-16T14:30:45Z'))), '2026-10-19T13:30:45.000Z')
  assert.equal(iso(addWorkHours(hours, at('2026-10-19T06:00:00Z'), 9)), '2026-10-19T15:00:00.000Z')
  assert.equal(iso(addWorkHours(hours, at('2026-10-17T10:00:00Z'))), '2026-10-19T14:00:00.000Z')
})

test('строк нічного перезвону: максимум восьми годин і кінця наступного робочого дня', () => {
  assert.equal(iso(callbackUntilMs(hours, at('2026-10-16T18:00:00Z'))), '2026-10-19T15:00:00.000Z')
  assert.equal(iso(callbackUntilMs(hours, at('2026-10-19T05:00:00Z'))), '2026-10-19T15:00:00.000Z')
  assert.equal(iso(callbackUntilMs(hours, at('2026-10-19T06:00:00Z'), 'Europe/Kyiv', true)), '2026-10-19T15:00:00.000Z')
  assert.equal(iso(callbackUntilMs(hours, at('2026-10-19T14:00:00Z'))), '2026-10-20T13:00:00.000Z')
})

test('робочий календар: перерви, перекриття, короткий день, DST та вимкнений розклад', () => {
  const split = parseHours('mon-fri 09:00-12:00; mon-fri 11:00-13:00; mon-fri 14:00-18:00')
  assert.equal(iso(addWorkHours(split, at('2026-10-19T06:00:00Z'))), '2026-10-19T15:00:00.000Z')
  const short = parseHours('mon-fri 09:00-13:00')
  assert.equal(iso(callbackUntilMs(short, at('2026-10-16T18:00:00Z'))), '2026-10-20T10:00:00.000Z')
  assert.equal(iso(addWorkHours(hours, at('2026-10-23T14:00:00Z'))), '2026-10-26T14:00:00.000Z')
  assert.equal(iso(workdayEndAfter(hours, at('2026-10-16T11:20:00Z'), 2)), '2026-10-20T15:00:00.000Z')
  assert.equal(addWorkHours([], 1000), 1000 + 8 * 3600000)
})

test('перезвін не зникає за TTL до обіцяного строку, повтор не скорочує його', () => {
  let now = at('2026-10-16T18:00:00Z')
  const store = makeCallbackStore({ callbackTtlHours: 1, now: () => now })
  const until = callbackUntilMs(hours, now)
  store.addPending({ managerKey: '907', clientNumber: '+380500000001', until })
  now += 2 * 3600000
  assert.equal(store.listPending().length, 1)
  const renewed = store.addPending({ managerKey: '907', clientNumber: '+380500000001', until: now + 1000 })
  assert.equal(renewed.until, until)
  now = until - 1
  assert.equal(store.listPending().length, 1)
  now = until
  assert.equal(store.listPending().length, 0)
})

test('відмова від перезвону прибирає лише клієнта у вибраній групі; термінова нічна ознака зберігається', () => {
  const store = makeCallbackStore({ now: () => 1_000_000 })
  const pending = store.addPending({ managerKey: '907', clientNumber: '+380500000001', afterHoursUrgent: true })
  store.updatePending(pending.id, { note: { urgent: true }, afterHoursUrgent: false })
  assert.equal(store.listPending()[0].afterHoursUrgent, true)
  assert.equal(store.addPending({ managerKey: '907', clientNumber: '+380500000001' }).afterHoursUrgent, true)
  store.addPending({ managerKey: '908', clientNumber: '+380500000001' })
  store.addPending({ managerKey: '907', clientNumber: '+380500000002' })
  assert.equal(store.removePendingFor(['907', '+380500000003'], '+380500000001'), 1)
  assert.deepEqual(store.listPending().map((x) => [x.managerKey, x.clientNumber]).sort(), [
    ['907', '+380500000002'], ['908', '+380500000001'],
  ])
})

test('перезвін з calls зберігає ownerUid без локального перевизначення; останній клієнт — також', () => {
  const store = makeCallbackStore({ now: () => 1_000_000 })
  store.addPending({ managerKey: '907', clientNumber: '+380500000001', ownerUid: ' fictional-owner ' })
  assert.equal(store.pickTarget(['907']).ownerUid, 'fictional-owner')
  const entry = store.addPending({ managerKey: '907', clientNumber: '+380500000001' })
  assert.equal(entry.ownerUid, 'fictional-owner')
  store.updatePending(entry.id, { ownerUid: 'fictional-next' })
  assert.equal(store.pickTarget(['907']).ownerUid, 'fictional-next')
  store.updatePending(entry.id, { ownerUid: 'bad\nuid' })
  assert.equal(store.pickTarget(['907']).ownerUid, undefined)
  store.removePending(entry.id)
  store.setLastClient('907', { number: '+380500000001', ownerUid: 'fictional-owner' })
  assert.equal(store.pickTarget(['907']).source, 'last')
  assert.equal(store.pickTarget(['907']).ownerUid, 'fictional-owner')
})
