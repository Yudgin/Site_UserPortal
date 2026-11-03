// node --test: вынесенная накладная saveInternetDocument и оба вида наложки codFields (novaPoshtaTtn.js). Без сети и Firebase:
// Новая Почта подменена. Прежнее поведение /api/np/ttn/create закрепляет novaPoshtaTtn.test.js, здесь то, чего там нет.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { ADMIN_EMAIL } from './adminAuth.js'
import { codFields, registerNpTtn, saveInternetDocument } from './novaPoshtaTtn.js'

const MONEY = (sum) => ({ BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: sum }] })
const CONTROL = (sum) => ({ AfterpaymentOnGoodsCost: sum })

const NPC = { apiKey: 'key-1', senderRef: 'snd', contactRef: 'cnt', cityRef: 'city-fop', warehouseRef: 'wh-fop', senderPhone: '380441112233' }
const TPL = { scenario: 'parts', fopId: 'fop1', weight: 0.5, seatsAmount: 2, description: 'Кришка', payerType: 'recipient', active: true }
const CLIENT = { cityRef: 'city-1', warehouseRef: 'wh-1', phone: '+380671234567', name: 'Коваль Іван Іванович' }

// Новая Почта: ответ по умолчанию на каждую модель, over подменяет модель целиком.
const fakeNp = (over = {}) => {
  const calls = []
  const np = async (apiKey, model, method, props) => {
    calls.push({ apiKey, model, method, props })
    if (over[model]) return over[model](props)
    if (model === 'Counterparty') return { success: true, data: [{ Ref: 'cp-1', ContactPerson: { data: [{ Ref: 'cont-1' }] } }] }
    if (model === 'Address') return { success: true, data: [{ Ref: `addr-${calls.length}` }] }
    if (model === 'InternetDocument') return { success: true, data: [{ IntDocNumber: '20450999999999', Ref: 'doc-1' }] }
    throw new Error(`unexpected ${model}`)
  }
  const models = () => calls.map((c) => c.model)
  const saved = () => calls.find((c) => c.model === 'InternetDocument')?.props
  return { np, calls, models, saved }
}

const save = (f, over = {}) => saveInternetDocument({
  np: f.np, apiKey: 'key-1', npc: NPC, tpl: TPL, scenario: 'parts', description: 'Кришка V2-LID-H', cost: 800, client: CLIENT, codAmount: 0, ...over,
})

// Накладная целиком, кроме даты.
const payload = (f) => {
  const { DateTime, ...rest } = f.saved()
  assert.match(DateTime, /^\d{2}\.\d{2}\.\d{4}$/)
  return rest
}
const BASE_PAYLOAD = {
  CargoType: 'Parcel', Weight: '0.5', ServiceType: 'WarehouseWarehouse', SeatsAmount: '2', Description: 'Кришка V2-LID-H', Cost: '800',
  PayerType: 'Recipient', PaymentMethod: 'Cash',
  CitySender: 'city-fop', Sender: 'snd', SenderAddress: 'wh-fop', ContactSender: 'cnt', SendersPhone: '380441112233',
  CityRecipient: 'city-1', Recipient: 'cp-1', RecipientAddress: 'wh-1', ContactRecipient: 'cont-1', RecipientsPhone: '+380671234567',
}

// ---------- codFields ----------
test('codFields: control даёт контроль оплаты, всё остальное денежный перевод', () => {
  assert.deepEqual(codFields('control', 800), CONTROL('800'))
  assert.deepEqual(codFields('money', 800), MONEY('800'))
  for (const kind of [undefined, null, '', 'Control', 'other']) assert.deepEqual(codFields(kind, 800), MONEY('800'), String(kind))
})

test('codFields: без положительной суммы наложки нет ни у какого вида', () => {
  for (const kind of ['control', 'money', undefined]) {
    for (const amount of [0, -1, NaN, undefined, null, '']) assert.deepEqual(codFields(kind, amount), {}, `${kind} ${amount}`)
  }
})

