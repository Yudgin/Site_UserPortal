// ШІ-співрозмовник (agent.mjs) на підробленому провайдері й підробленому рушії через справжній Unix-сокет
// (audiosock.mjs): привітання, звук в обидва боки, перебивання з обрізанням відповіді, інструменти, дія після фрази,
// помилки, тиша, межа часу. Рушій-підробка «грає» чергу в реальному часі (160 семплів на 20 мс), як справжній.
// Голос співрозмовника рушія-підробки — типово тиша (тиша рахується від клієнта, зокрема за VAD на його голосі).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { startAudioServer } from './audiosock.mjs'
import { createAgent } from './agent.mjs'
import { tone } from './pcm.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clock = { now: Date.now, setTimeout, clearTimeout }

function fakeProvider({ selfPrompt = false } = {}) {
  const sessions = []
  return {
    name: 'fake', model: 'fake-1', engineRate: 8000, selfPrompt,
    inputFormat: { encoding: 'pcm16', rate: 8000 },
    outputFormat: { encoding: 'pcm16', rate: 8000 },
    cost: (u, ms) => Math.round((ms / 60000) * 0.08 * 10000) / 10000,
    sessions,
    connect(opts) {
      const s = new EventEmitter()
      Object.assign(s, { opts, sent: [], calls: [], closed: false })
      s.sendAudio = (b) => s.sent.push(b)
      s.respond = (o) => s.calls.push(['respond', o])
      s.toolResult = (r) => s.calls.push(['toolResult', r])
      s.truncate = (t) => s.calls.push(['truncate', t])
      s.greet = () => s.calls.push(['greet'])
      s.close = () => { s.closed = true }
      sessions.push(s)
      return s
    },
  }
}

const frame = (type, data = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5)
  h[0] = type.charCodeAt(0)
  h.writeUInt32LE(data.length, 1)
  return Buffer.concat([h, data])
}
const kFrame = (played, dropped) => {
  const k = Buffer.alloc(8)
  k.writeUInt32LE(played, 0)
  k.writeUInt32LE(dropped, 4)
  return frame('K', k)
}

// Голос співрозмовника — кадр 20 мс: null — тиша, 'loud' — голос (RMS ≈ 2100), 'quiet' — шум нижче порога VAD (≈ 210)
const VOICE = { loud: tone(8000, 0.02, 300, 3000), quiet: tone(8000, 0.02, 300, 300) }
const SILENCE = Buffer.alloc(320)

// Рушій-підробка: під'єднується до сокета мозку з токеном, шле голос (st.voice можна міняти на ходу), грає чергу в
// реальному часі. kDelayMs — відповідь 'K' на скидання із запізненням (саме скидання — одразу, як у справжнього).
function fakeEngine(cmd, { voice = null, kDelayMs = 0 } = {}) {
  const sock = net.connect(cmd.sock)
  const st = { sock, queue: 0, played: 0, marks: [], frames: [], closed: false, timer: null, voice }
  sock.on('connect', () => sock.write(`${JSON.stringify({ token: cmd.token, call: cmd.call, rate: cmd.rate || 8000 })}\n`))
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1)
      if (buf.length < 5 + len) break
      const type = String.fromCharCode(buf[0])
      const data = buf.subarray(5, 5 + len)
      buf = buf.subarray(5 + len)
      st.frames.push(type)
      if (type === 'A') st.queue += len / 2
      else if (type === 'C') {
        const k = kFrame(st.played, st.queue)
        st.queue = 0
        st.marks = []
        if (kDelayMs > 0) setTimeout(() => { if (!st.closed) sock.write(k) }, kDelayMs)
        else sock.write(k)
      } else if (type === 'M') {
        const id = data.readUInt32LE(0)
        if (st.queue === 0) st.sendMark(id)
        else st.marks.push({ pos: st.played + st.queue, id })
      }
    }
  })
  st.sendMark = (id) => {
    const m = Buffer.alloc(8)
    m.writeUInt32LE(id, 0)
    m.writeUInt32LE(st.played, 4)
    sock.write(frame('M', m))
  }
  st.timer = setInterval(() => {
    const n = Math.min(160, st.queue)
    st.queue -= n
    st.played += n
    while (st.marks.length && st.marks[0].pos <= st.played) st.sendMark(st.marks.shift().id)
    if (!st.closed) sock.write(frame('A', VOICE[st.voice] || SILENCE)) // голос співрозмовника
  }, 20)
  sock.on('close', () => { st.closed = true; clearInterval(st.timer) })
  sock.on('error', () => {})
  st.close = () => { clearInterval(st.timer); sock.destroy() }
  return st
}

