// node --test: доставка зворотної ТТН з історії НП у 1С (returnDeliveryOf) — для правила «відкрита, доки клієнт не
// отримав кораблик, і ще 14 днів після» (isOpen у binotelWebhook.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { returnDeliveryOf } from './onecSync.js'

test('returnDeliveryOf: дата відправки — перша подія, отримання — перше «отримано», за Києвом → UTC', () => {
  const r = returnDeliveryOf({ returnTtn: '20451234567890', returnTtnHistory: [
    { status: '', timestamp: '2025-10-02T15:29:53' },
    { status: 'Прибув у відділення', timestamp: '2025-10-02T15:36:30' },
    { status: 'Відправлення отримано', timestamp: '2025-10-09T10:07:04' },
  ] })
  assert.deepEqual(r, { ttn: '20451234567890', shippedAt: '2025-10-02T12:29:53.000Z', deliveredAt: '2025-10-09T07:07:04.000Z' })
  // зима: UTC+2
  assert.equal(returnDeliveryOf({ returnTtn: '1', returnTtnHistory: [{ status: 'Відправлення отримано', timestamp: '2026-01-15T10:00:00' }] }).deliveredAt, '2026-01-15T08:00:00.000Z')
})

test('returnDeliveryOf: повернення відправнику і відмова — не отримання клієнтом; без ТТН — null; без історії — лише ттн', () => {
  assert.equal(returnDeliveryOf({ returnTtn: '1', returnTtnHistory: [{ status: 'Відправлення отримано відправником', timestamp: '2025-10-09T10:07:04' }] }).deliveredAt, null)
  assert.equal(returnDeliveryOf({ returnTtn: '1', returnTtnHistory: [{ status: 'Відмова від отримання', timestamp: '2025-10-09T10:07:04' }] }).deliveredAt, null)
  assert.equal(returnDeliveryOf({ returnTtn: 0, returnTtnHistory: [] }), null)
  assert.equal(returnDeliveryOf({}), null)
  assert.deepEqual(returnDeliveryOf({ returnTtn: '2045' }), { ttn: '2045', shippedAt: null, deliveredAt: null })
  assert.deepEqual(returnDeliveryOf({ returnTtn: '2045', returnTtnHistory: [{ status: 'x', timestamp: 'сміття' }] }), { ttn: '2045', shippedAt: null, deliveredAt: null })
  // timestamp із зоною береться як є
  assert.equal(returnDeliveryOf({ returnTtn: '1', returnTtnHistory: [{ status: 'Вручено', timestamp: '2025-10-09T10:07:04Z' }] }).deliveredAt, '2025-10-09T10:07:04.000Z')
})
