// node --test: опитування НП для вхідних посилок (фаза «чекаємо кораблик» правила відкритої заявки).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { incomingFromNp, npDateToIso, awaitingBoat, registerIncomingRefresh } from './incomingRefresh.js'

const NOW = '2026-10-18T10:00:00.000Z'

test('incomingFromNp: отримано (код 9) з датою НП; «Номер не знайдено» (3) і видалено (2); попередня дата отримання не губиться', () => {
  const got = incomingFromNp({ Number: '2045', StatusCode: '9', Status: 'Відправлення отримано', RecipientDateTime: '15.10.2026 13:20:00' }, null, NOW)
  assert.equal(got.arrivedAt, '2026-10-15T10:20:00.000Z')
  assert.equal(got.notFound, false)
  assert.equal(got.source, 'np')
  assert.equal(incomingFromNp({ Number: '2045', StatusCode: '3', Status: 'Номер не знайдено' }, null, NOW).notFound, true)
  assert.equal(incomingFromNp({ Number: '2045', StatusCode: '2', Status: 'Видалено' }, null, NOW).notFound, true)
  const keep = incomingFromNp({ Number: '2045', StatusCode: '3', Status: 'Номер не знайдено' }, { ttn: '2045', arrivedAt: '2026-04-01T10:00:00.000Z' }, NOW)
  assert.equal(keep.arrivedAt, '2026-04-01T10:00:00.000Z')
  assert.equal(keep.notFound, false)
  // «отримано відправником» — посилка повернулась до клієнта, не приїзд
  assert.equal(incomingFromNp({ Number: '2045', StatusCode: '0', Status: 'Відправлення отримано відправником' }, null, NOW).arrivedAt, null)
  assert.equal(npDateToIso('сміття'), null)
})

test('awaitingBoat: без етапу, не done/cancelled, без зворотної ТТН', () => {
  assert.equal(awaitingBoat({ status: 'new' }), true)
  assert.equal(awaitingBoat({ status: 'new', stage: 'received' }), false)
  assert.equal(awaitingBoat({ status: 'new', stageHistory: [{ stage: 'received' }] }), false)
  assert.equal(awaitingBoat({ status: 'done' }), false)
  assert.equal(awaitingBoat({ status: 'new', returnTtn: '7' }), false)
})

test('маршрут: 403 без токена; опитує лише заявки, що чекають з ТТН; пише incomingDelivery', async () => {
  process.env.PAYMENTS_ADMIN_TOKEN = 'adm'
  const docs = {
    a: { status: 'new', waybillNumber: '111' },
    b: { status: 'new' }, // без ТТН — не опитуємо
    c: { status: 'in_work', stage: 'received', waybillNumber: '333' }, // уже в нас
    d: { status: 'new', waybillNumber: '444' },
  }
  const updates = {}
  const db = {
    collection: () => ({
      where: (f, op, vals) => ({ get: async () => ({ docs: Object.entries(docs).filter(([, v]) => vals.includes(v.status)).map(([id, v]) => ({ id, data: () => v, ref: { update: async (p) => { updates[id] = p } } })) }) }),
    }),
  }
  const calls = []
  const npRequest = async (model, method, props) => {
    calls.push(props.Documents.map((d) => d.DocumentNumber))
    return { data: [{ Number: '111', StatusCode: '9', Status: 'Відправлення отримано', RecipientDateTime: '17.10.2026 10:00:00' }, { Number: '444', StatusCode: '3', Status: 'Номер не знайдено' }] }
  }
  const app = express()
  app.use(express.json())
  registerIncomingRefresh(app, { adminDb: db, npRequest })
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/service-requests/refresh-incoming`
    assert.equal((await fetch(url, { method: 'POST' })).status, 403)
    const r = await fetch(url, { method: 'POST', headers: { 'x-admin-token': 'adm' } })
    const j = await r.json()
    assert.deepEqual(j.data, { checked: 2, updated: 2, arrived: 1, gone: 1 })
    assert.deepEqual(calls, [['111', '444']])
    assert.equal(updates.a.incomingDelivery.arrivedAt, '2026-10-17T07:00:00.000Z')
    assert.equal(updates.d.incomingDelivery.notFound, true)
    assert.equal(updates.b, undefined)
    assert.equal(updates.c, undefined)
  } finally { server.close(); delete process.env.PAYMENTS_ADMIN_TOKEN }
})