async function setup(t, { limits = {}, onTool = async () => ({ ok: true }), selfPrompt = false, voice = null, kDelayMs = 0 } = {}) {
  const server = await startAudioServer()
  const provider = fakeProvider({ selfPrompt })
  const events = { ends: [], speaking: 0, logs: [] }
  const agent = createAgent({
    call: 7, server, provider, connectOpts: { instructions: 'x' }, clock, limits,
    onTool, onSpeaking: () => events.speaking++, onEnd: (i) => events.ends.push(i), log: (m) => events.logs.push(m),
  })
  const cmd = agent.start()
  const eng = fakeEngine(cmd, { voice, kDelayMs })
  const p = provider.sessions[0]
  t.after(() => { eng.close(); agent.stop('test_end'); server.close() })
  return { server, provider, agent, cmd, eng, p, events }
}

const until = async (pred, ms = 3000, label = '') => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await sleep(10)
  }
  throw new Error(`тайм-аут: ${label}`)
}

test('ШІ: audio_start з токеном, привітання один раз після ready і рушія, голос рушія → провайдер, звук моделі → рушій', async (t) => {
  const { cmd, eng, p, events, agent } = await setup(t)
  assert.equal(cmd.cmd, 'audio_start')
  assert.equal(cmd.call, 7)
  assert.match(cmd.token, /^[0-9a-f]{24}$/)
  assert.equal(cmd.rate, 8000)
  await sleep(100)
  assert.equal(p.calls.filter((c) => c[0] === 'greet').length, 0, 'без ready привітання немає')
  p.emit('ready')
  await until(() => p.calls.some((c) => c[0] === 'greet'), 1000, 'greet')
  await until(() => p.sent.length >= 5, 1000, 'голос до провайдера')
  assert.ok(p.sent.every((b) => b.length === 320))
  p.emit('audio', { data: tone(8000, 0.3), itemId: 'i1' })
  await until(() => eng.frames.filter((f) => f === 'A').length > 0, 1000, 'звук моделі в рушії')
  assert.equal(events.speaking, 1)
  p.emit('audio', { data: tone(8000, 0.1), itemId: 'i1' })
  await sleep(50)
  assert.equal(events.speaking, 1, 'onSpeaking — лише на перший звук')
  assert.equal(p.calls.filter((c) => c[0] === 'greet').length, 1)
  assert.equal(agent.state, 'live')
})

test('ШІ: звук моделі до під\'єднання рушія (привітання) не губиться', async (t) => {
  const server = await startAudioServer()
  const provider = fakeProvider()
  const agent = createAgent({ call: 3, server, provider, connectOpts: {}, clock, onTool: async () => ({}), onEnd: () => {} })
  const cmd = agent.start()
  const p = provider.sessions[0]
  p.emit('audio', { data: tone(8000, 0.5), itemId: 'g' }) // привітання раніше за рушій
  const eng = fakeEngine(cmd)
  t.after(() => { eng.close(); agent.stop('x'); server.close() })
  await until(() => eng.queue > 0 || eng.played > 0, 1000, 'раннє привітання дійшло до рушія')
  await sleep(50)
  assert.ok(eng.played + eng.queue >= 3900, `семплів ${eng.played + eng.queue}`)
})

