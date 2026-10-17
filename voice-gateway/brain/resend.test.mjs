// Попередній адаптер посилань: тільки loopback HTTP; токен і дані клієнта не потрапляють у сторонні поля.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeResendLink, resendPayload } from './resend.mjs'
import { toolsFor, buildInstructions } from './aiprompt.mjs'
import { toolConfig } from './ai-setup-elevenlabs.mjs'

const secret = 'fake-resend-token'
const input = { serviceRequestId: 'sr-fictional', gcid: 'gcid-fictional' }
async function serve(t, handle) {
  const server = http.createServer(handle)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)) })
  return `http://127.0.0.1:${server.address().port}/test-resend`
}

test('resend: типово вимкнено, без секрету/заявки запиту немає; інструмент з’являється тільки за прапорцем', async () => {
  let n = 0
  const fetchImpl = async () => { n++; throw new Error('must not request') }
  assert.deepEqual(await makeResendLink({ fetchImpl })(input), { ok: false, error: 'disabled' })
  assert.deepEqual(await makeResendLink({ url: 'http://127.0.0.1:1', fetchImpl })(input), { ok: false, error: 'disabled' })
  assert.deepEqual(await makeResendLink({ url: 'http://127.0.0.1:1', getToken: async () => secret, fetchImpl })({}), { ok: false, error: 'no_request' })
  assert.equal(n, 0)
  assert.equal(toolsFor().some((t) => t.name === 'resend_request_link'), false)
  const enabled = toolsFor({ resend: true })
  assert.equal(enabled.filter((t) => t.name === 'resend_request_link').length, 1)
  const converted = toolConfig(enabled.find((t) => t.name === 'resend_request_link')).tool_config
  assert.deepEqual(converted.parameters.properties, {}, 'модель не обирає чужий номер чи заявку')
  assert.equal(converted.expects_response, true)
  assert.equal(converted.execution_mode, 'immediate')
  assert.equal(toolsFor({ resend: true, transfer: false }).some((t) => t.name === 'transfer_to_manager'), false)
  assert.match(buildInstructions({ resendAllowed: true }), /resend_request_link/)
  assert.doesNotMatch(buildInstructions({ resendAllowed: false }), /resend_request_link/)
})

test('resend: POST {serviceRequestId,gcid}, Bearer, тільки прийнятий запит без обіцянки доставки', async (t) => {
  let received
  const url = await serve(t, (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { received = { method: req.method, auth: req.headers.authorization, body: JSON.parse(body) }; res.statusCode = 202; res.end('{"delivered":true}') })
  })
  const extra = { ...input, phone: '+380500000001', clientName: 'Fictional', transcript: 'private' }
  assert.deepEqual(resendPayload(extra), input)
  assert.deepEqual(resendPayload({ serviceRequestId: input.serviceRequestId }), { serviceRequestId: input.serviceRequestId, gcid: null })
  assert.deepEqual(await makeResendLink({ url, getToken: async () => secret })(extra), { ok: true, accepted: true })
  assert.deepEqual(received, { method: 'POST', auth: `Bearer ${secret}`, body: input })
})

test('resend: HTTP-помилка і redirect не дають успіху та не розкривають тіло відповіді', async (t) => {
  let status = 503
  const url = await serve(t, (_req, res) => { res.statusCode = status; if (status === 302) res.setHeader('location', '/redirected'); res.end(secret) })
  const logs = []
  const send = makeResendLink({ url, getToken: async () => secret, log: (m) => logs.push(m) })
  assert.deepEqual(await send(input), { ok: false, error: 'unavailable' })
  status = 302
  assert.deepEqual(await send(input), { ok: false, error: 'unavailable' })
  assert.equal(logs.length, 2)
  assert.equal(logs.join(' ').includes(secret), false)
})

test('resend: HTTP і отримання токена обмежені бюджетом; пізній токен не запускає POST', async (t) => {
  const url = await serve(t, () => {})
  assert.deepEqual(await makeResendLink({ url, getToken: async () => secret, timeoutMs: 5 })(input), { ok: false, error: 'unavailable' })
  let resolveToken
  let posts = 0
  const send = makeResendLink({ url, getToken: () => new Promise((r) => { resolveToken = r }), timeoutMs: 5, fetchImpl: async () => { posts++; return { ok: true } } })
  assert.deepEqual(await send(input), { ok: false, error: 'unavailable' })
  resolveToken(secret)
  await new Promise((r) => setImmediate(r))
  assert.equal(posts, 0)
})

test('resend: порожній токен або помилка секрету — без запиту й без секрету в журналі', async () => {
  let posts = 0
  const logs = []
  for (const getToken of [async () => '', async () => { throw new Error(secret) }]) {
    const send = makeResendLink({ url: 'http://127.0.0.1:1', getToken, fetchImpl: async () => { posts++; return { ok: true } }, log: (m) => logs.push(m) })
    assert.deepEqual(await send(input), { ok: false, error: 'unavailable' })
  }
  assert.equal(posts, 0)
  assert.equal(logs.join(' ').includes(secret), false)
})
