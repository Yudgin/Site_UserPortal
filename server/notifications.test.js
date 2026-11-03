// node --test: журнал оповещений клиента (server/notifications.js) на фейковом Firestore, без сети и firebase-admin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'events'
import express from 'express'
import { registerNotifications } from './notifications.js'

// ---------- фейковый Firestore: транзакции идут по очереди, как при конфликте в настоящем ----------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
class FakeDb {
  constructor(seed = {}) {
    this.docs = {}
    this.reads = []
    this.txQueue = Promise.resolve()
    for (const [path, v] of Object.entries(seed)) this.docs[path] = clone(v)
  }
  get(path) { return clone(this.docs[path]) }
  write(path, v, opts) {
    if (opts && opts.merge && this.docs[path]) Object.assign(this.docs[path], clone(v))
    else this.docs[path] = clone(v)
  }
  collection(name) {
    const db = this
    return {
      doc(id) {
        const did = id || `auto${Math.random().toString(36).slice(2, 10)}`
        const path = `${name}/${did}`
        return {
          id: did, path,
          async get() { db.reads.push(path); const d = db.docs[path]; return { id: did, exists: !!d, data: () => clone(d) } },
          async set(v, opts) { db.write(path, v, opts) },
        }
      },
    }
  }
  runTransaction(fn) {
    const run = async () => {
      const writes = []
      const tx = {
        async get(ref) { if (writes.length) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
        set(ref, v, opts) { writes.push([ref.path, v, opts]) },
      }
      const out = await fn(tx)
      for (const [path, v, opts] of writes) this.write(path, v, opts)
      return out
    }
    const p = this.txQueue.then(run)
    this.txQueue = p.catch(() => {})
    return p
  }
}

// ---------- стенд ----------
const PHONE = '+380671234567'
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv'
const KEY = 'order0001-paid'
const SHOP_ID = `ntf-na-shop-${KEY}`
const smsAlwaysOk = async () => ({ ok: true })
const stand = ({ seed = {}, sms: answer = smsAlwaysOk, senders } = {}) => {
  const db = new FakeDb(seed)
  const sms = []
  const sendSms = async (to, text) => { sms.push({ to, text }); return answer(sms.length) }
  const { notifyClient } = registerNotifications({ post() {} }, { adminDb: db, sendSms, senders })
  return { db, sms, notifyClient }
}
const shop = (extra = {}) => ({ event: 'shop', text: 'RunFerry: оплату 800 грн отримано', phone: PHONE, clientKey: KEY, by: 'shop', ...extra })
const journalDocs = (db) => Object.keys(db.docs).filter((p) => p.startsWith('notifications/'))

// ---------- событие shop: один ключ — один платный SMS ----------
test('shop: первая отправка — SMS по телефону, документ ntf-na-shop-<ключ>', async () => {
  const { db, sms, notifyClient } = stand()
  const rec = await notifyClient(shop())
  assert.deepEqual(sms, [{ to: PHONE, text: 'RunFerry: оплату 800 грн отримано' }])
  assert.equal(rec.id, SHOP_ID)
  assert.equal(rec.status, 'sent')
  assert.equal(rec.channel, 'sms')
  assert.equal(rec.via, 'sms')
  assert.equal(rec.event, 'shop')
  assert.equal(rec.serviceRequestId, null)
  assert.equal(rec.by, 'shop')
  assert.deepEqual(journalDocs(db), [`notifications/${SHOP_ID}`])
  assert.equal(db.get(`notifications/${SHOP_ID}`).status, 'sent')
})

test('shop: повтор с тем же ключом не шлёт второй SMS и не трогает запись', async () => {
  const { db, sms, notifyClient } = stand()
  await notifyClient(shop())
  const before = db.get(`notifications/${SHOP_ID}`)
  const again = await notifyClient(shop({ text: 'RunFerry: інший текст' }))
  assert.equal(again.skipped, true)
  assert.equal(again.status, 'sent')
  assert.equal(sms.length, 1)
  assert.deepEqual(db.get(`notifications/${SHOP_ID}`), before)
})

test('shop: параллельные вызовы с одним ключом дают один SMS', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true } }
  const { sms, notifyClient } = stand({ sms: slow })
  const [a, b] = await Promise.all([notifyClient(shop()), notifyClient(shop())])
  assert.equal(sms.length, 1)
  assert.equal(a.status, 'sent')
  // второй не знает исхода первого: pending не значит ни «доставлено», ни «не удалось»
  assert.equal(b.skipped, true)
  assert.equal(b.status, 'pending')
})

