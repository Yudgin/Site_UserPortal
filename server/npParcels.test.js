// node --test: синхронізація журналу посилок з Новою Поштою (§36).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  npDate, npDay, npReqDate, statusGroup, isFinal, fromList, fromPhone, fromTrack, mergeParts, directionOf, applyFresh, sameDoc,
  makeNp, listWindows, syncKey, syncAll, linkPass,
} from './npParcels.js'
import { fakeDb } from './testFakeDb.js'

const NOW = '2026-11-10T10:00:00.000Z'
const OWN = '+380670000085'

const listDoc = (over = {}) => ({
  IntDocNumber: '20451111111111', Ref: 'ref-1', DateTime: '2026-11-05 17:18:58', StateId: 9, StateName: 'Відправлення отримано',
  RecipientDateTime: '09.11.2026 11:11:02', ScheduledDeliveryDate: '2026-11-06 18:00:00', DateLastUpdatedStatus: '2026-11-05 17:18:58',
  SenderDescription: 'ФОП Тест', SenderContactPerson: 'Тест Тестович', SendersPhone: '380670000085', CitySenderDescription: 'Київ', SenderAddressDescription: 'Відділення №1',
  RecipientDescription: 'Приватна особа', RecipientContactPerson: 'Клієнт Іван', RecipientsPhone: '380501112233', CityRecipientDescription: 'Львів', RecipientAddressDescription: 'Відділення №5',
  Description: 'Кораблик', Cost: '30000.00', CostOnSite: '550.00', AfterpaymentOnGoodsCost: '0.00', PayerType: 'Recipient', PaymentMethod: 'Cash',
  Weight: '50.00', CheckWeight: 66.52, SeatsAmount: '2', ServiceType: 'WarehouseWarehouse', Sender: 'cp-sender', DeletionMark: '0', ...over,
})
const phoneDoc = (over = {}) => ({
  Number: '20451111111111', RefEW: 'ref-1', TrackingStatusCode: '9', TrackingStatusName: 'Отримано', DateTime: '2026-11-05 18:55:46',
  ArrivalDateTime: '2026-11-07 10:56:30', ReceivingDateTime: '2026-11-07 13:21:27', ScheduledDeliveryDate: '2026-11-07 15:00:00', AdjustedDate: '0001-01-01 00:00:00',
  TrackingUpdateDate: '2026-11-07 13:21:29', CargoAutoReturnDate: '0001-01-01 00:00:00', FirstDayStorage: '',
  SenderName: 'Тест Тестович', CounterpartySenderDescription: 'ФОП Тест', PhoneSender: '380670000085', CitySenderDescription: 'Київ', SenderAddressDescription: 'Відділення №1',
  RecipientFullName: 'Клієнт Іван Іванович', RecipientName: 'Клієнт Іван', PhoneRecipient: '380501112233', CityRecipientDescription: 'Львів', RecipientAddressDescription: 'Відділення №5',
  CargoDescription: 'Кораблик', Cost: '980', DocumentCost: 91.9, AfterpaymentOnGoodsCost: '980.00', PayerType: 'Recipient', PaymentMethod: 'Cash', ExpressWaybillPaymentStatus: 'Payed',
  FactualWeight: '1.00', SeatsAmount: '1', ServiceType: 'WarehouseWarehouse', CounterpartySender: 'cp-sender',
  possibilityCreateRedirecting: false, possibilityChangeEW: false, possibilityCreateReturn: false, possibilityTermExtension: false, possibilityCreateRefusal: false, ...over,
})

test('дати НП: три формати, порожня «0001», лише день, дата запиту за Києвом', () => {
  assert.equal(npDate('2026-11-05 17:18:58'), '2026-11-05T15:18:58.000Z')
  assert.equal(npDate('09.11.2026 11:11:02'), '2026-11-09T09:11:02.000Z')
  assert.equal(npDate('05-11-2026 18:54:07'), '2026-11-05T16:54:07.000Z')
  assert.equal(npDate('0001-01-01 00:00:00'), null)
  assert.equal(npDate(''), null)
  assert.equal(npDay('2026-11-14'), '2026-11-14')
  assert.equal(npDay('14.11.2026'), '2026-11-14')
  assert.equal(npDay(''), null)
  assert.equal(npReqDate(new Date('2026-11-09T22:30:00.000Z')), '10.11.2026') // у Києві вже 10-те
})

