// Адаптер ElevenLabs Agents (realtime-elevenlabs.mjs) проти підробленого сервера (fake-ai-server.mjs) по справжньому
// WebSocket на 127.0.0.1: підписана адреса з ключем, переозначення (інструкції, перша фраза, мова, голос, тривалість),
// звук 8 кГц, кінець репліки клієнта → інструмент з відповіддю, перебивання і запізнілий звук, ping/pong, помилки;
// набір інструментів на дзвінок (tool_ids), відмова інструмента без відповіді → contextual_update, черга → відмова,
// виклик інструмента до звуку фрази, проміжне розпізнавання → user_activity.
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
  const ev = { audio: [], transcripts: [], tools: [], errors: [], interrupted: 0, ready: 0, started: 0, done: 0, activity: 0, close: null, order: [] }
  s.on('ready', () => ev.ready++)
  s.on('audio', (a) => { ev.audio.push(a); ev.order.push(`audio:${a.itemId}`) })
  s.on('transcript', (t) => ev.transcripts.push(t))
  s.on('tool_call', (t) => { ev.tools.push(t); ev.order.push(`tool:${t.name}`) })
  s.on('user_activity', () => ev.activity++)
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

test('ElevenLabs: набір інструментів на дзвінок — tool_ids у переозначенні лише коли є і toolIds, і tools; немає id — не звужуємо', async (t) => {
  const srv = startFakeElevenLabs({ script: {} })
  await srv.ready
  t.after(() => srv.close())
  const logs = []
  const toolIds = { get_request_status: 'tool_a', save_question_for_manager: 'tool_b', transfer_to_manager: 'tool_c', end_call: 'tool_d' }
  const p = makeElevenLabsProvider({ wsUrl: srv.wsUrl, toolIds, log: (m) => logs.push(m) })
  const open = async (opts, n) => {
    const s = p.connect(opts)
    collect(s)
    await until(() => srv.rec.inits.length === n, 3000, `init ${n}`)
    s.close()
    return srv.rec.inits[n - 1].conversation_config_override.agent
  }
  // з'єднувати не можна — без transfer_to_manager; порядок і дублікати — як у tools, без повторів
  const a1 = await open({ instructions: 'x', tools: ['get_request_status', 'save_question_for_manager', 'end_call', 'end_call'] }, 1)
  assert.deepEqual(a1.prompt, { prompt: 'x', tool_ids: ['tool_a', 'tool_b', 'tool_d'] })
  // без інструкцій — prompt лише з tool_ids
  const a2 = await open({ tools: ['end_call'] }, 2)
  assert.deepEqual(a2.prompt, { tool_ids: ['tool_d'] })
  // tools не передано — набір агента як є
  const a3 = await open({ instructions: 'x' }, 3)
  assert.deepEqual(a3.prompt, { prompt: 'x' })
  // немає id інструмента (старий ai-elevenlabs.json) — не звужуємо, пишемо в журнал
  const a4 = await open({ instructions: 'x', tools: ['get_request_status', 'new_tool'] }, 4)
  assert.deepEqual(a4.prompt, { prompt: 'x' })
  assert.ok(logs.some((m) => /new_tool/.test(m)), logs.join('\n'))
  // провайдер без toolIds (агент без дозволу переозначати tool_ids) — tools ігноруємо
  const s5 = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x', tools: ['end_call'] })
  collect(s5)
  await until(() => srv.rec.inits.length === 5, 3000, 'init 5')
  s5.close()
  assert.deepEqual(srv.rec.inits[4].conversation_config_override.agent.prompt, { prompt: 'x' })
})

