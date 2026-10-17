// node --test: повторне посилання на сторінку заявки (requestLink.js) разом зі справжнім notifyClient
// (notifications.js) — без Firebase і мережі: Firestore у пам'яті, SMS і месенджери підмінені.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { clientPageGuid, clientPageLink, registerRequestLink } from './requestLink.js'
import { registerNotifications } from './notifications.js'

const GUID = '3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6'
const TOKEN = 'test-gateway-token-0123456789'

// ---------- Firestore у пам'яті (get/set/update + транзакції) ----------
const makeDb = (seed) => {
  const data = JSON.parse(JSON.stringify(seed))
  let auto = 0
  const docRef = (name, id) => ({
    id,
    get: async () => ({ exists: !!data[name]?.[id], data: () => data[name][id], id }),
    set: async (v, opts) => {
      data[name] = data[name] || {}
      data[name][id] = opts?.merge ? { ...(data[name][id] || {}), ...v } : { ...v }
    },
  })
  const adminDb = {
    collection: (name) => ({ doc: (id) => docRef(name, id ?? `auto-${++auto}`) }),
    runTransaction: async (fn) => {
      const tx = { get: (ref) => ref.get(), set: (ref, v, opts) => { ref.set(v, opts) } }
      return fn(tx)
    },
  }
  return { adminDb, data }
}

const seed = () => ({
  serviceRequests: {
    'sr-ext-a': { id: 'sr-ext-a', serviceCenterId: 'c1', clientPhone: '+380671234567', onec: { guid: GUID, number: '000000577' } },
    'sr-chat': { id: 'sr-chat', serviceCenterId: 'c1', clientPhone: '+380501112233', externalRequestId: GUID.toUpperCase(), tgSessionId: 'tg-1' },
    'sr-local': { id: 'sr-local', serviceCenterId: 'c1', clientPhone: '+380931112233', externalRequestId: '000577' },
    'sr-nobody': { id: 'sr-nobody', serviceCenterId: 'c1', onec: { guid: GUID } },
    'sr-c2': { id: 'sr-c2', serviceCenterId: 'c2', clientPhone: '+380661112233', onec: { guid: GUID } },
  },
  chatSessions: {
    'tg-1': { id: 'tg-1', channel: 'telegram', messages: [{ role: 'client', at: '2026-10-01T10:00:00.000Z', text: 'привіт' }] },
  },
})

const startApp = async (opts = {}) => {
  const app = express()
  app.use(express.json())
  const db = makeDb(opts.seed || seed())
  const sms = []
  const tg = []
  const sendSms = opts.sendSms || (async (phone, text) => { sms.push({ phone, text }); return { ok: true } })
  const senders = { telegram: async (session, text) => { tg.push({ session: session.id, text }); return { ok: true } } }
  const { notifyClient } = registerNotifications(app, { adminDb: db.adminDb, senders, sendSms, siteUrl: 'https://my.runferry.com' })
  let clock = opts.now ?? Date.parse('2026-10-18T10:00:00.000Z')
  const staff = opts.staff === undefined ? { uid: `own-${Math.random()}`, email: 'owner@x', role: 'owner', centers: [] } : opts.staff
  registerRequestLink(app, {
    adminDb: db.adminDb,
    notifyClient,
    siteUrl: 'https://my.runferry.com',
    gatewayToken: opts.gatewayToken === undefined ? TOKEN : opts.gatewayToken,
    perDay: opts.perDay ?? 3,
    verifyStaff: async (_req, roles) => (staff && roles.includes(staff.role) ? staff : null),
    now: () => clock,
  })
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, json: await r.json(), retryAfter: r.headers.get('retry-after') }))
  const gw = (body, token = TOKEN) => post('/api/voice-gateway/resend-link', body, token ? { authorization: `Bearer ${token}` } : {})
  const staffPost = (id, body) => post(`/api/service-requests/${id}/resend-link`, body)
  return { gw, staffPost, db, sms, tg, advance: (ms) => { clock += ms }, close: () => new Promise((r) => server.close(r)) }
}

