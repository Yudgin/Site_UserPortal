import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOpenForAi, aiCategory, pickRequestsForAi, buildCard, dsCardText } from './card.mjs'
import { makeLookup, termsAcceptedAtField } from './lookup.mjs'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const day = 86400000
const ago = (days) => new Date(NOW - days * day).toISOString()
const sr = (patch = {}) => ({ id: 'sr-test', status: 'done', createdAt: ago(100), doneAt: ago(10), ...patch })

test('C1: done відкрита до receivedAt + 14 днів, інакше doneAt або statusChangedAt', () => {
  assert.equal(isOpenForAi(sr(), NOW), true)
  assert.equal(isOpenForAi(sr({ doneAt: ago(14) }), NOW), false)
  assert.equal(isOpenForAi(sr({ doneAt: ago(20), receivedAt: ago(1) }), NOW), true)
  assert.equal(isOpenForAi(sr({ doneAt: ago(1), receivedAt: ago(20) }), NOW), false)
  assert.equal(isOpenForAi(sr({ doneAt: null, statusChangedAt: ago(1) }), NOW), true)
  assert.equal(isOpenForAi(sr({ doneAt: 'invalid', statusChangedAt: { seconds: (NOW - day) / 1000 } }), NOW), true)
  assert.equal(isOpenForAi(sr({ doneAt: { toMillis: () => NOW - day } }), NOW), true)
  assert.equal(isOpenForAi(sr({ status: 'cancelled', receivedAt: ago(1) }), NOW), false)
  assert.equal(isOpenForAi(sr({ doneAt: null }), NOW), false)
})

test('C1: категорія, головна заявка та картка використовують одну межу отримання', () => {
  const latest = sr({ id: 'received', doneAt: ago(50), receivedAt: ago(1) })
  const old = sr({ id: 'old', doneAt: ago(40) })
  const lookup = { requests: [old, latest], orders: [], profile: null }
  assert.equal(aiCategory(lookup, NOW), 'openRequest')
  assert.equal(pickRequestsForAi(lookup.requests, NOW).main.id, 'received')
  const card = buildCard(lookup, { phone: '+380500000001', nowMs: NOW })
  assert.equal(card.category, 'openRequest')
  assert.equal(card.serviceRequestId, 'received')
  assert.equal(aiCategory({ requests: [sr({ doneAt: ago(30), statusChangedAt: ago(1) })] }, NOW), 'knownClient')
})

test('MGR-DS-CARD: причина, номер заявки, ім’я; brief.voice не довше 150 і без телефонів', () => {
  const lookup = { requests: [sr({ onec: { number: '00042' }, clientName: 'Тестовий Клієнт +380500000001' })] }
  const card = dsCardText({ lookup, srId: 'sr-test', kind: 'talked', voice: `Питання +380500000002 ${'Уточнити статус. '.repeat(20)}` })
  assert.match(card, /^Передзвонює клієнт, з яким ви нещодавно говорили\. Заявка 42, Тестовий Клієнт\./)
  assert.doesNotMatch(card, /38050000000/)
  assert.ok(card.slice(card.indexOf('Питання ')).length <= 150)
  assert.match(dsCardText({ kind: 'called' }), /якому ви телефонували/)
  assert.match(dsCardText({ kind: 'general' }), /заявкою якого ви займаєтеся/)
})

test('C4: ознака угоди — false відрізняється від відсутніх даних, accepted важливіше дати', () => {
  assert.equal(termsAcceptedAtField({ clientAcceptedTerms: { accepted: false, acceptedAt: ago(1) } }, 'clientAcceptedTerms'), false)
  assert.equal(termsAcceptedAtField({ clientAcceptedTerms: { accepted: true } }, 'clientAcceptedTerms.accepted'), true)
  assert.equal(termsAcceptedAtField({ raw: { agreement_at: null } }, 'raw.agreement_at'), false)
  assert.equal(termsAcceptedAtField({ raw: { agreement_at: ago(1) } }, 'raw.agreement_at'), true)
  assert.equal(termsAcceptedAtField({ raw: {} }, 'raw.agreement_at'), null)
  assert.equal(termsAcceptedAtField({}, 'clientAcceptedTerms.accepted'), null)
  assert.equal(termsAcceptedAtField({}, '__proto__.accepted'), null)
})