// ---------- saveInternetDocument: что уходит в Новую Почту ----------
test('накладная: денежный перевод, все поля и ни одного лишнего', async () => {
  const f = fakeNp()
  const r = await save(f, { codAmount: 800, codKind: 'money' })
  assert.deepEqual(payload(f), { ...BASE_PAYLOAD, ...MONEY('800') })
  assert.deepEqual(r, { doc: { IntDocNumber: '20450999999999', Ref: 'doc-1' }, ttn: '20450999999999' })
})

test('накладная: контроль оплаты, все поля и ни одного лишнего', async () => {
  const f = fakeNp()
  await save(f, { codAmount: 800, codKind: 'control' })
  assert.deepEqual(payload(f), { ...BASE_PAYLOAD, ...CONTROL('800') })
})

test('накладная: вид не указан, значит денежный перевод, как у ремонтов и лодок', async () => {
  const f = fakeNp()
  await save(f, { codAmount: 800 })
  assert.deepEqual(payload(f), { ...BASE_PAYLOAD, ...MONEY('800') })
})

test('накладная: оплаченный заказ без наложки при любом виде', async () => {
  for (const codKind of ['money', 'control', undefined]) {
    const f = fakeNp()
    await save(f, { codAmount: 0, codKind })
    assert.deepEqual(payload(f), BASE_PAYLOAD)
  }
})

test('накладная: сначала получатель, потом документ, всё на переданном ключе, имя делится по пробелам', async () => {
  const f = fakeNp()
  await save(f, { apiKey: 'key-9' })
  assert.deepEqual(f.models(), ['Counterparty', 'InternetDocument'])
  assert.ok(f.calls.every((c) => c.apiKey === 'key-9' && c.method === 'save'))
  assert.deepEqual(f.calls[0].props, {
    CounterpartyProperty: 'Recipient', CounterpartyType: 'PrivatePerson', CityRef: 'city-1',
    FirstName: 'Іван', LastName: 'Коваль', MiddleName: 'Іванович', Phone: '+380671234567',
  })
})

test('накладная: необязательные поля шаблона и умолчания', async () => {
  const bare = fakeNp()
  await save(bare, { tpl: { scenario: 'parts' } })
  assert.equal(bare.saved().CargoType, 'Parcel')
  assert.equal(bare.saved().Weight, '1')
  assert.equal(bare.saved().SeatsAmount, '1')
  assert.equal(bare.saved().ServiceType, 'WarehouseWarehouse')
  assert.equal('VolumeGeneral' in bare.saved(), false)

  const full = fakeNp()
  await save(full, { tpl: { ...TPL, cargoType: 'Cargo', volumeGeneral: 0.02 } })
  assert.equal(full.saved().CargoType, 'Cargo')
  assert.equal(full.saved().VolumeGeneral, '0.02')
})

test('накладная: плательщик по шаблону, но клиент-отправитель платит всегда', async () => {
  const cases = [
    [{ payerType: 'sender' }, 'Sender'],
    [{ payerType: 'recipient' }, 'Recipient'],
    [{}, 'Recipient'],
    [{ payerType: 'recipient', senderTarget: 'client' }, 'Sender'],
  ]
  for (const [over, expected] of cases) {
    const f = fakeNp()
    await save(f, { tpl: { ...TPL, ...over } })
    assert.equal(f.saved().PayerType, expected, JSON.stringify(over))
  }
})

test('накладная: приём от клиента едет с его отделения на отделение ФОП, Counterparty не создаётся', async () => {
  const f = fakeNp()
  await save(f, { scenario: 'incoming', tpl: { ...TPL, scenario: 'incoming', senderTarget: 'client' } })
  assert.deepEqual(f.models(), ['InternetDocument'])
  const mp = f.saved()
  assert.equal(mp.CitySender, 'city-1')
  assert.equal(mp.SenderAddress, 'wh-1')
  assert.equal(mp.Sender, 'snd')
  assert.equal(mp.Recipient, 'snd')
  assert.equal(mp.CityRecipient, 'city-fop')
  assert.equal(mp.RecipientAddress, 'wh-fop')
  assert.equal(mp.ContactRecipient, 'cnt')
  assert.equal(mp.RecipientsPhone, '380441112233')
})