// ---------- чисті функції ----------
test('clientPageGuid: onec.guid → externalRequestId GUID (any case) → null for numbers', () => {
  assert.equal(clientPageGuid({ onec: { guid: GUID } }), GUID)
  assert.equal(clientPageGuid({ externalRequestId: GUID.toUpperCase() }), GUID)
  assert.equal(clientPageGuid({ externalRequestId: '000577' }), null)
  assert.equal(clientPageGuid({}), null)
  assert.equal(clientPageGuid(null), null)
  assert.equal(clientPageLink({ onec: { guid: GUID } }, 'https://my.runferry.com/'), `https://my.runferry.com/serviceshare/${GUID}`)
  assert.equal(clientPageLink({ externalRequestId: '000577' }), null)
})

// ---------- шлюз ----------
test('gateway: sends the /serviceshare link by SMS, journals it, no phone in the answer', async (t) => {
  const a = await startApp()
  t.after(a.close)
  const r = await a.gw({ serviceRequestId: 'sr-ext-a', gcid: '4471234567' })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.status, 'sent')
  assert.equal(r.json.data.channel, 'sms')
  assert.equal(r.json.data.repeated, false)
  assert.equal(r.json.data.remainingToday, 2)
  assert.ok(!JSON.stringify(r.json).includes('380671234567'), 'phone must not leak')
  assert.equal(a.sms.length, 1)
  assert.equal(a.sms[0].phone, '+380671234567')
  assert.equal(a.sms[0].text, `Сторінка вашої заявки RunFerry: https://my.runferry.com/serviceshare/${GUID}`)
  const rec = a.db.data.notifications['ntf-sr-ext-a-link-vgcall-4471234567']
  assert.equal(rec.event, 'link')
  assert.equal(rec.status, 'sent')
  assert.equal(rec.by, 'voice-gateway')
  assert.deepEqual(rec.meta, { source: 'voice-gateway', gcid: '4471234567' })
})

test('gateway: same gcid twice → one SMS, second answer repeated, quota not spent', async (t) => {
  const a = await startApp()
  t.after(a.close)
  await a.gw({ serviceRequestId: 'sr-ext-a', gcid: '777' })
  const r = await a.gw({ serviceRequestId: 'sr-ext-a', gcid: '777' })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.repeated, true)
  assert.equal(a.sms.length, 1)
  assert.equal(a.db.data.notifyQuota['link-sr-ext-a'].hits.length, 1)
})

test('gateway: Telegram binding wins over SMS (free channel), externalRequestId GUID works', async (t) => {
  const a = await startApp()
  t.after(a.close)
  const r = await a.gw({ serviceRequestId: 'sr-chat' })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.channel, 'telegram')
  assert.equal(a.tg.length, 1)
  assert.equal(a.sms.length, 0)
  assert.match(a.tg[0].text, new RegExp(`/serviceshare/${GUID}$`))
})

test('gateway: daily limit per request → 429 LIMIT with Retry-After; next day allowed again', async (t) => {
  const a = await startApp({ perDay: 2 })
  t.after(a.close)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'c1' })).status, 200)
  a.advance(3600 * 1000)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'c2' })).status, 200)
  const r = await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'c3' })
  assert.equal(r.status, 429)
  assert.equal(r.json.error.code, 'LIMIT')
  assert.equal(Number(r.retryAfter), 23 * 3600, 'until the oldest slot expires')
  assert.equal(a.sms.length, 2)
  a.advance(23 * 3600 * 1000 + 1000)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'c4' })).status, 200)
})