test('групи статусів і «завершена»: отримана й видалена — одразу; чернетка — за 14 днів, у водія — за 45; решта — за 60', () => {
  assert.equal(statusGroup('1'), 'draft')
  assert.equal(statusGroup('7'), 'arrived')
  assert.equal(statusGroup('9'), 'received')
  assert.equal(statusGroup('103'), 'problem')
  assert.equal(statusGroup('', 'Прибув у відділення'), 'arrived')
  assert.equal(statusGroup('', 'Відмова одержувача'), 'problem')
  assert.equal(statusGroup('', ''), 'other')
  assert.equal(isFinal({ group: 'received', createdAt: NOW }, NOW), true)
  assert.equal(isFinal({ group: 'draft', createdAt: '2026-11-01T10:00:00.000Z' }, NOW), false)
  assert.equal(isFinal({ group: 'draft', createdAt: '2026-10-20T10:00:00.000Z' }, NOW), true)
  assert.equal(isFinal({ group: 'draft', createdAt: '2026-10-20T10:00:00.000Z', transfer: { id: 't' } }, NOW), false)
  assert.equal(isFinal({ group: 'transit', createdAt: '2026-09-01T10:00:00.000Z' }, NOW), true)
  assert.equal(isFinal({ group: 'arrived', createdAt: '2026-11-01T10:00:00.000Z' }, NOW), false)
})

test('розкладка і злиття джерел: телефонне джерело перекриває список непорожнім, нулі не затирають суму', () => {
  const fresh = mergeParts([fromPhone(phoneDoc(), 'out'), fromList(listDoc())])
  assert.equal(fresh.number, '20451111111111')
  assert.deepEqual(fresh.srcs, ['list', 'out'])
  assert.equal(fresh.statusName, 'Отримано')
  assert.equal(fresh.arrivedAt, '2026-11-07T08:56:30.000Z')
  assert.equal(fresh.cod, 980) // у списку 0, у телефонному 980
  assert.equal(fresh.declaredCost, 980)
  assert.equal(fresh.recipient.name, 'Клієнт Іван Іванович')
  assert.equal(fresh.recipient.phone, '+380501112233')
  assert.equal(fresh.sender.phone, OWN)
  assert.equal(fresh.scheduledAt, '2026-11-07T13:00:00.000Z') // AdjustedDate порожня → планова
  assert.equal(directionOf(fresh, new Set([OWN])), 'out')
  assert.equal(directionOf(mergeParts([fromPhone(phoneDoc(), 'in')]), new Set()), 'in')
  assert.equal(directionOf(mergeParts([fromList(listDoc({ RecipientsPhone: '380670000085' }))]), new Set([OWN])), 'in') // клієнт шле нам
  const tr = fromTrack({ Number: '2045 1111 111111', StatusCode: '7', Status: 'Прибув у відділення', ActualDeliveryDate: '2026-11-06 09:34:16', DateFirstDayStorage: '2026-11-14', PossibilityTrusteeRecipient: true })
  assert.equal(tr.number, '20451111111111')
  assert.equal(tr.storageFrom, '2026-11-14')
  assert.equal(tr.can.trustee, true)
})

test('applyFresh: історія статусів, кілька акаунтів, приватність, незмінний документ не переписується', () => {
  const a = applyFresh(null, mergeParts([fromList(listDoc({ StateId: 1, StateName: 'Створена', RecipientDateTime: null }))]), { accountId: 'fop:a', private: false, dir: 'out', now: NOW })
  assert.equal(a.group, 'draft')
  assert.equal(a.final, false)
  assert.equal(a.history.length, 1)
  assert.equal(a.linkTry, true)
  assert.equal(a.fopId, 'a')
  assert.deepEqual(a.directions, ['out'])
  const later = '2026-11-11T10:00:00.000Z'
  const b = applyFresh(a, mergeParts([fromPhone(phoneDoc(), 'out')]), { accountId: 'fop:a', private: false, dir: 'out', now: later })
  assert.equal(b.group, 'received')
  assert.equal(b.final, true)
  assert.deepEqual(b.history.map((h) => h.code), ['1', '9'])
  assert.equal(b.firstSeenAt, NOW)
  assert.deepEqual(b.sources, ['list', 'out'])
  assert.equal(sameDoc(b, applyFresh(b, mergeParts([fromPhone(phoneDoc(), 'out')]), { accountId: 'fop:a', private: false, dir: 'out', now: '2026-11-12T10:00:00.000Z' })), true)
  // ту саму накладну бачить особистий акаунт як вхідну: посилка лишається діловою, напрямів два
  const c = applyFresh(b, mergeParts([fromPhone(phoneDoc(), 'in')]), { accountId: 'acc:me', private: true, dir: 'in', now: later })
  assert.deepEqual(c.accountIds, ['acc:me', 'fop:a'])
  assert.deepEqual(c.directions, ['in', 'out'])
  assert.equal(c.private, false)
  // лише особистий акаунт → приватна і до заявок не привʼязуємо
  const p = applyFresh(null, mergeParts([fromPhone(phoneDoc(), 'in')]), { accountId: 'acc:me', private: true, dir: 'in', now: NOW })
  assert.equal(p.private, true)
  assert.equal(p.linkTry, false)
  assert.equal(p.fopId, null)
})

