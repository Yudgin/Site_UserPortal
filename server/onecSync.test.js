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

test('ревʼю: номер у 1С = 0 — історію беремо; останній цикл; перше «отримано» в циклі; копія вхідної — ні; до приїзду — ні', () => {
  // реальна форма (sr-ext-4f283fe8): returnTtn 0, «отримано» 2026-10-10
  const real = returnDeliveryOf({ returnTtn: 0, returnTtnHistory: [
    { status: '', timestamp: '2026-10-09T13:04:23' }, { status: 'Прибув у відділення', timestamp: '2026-10-09T18:00:00' },
    { status: 'Змінено адресу', timestamp: '2026-10-10T09:00:00' }, { status: 'Відправлення отримано', timestamp: '2026-10-10T14:25:01' },
    { status: 'Відправлення отримано', timestamp: '2026-10-10T14:40:01' }, // повторне опитування 1С
  ] })
  assert.deepEqual(real, { ttn: null, shippedAt: '2026-10-09T10:04:23.000Z', deliveredAt: '2026-10-10T11:25:01.000Z' })
  // два цикли: стара посилка отримана, нова в дорозі → отримання невідоме
  const two = returnDeliveryOf({ returnTtn: 0, returnTtnHistory: [
    { status: '', timestamp: '2026-09-01T10:00:00' }, { status: 'Відправлення отримано', timestamp: '2026-09-03T10:00:00' },
    { status: 'Прибув у відділення', timestamp: '2026-10-12T10:00:00' }, { status: '', timestamp: '2026-10-10T10:00:00' }, // не за порядком
  ] })
  assert.equal(two.shippedAt, '2026-10-10T07:00:00.000Z')
  assert.equal(two.deliveredAt, null)
  // побайтна копія вхідної історії — відкидаємо
  const h = [{ status: '', timestamp: '2026-05-01T10:00:00' }, { status: 'Відправлення отримано', timestamp: '2026-05-03T10:00:00' }]
  assert.equal(returnDeliveryOf({ returnTtn: 0, returnTtnHistory: h, shipment: { statusHistory: h } }), null)
  // події до приїзду кораблика до нас не беремо
  const arrived = returnDeliveryOf({ returnTtn: 0,
    shipment: { statusHistory: [{ status: 'Відправлення отримано', timestamp: '2026-06-10T10:00:00' }] },
    returnTtnHistory: [{ status: 'Відправлення отримано', timestamp: '2026-06-01T10:00:00' }] })
  assert.equal(arrived, null)
})

test('ревʼю: перехід на літній/зимовий час — правильний зсув уночі', () => {
  const at = (ts) => returnDeliveryOf({ returnTtn: 1, returnTtnHistory: [{ status: 'Вручено', timestamp: ts }] }).deliveredAt
  assert.equal(at('2025-10-26T01:30:00'), '2025-10-25T22:30:00.000Z') // ще EEST (+3)
  assert.equal(at('2026-03-29T01:30:00'), '2026-03-28T23:30:00.000Z') // ще EET (+2)
  assert.equal(at('2025-10-26T04:30:00'), '2025-10-26T02:30:00.000Z')
})

test('повторна перевірка: копія вхідної історії з новим циклом після приїзду дає повернення', () => {
  const h = [
    { status: '', timestamp: '2025-07-20T10:00:00' }, { status: 'Відправлення отримано', timestamp: '2025-07-22T10:00:00' }, // вхідна
    { status: 'Відправлення отримано', timestamp: '2025-07-22T10:15:00' }, // повторне опитування
    { status: '', timestamp: '2025-08-11T14:28:47' }, { status: 'Відправлення отримано', timestamp: '2025-08-11T14:38:39' }, // повернення
  ]
  const r = returnDeliveryOf({ returnTtn: 0, returnTtnHistory: h, shipment: { statusHistory: h } })
  assert.deepEqual(r, { ttn: null, shippedAt: '2025-08-11T11:28:47.000Z', deliveredAt: '2025-08-11T11:38:39.000Z' })
})