test('ШІ: перебивання — скидання черги рушія й обрізання відповіді на тому місці, де клієнт перебив', async (t) => {
  const { eng, p } = await setup(t)
  p.emit('ready')
  await sleep(50)
  p.emit('response_started', {})
  p.emit('audio', { data: tone(8000, 2), itemId: 'long' })
  await sleep(520)
  p.emit('speech_started')
  await until(() => p.calls.some((c) => c[0] === 'truncate'), 1000, 'truncate')
  const tr = p.calls.find((c) => c[0] === 'truncate')[1]
  assert.equal(tr.itemId, 'long')
  assert.ok(tr.audioEndMs >= 400 && tr.audioEndMs <= 700, `обрізано на ${tr.audioEndMs} мс`)
  assert.equal(eng.queue, 0, 'черга рушія скинута')
  // наступна відповідь після скидання грає з правильної позиції; повторне перебивання обрізає вже її
  p.emit('audio', { data: tone(8000, 1), itemId: 'next' })
  await sleep(300)
  p.emit('speech_started')
  await until(() => p.calls.filter((c) => c[0] === 'truncate').length === 2, 1000, 'друге truncate')
  const tr2 = p.calls.filter((c) => c[0] === 'truncate')[1][1]
  assert.equal(tr2.itemId, 'next')
  assert.ok(tr2.audioEndMs >= 200 && tr2.audioEndMs <= 450, `друге обрізання на ${tr2.audioEndMs} мс`)
  // перебивання, коли нічого не грає, — без обрізання
  await sleep(100)
  p.emit('speech_started')
  await sleep(150)
  assert.equal(p.calls.filter((c) => c[0] === 'truncate').length, 2)
})

test('ШІ: перебивання від провайдера (interrupted) — лише скидання, без truncate', async (t) => {
  const { eng, p } = await setup(t)
  p.emit('ready')
  p.emit('audio', { data: tone(8000, 2), itemId: 'a' })
  await sleep(300)
  p.emit('interrupted')
  await until(() => eng.frames.includes('C'), 1000, 'C у рушії')
  await sleep(100)
  assert.equal(eng.queue, 0)
  assert.equal(p.calls.filter((c) => c[0] === 'truncate').length, 0)
})

test('ШІ: інструменти — результат провайдеру з continue; помилка інструмента — ok:false замість падіння', async (t) => {
  const calls = []
  const { p } = await setup(t, {
    onTool: async (name, args) => {
      calls.push([name, args])
      if (name === 'boom') throw new Error('kaput')
      return { ok: true, found: true, openCount: 1 }
    },
  })
  p.emit('ready')
  p.emit('tool_call', { callId: 'c1', name: 'get_request_status', args: {} })
  await until(() => p.calls.some((c) => c[0] === 'toolResult'), 1000, 'toolResult')
  const r = p.calls.find((c) => c[0] === 'toolResult')[1]
  assert.deepEqual(r, { callId: 'c1', name: 'get_request_status', output: { ok: true, found: true, openCount: 1 }, continue: true })
  p.emit('tool_call', { callId: 'c2', name: 'boom', args: { a: 1 } })
  await until(() => p.calls.filter((c) => c[0] === 'toolResult').length === 2, 1000, 'toolResult 2')
  const r2 = p.calls.filter((c) => c[0] === 'toolResult')[1][1]
  assert.equal(r2.output.ok, false)
  assert.equal(r2.continue, true)
  assert.deepEqual(calls, [['get_request_status', {}], ['boom', { a: 1 }]])
})