test('накладная: клиент-отправитель без адреса берёт адрес шаблона, затем ФОП', async () => {
  const noAddress = { ...CLIENT, warehouseRef: '' }
  const fromTpl = fakeNp()
  await save(fromTpl, { client: noAddress, scenario: 'incoming', tpl: { ...TPL, senderTarget: 'client', sender: { cityRef: 'city-t', warehouseRef: 'wh-t' }, recipient: { cityRef: 'city-r', warehouseRef: 'wh-r' } } })
  assert.equal(fromTpl.saved().CitySender, 'city-t')
  assert.equal(fromTpl.saved().SenderAddress, 'wh-t')
  assert.equal(fromTpl.saved().CityRecipient, 'city-r')
  assert.equal(fromTpl.saved().RecipientAddress, 'wh-r')

  const fromFop = fakeNp()
  await save(fromFop, { client: noAddress, scenario: 'incoming', tpl: { ...TPL, senderTarget: 'client' } })
  assert.equal(fromFop.saved().CitySender, 'city-fop')
  assert.equal(fromFop.saved().SenderAddress, 'wh-fop')
})

test('накладная: получатель без явной цели зависит от сценария', async () => {
  const incoming = fakeNp()
  await save(incoming, { scenario: 'incoming' })
  assert.deepEqual(incoming.models(), ['InternetDocument'])
  assert.equal(incoming.saved().Recipient, 'snd')

  const explicit = fakeNp()
  await save(explicit, { scenario: 'incoming', tpl: { ...TPL, recipientTarget: 'client' } })
  assert.equal(explicit.saved().Recipient, 'cp-1')
})

test('накладная: адресная доставка создаёт адреса у нужной стороны и в нужном порядке', async () => {
  const street = { streetRef: 'st', house: 5, flat: 7 }
  const f = fakeNp()
  await save(f, { client: {}, tpl: { ...TPL, serviceType: 'DoorsDoors', recipientTarget: 'fixed', recipientName: 'Склад Петро', recipientPhone: '+380501112233', sender: { ...street, cityRef: 'city-s' }, recipient: { ...street, cityRef: 'city-r' } } })
  assert.deepEqual(f.models(), ['Address', 'Counterparty', 'Address', 'InternetDocument'])
  assert.deepEqual(f.calls[0].props, { CounterpartyRef: 'snd', StreetRef: 'st', BuildingNumber: '5', Flat: '7' })
  assert.equal(f.calls[1].props.LastName, 'Склад')
  assert.equal(f.calls[1].props.FirstName, 'Петро')
  assert.equal(f.calls[1].props.Phone, '+380501112233')
  assert.equal(f.calls[1].props.CityRef, 'city-r')
  assert.equal(f.calls[2].props.CounterpartyRef, 'cp-1')
  const mp = f.saved()
  assert.equal(mp.ServiceType, 'DoorsDoors')
  assert.equal(mp.CitySender, 'city-s')
  assert.equal(mp.SenderAddress, 'addr-1')
  assert.equal(mp.CityRecipient, 'city-r')
  assert.equal(mp.RecipientAddress, 'addr-3')
  assert.equal(mp.RecipientsPhone, '+380501112233')

  const toService = fakeNp()
  await save(toService, { client: {}, tpl: { ...TPL, serviceType: 'WarehouseDoors', recipientTarget: 'service', recipient: street } })
  assert.deepEqual(toService.models(), ['Address', 'InternetDocument'])
  assert.equal(toService.calls[0].props.CounterpartyRef, 'snd')
  assert.equal(toService.saved().SenderAddress, 'wh-fop')
  assert.equal(toService.saved().RecipientAddress, 'addr-1')
})

test('накладная: клиент получает только на отделение, даже в адресном шаблоне', async () => {
  const f = fakeNp()
  await save(f, { tpl: { ...TPL, serviceType: 'WarehouseDoors' } })
  assert.deepEqual(f.models(), ['Counterparty', 'InternetDocument'])
  assert.equal(f.saved().RecipientAddress, 'wh-1')
})