test('shop: другой ключ — другой документ и другой SMS', async () => {
  const { db, sms, notifyClient } = stand()
  await notifyClient(shop())
  const rec = await notifyClient(shop({ clientKey: 'order0001-rcpt' }))
  assert.equal(rec.id, 'ntf-na-shop-order0001-rcpt')
  assert.equal(sms.length, 2)
  assert.equal(journalDocs(db).length, 2)
})

test('shop: неудача не занимает ключ, повтор шлёт снова, после успеха больше нет', async () => {
  const answers = [
    async () => ({ ok: false, error: 'gateway down' }),
    async () => { throw new Error('socket hang up') },
    smsAlwaysOk,
  ]
  const { db, sms, notifyClient } = stand({ sms: (n) => answers[n - 1]() })
  const first = await notifyClient(shop())
  assert.equal(first.status, 'failed')
  assert.equal(first.error, 'gateway down')
  const second = await notifyClient(shop())
  assert.equal(second.status, 'failed')
  assert.match(second.error, /socket hang up/)
  const third = await notifyClient(shop())
  assert.equal(third.status, 'sent')
  assert.equal(third.error, null)
  assert.equal((await notifyClient(shop())).skipped, true)
  assert.equal(sms.length, 3)
  assert.equal(journalDocs(db).length, 1)
})

test('shop: свежий захват другого вызова пропускается, зависший дольше минуты шлётся заново', async () => {
  const pending = (ageMs) => ({ [`notifications/${SHOP_ID}`]: { id: SHOP_ID, status: 'pending', claimedAt: new Date(Date.now() - ageMs).toISOString(), event: 'shop' } })
  const fresh = stand({ seed: pending(30000) })
  const skipped = await fresh.notifyClient(shop())
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.status, 'pending')
  assert.equal(fresh.sms.length, 0)
  const stale = stand({ seed: pending(61000) })
  assert.equal((await stale.notifyClient(shop())).status, 'sent')
  assert.equal(stale.sms.length, 1)
})

test('shop: без верного ключа отказ до отправки и без записи', async () => {
  const bad = [undefined, null, '', 'short12', 'with space1', 'ключ-кирилицею', 'a'.repeat(65), 'order/0001/paid', 'order 2045 1234 5678 90']
  for (const clientKey of bad) {
    const { db, sms, notifyClient } = stand()
    await assert.rejects(notifyClient(shop({ clientKey })), /clientKey/, `ключ ${clientKey}`)
    assert.equal(sms.length, 0, `ключ ${clientKey}`)
    assert.deepEqual(journalDocs(db), [], `ключ ${clientKey}`)
  }
  for (const clientKey of ['a'.repeat(8), 'a'.repeat(64)]) {
    const { sms, notifyClient } = stand()
    assert.equal((await notifyClient(shop({ clientKey }))).id, `ntf-na-shop-${clientKey}`)
    assert.equal(sms.length, 1)
  }
})

test('shop: пустой текст — отказ без записи и SMS', async () => {
  for (const text of [null, '', '   ']) {
    const { db, sms, notifyClient } = stand()
    await assert.rejects(notifyClient(shop({ text })), /empty notification body/)
    assert.equal(sms.length, 0)
    assert.deepEqual(journalDocs(db), [])
  }
})

