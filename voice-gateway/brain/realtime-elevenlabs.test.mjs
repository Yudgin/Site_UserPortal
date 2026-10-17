// Адаптер ElevenLabs Agents (realtime-elevenlabs.mjs) проти підробленого сервера (fake-ai-server.mjs) по справжньому
// WebSocket на 127.0.0.1: підписана адреса з ключем, переозначення (інструкції, перша фраза, мова, голос, тривалість),
// звук 8 кГц, кінець репліки клієнта → інструмент з відповіддю, перебивання і запізнілий звук, ping/pong, помилки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeElevenLabs } from './fake-ai-server.mjs'
import { makeElevenLabsProvider } from './realtime-elevenlabs.mjs'
import { tone } from './pcm.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 3000, label = '') => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await sleep(10)
  }
  throw new Error(`тайм-аут: ${label}`)
}

// Голос клієнта в реальному часі: шматки по 20 мс
async function speak(s, sec, loud = true) {
  const n = Math.round(sec / 0.02)
  for (let i = 0; i < n; i++) {
    s.sendAudio(loud ? tone(8000, 0.02, 300, 6000) : Buffer.alloc(320))
    await sleep(20)
  }
}

function collect(s) {
  const ev = { audio: [], transcripts: [], tools: [], errors: [], interrupted: 0, ready: 0, started: 0, done: 0, close: null }
  s.on('ready', () => ev.ready++)
  s.on('audio', (a) => ev.audio.push(a))
  s.on('transcript', (t) => ev.transcripts.push(t))
  s.on('tool_call', (t) => ev.tools.push(t))
  s.on('error', (e) => ev.errors.push(e))
  s.on('interrupted', () => ev.interrupted++)
  s.on('response_started', () => ev.started++)
  s.on('response_done', () => ev.done++)
  s.on('close', (c) => { ev.close = c })
  return ev
}

test('ElevenLabs: підписана адреса з ключем, переозначення в conversation_initiation_client_data, ready, перша фраза 8 кГц', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.5 } })
  await srv.ready
  t.after(() => srv.close())
  const p = makeElevenLabsProvider({ getApiKey: async () => 'test-key', agentId: 'agent_x', apiBase: srv.apiBase, voiceId: 'voice_mila', maxDurationSec: 300, llm: 'claude-sonnet-5-5' })
  assert.equal(p.engineRate, 8000)
  assert.deepEqual(p.inputFormat, { encoding: 'pcm16', rate: 8000 })
  assert.equal(p.model, 'elevenlabs-agents/claude-sonnet-5-5')
  const s = p.connect({ instructions: 'Ти — помічник.', firstMessage: 'Вітаю!' })
  const ev = collect(s)
  await until(() => ev.ready === 1, 3000, 'ready')
  assert.equal(srv.rec.signedUrlKey, 'present')
  const init = srv.rec.inits[0]
  assert.equal(init.type, 'conversation_initiation_client_data')
  assert.deepEqual(init.conversation_config_override, {
    agent: { language: 'uk', prompt: { prompt: 'Ти — помічник.' }, first_message: 'Вітаю!' },
    tts: { voice_id: 'voice_mila' },
    conversation: { max_duration_seconds: 300 },
  })
  await until(() => ev.done >= 1, 3000, 'перша фраза завершена')
  const bytes = ev.audio.reduce((a, x) => a + x.data.length, 0)
  assert.equal(bytes, 8000) // 0,5 с × 8000 × 2 байти
  assert.equal(ev.started, 1)
  assert.deepEqual(ev.transcripts[0], { role: 'assistant', text: 'Вітаю!', itemId: '1' })
  assert.equal(s.conversationId, 'conv_fake_1')
  s.close()
  await until(() => srv.rec.closes.some((c) => c.by === 'client' && c.code === 1000), 2000, 'клієнт закрив 1000')
})