test('ШІ: end_call — завершення лише тоді, коли прощальну фразу дограно; transfer — так само, з action transfer', async (t) => {
  for (const [name, action] of [['end_call', 'end'], ['transfer_to_manager', 'transfer']]) {
    const { p, events, eng } = await setup(t)
    p.emit('ready')
    await sleep(30)
    p.emit('response_started', {})
    p.emit('audio', { data: tone(8000, 1), itemId: 'bye' })
    const sent = Date.now()
    p.emit('tool_call', { callId: 'e1', name, args: {} })
    await sleep(50)
    p.emit('response_done', {})
    await until(() => events.ends.length === 1, 3000, `onEnd ${name}`)
    const waited = Date.now() - sent
    assert.ok(waited >= 850, `${name}: завершено через ${waited} мс — раніше, ніж дограно фразу`)
    assert.equal(events.ends[0].reason, 'tool')
    assert.equal(events.ends[0].action, action)
    const tr = p.calls.find((c) => c[0] === 'toolResult')[1]
    assert.equal(tr.continue, false)
    assert.ok(p.closed, 'сесію провайдера закрито')
    await until(() => eng.closed, 1000, 'сокет рушія закрито')
  }
})

test('ШІ: клієнт перебив прощальну фразу — дію скасовано (модель відповість знову)', async (t) => {
  const { p, events } = await setup(t)
  p.emit('ready')
  p.emit('response_started', {})
  p.emit('audio', { data: tone(8000, 1.5), itemId: 'bye' })
  p.emit('tool_call', { callId: 'e1', name: 'end_call', args: {} })
  p.emit('response_done', {})
  await sleep(300)
  p.emit('speech_started')
  await sleep(1600)
  assert.equal(events.ends.length, 0, 'дзвінок не завершено')
})

test('ШІ: провайдер закрився / фатальна помилка → onEnd ai_error; рушій закрив сокет → engine_closed', async (t) => {
  {
    const { p, events } = await setup(t)
    p.emit('ready')
    p.emit('close', { code: 1006, reason: 'gone' })
    await until(() => events.ends.length === 1, 1000, 'ai_error')
    assert.equal(events.ends[0].reason, 'ai_error')
  }
  {
    const { p, events, eng } = await setup(t)
    p.emit('ready')
    await sleep(50)
    eng.close()
    await until(() => events.ends.length === 1, 1000, 'engine_closed')
    assert.equal(events.ends[0].reason, 'engine_closed')
    assert.ok(p.closed)
  }
  {
    const { p, events } = await setup(t)
    p.emit('error', Object.assign(new Error('bad'), { fatal: false }))
    await sleep(50)
    assert.equal(events.ends.length, 0, 'нефатальна помилка — розмова триває')
    p.emit('error', Object.assign(new Error('auth'), { fatal: true }))
    await until(() => events.ends.length === 1, 1000, 'фатальна')
    assert.equal(events.ends[0].reason, 'ai_error')
  }
})

test('ШІ: тиша — один раз перепитати, потім завершити; selfPrompt — не перепитувати самим', async (t) => {
  {
    const { p, events } = await setup(t, { limits: { idleSec: 0.3 } })
    p.emit('ready')
    await until(() => events.ends.length === 1, 2000, 'idle')
    assert.equal(events.ends[0].reason, 'idle')
    assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 1)
  }
  {
    const { p, events } = await setup(t, { limits: { idleSec: 0.3 }, selfPrompt: true })
    p.emit('ready')
    await until(() => events.ends.length === 1, 2000, 'idle selfPrompt')
    assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 0)
  }
})

test('ШІ: межа часу — спершу «час спливає» моделі, потім завершення max_duration; result() з розшифровкою за часом', async (t) => {
  const { p, events, agent } = await setup(t, { limits: { maxSec: 0.6, wrapSec: 0.3, idleSec: 10 } })
  p.emit('ready')
  p.emit('speech_started')
  p.emit('transcript', { role: 'user', text: 'Де мій кораблик?' })
  p.emit('audio', { data: tone(8000, 0.1), itemId: 'r1' })
  p.emit('transcript', { role: 'assistant', text: 'Зараз перевірю.', itemId: 'r1' })
  p.emit('usage', { inputAudio: 100, outputAudio: 50 })
  await until(() => events.ends.length === 1, 2000, 'max_duration')
  assert.equal(events.ends[0].reason, 'max_duration')
  assert.ok(p.calls.some((c) => c[0] === 'respond' && /спливає/.test(c[1].instructions)))
  const r = agent.result()
  assert.equal(r.provider, 'fake')
  assert.deepEqual(r.turns.map((x) => [x.speaker, x.text]), [['client', 'Де мій кораблик?'], ['ai', 'Зараз перевірю.']])
  assert.equal(r.usage.inputAudio, 100)
  assert.equal(r.wrapped, true)
  assert.equal(typeof r.costUsd, 'number')
})