test('накладная: фиксированный получатель из шаблона, если у клиента нет адреса', async () => {
  const f = fakeNp()
  await save(f, { client: { ...CLIENT, cityRef: '' }, tpl: { ...TPL, recipientName: 'Склад Петро', recipientPhone: '+380501112233', recipient: { cityRef: 'city-t', warehouseRef: 'wh-t' } } })
  assert.equal(f.calls[0].props.LastName, 'Склад')
  assert.equal(f.saved().CityRecipient, 'city-t')
  assert.equal(f.saved().RecipientAddress, 'wh-t')
  assert.equal(f.saved().RecipientsPhone, '+380501112233')

  const unnamed = fakeNp()
  await save(unnamed, { client: {}, tpl: { ...TPL, recipient: { cityRef: 'city-t', warehouseRef: 'wh-t' } } })
  assert.equal(unnamed.calls[0].props.LastName, 'Отримувач')
  assert.equal(unnamed.calls[0].props.Phone, '')
  assert.equal(unnamed.saved().RecipientsPhone, '')
})

test('накладная: при адресе клиента едет ему, а не фиксированному получателю шаблона', async () => {
  const f = fakeNp()
  await save(f, { tpl: { ...TPL, recipientName: 'Склад Петро', recipientPhone: '+380501112233', recipient: { cityRef: 'city-t', warehouseRef: 'wh-t' } } })
  assert.equal(f.calls[0].props.LastName, 'Коваль')
  assert.deepEqual(payload(f), BASE_PAYLOAD)
})

test('накладная: адрес клиента без отделения не считается адресом', async () => {
  const f = fakeNp()
  await save(f, { client: { ...CLIENT, warehouseRef: '' }, tpl: { ...TPL, recipientName: 'Склад Петро', recipient: { cityRef: 'city-t', warehouseRef: 'wh-t' } } })
  assert.equal(f.calls[0].props.LastName, 'Склад')
  assert.equal(f.saved().CityRecipient, 'city-t')
  assert.equal(f.saved().RecipientAddress, 'wh-t')
})

test('накладная: фиксированный получатель не заменяется клиентом, даже если у клиента есть адрес', async () => {
  const f = fakeNp()
  await save(f, { tpl: { ...TPL, recipientTarget: 'fixed', recipientName: 'Склад Петро', recipient: { cityRef: 'city-t', warehouseRef: 'wh-t' } } })
  assert.equal(f.calls[0].props.LastName, 'Склад')
  assert.equal(f.calls[0].props.Phone, '')
  assert.equal(f.saved().CityRecipient, 'city-t')
  assert.equal(f.saved().RecipientAddress, 'wh-t')
  assert.equal(f.saved().RecipientsPhone, '')
})

test('накладная: у ФОП нет телефона, в полях пустая строка', async () => {
  const { senderPhone, ...npc } = NPC
  const f = fakeNp()
  await save(f, { npc, scenario: 'incoming' })
  assert.equal(f.saved().SendersPhone, '')
  assert.equal(f.saved().RecipientsPhone, '')
})

test('накладная: номер берётся из IntDocNumber, затем Number, иначе пусто', async () => {
  const ofDoc = async (doc) => (await save(fakeNp({ InternetDocument: () => ({ success: true, data: [doc] }) }))).ttn
  assert.equal(await ofDoc({ IntDocNumber: '1', Number: '2' }), '1')
  assert.equal(await ofDoc({ Number: '2' }), '2')
  assert.equal(await ofDoc({ Ref: 'doc' }), '')
})

// ---------- saveInternetDocument: отказы и признак «накладной точно нет» ----------
test('нет города или отделения получателя: problem без единого обращения к документу', async () => {
  const noCity = fakeNp()
  assert.deepEqual(await save(noCity, { client: {} }), {
    problem: { status: 400, code: 'NO_RECIP_CITY', message: 'Немає міста отримувача (ні в заявці, ні в шаблоні)', noDocument: true },
  })
  assert.deepEqual(noCity.models(), [])

  const noAddr = fakeNp()
  assert.deepEqual(await save(noAddr, { client: {}, tpl: { ...TPL, recipient: { cityRef: 'city-t' } } }), {
    problem: { status: 400, code: 'NO_RECIP_ADDR', message: 'Немає відділення отримувача (ні в заявці, ні в шаблоні)', noDocument: true },
  })
  assert.deepEqual(noAddr.models(), ['Counterparty'])
})