test('ElevenLabs: репліка клієнта → user_transcript → client_tool_call з відповіддю → result рядком JSON → продовження', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.3, steps: [{ tool: { name: 'get_request_status', expect: true }, then: { say: 0.4, text: 'Заявка є.' } }, { say: 0.3, tool: { name: 'end_call' } }] } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x', firstMessage: 'Вітаю!' })
  const ev = collect(s)
  await until(() => ev.ready === 1 && ev.done >= 1, 3000, 'ready і перша фраза')
  await sleep(400) // перша фраза «дозвучала»
  await speak(s, 0.5)
  await speak(s, 0.7, false)
  await until(() => ev.tools.length === 1, 3000, 'tool_call')
  assert.deepEqual(ev.tools[0], { callId: 'tc-1', name: 'get_request_status', args: {}, expectsResponse: true })
  assert.ok(ev.transcripts.some((x) => x.role === 'user' && x.text === 'репліка 1'))
  s.toolResult({ callId: 'tc-1', name: 'get_request_status', output: { ok: true, found: true }, continue: true })
  await until(() => srv.rec.toolResults.length === 1, 2000, 'client_tool_result')
  assert.deepEqual(srv.rec.toolResults[0], { id: 'tc-1', result: { ok: true, found: true }, is_error: false })
  await until(() => ev.transcripts.some((x) => x.text === 'Заявка є.'), 2000, 'продовження після інструмента')
  // наступна репліка — прощання й end_call без очікування відповіді
  await sleep(500)
  await speak(s, 0.5)
  await speak(s, 0.7, false)
  await until(() => ev.tools.length === 2, 3000, 'end_call')
  assert.equal(ev.tools[1].name, 'end_call')
  assert.equal(ev.tools[1].expectsResponse, false)
  s.toolResult({ callId: ev.tools[1].callId, name: 'end_call', output: { ok: true }, continue: false })
  await sleep(200)
  assert.equal(srv.rec.toolResults.length, 1, 'на end_call відповідь не шлемо')
  s.close()
})

test('ElevenLabs: клієнт заговорив поверх фрази → interruption, запізнілий звук перебитої відповіді відкинуто; ping → pong', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 3, lateAudio: true } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ firstMessage: 'Довге привітання' })
  const ev = collect(s)
  await until(() => ev.ready === 1, 3000, 'ready')
  await sleep(300)
  await speak(s, 0.4) // поверх трисекундної фрази
  const before = ev.audio.length
  await until(() => ev.interrupted === 1, 2000, 'interrupted')
  assert.equal(srv.rec.interruptions, 1)
  // сервер одразу за interruption шле хвіст перебитої відповіді (той самий event_id) — адаптер його не віддає
  await sleep(1300)
  assert.ok(srv.rec.pongs >= 1, `pong ${srv.rec.pongs}`)
  assert.equal(ev.audio.length, before)
  s.close()
})

test('ElevenLabs: агент в іншому форматі → фатальна помилка; сервер відмовив → помилка; немає agent_id → помилка', async (t) => {
  {
    const srv = startFakeElevenLabs({ script: { format: 'pcm_16000' } })
    await srv.ready
    t.after(() => srv.close())
    const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({})
    const ev = collect(s)
    await until(() => ev.errors.length >= 1, 3000, 'помилка формату')
    assert.equal(ev.errors[0].fatal, true)
    assert.match(ev.errors[0].message, /pcm_16000/)
    assert.equal(ev.ready, 0)
    s.close()
  }
  {
    const srv = startFakeElevenLabs({ script: { refuse: true } })
    await srv.ready
    t.after(() => srv.close())
    const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({})
    const ev = collect(s)
    await until(() => ev.errors.length >= 1 || ev.close, 3000, 'відмова')
    assert.ok(ev.errors.some((e) => e.fatal) || ev.close)
  }
  {
    const s = makeElevenLabsProvider({ getApiKey: async () => 'k' }).connect({})
    const ev = collect(s)
    await until(() => ev.errors.length >= 1, 1000, 'без agent_id')
    assert.match(ev.errors[0].message, /agent_id/)
  }
})

test('ElevenLabs: розрив з боку сервера посеред розмови → close; contextual_update для підказок', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.2, closeAfterMs: 600 } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ firstMessage: 'Так' })
  const ev = collect(s)
  await until(() => ev.ready === 1, 2000, 'ready')
  s.respond({ instructions: 'Час спливає' })
  await until(() => ev.close, 3000, 'close від сервера')
  assert.equal(ev.close.code, 1011)
  assert.equal(srv.rec.contextual, 1)
})