test('shop: журнал читает весь персонал — телефона и токена там нет, покупателю полный текст', async () => {
  const text = `RunFerry: оплату 800 грн отримано. Замовлення: https://runferry.ua/uk/order/${TOKEN}`
  const masked = stand()
  const rec = await masked.notifyClient(shop({ text, journal: { text: 'RunFerry: оплату 800 грн отримано. Замовлення: https://runferry.ua/uk/order/…' } }))
  assert.equal(masked.sms[0].text, text)
  assert.equal(masked.sms[0].to, PHONE)
  const doc = masked.db.get(`notifications/${SHOP_ID}`)
  assert.equal(doc.text, 'RunFerry: оплату 800 грн отримано. Замовлення: https://runferry.ua/uk/order/…')
  assert.equal(doc.phone, null)
  assert.equal(doc.status, 'sent')
  const skipped = await masked.notifyClient(shop({ text }))
  for (const seen of [JSON.stringify(doc), JSON.stringify(rec), JSON.stringify(skipped)]) {
    assert.ok(!seen.includes(TOKEN))
    assert.ok(!seen.includes(PHONE))
  }
  // забыли передать journal: пустой текст лучше ссылки-доступа в журнале
  const forgot = stand()
  await forgot.notifyClient(shop({ text }))
  assert.equal(forgot.sms[0].text, text)
  assert.equal(forgot.db.get(`notifications/${SHOP_ID}`).text, '')
  assert.equal(forgot.db.get(`notifications/${SHOP_ID}`).phone, null)
  // неудача: то же самое, повтор сверки не должен оставлять телефон в журнале
  const failed = stand({ sms: async () => ({ ok: false, error: 'invalid phone' }) })
  await failed.notifyClient(shop({ text }))
  assert.equal(failed.db.get(`notifications/${SHOP_ID}`).status, 'failed')
  assert.ok(!JSON.stringify(failed.db.get(`notifications/${SHOP_ID}`)).includes(PHONE))
})

test('shop: только готовый текст и SMS — без шаблона, заявки, сессии и мессенджера', async () => {
  let messenger = 0
  const senders = { telegram: async () => { messenger++; return { ok: true } } }
  const { db, sms, notifyClient } = stand({ senders })
  await notifyClient(shop({ link: 'https://x/y', ttn: '20450000000000' }))
  assert.equal(sms[0].text, 'RunFerry: оплату 800 грн отримано')
  assert.equal(messenger, 0)
  assert.deepEqual(db.reads, [`notifications/${SHOP_ID}`])
  // телефона нет (данные уже стёрты): ошибка в журнале, SMS нет
  const none = stand()
  const rec = await none.notifyClient(shop({ phone: null }))
  assert.equal(rec.status, 'failed')
  assert.match(rec.error, /немає доступного каналу/)
  assert.equal(none.sms.length, 0)
})

// ---------- /api/notify: снаружи событие недоступно ----------
const STAFF = {
  owner: { uid: 'u-owner', email: 'o@x', role: 'owner', centers: [] },
  director: { uid: 'u-director', email: 'd@x', role: 'director', centers: [{ centerId: 'c1' }] },
  master: { uid: 'u-master', email: 'm@x', role: 'master', centers: [{ centerId: 'c1' }] },
}
const route = async (deps, fn) => {
  const db = new FakeDb()
  const sms = []
  const app = express()
  app.use(express.json())
  registerNotifications(app, { adminDb: db, sendSms: async (to, text) => { sms.push({ to, text }); return { ok: true } }, ...deps })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    await fn({ post, db, sms })
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

test('/api/notify отвергает shop и chat-invite у любой роли: без SMS и записи', async () => {
  for (const role of Object.keys(STAFF)) {
    for (const event of ['shop', 'chat-invite']) {
      await route({ verifyStaff: async () => STAFF[role] }, async ({ post, db, sms }) => {
        const res = await post({ event, text: 'будь-який текст', phone: PHONE, clientKey: KEY, serviceRequestId: 'sr1' })
        assert.equal(res.status, 400, `${role} ${event}`)
        assert.equal((await res.json()).error.code, 'BAD_EVENT')
        assert.equal(sms.length, 0)
        assert.deepEqual(journalDocs(db), [])
        assert.deepEqual(db.reads, [])
      })
    }
  }
})

test('/api/notify: контроль — тот же запрос с custom у владельца проходит', async () => {
  await route({ verifyStaff: async () => STAFF.owner }, async ({ post, sms }) => {
    const res = await post({ event: 'custom', text: 'будь-який текст', phone: PHONE, clientKey: KEY })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).data.status, 'sent')
    assert.equal(sms.length, 1)
  })
})

