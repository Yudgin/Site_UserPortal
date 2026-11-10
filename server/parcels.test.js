// node --test: журнал «Посилки» — доступ, ручні записи, передачі водієві, акаунти НП (§36).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerParcels, splitCost, attentionOf, canSee, loadAccounts, loadOwnPhones } from './parcels.js'
import { fakeDb } from './testFakeDb.js'

const NOW = '2026-11-10T10:00:00.000Z'
const np = (number, over = {}) => ({
  number, method: 'np', accountIds: ['fop:a'], accountDirs: { 'fop:a': 'out' }, privBy: { 'fop:a': false }, directions: ['out'], private: false, fopId: 'a',
  statusCode: '5', statusName: 'Прямує', group: 'transit', final: false, createdAt: '2026-11-08T10:00:00.000Z', sortAt: '2026-11-08T10:00:00.000Z',
  firstSeenAt: '2026-11-08T10:00:00.000Z', sender: {}, recipient: { name: 'Клієнт', phone: '+380501112233' }, phones: ['+380501112233'], history: [], sources: ['list'], link: null, linkTry: true, transfer: null, ...over,
})

// Сервер з підробленою базою; роль запиту — заголовком x-role (owner | director:<центр> | нічого).
async function serve(seed, extra = {}) {
  const db = fakeDb(seed)
  const app = express()
  app.use(express.json())
  const roleOf = (req) => String(req.get('x-role') || '')
  registerParcels(app, {
    adminDb: db, now: () => NOW, gapMs: 0,
    verifyAdmin: async (req) => roleOf(req) === 'owner',
    verifyStaff: async (req, roles) => {
      const [role, center] = roleOf(req).split(':')
      if (!roles.includes(role)) return null
      return { uid: 'u', email: 'x@y', role, centers: center ? [{ centerId: center, perms: [] }] : [] }
    },
    listFops: () => [{ id: 'a', name: 'ФОП А', active: true, apiKey: 'KEY-A', senderRef: 'cp', senderPhone: '0670000085' }],
    ...extra,
  })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, role, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(role ? { 'x-role': role } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  return { db, call, close: () => server.close() }
}

test('splitCost: порівну, копійка до копійки; canSee; attentionOf', () => {
  assert.deepEqual(splitCost(40, ['a', 'b', 'c']), { a: 13.34, b: 13.33, c: 13.33 })
  assert.deepEqual(splitCost(40, ['a', 'b']), { a: 20, b: 20 })
  assert.deepEqual(splitCost(40, []), {})
  const linked = np('1', { link: { serviceCenterId: 'c1' } })
  assert.equal(canSee({ role: 'owner' }, np('1', { private: true })), true)
  assert.equal(canSee({ role: 'director', centers: [{ centerId: 'c1' }] }, linked), true)
  assert.equal(canSee({ role: 'director', centers: [{ centerId: 'c2' }] }, linked), false)
  assert.equal(canSee({ role: 'director', centers: [{ centerId: 'c1' }] }, np('1')), false) // без привʼязки — лише власник
  assert.equal(canSee({ role: 'director', centers: [{ centerId: 'c1' }] }, { ...linked, private: true }), false)
  assert.equal(canSee(null, linked), false)
  assert.deepEqual(attentionOf(np('1', { group: 'arrived', arrivedAt: '2026-11-06T10:00:00.000Z', storageFrom: '2026-11-11' }), NOW), ['waiting', 'storage'])
  assert.deepEqual(attentionOf(np('1', { group: 'arrived', arrivedAt: '2026-11-09T10:00:00.000Z', storageFrom: '2026-11-16' }), NOW), [])
  assert.deepEqual(attentionOf(np('1', { group: 'problem' }), NOW), ['problem'])
  assert.deepEqual(attentionOf(np('1', { group: 'draft', transfer: { id: 't', date: '2026-11-03' } }), NOW), ['driver'])
  assert.deepEqual(attentionOf(np('1', { group: 'problem', final: true }), NOW), [])
})

test('loadAccounts: ФОП з ключем + особисті; приватність особистого за замовчуванням', async () => {
  const db = fakeDb({ npAccounts: { me: { name: 'Особистий' }, shop: { name: 'Спільний', private: false, active: false } }, npAccountSecrets: { me: { apiKey: 'K-ME' } } })
  const acc = await loadAccounts(db, () => [{ id: 'a', name: 'ФОП А', active: true, apiKey: 'KA', senderRef: 'cp', senderPhone: '0670000085' }])
  assert.deepEqual(acc.map((a) => [a.id, a.kind, a.private, a.active, !!a.apiKey]), [['fop:a', 'fop', false, true, true], ['acc:me', 'personal', true, true, true], ['acc:shop', 'personal', false, false, false]])
  assert.deepEqual(acc[0].phones, ['+380670000085'])
})

test('журнал: без ролі 403; власник бачить усе (і приватне, і старе незавершене); директор — лише ділове свого центру; службові поля не віддаються', async () => {
  const s = await serve({
    parcels: {
      1: np('1', { link: { kind: 'return', serviceRequestId: 'r1', serviceCenterId: 'c1' } }),
      2: np('2'),
      3: np('3', { private: true, accountIds: ['acc:me'], link: { serviceCenterId: 'c1' } }),
      4: np('4', { sortAt: '2026-08-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z', group: 'arrived', arrivedAt: '2026-08-03T10:00:00.000Z' }), // стара, але незавершена
      5: np('5', { sortAt: '2026-08-01T10:00:00.000Z', final: true, group: 'received' }), // стара завершена — поза вікном
    },
    npAccounts: { me: { name: 'Особистий' } },
  })
  try {
    assert.equal((await s.call('GET', '/api/parcels')).status, 403)
    assert.equal((await s.call('GET', '/api/parcels', 'master')).status, 403)
    const own = await s.call('GET', '/api/parcels', 'owner')
    assert.deepEqual(own.json.data.items.map((p) => p.id), ['1', '2', '3', '4'])
    assert.equal(own.json.data.owner, true)
    assert.deepEqual(own.json.data.accounts.map((a) => a.id), ['fop:a', 'acc:me'])
    const item = own.json.data.items[0]
    assert.equal(item.privBy, undefined)
    assert.equal(item.linkTry, undefined)
    assert.equal(item.phones, undefined)
    assert.deepEqual(own.json.data.items[3].attention, ['waiting'])
    const dir = await s.call('GET', '/api/parcels', 'director:c1')
    assert.deepEqual(dir.json.data.items.map((p) => p.id), ['1'])
    assert.deepEqual(dir.json.data.accounts.map((a) => a.id), ['fop:a'])
    assert.equal(dir.json.data.owner, false)
    assert.deepEqual((await s.call('GET', '/api/parcels', 'director:c9')).json.data.items, [])
    const wide = await s.call('GET', '/api/parcels?days=200', 'owner')
    assert.equal(wide.json.data.items.length, 5)
  } finally { s.close() }
})

test('ручні записи: автобус із вартістю, перевірки, зміна стану пише історію, видалення; запис НП цими маршрутами не змінити', async () => {
  const s = await serve({ parcels: { 1: np('1') }, serviceRequests: { r1: { serviceCenterId: 'c1', clientName: 'Іван' } } })
  try {
    assert.equal((await s.call('POST', '/api/parcels/manual', 'director:c1', { method: 'bus' })).status, 403)
    assert.equal((await s.call('POST', '/api/parcels/manual', 'owner', { method: 'plane' })).status, 400)
    assert.equal((await s.call('POST', '/api/parcels/manual', 'owner', { method: 'bus' })).status, 400) // ні кому, ні що
    assert.equal((await s.call('POST', '/api/parcels/manual', 'owner', { method: 'bus', description: 'x', serviceRequestId: 'nope' })).status, 400)
    const made = await s.call('POST', '/api/parcels/manual', 'owner', {
      method: 'bus', direction: 'out', date: '2026-11-09', group: 'transit', number: 'рейс 12', description: 'Кораблик після ремонту',
      counterparty: { name: 'Петро', phone: '050 111 22 33', city: 'Львів' }, cost: { amount: '15,5', currency: 'EUR' }, serviceRequestId: 'r1', note: 'водій Микола',
    })
    assert.equal(made.status, 200)
    const id = made.json.data.id
    const doc = s.db._get('parcels', id)
    assert.equal(doc.manual, true)
    assert.equal(doc.method, 'bus')
    assert.equal(doc.recipient.phone, '+380501112233')
    assert.deepEqual(doc.extraCost, { amount: 15.5, currency: 'EUR' })
    assert.equal(doc.sortAt, '2026-11-09T09:00:00.000Z')
    assert.equal(doc.final, false)
    assert.deepEqual(doc.link, { kind: 'manual', serviceRequestId: 'r1', boatOrderId: null, serviceCenterId: 'c1', title: 'Іван' })
    assert.equal(doc.createdBy, 'owner')
    // директор центру c1 тепер бачить цей запис (привʼязаний до його заявки)
    assert.deepEqual((await s.call('GET', '/api/parcels', 'director:c1')).json.data.items.map((p) => p.id), [id])
    const upd = await s.call('PUT', `/api/parcels/manual/${id}`, 'owner', { method: 'pickup', direction: 'out', date: '2026-11-09', group: 'received', counterparty: { name: 'Петро' } })
    assert.equal(upd.status, 200)
    const after = s.db._get('parcels', id)
    assert.equal(after.final, true)
    assert.equal(after.receivedAt, NOW)
    assert.deepEqual(after.history.map((h) => h.name), ['Передано', 'Отримано'])
    assert.equal(after.link.serviceRequestId, 'r1') // привʼязку не чіпали — лишилась
    assert.equal(after.extraCost, null)
    assert.equal((await s.call('PUT', '/api/parcels/manual/1', 'owner', { method: 'bus', description: 'x' })).status, 404)
    assert.equal((await s.call('DELETE', '/api/parcels/manual/1', 'owner')).status, 404)
    assert.equal((await s.call('DELETE', `/api/parcels/manual/${id}`, 'owner')).status, 200)
    assert.equal(s.db._get('parcels', id), undefined)
    assert.ok(s.db._get('parcels', '1'))
  } finally { s.close() }
})

test('нотатка і ручна привʼязка до заявки для посилки НП', async () => {
  const s = await serve({ parcels: { 1: np('1') }, serviceRequests: { r1: { serviceCenterId: 'c1', clientName: 'Іван' } } })
  try {
    assert.equal((await s.call('PUT', '/api/parcels/1/meta', 'director:c1', { note: 'x' })).status, 403)
    assert.equal((await s.call('PUT', '/api/parcels/9/meta', 'owner', { note: 'x' })).status, 404)
    assert.equal((await s.call('PUT', '/api/parcels/1/meta', 'owner', { serviceRequestId: 'nope' })).status, 400)
    const r = await s.call('PUT', '/api/parcels/1/meta', 'owner', { note: 'запчастини', serviceRequestId: 'r1' })
    assert.equal(r.status, 200)
    const doc = s.db._get('parcels', '1')
    assert.equal(doc.note, 'запчастини')
    assert.equal(doc.link.serviceCenterId, 'c1')
    assert.equal(doc.linkTry, false)
    await s.call('PUT', '/api/parcels/1/meta', 'owner', { serviceRequestId: '' }) // зняти привʼязку
    assert.equal(s.db._get('parcels', '1').link, null)
  } finally { s.close() }
})

test('передачі водієві: сума порівну на посилки; зміна складу; посилка лише в одній передачі; видалення знімає частки', async () => {
  const s = await serve({ parcels: { 1: np('1', { group: 'draft' }), 2: np('2', { group: 'draft' }), 3: np('3', { group: 'draft' }), 4: np('4') } })
  try {
    assert.equal((await s.call('GET', '/api/parcels/transfers', 'director:c1')).status, 403)
    assert.equal((await s.call('PUT', '/api/parcels/transfers/new', 'owner', { driver: '', parcelIds: ['1'] })).status, 400)
    assert.equal((await s.call('PUT', '/api/parcels/transfers/new', 'owner', { driver: 'Микола', parcelIds: [] })).status, 400)
    assert.equal((await s.call('PUT', '/api/parcels/transfers/new', 'owner', { driver: 'Микола', parcelIds: ['1', '99'] })).status, 400)
    const made = await s.call('PUT', '/api/parcels/transfers/new', 'owner', { date: '2026-11-08', driver: 'Микола', driverPhone: '0671234567', route: 'Берлін → Київ', cost: 40, currency: 'EUR', parcelIds: ['1', '2', '3', '1'] })
    assert.equal(made.status, 200)
    const id = made.json.data.id
    assert.deepEqual(made.json.data.shares, { 1: 13.34, 2: 13.33, 3: 13.33 })
    assert.deepEqual(s.db._get('parcels', '2').transfer, { id, date: '2026-11-08', driver: 'Микола', share: 13.33, currency: 'EUR' })
    assert.equal(s.db._get('parcelTransfers', id).driverPhone, '+380671234567')
    // інша передача не може забрати ту саму посилку
    assert.equal((await s.call('PUT', '/api/parcels/transfers/new', 'owner', { driver: 'Інший', cost: 10, parcelIds: ['2', '4'] })).status, 409)
    assert.equal(s.db._get('parcels', '4').transfer, null)
    // прибрали посилку 3, сума та сама → по 20
    const upd = await s.call('PUT', `/api/parcels/transfers/${id}`, 'owner', { date: '2026-11-08', driver: 'Микола', cost: 40, currency: 'EUR', parcelIds: ['1', '2'], done: true })
    assert.deepEqual(upd.json.data.shares, { 1: 20, 2: 20 })
    assert.equal(s.db._get('parcels', '3').transfer, null)
    assert.equal(s.db._get('parcels', '1').transfer.share, 20)
    assert.equal(s.db._get('parcelTransfers', id).done, true)
    const list = await s.call('GET', '/api/parcels/transfers', 'owner')
    assert.equal(list.json.data.length, 1)
    assert.equal((await s.call('PUT', '/api/parcels/transfers/nope', 'owner', { driver: 'x', parcelIds: ['1'] })).status, 404)
    assert.equal((await s.call('DELETE', `/api/parcels/transfers/${id}`, 'owner')).status, 200)
    assert.equal(s.db._get('parcelTransfers', id), undefined)
    assert.equal(s.db._get('parcels', '1').transfer, null)
    assert.equal(s.db._get('parcels', '2').transfer, null)
  } finally { s.close() }
})

test('видалення ручного запису з передачі перераховує частки решти', async () => {
  const s = await serve({ parcels: { 1: np('1', { group: 'draft' }) } })
  try {
    const m = await s.call('POST', '/api/parcels/manual', 'owner', { method: 'bus', description: 'коробка', group: 'transit' })
    const mid = m.json.data.id
    const tr = await s.call('PUT', '/api/parcels/transfers/new', 'owner', { driver: 'Микола', cost: 30, currency: 'EUR', parcelIds: ['1', mid] })
    assert.equal(s.db._get('parcels', '1').transfer.share, 15)
    assert.equal((await s.call('DELETE', `/api/parcels/manual/${mid}`, 'owner')).status, 200)
    assert.equal(s.db._get('parcels', '1').transfer.share, 30)
    assert.deepEqual(s.db._get('parcelTransfers', tr.json.data.id).parcelIds, ['1'])
  } finally { s.close() }
})

test('акаунти НП: особистий ключ пишеться окремо і назовні не віддається; ключ ФОП тут не змінити; перевірка ключа; видалення', async () => {
  const seen = []
  const s = await serve({ npSyncState: { 'fop:a': { lastOkAt: NOW, phones: ['+380670000085'], counts: { listed: 3 } } } }, {
    npImpl: async (apiKey, model, method) => {
      seen.push([apiKey, method])
      if (method === 'getDocumentList') return { success: false, errors: ['Access denied'] }
      if (method === 'getOutgoingDocumentsByPhone') return { success: true, data: [{ result: [{ Number: '1', PhoneSender: '380931234567' }] }] }
      return { success: true, data: [{ result: [{ Number: '2' }, { Number: '3' }] }] }
    },
  })
  try {
    assert.equal((await s.call('GET', '/api/parcels/accounts', 'director:c1')).status, 403)
    assert.equal((await s.call('PUT', '/api/parcels/accounts/fop:a', 'owner', { apiKey: 'x' })).status, 400)
    assert.equal((await s.call('PUT', '/api/parcels/accounts/me', 'owner', { name: 'Особистий', apiKey: ' SECRET-KEY ' })).status, 200)
    assert.equal(s.db._get('npAccountSecrets', 'me').apiKey, 'SECRET-KEY')
    assert.equal(s.db._get('npAccounts', 'me').apiKey, undefined)
    assert.equal(s.db._get('npAccounts', 'me').private, true)
    await s.call('PUT', '/api/parcels/accounts/acc:me', 'owner', { name: 'Мій номер' }) // без ключа — ключ лишається
    assert.equal(s.db._get('npAccountSecrets', 'me').apiKey, 'SECRET-KEY')
    const list = await s.call('GET', '/api/parcels/accounts', 'owner')
    assert.equal(JSON.stringify(list.json).includes('SECRET-KEY'), false)
    assert.equal(JSON.stringify(list.json).includes('KEY-A'), false)
    assert.deepEqual(list.json.data.map((a) => [a.id, a.name, a.keySet, a.private]), [['fop:a', 'ФОП А', true, false], ['acc:me', 'Мій номер', true, true]])
    assert.deepEqual(list.json.data[0].phones, ['+38067•••••85'])
    // перевірка збереженого ключа
    const chk = await s.call('POST', '/api/parcels/accounts/acc:me/check', 'owner', {})
    assert.deepEqual(chk.json.data, { list: { ok: false, count: 0, error: 'Access denied' }, outgoing: { ok: true, count: 1 }, incoming: { ok: true, count: 2 }, phone: '+38093•••••67' })
    assert.equal(seen.every(([k]) => k === 'SECRET-KEY'), true)
    // щойно введений ключ перевіряється без збереження
    seen.length = 0
    await s.call('POST', '/api/parcels/accounts/acc:new/check', 'owner', { apiKey: 'TYPED' })
    assert.equal(seen.every(([k]) => k === 'TYPED'), true)
    assert.equal(s.db._get('npAccountSecrets', 'new'), undefined)
    assert.equal((await s.call('POST', '/api/parcels/accounts/acc:none/check', 'owner', {})).status, 400)
    assert.equal((await s.call('DELETE', '/api/parcels/accounts/acc:me', 'owner')).status, 200)
    assert.equal(s.db._get('npAccountSecrets', 'me'), undefined)
    assert.equal(s.db._get('npAccounts', 'me'), undefined)
  } finally { s.close() }
})

test('синхронізація: 403 без токена і не власнику; за токеном планувальника — проходить; замок від одночасного запуску', async () => {
  process.env.PAYMENTS_ADMIN_TOKEN = 'adm'
  const s = await serve({}, {
    npImpl: async (apiKey, model, method) => (method === 'getDocumentList'
      ? { success: true, data: [] }
      : { success: true, data: [{ result: method === 'getIncomingDocumentsByPhone' ? [{ Number: '20457777777777', TrackingStatusCode: '7', TrackingStatusName: 'Прибув у відділення', DateTime: '2026-11-07 13:55:01', PhoneRecipient: '380670000085' }] : [] }] }),
  })
  try {
    assert.equal((await s.call('POST', '/api/parcels/sync')).status, 403)
    assert.equal((await s.call('POST', '/api/parcels/sync', 'director:c1')).status, 403)
    assert.equal((await s.call('POST', '/api/parcels/sync', '', {}, { 'x-admin-token': 'wrong' })).status, 403)
    const byToken = await s.call('POST', '/api/parcels/sync', '', {}, { 'x-admin-token': 'adm' })
    assert.equal(byToken.status, 200)
    assert.equal(byToken.json.data.accounts[0].created, 1)
    const byOwner = await s.call('POST', '/api/parcels/sync', 'owner', {})
    assert.equal(byOwner.status, 200)
    assert.deepEqual(byOwner.json.data.accounts.map((a) => [a.accounts, a.inc, a.created, a.written, a.ok]), [[['fop:a'], 1, 0, 0, true]]) // повтор: нічого нового
    assert.equal(s.db._get('parcels', '20457777777777').directions[0], 'in')
    assert.equal(s.db._get('npSyncState', '_meta').lockedUntil, null)
    await s.db.collection('npSyncState').doc('_meta').set({ lockedUntil: '2026-11-10T10:03:00.000Z' }, { merge: true })
    assert.equal((await s.call('POST', '/api/parcels/sync', 'owner', {})).status, 409)
  } finally { s.close(); delete process.env.PAYMENTS_ADMIN_TOKEN }
})

test('«наші телефони»: задані власником + одержувач із шаблонів «до нас»; діють для акаунтів ФОП; після зміни напрям перераховується', async () => {
  const s = await serve({
    npSyncState: { _meta: { ownPhones: ['+380630000021'] }, 'fop:a': { phones: ['+380670000085'] } },
    npTemplates: { t1: { scenario: 'incoming', recipientPhone: '063 111 11 11' }, t2: { scenario: 'return', recipientPhone: '0509999999' } },
    parcels: {
      1: np('1', { recipient: { phone: '+380631234567' } }), // стане вхідною, коли номер додадуть у «наші»
      2: np('2', { recipient: { phone: '+380501112233' } }), // клієнтові — лишається вихідною
      3: np('3', { sources: ['in'], accountDirs: { 'fop:a': 'in' }, directions: ['in'], recipient: { phone: '+380670000085' } }),
      4: np('4', { accountIds: ['acc:me', 'fop:a'], accountDirs: { 'acc:me': 'in', 'fop:a': 'out' }, directions: ['in', 'out'], recipient: { phone: '+380631234567' } }), // спільну не чіпаємо
      5: { method: 'bus', manual: true, direction: 'out', directions: ['out'], accountIds: [], recipient: { phone: '+380631234567' } },
    },
  })
  try {
    assert.deepEqual(await loadOwnPhones(s.db), { manual: ['+380630000021'], all: ['+380630000021', '+380631111111'] })
    assert.deepEqual((await loadAccounts(s.db, () => [{ id: 'a', name: 'A', active: true, apiKey: 'K', senderPhone: '0670000085' }]))[0].phones, ['+380670000085', '+380630000021', '+380631111111'])
    assert.equal((await s.call('GET', '/api/parcels/settings', 'director:c1')).status, 403)
    assert.deepEqual((await s.call('GET', '/api/parcels/settings', 'owner')).json.data, { ownPhones: ['+380630000021'], fromTemplates: ['+380631111111'] })
    assert.equal((await s.call('PUT', '/api/parcels/settings', 'owner', { ownPhones: ['12345'] })).status, 400)
    const r = await s.call('PUT', '/api/parcels/settings', 'owner', { ownPhones: ['063 000 00 21', '0631234567', '0631234567'] })
    assert.deepEqual(r.json.data, { ownPhones: ['+380630000021', '+380631234567'], recalculated: { checked: 4, changed: 1 } })
    assert.deepEqual(s.db._get('parcels', '1').directions, ['in'])
    assert.equal(s.db._get('parcels', '1').selfSender, false)
    assert.deepEqual(s.db._get('parcels', '2').directions, ['out'])
    assert.deepEqual(s.db._get('parcels', '3').directions, ['in'])
    assert.deepEqual(s.db._get('parcels', '4').directions, ['in', 'out'])
    assert.deepEqual(s.db._get('parcels', '5').directions, ['out'])
    // номер прибрали → посилка знову вихідна
    await s.call('PUT', '/api/parcels/settings', 'owner', { ownPhones: [] })
    assert.deepEqual(s.db._get('parcels', '1').directions, ['out'])
  } finally { s.close() }
})