test('явный отказ Новой Почты: problem с её текстом и noDocument', async () => {
  const errors = fakeNp({ InternetDocument: () => ({ success: false, errors: ['Адреса невірна', 'Вага'], warnings: ['інше'] }) })
  assert.deepEqual(await save(errors), {
    problem: { status: 502, code: 'NP_ERROR', message: 'Адреса невірна; Вага', extra: { npErrors: ['Адреса невірна', 'Вага'] }, noDocument: true },
  })

  const warnings = fakeNp({ InternetDocument: () => ({ success: false, warnings: ['інше'] }) })
  assert.deepEqual(await save(warnings), {
    problem: { status: 502, code: 'NP_ERROR', message: 'інше', extra: { npErrors: ['інше'] }, noDocument: true },
  })

  const silent = fakeNp({ InternetDocument: () => ({ success: false }) })
  assert.deepEqual(await save(silent), {
    problem: { status: 502, code: 'NP_ERROR', message: 'Нова Пошта відхилила запит', extra: { npErrors: [] }, noDocument: true },
  })
})

test('странный ответ это не явный отказ: problem без noDocument, исход неизвестен', async () => {
  for (const resp of [null, undefined, {}, '<html>', { success: true }, { success: true, data: [] }, { success: 'false' }]) {
    const { problem } = await save(fakeNp({ InternetDocument: () => resp }))
    assert.equal(problem.code, 'NP_ERROR', JSON.stringify(resp))
    assert.equal(problem.status, 502)
    assert.equal(problem.noDocument, false, JSON.stringify(resp))
  }
})

test('таймаут самого документа: та же ошибка наружу без noDocument, накладная могла создаться', async () => {
  const timeout = Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' })
  const f = fakeNp({ InternetDocument: () => { throw timeout } })
  await assert.rejects(save(f), (e) => {
    assert.equal(e, timeout)
    assert.equal(e.noDocument, undefined)
    return true
  })
})

test('сбой до документа: та же ошибка наружу с noDocument, документ не вызывался', async () => {
  const timeout = new Error('timeout of 20000ms exceeded')
  const counterparty = fakeNp({ Counterparty: () => { throw timeout } })
  await assert.rejects(save(counterparty), (e) => {
    assert.equal(e, timeout)
    assert.equal(e.noDocument, true)
    return true
  })
  assert.deepEqual(counterparty.models(), ['Counterparty'])

  const address = fakeNp({ Address: () => { throw new Error('socket hang up') } })
  await assert.rejects(save(address, { tpl: { ...TPL, serviceType: 'DoorsWarehouse', sender: { streetRef: 'st' } } }), (e) => {
    assert.equal(e.message, 'socket hang up')
    assert.equal(e.noDocument, true)
    return true
  })
  assert.deepEqual(address.models(), ['Address'])
})

test('отказ на сторонах: текст Новой Почты и noDocument, документ не вызывался', async () => {
  const counterparty = fakeNp({ Counterparty: () => ({ success: false, errors: ['Телефон невірний'] }) })
  await assert.rejects(save(counterparty), (e) => {
    assert.equal(e.message, 'Телефон невірний')
    assert.equal(e.noDocument, true)
    return true
  })
  assert.deepEqual(counterparty.models(), ['Counterparty'])

  const address = fakeNp({ Address: () => ({ success: false, errors: ['Вулиця невірна'] }) })
  await assert.rejects(save(address, { tpl: { ...TPL, serviceType: 'DoorsWarehouse', sender: { streetRef: 'st' } } }), (e) => {
    assert.equal(e.message, 'Вулиця невірна')
    assert.equal(e.noDocument, true)
    return true
  })
  assert.deepEqual(address.models(), ['Address'])

  const noStreet = fakeNp()
  await assert.rejects(save(noStreet, { tpl: { ...TPL, serviceType: 'DoorsWarehouse' } }), (e) => {
    assert.equal(e.message, 'Для адресної доставки не задана вулиця')
    assert.equal(e.noDocument, true)
    return true
  })
  assert.deepEqual(noStreet.models(), [])
})