const truncs = (p) => p.calls.filter((c) => c[0] === 'truncate').map((c) => c[1])

test('ШІ: дія після фрази — інструмент прийшов раніше за звук фрази: дія лише тоді, коли цей звук дограно', async (t) => {
  const { p, events, eng } = await setup(t)
  p.emit('ready')
  await sleep(30)
  const calledAt = Date.now()
  p.emit('tool_call', { callId: 't1', name: 'transfer_to_manager', args: {} })
  await sleep(300)
  assert.equal(events.ends.length, 0, 'звуку фрази ще не було — дію не виконано')
  p.emit('response_started', {})
  p.emit('audio', { data: tone(8000, 1), itemId: 'conn' })
  const audioAt = Date.now()
  await sleep(50)
  p.emit('response_done', {})
  await until(() => events.ends.length === 1, 4000, 'onEnd transfer')
  const afterAudio = Date.now() - audioAt
  assert.equal(events.ends[0].reason, 'tool')
  assert.equal(events.ends[0].action, 'transfer')
  assert.ok(afterAudio >= 900, `з'єднано через ${afterAudio} мс після звуку фрази — раніше, ніж її дограно`)
  assert.ok(Date.now() - calledAt >= 1200)
  assert.ok(eng.played >= 7800, `дограно семплів ${eng.played} з 8000`)
})

test('ШІ: дія після фрази — друге речення фрази прийшло вже після response_done: мітка переноситься, дія — коли дограно все', async (t) => {
  const { p, events, eng } = await setup(t)
  p.emit('ready')
  await sleep(30)
  p.emit('response_started', {})
  p.emit('audio', { data: tone(8000, 0.5), itemId: 'bye' })
  p.emit('tool_call', { callId: 'e1', name: 'end_call', args: {} })
  await sleep(20)
  p.emit('response_done', {})
  await sleep(200)
  p.emit('audio', { data: tone(8000, 1), itemId: 'bye' }) // друге речення — після response_done і вже поставленої мітки
  const secondAt = Date.now()
  await until(() => events.ends.length === 1, 4000, 'onEnd end')
  assert.equal(events.ends[0].action, 'end')
  assert.ok(Date.now() - secondAt >= 900, `завершено через ${Date.now() - secondAt} мс після другого речення — раніше, ніж його дограно`)
  assert.ok(eng.played >= 11800, `дограно семплів ${eng.played} з 12000`)
})

test('ШІ: дія без жодного звуку фрази — після вікна ACTION_SETTLE_MS, не одразу; кожен шматок звуку — вікно заново', async (t) => {
  {
    const { p, events } = await setup(t)
    p.emit('ready')
    await sleep(30)
    const calledAt = Date.now()
    p.emit('tool_call', { callId: 't1', name: 'end_call', args: {} })
    await until(() => events.ends.length === 1, 3000, 'onEnd end')
    const waited = Date.now() - calledAt
    assert.equal(events.ends[0].action, 'end')
    assert.ok(waited >= 1100 && waited < 2500, `завершено через ${waited} мс`)
  }
  {
    // звук фрази шматками після виклику, без response_started/response_done (провайдер їх не шле)
    const { p, events } = await setup(t)
    p.emit('ready')
    await sleep(30)
    p.emit('tool_call', { callId: 't2', name: 'end_call', args: {} })
    for (let i = 0; i < 3; i++) {
      await sleep(i ? 500 : 20)
      p.emit('audio', { data: tone(8000, 0.3), itemId: 'bye' })
    }
    const lastAt = Date.now()
    await until(() => events.ends.length === 1, 4000, 'onEnd end (шматки)')
    const waited = Date.now() - lastAt
    assert.ok(waited >= 1100, `завершено через ${waited} мс після останнього шматка — вікно не перезапускалось`)
  }
})