test('вікна списку: звичайний прохід — 15 днів одним вікном; перший — історія вікнами до 85 днів', () => {
  const now = Date.parse(NOW)
  const reg = listWindows(now)
  assert.equal(reg.length, 1)
  assert.equal(Math.round((reg[0][1] - reg[0][0]) / 864e5), 15)
  const back = listWindows(now, { backfill: true })
  assert.equal(back.length, 5)
  for (const [from, to] of back) assert.equal(Math.round((to - from) / 864e5), 85)
  assert.equal(back[1][1], back[0][0])
})

test('makeNp: «To many requests» повторюється, інша помилка — ні', async () => {
  let n = 0
  const np = makeNp(async () => (++n < 3 ? { success: false, errors: ['To many requests'] } : { success: true, data: [] }), { gapMs: 0 })
  assert.equal((await np('k', 'M', 'm', {})).success, true)
  assert.equal(n, 3)
  let m = 0
  const np2 = makeNp(async () => { m++; return { success: false, errors: ['API key expired'] } }, { gapMs: 0 })
  assert.equal((await np2('k', 'M', 'm', {})).success, false)
  assert.equal(m, 1)
})

// Підробка НП: відповіді за методом; лічить виклики.
const fakeNp = (answers) => {
  const calls = []
  const np = async (apiKey, model, method, props) => {
    calls.push({ apiKey, method, props })
    const a = answers[method]
    return typeof a === 'function' ? a(props, apiKey) : a
  }
  np.calls = calls
  return np
}
const byPhone = (rows) => ({ success: true, data: [{ result: rows }] })