test('ElevenLabs: інструмент без відповіді (expects_response=false) — client_tool_result не шлемо; відмова шлюзу → contextual_update з note', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.2, auto: true, vad: false, steps: [
    { say: 0.2, text: "З'єдную з менеджером.", tool: { name: 'transfer_to_manager' }, afterMs: 50 },
    { say: 0.2, text: 'До побачення.', tool: { name: 'end_call' }, afterMs: 50 },
    { say: 0.1, tool: { name: 'transfer_to_manager' }, afterMs: 50 },
  ] } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x', firstMessage: 'Вітаю!' })
  const ev = collect(s)
  await until(() => ev.tools.length === 1, 3000, 'transfer_to_manager')
  assert.equal(ev.tools[0].expectsResponse, false)
  const note = "З'єднати з менеджером зараз не можна. Запропонуй записати питання — менеджер передзвонить."
  // відмова (неробочий час): agent.mjs відповідає з continue:true — сервер результату не чекає, тож лише contextual_update
  s.toolResult({ callId: ev.tools[0].callId, name: 'transfer_to_manager', output: { ok: false, reason: 'after_hours', note }, continue: true })
  await until(() => srv.rec.contextualTexts.length === 1, 2000, 'contextual_update')
  assert.equal(srv.rec.contextualTexts[0], `Інструмент transfer_to_manager не виконано: ${note}`)
  // виконано — нічого, навіть з continue:true (рішення — за expects_response виклику, а не за continue)
  await until(() => ev.tools.length === 2, 3000, 'end_call')
  s.toolResult({ callId: ev.tools[1].callId, name: 'end_call', output: { ok: true }, continue: true })
  // збій без note — текст say
  await until(() => ev.tools.length === 3, 3000, 'transfer_to_manager 2')
  s.toolResult({ callId: ev.tools[2].callId, name: 'transfer_to_manager', output: { ok: false, error: 'internal_error', say: 'Сталася технічна помилка.' }, continue: true })
  await until(() => srv.rec.contextualTexts.length === 2, 2000, 'contextual_update 2')
  assert.equal(srv.rec.contextualTexts[1], 'Інструмент transfer_to_manager не виконано: Сталася технічна помилка.')
  await sleep(150)
  assert.equal(srv.rec.toolResults.length, 0, 'client_tool_result на виклики без відповіді не шлемо')
  assert.equal(srv.rec.contextualTexts.length, 2)
  s.close()
})

test('ElevenLabs: queue_status waiting (агент на ліміті з чергою) → фатальна помилка, без ready, тон утримання не віддаємо, з\'єднання закрито', async (t) => {
  const srv = startFakeElevenLabs({ script: { queued: true } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x', firstMessage: 'Вітаю!' })
  const ev = collect(s)
  await until(() => ev.errors.length >= 1, 3000, 'помилка черги')
  assert.equal(ev.errors[0].fatal, true)
  assert.match(ev.errors[0].message, /очеред/)
  assert.equal(srv.rec.queued, 1)
  s.sendAudio(tone(8000, 0.02, 300, 6000))
  await sleep(500) // довше за очікування допуску
  assert.equal(ev.ready, 0)
  assert.equal(ev.audio.length, 0, 'тон утримання — не мова агента')
  assert.equal(srv.rec.audioChunks, 0, 'голос клієнта в чергу не шлемо')
  await until(() => srv.rec.closes.some((c) => c.by === 'client' && c.code === 1000), 2000, 'адаптер закрив з\'єднання')
  assert.equal(ev.close, null)
})

test('ElevenLabs: без черги ready — щойно перша подія розмови після metadata; порожня перша фраза — після очікування допуску', async (t) => {
  const srv = startFakeElevenLabs({ script: {} })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x' }) // first_message немає — сервер мовчить
  const ev = collect(s)
  await until(() => srv.rec.inits.length === 1, 3000, 'init')
  const t0 = Date.now()
  await until(() => ev.ready === 1, 2000, 'ready без звуку')
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(ev.errors.length, 0)
  s.close()
})

test('ElevenLabs: client_tool_call до звуку фрази (toolFirst) — tool_call віддаємо в порядку надходження, звук фрази — після', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.2, auto: true, vad: false, steps: [{ toolFirst: true, say: 0.3, text: "З'єдную з менеджером.", tool: { name: 'transfer_to_manager' }, afterMs: 50 }] } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ instructions: 'x', firstMessage: 'Вітаю!' })
  const ev = collect(s)
  await until(() => ev.audio.filter((a) => a.itemId === '2').length === 3, 3000, 'звук фрази кроку')
  const iTool = ev.order.indexOf('tool:transfer_to_manager')
  const iAudio = ev.order.indexOf('audio:2')
  assert.ok(iTool >= 0 && iTool < iAudio, ev.order.join(' '))
  assert.ok(ev.order.slice(0, iTool).every((x) => x === 'audio:1'), 'перед викликом — лише перша фраза')
  s.close()
})

test('ElevenLabs: tentative_user_transcript (довга репліка клієнта) → user_activity', async (t) => {
  const srv = startFakeElevenLabs({ script: { firstSec: 0.1, tentative: true } })
  await srv.ready
  t.after(() => srv.close())
  const s = makeElevenLabsProvider({ wsUrl: srv.wsUrl }).connect({ firstMessage: 'Так' })
  const ev = collect(s)
  await until(() => ev.ready === 1, 2000, 'ready')
  await sleep(250)
  await speak(s, 0.3)
  await until(() => ev.activity >= 1, 2000, 'user_activity')
  assert.equal(srv.rec.userTurns, 0, 'репліка ще не скінчилась — активність уже є')
  s.close()
})