test('ШІ: тиша рахується від співрозмовника — перепитування моделі (selfPrompt, звук кожні 0,4 с) дзвінок не тримають', async (t) => {
  const { p, events } = await setup(t, { limits: { idleSec: 1 }, selfPrompt: true })
  p.emit('ready')
  const t0 = Date.now()
  let n = 0
  const iv = setInterval(() => p.emit('audio', { data: tone(8000, 0.2), itemId: `rp${n++}` }), 400)
  t.after(() => clearInterval(iv))
  await until(() => events.ends.length === 1, 4000, 'idle при перепитуваннях моделі')
  clearInterval(iv)
  const waited = Date.now() - t0
  assert.equal(events.ends[0].reason, 'idle')
  assert.ok(waited >= 1900 && waited < 3000, `idle через ${waited} мс (чекали ≈ 2×idleSec)`)
  assert.ok(n >= 4, 'модель перепитувала')
  assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 0, 'selfPrompt — самі не перепитуємо')
})

test('ШІ: голос співрозмовника (VAD на звуку рушія) тримає дзвінок; шум нижче порога — ні; до привітання відліку немає', async (t) => {
  const { p, events, eng } = await setup(t, { limits: { idleSec: 0.5 }, voice: 'loud' })
  await sleep(700)
  assert.equal(events.ends.length, 0, 'до привітання тишу не рахуємо')
  assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 0)
  p.emit('ready')
  await sleep(1600)
  assert.equal(events.ends.length, 0, 'клієнт говорить — дзвінок триває')
  assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 0, 'клієнт говорить — не перепитуємо')
  eng.voice = 'quiet'
  const quietAt = Date.now()
  await until(() => events.ends.length === 1, 3000, 'idle після того, як клієнт замовк')
  const waited = Date.now() - quietAt
  assert.equal(events.ends[0].reason, 'idle')
  assert.ok(waited >= 700 && waited < 2000, `idle через ${waited} мс після тиші`)
  assert.equal(p.calls.filter((c) => c[0] === 'respond').length, 1)
})

test('ШІ: interrupted скидає «відповідь триває» — наступна дія спрацьовує після своєї фрази, а не через ACTION_WAIT_MS', async (t) => {
  const { p, events, eng } = await setup(t)
  p.emit('ready')
  await sleep(30)
  p.emit('response_started', {})
  p.emit('audio', { data: tone(8000, 2), itemId: 'a' })
  await sleep(300)
  p.emit('interrupted') // як адаптер ElevenLabs: response_done на перебивання не приходить
  await until(() => eng.frames.includes('C'), 1000, 'C у рушії')
  await sleep(50)
  p.emit('tool_call', { callId: 't', name: 'transfer_to_manager', args: {} })
  p.emit('audio', { data: tone(8000, 0.5), itemId: 'b' }) // «з'єдную» без response_started / response_done
  const audioAt = Date.now()
  await until(() => events.ends.length === 1, 4000, 'transfer після своєї фрази')
  const waited = Date.now() - audioAt
  assert.equal(events.ends[0].action, 'transfer')
  assert.ok(waited >= 500, `з'єднано через ${waited} мс — раніше, ніж дограно фразу`)
})

test('ШІ: межа часу, коли фраза перед дією ще грає, — виконати дію (transfer / end), а не max_duration', async (t) => {
  for (const [name, action] of [['transfer_to_manager', 'transfer'], ['end_call', 'end']]) {
    const { p, events } = await setup(t, { limits: { maxSec: 0.8, idleSec: 10 } })
    p.emit('ready')
    await sleep(30)
    p.emit('response_started', {})
    p.emit('audio', { data: tone(8000, 3), itemId: 'long' })
    p.emit('tool_call', { callId: 'm', name, args: {} })
    await until(() => events.ends.length === 1, 2000, `onEnd ${name}`)
    assert.equal(events.ends[0].reason, 'tool')
    assert.equal(events.ends[0].action, action)
    assert.ok(events.logs.some((l) => /\(max\)/.test(l)), 'дію виконала межа часу')
  }
})

