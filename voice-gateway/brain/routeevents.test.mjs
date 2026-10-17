// Контракт route-event: тільки підроблений HTTP на 127.0.0.1, без телефонів і секретів у логах.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeRouteEvents, ROUTE_EVENTS } from './routeevents.mjs'

const event = { serviceRequestId: 'sr-fictional', generalCallID: 'gcid-fictional', ownerUid: 'fictional-owner', at: '2026-10-16T12:00:00Z' }
const secret = 'fake-route-token'
async function serve(t, handle) {
  const server = http.createServer(handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}/api/discussions/route-event`
}

test('route-event: усі сім подій POST за контрактом, один токен, зайві дані не потрапляють у запит', async (t) => {
  const seen = []
  const url = await serve(t, (req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { seen.push({ method: req.method, auth: req.headers.authorization, body: JSON.parse(body) }); res.end('{}') })
  })
  let tokens = 0
  const client = makeRouteEvents({ url, getToken: async () => { tokens++; return secret } })
  assert.equal(client.enabled, true)
  for (const kind of ROUTE_EVENTS) assert.equal(await client.send({ ...event, event: kind, phone: '+380500000001', clientPhone: '+380500000002', transcript: 'private', extra: { number: '+380500000003' } }), true)
  assert.equal(tokens, 1)
  assert.equal(seen.length, 7)
  for (let i = 0; i < seen.length; i++) assert.deepEqual(seen[i], { method: 'POST', auth: `Bearer ${secret}`, body: { ...event, event: ROUTE_EVENTS[i] } })
  assert.equal(JSON.stringify(seen).includes('+380'), false)
})

test('route-event: типово вимкнено, без токена/заявки/невідомої події POST немає', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('must not post') }
  for (const options of [{}, { url: 'http://127.0.0.1:1' }]) {
    const c = makeRouteEvents({ ...options, fetchImpl })
    assert.equal(c.enabled, false)
    assert.equal(c.send({ ...event, event: 'route' }), null)
  }
  const c = makeRouteEvents({ url: 'http://127.0.0.1:1', getToken: async () => '', fetchImpl })
  assert.equal(c.send({ event: 'route' }), null)
  assert.equal(c.send({ ...event, event: 'other' }), null)
  assert.equal(await c.send({ ...event, event: 'route' }), false)
  assert.equal(calls, 0)
})

test('route-event: HTTP-помилки і таймаут лише в лог; текст відповіді не витікає', async (t) => {
  let hang = false
  const url = await serve(t, (_req, res) => { if (!hang) { res.statusCode = 503; res.end(secret) } })
  const logs = []
  const c = makeRouteEvents({ url, getToken: async () => secret, timeoutMs: 1000, log: (m) => logs.push(m) })
  assert.equal(await c.send({ ...event, event: 'fallback' }), false)
  hang = true
  const timed = makeRouteEvents({ url, getToken: async () => secret, timeoutMs: 20, log: (m) => logs.push(m) })
  assert.equal(await timed.send({ ...event, event: 'route' }), false)
  assert.match(logs[0], /HTTP 503/)
  assert.match(logs[1], /таймаут/)
  assert.equal(logs.join(' ').includes(secret), false)
})

test('route-event: бюджет включає завислий секрет; пізній секрет не запускає POST, наступна подія відновлюється', async () => {
  let resolveToken
  let tokenCalls = 0
  let posts = 0
  const c = makeRouteEvents({ url: 'http://127.0.0.1:1', timeoutMs: 5, getToken: () => ++tokenCalls === 1 ? new Promise((r) => { resolveToken = r }) : secret, fetchImpl: async () => { posts++; return { ok: true } } })
  assert.equal(await c.send({ ...event, event: 'route' }), false)
  resolveToken(secret)
  await new Promise((r) => setImmediate(r))
  assert.equal(posts, 0)
  assert.equal(await c.send({ ...event, event: 'answered' }), true)
  assert.equal(posts, 1)
})