// ---------- маршрут /api/np/ttn/create: ремонты и лодки как были ----------
const FOP = { id: 'fop1', methods: {}, novaPoshta: NPC }
const RETURN_TPL = { name: 'З ремонту', scenario: 'return', fopId: 'fop1', weight: 2, description: 'Кораблик', cod: true, active: true }

const startApp = async ({ staff, np, templates = {} }) => {
  const data = {
    serviceRequests: { 'sr-1': { id: 'sr-1', serviceCenterId: 'c1', clientName: 'Коваль Іван', clientPhone: '+380671234567', clientCityRef: 'city-1', clientWarehouseRef: 'wh-1', actualEstimateId: 'est-1' }, 'sr-2': { id: 'sr-2', clientName: 'Без адреси' } },
    serviceCenters: { c1: { returnTtnTemplateId: 'tpl-ret' } },
    npTemplates: { 'tpl-ret': RETURN_TPL, ...templates },
    priceEstimates: { 'est-1': { total: 12500, status: 'approved' } },
  }
  const writes = []
  const adminDb = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({ exists: !!data[name]?.[id], data: () => data[name][id] }),
        set: async (patch) => { writes.push({ name, id, patch }) },
      }),
    }),
  }
  const app = express()
  app.use(express.json())
  registerNpTtn(app, { adminDb, verifyStaff: async () => staff, resolveFop: () => FOP, np })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const create = async (body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/np/ttn/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, json: await r.json() }
  }
  return { create, writes, close: () => new Promise((r) => server.close(r)) }
}

const OWNER = { uid: 'own-save-test', email: ADMIN_EMAIL, role: 'owner', centers: [] }
const DIRECTOR = { uid: 'dir-save-test', email: 'dir@runferry.test', role: 'director', centers: [{ centerId: 'c1', perms: [] }] }

// Тихий журнал: маршрут пишет ошибку в console.error, в выводе тестов она только мешает.
const quiet = async (t) => { t.mock.method(console, 'error', () => {}) }

test('маршрут: контроль оплаты недостижим, ремонт всегда денежный перевод', async () => {
  const delegatedNp = fakeNp()
  const delegated = await startApp({ staff: DIRECTOR, np: delegatedNp.np, templates: { 'tpl-ret': { ...RETURN_TPL, codKind: 'control' } } })
  try {
    const r = await delegated.create({ serviceRequestId: 'sr-1', codKind: 'control' })
    assert.equal(r.status, 200)
    assert.equal(r.json.data.codAmount, 12500)
    assert.deepEqual(delegatedNp.saved().BackwardDeliveryData, MONEY('12500').BackwardDeliveryData)
    assert.equal('AfterpaymentOnGoodsCost' in delegatedNp.saved(), false)
  } finally { await delegated.close() }

  const ownerNp = fakeNp()
  const owner = await startApp({ staff: OWNER, np: ownerNp.np, templates: { 'tpl-x': { ...RETURN_TPL, codKind: 'control' } } })
  try {
    const r = await owner.create({ serviceRequestId: 'sr-1', templateId: 'tpl-x', codAmount: 500, codKind: 'control' })
    assert.equal(r.status, 200)
    assert.deepEqual(ownerNp.saved().BackwardDeliveryData, MONEY('500').BackwardDeliveryData)
    assert.equal('AfterpaymentOnGoodsCost' in ownerNp.saved(), false)
  } finally { await owner.close() }
})

test('маршрут: тело накладной не подменяет плательщика и адрес отправителя', async () => {
  const f = fakeNp()
  const t = await startApp({ staff: OWNER, np: f.np, templates: { 'tpl-x': RETURN_TPL } })
  try {
    await t.create({ serviceRequestId: 'sr-1', templateId: 'tpl-x', clientName: 'Інший Клієнт', clientPhone: '+380990000000', clientCityRef: 'city-b', clientWarehouseRef: 'wh-b', PayerType: 'Sender', SenderAddress: 'x' })
    const mp = f.saved()
    assert.equal(mp.PayerType, 'Recipient')
    assert.equal(mp.SenderAddress, 'wh-fop')
    // Владелец на полном пути может указать адрес и имя клиента, как и раньше.
    assert.equal(mp.CityRecipient, 'city-b')
    assert.equal(mp.RecipientAddress, 'wh-b')
    assert.equal(mp.RecipientsPhone, '+380990000000')
    assert.equal(f.calls[0].props.LastName, 'Інший')
  } finally { await t.close() }
})