test('syncKey: три джерела зливаються за номером; повтор без змін не пише; незавершене поза вікнами опитується за номером; збій одного джерела не зупиняє решту', async () => {
  const db = fakeDb({
    parcels: {
      // давня незавершена (вже не у вікнах): має оновитись трекінгом
      20450000000001: { number: '20450000000001', method: 'np', accountIds: ['fop:a'], accountDirs: { 'fop:a': 'out' }, privBy: { 'fop:a': false }, statusCode: '5', statusName: 'Прямує', group: 'transit', final: false, createdAt: '2026-10-20T10:00:00.000Z', firstSeenAt: '2026-10-20T10:00:00.000Z', history: [{ at: '2026-10-20T10:00:00.000Z', code: '5', name: 'Прямує' }], sources: ['list'], linkTry: true },
      // чужого ключа — не чіпаємо
      20450000000002: { number: '20450000000002', method: 'np', accountIds: ['fop:b'], accountDirs: { 'fop:b': 'out' }, statusCode: '5', group: 'transit', final: false, createdAt: '2026-11-01T10:00:00.000Z' },
    },
  })
  const active = [db._get('parcels', '20450000000001'), db._get('parcels', '20450000000002')]
  const np = fakeNp({
    getDocumentList: (p) => (p.Page === '1' ? { success: true, data: [listDoc(), listDoc({ IntDocNumber: '20452222222222', StateId: 1, StateName: 'Створена', RecipientDateTime: null }), listDoc({ IntDocNumber: '20453333333333', DeletionMark: '1' })] } : { success: true, data: [] }),
    getOutgoingDocumentsByPhone: byPhone([phoneDoc(), phoneDoc({ Number: '59001111111111' })]),
    getIncomingDocumentsByPhone: { success: false, errors: ['Method is not available'] },
    getStatusDocuments: (p) => ({ success: true, data: p.Documents.map((d) => ({ Number: d.DocumentNumber, StatusCode: '9', Status: 'Відправлення отримано', RecipientDateTime: '08.11.2026 12:00:00' })) }),
  })
  const group = [{ id: 'fop:a', apiKey: 'KEY', private: false, senderRef: 'cp-sender', phones: [] }]
  const sigCache = new Map()
  const r1 = await syncKey(group, { backfilledAt: NOW }, { adminDb: db, np, now: NOW, gapMs: 0, sigCache, active })
  assert.equal(r1.listed, 3)
  assert.equal(r1.out, 2)
  assert.equal(r1.created, 3) // 2045…1111, 2045…2222, 5900…; видалена пропущена
  assert.equal(r1.tracked, 1)
  assert.equal(r1.errors.length, 1)
  assert.match(r1.errors[0], /getIncomingDocumentsByPhone/)
  assert.deepEqual(r1.phones, [OWN])
  const main = db._get('parcels', '20451111111111')
  assert.deepEqual(main.sources, ['list', 'out'])
  assert.equal(main.accountDirs['fop:a'], 'out')
  assert.equal(main.final, true)
  assert.equal(db._get('parcels', '59001111111111').sources.join(), 'out')
  assert.equal(db._get('parcels', '20453333333333'), undefined)
  const old = db._get('parcels', '20450000000001')
  assert.equal(old.group, 'received')
  assert.equal(old.receivedAt, '2026-11-08T10:00:00.000Z')
  assert.deepEqual(old.history.map((h) => h.code), ['5', '9'])
  assert.equal(db._get('parcels', '20450000000002').statusCode, '5')
  assert.deepEqual(np.calls.find((c) => c.method === 'getStatusDocuments').props.Documents, [{ DocumentNumber: '20450000000001', Phone: '380670000085' }])
  // «наш телефон» у налаштуваннях акаунта: посилка клієнта в наш офіс — вхідна, навіть без джерела «вхідні за телефоном»
  const db2 = fakeDb()
  const npOffice = fakeNp({ getDocumentList: (p) => ({ success: true, data: p.Page === '1' ? [listDoc({ RecipientsPhone: '380630000021' })] : [] }), getOutgoingDocumentsByPhone: byPhone([]), getIncomingDocumentsByPhone: byPhone([]) })
  const officeCache = new Map()
  await syncKey([{ id: 'fop:a', apiKey: 'KEY', private: false, phones: [] }], { backfilledAt: NOW }, { adminDb: db2, np: npOffice, now: NOW, gapMs: 0, sigCache: officeCache, active: [] })
  assert.deepEqual(db2._get('parcels', '20451111111111').directions, ['out'])
  const office = await syncKey([{ id: 'fop:a', apiKey: 'KEY', private: false, phones: ['+380630000021'] }], { backfilledAt: NOW }, { adminDb: db2, np: npOffice, now: NOW, gapMs: 0, sigCache: officeCache, active: [] })
  assert.equal(office.written, 1) // той самий кеш підписів: напрям змінився — документ переписано
  assert.deepEqual(db2._get('parcels', '20451111111111').directions, ['in'])
  assert.equal(db2._get('parcels', '20451111111111').selfSender, false) // телефон відправника (ФОП) ще не відомий як наш
  await syncKey([{ id: 'fop:a', apiKey: 'KEY', private: false, phones: ['+380630000021', OWN] }], { backfilledAt: NOW }, { adminDb: db2, np: npOffice, now: NOW, gapMs: 0, sigCache: officeCache, active: [] })
  assert.equal(db2._get('parcels', '20451111111111').selfSender, true) // і відправник, і одержувач — ми: клієнт здав за нашою накладною
  assert.deepEqual(office.phones, []) // задані телефони у стан не потрапляють — лише вивчені з НП
  // повтор тими самими даними: ні читань документів (кеш підписів), ні записів
  const w0 = db._stats.writes
  const r2 = await syncKey(group, { backfilledAt: NOW, phones: r1.phones }, { adminDb: db, np, now: '2026-11-10T10:15:00.000Z', gapMs: 0, sigCache, active: [] })
  assert.equal(r2.written, 0)
  assert.equal(db._stats.writes, w0)
  // новий екземпляр сервера (порожній кеш): читає, але не пише
  const r3 = await syncKey(group, { backfilledAt: NOW, phones: r1.phones }, { adminDb: db, np, now: '2026-11-10T10:30:00.000Z', gapMs: 0, sigCache: new Map(), active: [] })
  assert.equal(r3.written, 0)
  assert.equal(db._stats.writes, w0)
})

test('syncKey: перший прохід тягне історію вікнами і зупиняється після двох порожніх; сторінки по 100', async () => {
  let windows = 0
  const np = fakeNp({
    getDocumentList: (p) => {
      if (p.Page === '1') windows++
      if (windows === 1) return { success: true, data: p.Page === '1' ? Array.from({ length: 100 }, (_, i) => listDoc({ IntDocNumber: `2045${String(i).padStart(10, '0')}` })) : p.Page === '2' ? [listDoc({ IntDocNumber: '20459999999999' })] : [] }
      return { success: true, data: [] }
    },
    getOutgoingDocumentsByPhone: byPhone([]),
    getIncomingDocumentsByPhone: byPhone([]),
  })
  const db = fakeDb()
  const r = await syncKey([{ id: 'fop:a', apiKey: 'K', private: false, phones: [OWN] }], null, { adminDb: db, np, now: NOW, gapMs: 0, active: [] })
  assert.equal(r.listed, 101)
  assert.equal(r.created, 101)
  assert.equal(r.backfilled, true)
  assert.equal(windows, 3) // перше з даними + два порожні → стоп (а не всі п'ять)
  const first = np.calls.find((c) => c.method === 'getDocumentList').props
  assert.equal(first.DateTimeTo, '11.11.2026')
  assert.equal(first.DateTimeFrom, '18.08.2026')
})