function fakeDb({ requests = [sr()], snapshot = { raw: { clientAcceptedTerms: { accepted: false } } }, snapshotWait = null, snapshotError = null, routing = { discussion: { enabled: false, scope: 'test' } } } = {}) {
  const reads = []
  const ref = (name) => ({
    collection: (child) => ref(`${name}/${child}`),
    doc: (id) => ref(`${name}/${id}`),
    where: () => ref(name),
    orderBy: () => ref(name),
    limit: () => ref(name),
    get: async () => {
      reads.push(name)
      if (name.endsWith('/onec/snapshot')) {
        if (snapshotError) throw snapshotError
        if (snapshotWait) await snapshotWait
        return { exists: snapshot !== null, data: () => snapshot }
      }
      if (name === 'serviceRequests') return { docs: requests.map((r) => ({ id: r.id, data: () => r })) }
      if (name === 'system/binotelRouting') return { exists: true, data: () => routing }
      return { exists: false, docs: [], data: () => null }
    },
  })
  return { collection: (name) => ref(name), reads }
}

test('C4: прапорець вимкнений — без читання знімка; верхнє поле — без нового читання', async () => {
  const db = fakeDb()
  const disabled = makeLookup({ db, now: () => NOW })
  assert.equal((await disabled.lookup('+380500000001')).termsAccepted, undefined)
  assert.equal(await disabled.requestTerms('sr-test'), null)
  assert.equal(db.reads.some((x) => x.endsWith('/onec/snapshot')), false)
  const top = makeLookup({ db: fakeDb({ requests: [sr({ clientAcceptedTerms: { accepted: false } })] }), termsField: 'clientAcceptedTerms.accepted', now: () => NOW })
  assert.equal((await top.lookup('+380500000001')).termsAccepted, false)
})

test('C4: snapshot тільки для головної відкритої заявки, назовні лише boolean, усе лише читання', async () => {
  const db = fakeDb({ requests: [sr({ id: 'closed', doneAt: ago(30) }), sr()] })
  const lookup = makeLookup({ db, termsField: 'onec/snapshot.raw.clientAcceptedTerms', now: () => NOW })
  const result = await lookup.lookup('+380500000001')
  assert.equal(result.termsAccepted, false)
  assert.deepEqual(db.reads.filter((x) => x.includes('/onec/')), ['serviceRequests/sr-test/onec/snapshot'])
  assert.equal(Object.hasOwn(result, 'raw'), false)
  const closedDb = fakeDb({ requests: [sr({ doneAt: ago(30) })] })
  assert.equal((await makeLookup({ db: closedDb, termsField: 'onec/snapshot.raw.agreement_at', now: () => NOW }).lookup('+380500000001')).termsAccepted, null)
  assert.equal(closedDb.reads.some((x) => x.includes('/onec/')), false)
})

test('C4: бюджет знімка включений у бюджет пошуку; помилка — невідомо, не «не прийнято»', async () => {
  const forever = new Promise(() => {})
  const delayed = makeLookup({ db: fakeDb({ snapshotWait: forever }), termsField: 'onec/snapshot.raw.agreement_at', budgetMs: 10, now: () => NOW })
  assert.equal(await delayed.lookup('+380500000001'), null)
  const logs = []
  const failed = makeLookup({ db: fakeDb({ snapshotError: new Error('fake error') }), termsField: 'onec/snapshot.raw.agreement_at', now: () => NOW, log: (x) => logs.push(x) })
  assert.equal((await failed.lookup('+380500000001')).termsAccepted, null)
  assert.ok(logs.some((x) => x.includes('fake error')))
})

test('аварійний вимикач: snapshot отриманий із вже наявного warm читання', async () => {
  const db = fakeDb()
  const lookup = makeLookup({ db })
  assert.equal(lookup.routing(), null)
  await lookup.warm()
  assert.deepEqual(lookup.routing(), { discussion: { enabled: false, scope: 'test' } })
  assert.deepEqual(db.reads, ['system/binotelRouting'])
})