test('маршрут: сценарий шаблона решает, кто получатель и будет ли наложка', async () => {
  const f = fakeNp()
  const t = await startApp({ staff: OWNER, np: f.np, templates: { 'tpl-in': { ...RETURN_TPL, scenario: 'incoming' }, 'tpl-out': RETURN_TPL } })
  try {
    const incoming = await t.create({ serviceRequestId: 'sr-1', templateId: 'tpl-in' })
    assert.equal(incoming.status, 200)
    assert.equal(incoming.json.data.codAmount, 0, 'посылка едет в сервис: наложки нет, хотя у шаблона cod')
    assert.deepEqual(f.models(), ['InternetDocument'])
    assert.equal(f.saved().Recipient, 'snd')
    assert.equal(f.saved().BackwardDeliveryData, undefined)

    const out = await t.create({ serviceRequestId: 'sr-1', templateId: 'tpl-out' })
    assert.equal(out.json.data.codAmount, 12500)
    assert.equal(f.calls.at(-1).props.Recipient, 'cp-1')
    assert.deepEqual(f.calls.at(-1).props.BackwardDeliveryData, MONEY('12500').BackwardDeliveryData)
  } finally { await t.close() }
})

test('маршрут: отказы отвечают прежним телом, внутренний признак наружу не выходит', async (ctx) => {
  await quiet(ctx)
  const run = async (np, body, templates) => {
    const t = await startApp({ staff: OWNER, np, templates })
    try {
      const r = await t.create(body)
      assert.deepEqual(t.writes, [], 'заявка не меняется')
      return r
    } finally { await t.close() }
  }
  const body = { serviceRequestId: 'sr-1', templateId: 'tpl-x' }
  const failure = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } })

  assert.deepEqual(
    await run(fakeNp({ InternetDocument: () => ({ success: false, errors: ['Адреса невірна'] }) }).np, body, { 'tpl-x': RETURN_TPL }),
    { status: 502, json: failure('NP_ERROR', 'Адреса невірна', { npErrors: ['Адреса невірна'] }) },
  )
  assert.deepEqual(
    await run(fakeNp({ InternetDocument: () => ({ success: true, data: [] }) }).np, body, { 'tpl-x': RETURN_TPL }),
    { status: 502, json: failure('NP_ERROR', 'Нова Пошта відхилила запит', { npErrors: [] }) },
  )
  assert.deepEqual(
    await run(fakeNp().np, { serviceRequestId: 'sr-2', templateId: 'tpl-x' }, { 'tpl-x': RETURN_TPL }),
    { status: 400, json: failure('NO_RECIP_CITY', 'Немає міста отримувача (ні в заявці, ні в шаблоні)') },
  )
  assert.deepEqual(
    await run(fakeNp().np, { serviceRequestId: 'sr-2', templateId: 'tpl-x' }, { 'tpl-x': { ...RETURN_TPL, recipient: { cityRef: 'city-t' } } }),
    { status: 400, json: failure('NO_RECIP_ADDR', 'Немає відділення отримувача (ні в заявці, ні в шаблоні)') },
  )
  assert.deepEqual(
    await run(fakeNp({ Counterparty: () => ({ success: false, errors: ['Телефон невірний'] }) }).np, body, { 'tpl-x': RETURN_TPL }),
    { status: 500, json: failure('TTN_FAILED', 'Телефон невірний') },
  )
  assert.deepEqual(
    await run(fakeNp({ InternetDocument: () => { throw new Error('timeout of 20000ms exceeded') } }).np, body, { 'tpl-x': RETURN_TPL }),
    { status: 500, json: failure('TTN_FAILED', 'timeout of 20000ms exceeded') },
  )
})