test('linkPass: привʼязка за зворотною ТТН, вхідною ТТН і замовленням кораблика; після 21 дня спроби припиняються', async () => {
  const p = (number, firstSeenAt = NOW) => ({ number, method: 'np', linkTry: true, link: null, firstSeenAt })
  const db = fakeDb({
    parcels: { 111: p('111'), 222: p('222'), 333: p('333'), 444: p('444'), 555: p('555', '2026-10-01T10:00:00.000Z'), 666: { number: '666', linkTry: false } },
    serviceRequests: { r1: { returnTtn: '111', serviceCenterId: 'c1', clientName: 'Іван' }, r2: { waybillNumber: '222', serviceCenterId: 'c2', clientName: 'Петро' } },
    boatOrders: { o1: { ttn: '333', clientName: 'Олег' } },
  })
  const r = await linkPass(db, NOW)
  assert.deepEqual(r, { checked: 5, linked: 3, dropped: 1 })
  assert.deepEqual(db._get('parcels', '111').link, { kind: 'return', serviceRequestId: 'r1', boatOrderId: null, serviceCenterId: 'c1', title: 'Іван' })
  assert.equal(db._get('parcels', '222').link.kind, 'incoming')
  assert.equal(db._get('parcels', '333').link.boatOrderId, 'o1')
  assert.equal(db._get('parcels', '444').linkTry, true) // ще чекаємо, заявка може зʼявитись
  assert.equal(db._get('parcels', '555').linkTry, false)
})

test('syncAll: акаунти з одним ключем ідуть одним проходом; стан пишеться кожному; неактивні й без ключа пропускаються; привʼязка раз на годину', async () => {
  const db = fakeDb()
  const np = fakeNp({
    getDocumentList: (p, key) => ({ success: true, data: p.Page === '1' && key === 'K1' ? [listDoc({ Sender: 'cp-2' })] : [] }),
    getOutgoingDocumentsByPhone: byPhone([]),
    getIncomingDocumentsByPhone: (p, key) => (key === 'K2' ? byPhone([phoneDoc({ Number: '20457777777777', TrackingStatusCode: '7', TrackingStatusName: 'Прибув у відділення', PhoneRecipient: '380931234567' })]) : byPhone([])),
  })
  const accounts = [
    { id: 'fop:a', apiKey: 'K1', private: false, senderRef: 'cp-1', phones: [] },
    { id: 'fop:b', apiKey: 'K1', private: false, senderRef: 'cp-2', phones: [] },
    { id: 'acc:me', apiKey: 'K2', private: true, phones: [] },
    { id: 'fop:off', apiKey: 'K3', active: false, phones: [] },
    { id: 'acc:nokey', apiKey: '', phones: [] },
  ]
  const r = await syncAll(accounts, { adminDb: db, np, now: NOW, gapMs: 0 })
  assert.equal(r.accounts.length, 2)
  assert.deepEqual(r.accounts[0].accounts, ['fop:a', 'fop:b'])
  assert.equal(r.accounts[0].ok, true)
  assert.equal(db._get('parcels', '20451111111111').fopId, 'b') // за контрагентом-відправником
  const mine = db._get('parcels', '20457777777777')
  assert.equal(mine.private, true)
  assert.deepEqual(mine.directions, ['in'])
  assert.equal(db._get('npSyncState', 'fop:b').backfilledAt, NOW)
  assert.deepEqual(db._get('npSyncState', 'acc:me').phones, ['+380931234567'])
  assert.equal(db._get('npSyncState', 'fop:off'), undefined)
  assert.equal(new Set(np.calls.map((c) => c.apiKey)).has('K3'), false)
  assert.deepEqual(r.link, { checked: 1, linked: 0, dropped: 0 })
  const again = await syncAll(accounts, { adminDb: db, np, now: '2026-11-10T10:15:00.000Z', gapMs: 0, only: 'acc:me' })
  assert.equal(again.accounts.length, 1)
  assert.equal(again.link, null) // години ще не минуло
})