test('gateway: failed delivery → 502 SEND_FAILED, slot returned, journal says failed', async (t) => {
  const a = await startApp({ sendSms: async () => ({ ok: false, error: 'balance' }) })
  t.after(a.close)
  const r = await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'f1' })
  assert.equal(r.status, 502)
  assert.equal(r.json.error.code, 'SEND_FAILED')
  assert.equal(a.db.data.notifyQuota['link-sr-ext-a'].hits.length, 0)
  assert.equal(a.db.data.notifications['ntf-sr-ext-a-link-vgcall-f1'].status, 'failed')
})

test('gateway: errors — no page, no recipient, unknown request, bad input', async (t) => {
  const a = await startApp()
  t.after(a.close)
  assert.equal((await a.gw({ serviceRequestId: 'sr-local' })).json.error.code, 'NO_CLIENT_PAGE')
  assert.equal((await a.gw({ serviceRequestId: 'sr-nobody' })).json.error.code, 'NO_RECIPIENT')
  const missing = await a.gw({ serviceRequestId: 'sr-missing' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'NO_SR')
  assert.equal((await a.gw({})).status, 400)
  assert.equal((await a.gw({ serviceRequestId: '../x' })).status, 400)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'a b' })).json.error.code, 'BAD_GCID')
  assert.equal(a.sms.length, 0)
  assert.equal(a.db.data.notifyQuota, undefined, 'no quota spent on errors')
})

test('gateway: token — wrong → 403, missing → 403, not configured → 503', async (t) => {
  const a = await startApp()
  t.after(a.close)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a' }, 'wrong')).status, 403)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a' }, null)).status, 403)
  const b = await startApp({ gatewayToken: '' })
  t.after(b.close)
  const r = await b.gw({ serviceRequestId: 'sr-ext-a' })
  assert.equal(r.status, 503)
  assert.equal(r.json.error.code, 'NOT_CONFIGURED')
  assert.equal(a.sms.length + b.sms.length, 0)
})

// ---------- співробітник ----------
test('staff: director of own center sends; other center → 403; accountant → 403', async (t) => {
  const dir = await startApp({ staff: { uid: `d-${Math.random()}`, email: 'd@x', role: 'director', centers: [{ centerId: 'c1' }] } })
  t.after(dir.close)
  const ok = await dir.staffPost('sr-ext-a', { clientKey: 'tap-12345678' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.data.status, 'sent')
  assert.equal(dir.db.data.notifications['ntf-sr-ext-a-link-tap-12345678'].by, 'd@x')
  const other = await dir.staffPost('sr-c2', {})
  assert.equal(other.status, 403)
  assert.equal(other.json.error.code, 'OTHER_CENTER')
  const acc = await startApp({ staff: { uid: 'acc', email: 'a@x', role: 'accountant', centers: [{ centerId: 'c1' }] } })
  t.after(acc.close)
  assert.equal((await acc.staffPost('sr-ext-a', {})).status, 403)
  assert.equal(dir.sms.length, 1)
  assert.equal(acc.sms.length, 0)
})

test('staff and gateway share the per-request daily limit', async (t) => {
  const a = await startApp({ perDay: 2 })
  t.after(a.close)
  assert.equal((await a.gw({ serviceRequestId: 'sr-ext-a', gcid: 'x1' })).status, 200)
  assert.equal((await a.staffPost('sr-ext-a', {})).status, 200)
  assert.equal((await a.staffPost('sr-ext-a', {})).status, 429)
})

test('notifyClient link: no page → NO_CLIENT_PAGE (not an empty message); without key — new journal record', async () => {
  const app = express()
  const { adminDb } = makeDb(seed())
  const { notifyClient } = registerNotifications(app, { adminDb, senders: {}, sendSms: async () => ({ ok: true }) })
  await assert.rejects(() => notifyClient({ serviceRequestId: 'sr-local', event: 'link' }), (e) => e.code === 'NO_CLIENT_PAGE')
  const rec = await notifyClient({ serviceRequestId: 'sr-ext-a', event: 'link' })
  assert.equal(rec.status, 'sent')
  assert.match(rec.id, /^auto-/)
})