test('ШІ: result() після кінця — тривалість і вартість застигли', async (t) => {
  const { p, agent, events } = await setup(t)
  p.emit('ready')
  await sleep(80)
  agent.stop('client_hangup')
  const r1 = agent.result()
  await sleep(150)
  const r2 = agent.result()
  assert.equal(r1.durationMs, events.ends[0].at)
  assert.equal(r2.durationMs, r1.durationMs)
  assert.equal(r2.costUsd, r1.costUsd)
})

test('сокет звуку: два скидання до першої K — лічильник надісланого вирівнюється правильно', async (t) => {
  const server = await startAudioServer()
  const token = server.token()
  const pending = server.expect(token)
  const sock = net.connect(server.path)
  sock.on('error', () => {})
  t.after(() => { sock.destroy(); server.close() })
  sock.on('connect', () => sock.write(`${JSON.stringify({ token, call: 1, rate: 8000 })}\n`))
  const conn = await pending
  const got = []
  conn.play(Buffer.alloc(2000)) // 1000 семплів
  conn.clear((played, dropped, delta) => got.push({ played, dropped, delta })) // рушій скине при відтворено 200
  conn.play(Buffer.alloc(1000)) // ще 500
  conn.clear((played, dropped, delta) => got.push({ played, dropped, delta })) // рушій скине при відтворено 300
  assert.equal(conn.sentSamples, 1500)
  sock.write(kFrame(200, 800))
  await until(() => got.length === 1, 1000, 'перша K')
  assert.equal(conn.sentSamples, 700)
  sock.write(kFrame(300, 400))
  await until(() => got.length === 2, 1000, 'друга K')
  assert.equal(conn.sentSamples, 300)
  assert.deepEqual(got.map((x) => x.delta), [-800, -400])
})

test('ШІ: два перебивання до відповіді рушія на перше скидання — обидва обрізання й наступні позиції на своїх місцях', async (t) => {
  const { p } = await setup(t, { kDelayMs: 150 })
  p.emit('ready')
  await sleep(50)
  p.emit('audio', { data: tone(8000, 2), itemId: 'a' })
  await sleep(300)
  p.emit('speech_started') // скидання 1: 'K' прийде через 150 мс
  p.emit('audio', { data: tone(8000, 2), itemId: 'b' }) // нова відповідь ще до цієї 'K'
  await sleep(100)
  p.emit('speech_started') // скидання 2 — перша 'K' ще не прийшла
  await until(() => truncs(p).length === 2, 1500, 'два truncate')
  const [t1, t2] = truncs(p)
  assert.equal(t1.itemId, 'a')
  assert.ok(t1.audioEndMs >= 220 && t1.audioEndMs <= 450, `перше обрізання на ${t1.audioEndMs} мс`)
  assert.equal(t2.itemId, 'b')
  assert.ok(t2.audioEndMs >= 40 && t2.audioEndMs <= 250, `друге обрізання на ${t2.audioEndMs} мс`)
  // після обох 'K' лічильник надісланого збігається з рушієм: третя відповідь обрізається там, де перебили
  await sleep(250)
  p.emit('audio', { data: tone(8000, 2), itemId: 'c' })
  await sleep(200)
  p.emit('speech_started')
  await until(() => truncs(p).length === 3, 1500, 'третє truncate')
  const t3 = truncs(p)[2]
  assert.equal(t3.itemId, 'c')
  assert.ok(t3.audioEndMs >= 120 && t3.audioEndMs <= 350, `третє обрізання на ${t3.audioEndMs} мс`)
})
