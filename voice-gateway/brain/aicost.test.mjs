// Ціна ElevenLabs: підроблений HTTP, ін’єкції часу/секрету, жодних справжніх запитів.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseConversationCost, fetchConversationCost, costLine } from './aicost.mjs'

const secret = 'fake-el-key'
const priced = { status: 'done', metadata: { cost: 1300, call_duration_secs: 120, charging: { call_charge: 1000, llm_charge: 300, llm_price: 0.06 } } }
async function serve(t, handle) {
  const server = http.createServer(handle)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('cost: кредити/голос/LLM USD розділені; нуль допустимий, відсутня ціна не перетворюється на 0', () => {
  assert.deepEqual(parseConversationCost(priced), { status: 'done', costCredits: 1300, durationSec: 120, callCharge: 1000, llmCharge: 300, llmPriceUsd: 0.06 })
  assert.equal(parseConversationCost({ status: 'done', metadata: {} }), null)
  assert.equal(parseConversationCost({ metadata: { cost: false } }), null)
  assert.equal(parseConversationCost({ metadata: { cost: -1 } }), null)
  assert.equal(parseConversationCost({ metadata: { cost: 0 } }).costCredits, 0)
  assert.equal(parseConversationCost({ metadata: { charging: { cost: '5' } } }).costCredits, 5)
  assert.equal(parseConversationCost({ metadata: { charging: { llm_price: 0.02 } } }).llmPriceUsd, 0.02)
  assert.equal(costLine(parseConversationCost(priced)), '1300 кредитов (голос 1000, LLM 300 кр. / $0.0600)')
})

test('cost: GET із ключем після завершення, тимчасові 404/processing/порожня metadata повторюємо до фактичної ціни', async (t) => {
  const seen = []
  const replies = [{ code: 404 }, { json: { status: 'processing', metadata: { cost: 5 } } }, { json: { status: 'done', metadata: {} } }, { json: priced }]
  const apiBase = await serve(t, (req, res) => {
    seen.push({ method: req.method, url: req.url, key: req.headers['xi-api-key'] })
    const r = replies.shift()
    res.statusCode = r.code || 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(r.json || {}))
  })
  const waits = []
  const c = await fetchConversationCost({ conversationId: 'conv-fictional', apiBase: `${apiBase}/`, getApiKey: async () => secret, sleep: async (ms) => waits.push(ms) })
  assert.equal(c.costCredits, 1300)
  assert.equal(c.attempts, 4)
  assert.deepEqual(waits, [10000, 10000, 10000])
  assert.equal(seen.length, 4)
  for (const r of seen) assert.deepEqual(r, { method: 'GET', url: '/v1/convai/conversations/conv-fictional', key: secret })
})

test('cost: 401/403 не повторюємо; інші помилки лише в лог, ключ не витікає', async () => {
  for (const status of [401, 403]) {
    let n = 0
    const logs = []
    const c = await fetchConversationCost({ conversationId: 'conv-fictional', getApiKey: async () => secret, fetchImpl: async () => { n++; return { ok: false, status } }, log: (m) => logs.push(m), sleep: async () => {} })
    assert.equal(c, null)
    assert.equal(n, 1)
    assert.match(logs[0], new RegExp(`HTTP ${status}`))
  }
  const logs = []
  assert.equal(await fetchConversationCost({ conversationId: 'conv-fictional', getApiKey: async () => { throw new Error(secret) }, attempts: 2, sleep: async () => {}, log: (m) => logs.push(m) }), null)
  assert.equal(logs.length, 2)
  assert.equal(logs.join(' ').includes(secret), false)
})

test('cost: загальний бюджет ~60 с включає повтори; незавершена ціна явно попередня', async () => {
  let now = 0
  let n = 0
  const result = await fetchConversationCost({ conversationId: 'conv-fictional', getApiKey: async () => secret, now: () => now, attempts: 20, intervalMs: 10000, maxElapsedMs: 60000,
    sleep: async (ms) => { now += ms }, fetchImpl: async () => { n++; now += 2000; return { ok: true, json: async () => ({ ...priced, status: 'processing' }) } } })
  assert.equal(now, 60000)
  assert.equal(n, 5)
  assert.equal(result.final, false)
  assert.equal(result.attempts, 5)
  assert.match(costLine(result), /ещё считает/)
})

test('cost: HTTP і секрет мають таймаут; пізній секрет не починає GET', async (t) => {
  const apiBase = await serve(t, () => {})
  const logs = []
  assert.equal(await fetchConversationCost({ conversationId: 'conv-fictional', apiBase, getApiKey: async () => secret, attempts: 1, timeoutMs: 5, log: (m) => logs.push(m) }), null)
  assert.match(logs[0], /таймаут/)
  let resolveKey
  let calls = 0
  assert.equal(await fetchConversationCost({ conversationId: 'conv-fictional', getApiKey: () => new Promise((r) => { resolveKey = r }), fetchImpl: async () => { calls++; return { ok: true, json: async () => priced } }, attempts: 1, timeoutMs: 5 }), null)
  resolveKey(secret)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 0)
})

test('cost: небезпечний id, відсутній id/ключ — без запиту', async () => {
  let n = 0
  for (const conversationId of ['', '../other', 'conv?token=private']) assert.equal(await fetchConversationCost({ conversationId, getApiKey: async () => secret, fetchImpl: async () => { n++ } }), null)
  assert.equal(await fetchConversationCost({ conversationId: 'conv-fictional' }), null)
  assert.equal(n, 0)
})