test('/api/notify: проверка роли прежняя, без сотрудника 403 раньше проверки события', async () => {
  const roles = []
  await route({ verifyStaff: async (req, r) => { roles.push(r); return null } }, async ({ post, sms }) => {
    const res = await post({ event: 'shop', text: 'x', phone: PHONE, clientKey: KEY })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'FORBIDDEN')
    assert.equal(sms.length, 0)
  })
  assert.deepEqual(roles, [['owner', 'director', 'master']])
  // без подмены работает настоящая проверка: нет токена — нет доступа
  await route({}, async ({ post, sms }) => {
    assert.equal((await post({ event: 'custom', text: 'x', phone: PHONE })).status, 403)
    assert.equal(sms.length, 0)
  })
})

// ---------- ремонты и приглашения: документы и журнал прежние ----------
test('прежние события: id, журнал и повторы не изменились', async () => {
  const req = { clientPhone: '+380501112233', offerId: 'of1', actualEstimateId: 'est1', serviceCenterId: 'c1' }
  const seed = { 'serviceRequests/sr1': req }
  const cases = [
    { args: { event: 'offer', serviceRequestId: 'sr1' }, id: 'ntf-sr1-offer', to: req.clientPhone, text: /\/offer\/of1/ },
    { args: { event: 'actual', serviceRequestId: 'sr1' }, id: 'ntf-sr1-actual', to: req.clientPhone, text: /\/estimate\/est1/ },
    { args: { event: 'ttn', serviceRequestId: 'sr1', ttn: '20450000000000' }, id: 'ntf-sr1-ttn-20450000000000', to: req.clientPhone, text: /20450000000000/ },
    { args: { event: 'custom', serviceRequestId: 'sr1', text: 'Текст майстра', clientKey: KEY }, id: `ntf-sr1-custom-${KEY}`, to: req.clientPhone, text: /^Текст майстра$/ },
    { args: { event: 'chat-invite', serviceRequestId: 'sr1', text: 'Запрошення', clientKey: KEY, phone: PHONE }, id: `ntf-sr1-chat-invite-${KEY}`, to: PHONE, text: /^Запрошення$/ },
    { args: { event: 'chat-invite', text: 'Запрошення', clientKey: KEY, phone: PHONE }, id: `ntf-na-chat-invite-${KEY}`, to: PHONE, text: /^Запрошення$/ },
  ]
  for (const c of cases) {
    const { db, sms, notifyClient } = stand({ seed })
    const rec = await notifyClient(c.args)
    assert.equal(rec.id, c.id)
    assert.equal(rec.status, 'sent')
    assert.equal(sms[0].to, c.to)
    assert.match(sms[0].text, c.text)
    const doc = db.get(`notifications/${c.id}`)
    assert.equal(doc.phone, c.to, c.id)
    assert.equal(doc.text, sms[0].text, c.id)
    assert.equal((await notifyClient(c.args)).skipped, true, c.id)
    assert.equal(sms.length, 1, c.id)
  }
})

test('прежние события: custom и chat-invite без верного ключа, как раньше, шлются отдельным документом', async () => {
  const cases = [
    { event: 'custom', text: 'Текст', phone: PHONE },
    { event: 'custom', text: 'Текст', phone: PHONE, clientKey: KEY },
    { event: 'custom', text: 'Текст', serviceRequestId: 'sr1', phone: PHONE, clientKey: 'short' },
    { event: 'chat-invite', text: 'Текст', phone: PHONE },
  ]
  for (const args of cases) {
    const { db, sms, notifyClient } = stand()
    const a = await notifyClient(args)
    const b = await notifyClient(args)
    assert.notEqual(a.id, b.id)
    assert.equal(sms.length, 2)
    assert.equal(journalDocs(db).length, 2)
    assert.equal(db.get(`notifications/${a.id}`).phone, PHONE)
    assert.equal(db.get(`notifications/${a.id}`).text, 'Текст')
  }
})

test('прежние события: journal chat-invite подменяет текст и сессию, телефон остаётся', async () => {
  const { db, sms, notifyClient } = stand()
  const rec = await notifyClient({ event: 'chat-invite', text: 'Посилання https://x/c/SECRET', phone: PHONE, clientKey: KEY, journal: { text: 'Посилання https://x/c/…', sessionId: null } })
  const doc = db.get(`notifications/${rec.id}`)
  assert.equal(sms[0].text, 'Посилання https://x/c/SECRET')
  assert.equal(doc.text, 'Посилання https://x/c/…')
  assert.equal(doc.phone, PHONE)
})
