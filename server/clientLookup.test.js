import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeClientLookup, phoneVariants, SR_SCAN_LIMIT, ORDER_SCAN_LIMIT } from './clientLookup.js'

// Підроблений Firestore: записує кожен запит (колекція, умова, ліміт, id документа) і віддає дані з масивів.
function fakeDb({ requests = [], profiles = {}, orders = [] } = {}) {
  const calls = []
  return {
    calls,
    collection(name) {
      return {
        doc(id) {
          return {
            get: async () => {
              calls.push({ name, doc: id })
              const p = name === 'clientProfiles' ? profiles[id] : undefined
              return { exists: !!p, data: () => p }
            },
          }
        },
        where(field, op, value) {
          return {
            limit(n) {
              return {
                get: async () => {
                  calls.push({ name, field, op, value, limit: n })
                  const src = name === 'boatOrders' ? orders : name === 'serviceRequests' ? requests : []
                  const docs = src.filter((r) => op === 'in' && value.includes(r[field])).slice(0, n)
                  return { docs: docs.map((r) => ({ id: r.id, data: () => { const { id, ...rest } = r; return rest } })) }
                },
              }
            },
          }
        },
      }
    },
  }
}

test('clientLookup: варіанти номера +380…, 380…, 0…', () => {
  assert.deepEqual(phoneVariants('+380500000001'), ['+380500000001', '380500000001', '0500000001'])
})

test('clientLookup: ті самі запити, що й у приймачі Binotel; id документа в результаті', async () => {
  const db = fakeDb({
    requests: [
      { id: 'sr1', clientPhone: '+380500000001', status: 'in_work' },
      { id: 'sr2', clientPhone: '0500000001', status: 'done' },
      { id: 'sr3', clientPhone: '+380631112233', status: 'new' }, // чужий номер
    ],
    profiles: { 380500000001: { name: 'Петренко Іван' } },
    orders: [{ id: 'bo1', clientPhone: '380500000001', status: 'done' }],
  })
  const lookup = makeClientLookup(db)
  const r = await lookup('+380500000001')
  assert.deepEqual(r.requests.map((x) => x.id), ['sr1', 'sr2'])
  assert.equal(r.requests[0].status, 'in_work')
  assert.deepEqual(r.profile, { name: 'Петренко Іван' })
  assert.deepEqual(r.orders, [{ id: 'bo1', clientPhone: '380500000001', status: 'done' }])

  const variants = ['+380500000001', '380500000001', '0500000001']
  assert.deepEqual(db.calls.find((c) => c.name === 'serviceRequests'), { name: 'serviceRequests', field: 'clientPhone', op: 'in', value: variants, limit: SR_SCAN_LIMIT })
  assert.deepEqual(db.calls.find((c) => c.name === 'clientProfiles'), { name: 'clientProfiles', doc: '380500000001' })
  assert.deepEqual(db.calls.find((c) => c.name === 'boatOrders'), { name: 'boatOrders', field: 'clientPhone', op: 'in', value: variants, limit: ORDER_SCAN_LIMIT })
  assert.equal(db.calls.length, 3)
  assert.equal(SR_SCAN_LIMIT, 100)
  assert.equal(ORDER_SCAN_LIMIT, 10)
})

test('clientLookup: нічого не знайдено → порожні масиви і profile null; помилка Firestore — назовні', async () => {
  const r = await makeClientLookup(fakeDb())('+380501234567')
  assert.deepEqual(r, { requests: [], profile: null, orders: [] })
  const broken = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('unavailable') } }), where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) }
  await assert.rejects(makeClientLookup(broken)('+380501234567'), /unavailable/)
})

test('clientLookup: фабрика не чіпає adminDb до першого виклику (null допустимий)', () => {
  assert.equal(typeof makeClientLookup(null), 'function')
})
