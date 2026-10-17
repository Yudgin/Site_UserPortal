// Сценарій дзвінка в режимі ШІ (noAnswerMode 'ai') на підробленому рушії, годиннику й підробленій сесії ШІ: менеджер
// не взяв → ШІ замість «лінія зайнята»; неробочий час → ШІ одразу; інструменти (стан заявки за правилами приватності,
// питання в передзвін, з'єднати, завершити); перевід через ШІ на менеджера тим самим шляхом («1», REFER); менеджер не
// взяв — ШІ знову; помилки ШІ — як busy; клієнт поклав; без фабрики ШІ — як busy. Крайові випадки: сокет ШІ закрився
// раніше за DISCONNECTED клієнта (пауза AI_DOWN_GRACE_MS); відмова від передзвону тримається; передзвін знову після
// невдалого з'єднання; пропущений у менеджера до ШІ; кілька з'єднань (aiTransferMax); свій ліміт повторів у раунді на
// запит ШІ; рушій без звуку (ai.available() false) — як busy; менеджер передзвонює, поки клієнт із ШІ.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from './flow.mjs'
import { makeCallbackStore } from './callbacks.mjs'
import { parseHours } from './hours.mjs'
import { buildCard } from './card.mjs'

const MGR = 'sip:907@sip14.binotel.com;transport=udp'
const PROMPTS = { confirm: '/p/confirm.wav', busy: '/p/busy.wav' }
const CONFIG = {
  managerUri: MGR,
  fallbackUri: '',
  fallbackMode: 'consult',
  noAnswerMode: 'ai',
  confirmEnabled: true,
  confirmTimeoutSec: 10,
  confirmRepeats: 1,
  confirmDigit: '1',
  declineDigit: '2',
  dtmfSupported: true,
  prompts: PROMPTS,
  managers: [['907']],
  sipServer: 'sip14.binotel.com',
  clientUriTemplate: 'sip:{national}@{server};transport=udp',
  allowedCallers: ['+380500000001'],
  maxCalls: 2,
  greetingFile: '/p/greeting.wav',
  holdFile: '/p/hold.wav',
  genericCardFile: null,
  dialDelayMs: 1000,
  dialRetryWindowSec: 12,
  dialRetryIntervalMs: 2000,
  dialRetries: null,
  retryCodes: [503, 408, 480],
  managerTimeoutSec: 25,
  mediaGraceMs: 1000,
  ttsWaitMs: 6000,
  afterCardMs: 700,
  cardMaxSec: 20,
  xferTimeoutMs: 8000,
  xferClearMs: 4000,
  bridgeMaxMin: 60,
  lateEventsMs: 60000,
  allowedInternal: [],
  aiTransferMax: 1,
  aiStatusDetail: 'minimal',
  timeZone: 'Europe/Kyiv',
  workHours: parseHours('mon-fri 09:00-18:00'),
  aiAfterHours: true,
}
// 2026-10-16 — п'ятниця; 10:00 UTC = 13:00 Київ (робочий час), 20:00 UTC = 23:00 Київ (неробочий)
const DAY = Date.parse('2026-10-16T10:00:00Z')
const NIGHT = Date.parse('2026-10-16T20:00:00Z')

function fakeClock(start = DAY) {
  let now = start
  let seq = 0
  const timers = new Map()
  const flush = () => new Promise((r) => setImmediate(r))
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    flush,
    async advance(ms) {
      const target = now + ms
      await flush()
      for (;;) {
        let next = null
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

// Підроблена фабрика сесій ШІ: тест сам «говорить» за модель (tool, speak, end)
function fakeAi({ startFails = false } = {}) {
  const sessions = []
  const factory = (opts) => {
    const s = {
      opts,
      ended: false,
      stopped: null,
      endInfo: null,
      start() {
        if (startFails) return null
        return { cmd: 'audio_start', call: opts.call, sock: '/tmp/rf-vg/ai.sock', token: `tok${sessions.length}`, rate: 8000 }
      },
      stop(reason) {
        if (s.ended) return
        s.ended = true
        s.stopped = reason
        s.endInfo = { reason }
        opts.onEnd({ reason })
      },
      result() {
        return { provider: 'fake', model: 'fake-1', durationMs: 4000, end: s.endInfo, turns: [{ speaker: 'ai', start: 0.1, end: 1, text: 'Вітаю!' }, { speaker: 'client', start: 1.5, end: 2.5, text: 'Де мій кораблик?' }], toolCalls: [], usage: {}, costUsd: 0.0053, errors: [] }
      },
      end(info) {
        s.ended = true
        s.endInfo = info
        opts.onEnd(info)
      },
      tool: (name, args = {}) => opts.onTool(name, args),
      speak: () => opts.onSpeaking(),
    }
    sessions.push(s)
    return s
  }
  factory.sessions = sessions
  return factory
}

const SR_OPEN = {
  id: 'sr1', status: 'diagnostics', stage: 'diagnosed', clientName: 'Петренко Іван', clientPhone: '+380500000001', boat: 'Runferry R3', complaint: 'Не крутиться правий гвинт',
  onec: { number: '000123' }, createdAt: '2026-10-10T10:00:00Z',
}

function harness({ config = {}, ai = fakeAi(), start = DAY, lookup, tts } = {}) {
  const cmds = []
  const journal = []
  const logs = []
  const clock = fakeClock(start)
  const store = makeCallbackStore({ now: clock.now })
  const ttsTexts = []
  const d = createDispatcher({
    config: { ...CONFIG, ...config },
    send: (c) => cmds.push(c),
    clock,
    lookup: lookup === undefined ? async () => ({ requests: [SR_OPEN], profile: null, orders: [] }) : lookup,
    buildCard: (res, o) => buildCard(res, { ...o, nowMs: clock.now() }),
    tts: tts === undefined ? async (text) => { ttsTexts.push(text); return { file: `/cache/card-${ttsTexts.length}.wav`, cached: false } } : tts,
    voicemailPath: () => '/data/vm.wav',
    callbacks: store,
    ai,
    log: (m) => logs.push(m),
    onDone: (e) => journal.push(e),
  })
  const ev = async (e) => { d.handle(e); await clock.flush() }
  const sent = (name) => cmds.filter((c) => c.cmd === name)
  return { d, cmds, journal, logs, clock, ev, sent, ai, callbacks: store, ttsTexts }
}

const INCOMING = { ev: 'incoming', call: 1, from: 'sip:0500000001@45.91.130.64', number: '0500000001', name: 'RUN Call Test', gcid: '6929148313', to: 'sip:901@sip14.binotel.com' }

async function answered(h) {
  await h.ev(INCOMING)
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
}

// Клієнт → менеджер не взяв за 25 с → ШІ на лінії (сесія 0)
async function toAi(h) {
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.clock.advance(1000)
  assert.deepEqual(h.sent('dial')[0], { cmd: 'dial', ref: 'mgr-1-1', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(25000)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  assert.equal(h.ai.sessions.length, 1, 'сесія ШІ створена')
  return h.ai.sessions[0]
}

test('ШІ замість «лінія зайнята»: менеджер не взяв → audio_start, утримання до першого звуку, передзвін одразу; стан заявки без особистих даних; питання → у передзвін; end_call → ai_noted', async () => {
  const h = harness()
  const s = await toAi(h)
  assert.equal(s.opts.kind, 'busy')
  assert.equal(s.opts.category, 'openRequest')
  assert.equal(s.opts.transferAllowed, true)
  assert.equal(s.opts.call, 1)
  const as = h.sent('audio_start')
  assert.deepEqual(as, [{ cmd: 'audio_start', call: 1, sock: '/tmp/rf-vg/ai.sock', token: 'tok1', rate: 8000 }])
  assert.equal(h.sent('play').filter((c) => c.tag === 'busy').length, 0, '«лінія зайнята» не звучить')
  assert.equal(h.sent('stop').filter((c) => c.call === 1).length, 0, 'утримання грає, поки ШІ мовчить')
  const pend = h.callbacks.listPending('907')
  assert.equal(pend.length, 1, 'передзвін збережено одразу')
  s.speak()
  assert.deepEqual(h.cmds.at(-1), { cmd: 'stop', call: 1 })
  s.speak()
  assert.equal(h.sent('stop').filter((c) => c.call === 1).length, 1)
  // стан заявки: є відкрита, номер — без імені, моделі, скарги, телефону, етапу
  const st = await s.tool('get_request_status')
  assert.deepEqual(Object.keys(st).sort(), ['found', 'note', 'ok', 'open', 'openCount', 'requestNumber'])
  assert.equal(st.found, true)
  assert.equal(st.open, true)
  assert.equal(st.requestNumber, '123')
  const flat = JSON.stringify(st)
  for (const bad of ['Петренко', 'R3', 'гвинт', '0500000001', '380500000001', 'діагност']) assert.ok(!flat.includes(bad), `у відповіді є «${bad}»`)
  // питання для менеджера → у запис передзвону (без номера в тексті не перевіряємо — це слова клієнта)
  const sq = await s.tool('save_question_for_manager', { question: '  Коли   буде готовий ремонт? ', topic: 'repair', callback: true })
  assert.deepEqual(sq, { ok: true, saved: true, callback: true, note: 'Записано. Менеджер передзвонить.' })
  const p2 = h.callbacks.listPending('907')
  assert.equal(p2.length, 1)
  assert.deepEqual(p2[0].note, { question: 'Коли буде готовий ремонт?', topic: 'repair', urgent: false })
  const ec = await s.tool('end_call')
  assert.deepEqual(ec, { ok: true })
  s.end({ reason: 'tool', action: 'end' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'ai_noted')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.noAnswerMode, 'ai')
  assert.equal(e.callback.stored, true)
  assert.equal(e.ai.kind, 'busy')
  assert.equal(e.ai.transfers, 0)
  assert.deepEqual(e.ai.note, { topic: 'repair', urgent: false, callback: true, chars: 25 })
  assert.equal(e.ai.sessions.length, 1)
  assert.equal(e.ai.sessions[0].provider, 'fake')
  assert.equal(e.ai.sessions[0].turns, 2)
  assert.ok(!JSON.stringify(e.ai).includes('Коли буде'), 'у журнальному полі ai немає тексту питання')
  assert.equal(e.aiTranscript.note.question, 'Коли буде готовий ремонт?')
  assert.equal(e.aiTranscript.turns.length, 2)
  assert.equal(e.aiTranscript.turns[0].start, 26.1) // сесія почалась на 26-й с дзвінка (1 с до набору + 25 с дзвінка)
  assert.ok(e.t.ai != null && e.t.aiStart != null && e.t.aiNote != null)
})

test('стан заявки з VG_AI_STATUS_DETAIL=stage — етап є, особистих даних немає; пошук не вдався — unavailable; номера немає в базі — found:false', async () => {
  {
    const h = harness({ config: { aiStatusDetail: 'stage' } })
    const s = await toAi(h)
    const st = await s.tool('get_request_status')
    assert.equal(st.stage, 'діагностовано')
    assert.ok(!JSON.stringify(st).includes('Петренко'))
  }
  {
    const h = harness({ lookup: async () => null })
    const s = await toAi(h)
    const st = await s.tool('get_request_status')
    assert.equal(st.ok, false)
    assert.equal(st.error, 'unavailable')
  }
  {
    const h = harness({ lookup: async () => ({ requests: [], profile: null, orders: [] }) })
    const s = await toAi(h)
    assert.equal(s.opts.category, 'unknown')
    const st = await s.tool('get_request_status')
    assert.equal(st.found, false)
  }
})

test('неробочий час: менеджеру не дзвонимо, ШІ одразу (after_hours), утримання до першого звуку, з\'єднати не можна', async () => {
  const h = harness({ start: NIGHT })
  await answered(h)
  await h.clock.advance(2000)
  assert.equal(h.sent('dial').length, 0)
  assert.equal(h.sent('play').filter((c) => c.tag === 'greeting').length, 0, 'тестове привітання не грає — вітається ШІ')
  assert.deepEqual(h.sent('play').filter((c) => c.tag === 'hold').length, 1)
  const s = h.ai.sessions[0]
  assert.equal(s.opts.kind, 'after_hours')
  assert.equal(s.opts.transferAllowed, false)
  assert.equal(h.sent('audio_start').length, 1)
  const tr = await s.tool('transfer_to_manager', { reason: 'хоче людину' })
  assert.equal(tr.ok, false)
  assert.equal(tr.reason, 'after_hours')
  const sq = await s.tool('save_question_for_manager', { question: 'Потрібен пульт', topic: 'purchase', callback: true })
  assert.equal(sq.note, 'Записано. Менеджер передзвонить у робочий час.')
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // клієнт поклав, поки ШІ говорив
  assert.equal(s.stopped, 'client_hangup')
  const e = h.journal[0]
  assert.equal(e.outcome, 'ai_noted')
  assert.equal(e.reason, 'after_hours')
  assert.equal(e.ai.kind, 'after_hours')
  assert.equal(e.dials.length, 0)
  // aiAfterHours=0 — уночі як завжди: набір менеджера
  const h2 = harness({ start: NIGHT, config: { aiAfterHours: false } })
  await answered(h2)
  await h2.clock.advance(1000)
  assert.equal(h2.sent('dial').length, 1)
})

test('ШІ передає менеджеру: transfer_to_manager → сесію закрито → набір менеджера з карткою-питанням → «1» → REFER → connected; передзвін знято', async () => {
  const h = harness()
  const s = await toAi(h)
  s.speak()
  await s.tool('save_question_for_manager', { question: 'Гарантія на мотор, він задимів', topic: 'warranty', urgent: true, callback: true })
  const tr = await s.tool('transfer_to_manager', { reason: 'гарантія' })
  assert.deepEqual(tr, { ok: true })
  s.end({ reason: 'tool', action: 'transfer' })
  // утримання знову і набір менеджера (друга спроба в списку наборів)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/hold.wav', loop: true, tag: 'hold' })
  const d2 = h.sent('dial')[1]
  assert.deepEqual(d2, { cmd: 'dial', ref: 'mgr-1-2', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'EARLY', code: 180 })
  await h.ev({ ev: 'state', call: 3, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 3, active: true })
  await h.clock.flush()
  assert.match(h.ttsTexts.at(-1), /Питання клієнта: Гарантія на мотор, він задимів/)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 3, file: `/cache/card-${h.ttsTexts.length}.wav`, loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 3, file: '/p/confirm.wav', loop: false, tag: 'confirm' })
  await h.ev({ ev: 'dtmf', call: 3, digit: '1', method: 'rfc2833' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 3 })
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.ai.transfers, 1)
  assert.equal(e.ai.endReason, 'transfer')
  assert.deepEqual(e.dials.map((x) => [x.attempt, x.ai ?? 0]), [[1, 0], [2, 1]])
  assert.equal(e.pendingRemoved, 1, 'клієнта обслужено — передзвін знято')
  assert.equal(h.callbacks.listPending('907').length, 0)
  assert.deepEqual(e.confirm, { manager: { plays: 1, digit: '1' } })
})

test('менеджер на запит ШІ не взяв → знову ШІ (transfer_failed, з\'єднати вже не можна) → прощання → ai_noted; другий перевід — відмова', async () => {
  const h = harness()
  const s = await toAi(h)
  await s.tool('save_question_for_manager', { question: 'Хочу поговорити з людиною', callback: true })
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 486 }) // зайнято
  assert.equal(h.ai.sessions.length, 2)
  const s2 = h.ai.sessions[1]
  assert.equal(s2.opts.kind, 'transfer_failed')
  assert.equal(s2.opts.transferAllowed, false)
  assert.equal(s2.opts.note.question, 'Хочу поговорити з людиною')
  assert.equal(h.sent('audio_start').length, 2)
  const tr = await s2.tool('transfer_to_manager', {})
  assert.equal(tr.ok, false)
  s2.end({ reason: 'tool', action: 'end' })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'ai_noted')
  assert.equal(e.reason, 'manager_486')
  assert.equal(e.ai.sessions.length, 2)
  assert.deepEqual(e.ai.sessions.map((x) => x.kind), ['busy', 'transfer_failed'])
  assert.equal(h.callbacks.listPending('907').length, 1, 'передзвін лишився')
})

test('ШІ не вдався: помилка провайдера → «лінія зайнята» (busy_callback), передзвін один; сесія не стартувала → те саме; помилка audio_start → те саме', async () => {
  {
    const h = harness()
    const s = await toAi(h)
    s.end({ reason: 'ai_error' })
    // спершу AI_DOWN_GRACE_MS чекаємо DISCONNECTED клієнта (міг просто покласти), нога жива — «лінія зайнята»
    await h.clock.advance(499)
    assert.equal(h.sent('play').at(-1).tag, 'hold')
    await h.clock.advance(1)
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/busy.wav', loop: false, tag: 'busy' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    const e = h.journal[0]
    assert.equal(e.outcome, 'busy_callback')
    assert.equal(e.ai.error, 'ai_error')
    assert.equal(h.callbacks.listPending('907').length, 1)
  }
  {
    const h = harness({ ai: fakeAi({ startFails: true }) })
    await toAi(h)
    assert.equal(h.sent('audio_start').length, 0)
    assert.equal(h.sent('play').at(-1).tag, 'busy')
    await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
    assert.equal(h.journal[0].outcome, 'busy_callback')
    assert.equal(h.journal[0].ai.error, 'ai_start')
  }
  {
    const h = harness()
    const s = await toAi(h)
    await h.ev({ ev: 'error', cmd: 'audio_start', call: 1, ref: null, msg: 'connect: No such file or directory' })
    assert.equal(s.stopped, 'engine_error')
    assert.equal(h.sent('play').at(-1).tag, 'busy')
  }
})

test('клієнт поклав під час розмови з ШІ без питання → ai_client_hangup; callback:false — передзвін знято; ШІ попрощався без питання → ai_answered', async () => {
  {
    const h = harness()
    const s = await toAi(h)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(s.stopped, 'client_hangup')
    assert.equal(h.journal[0].outcome, 'ai_client_hangup')
    assert.equal(h.callbacks.listPending('907').length, 1, 'передзвін є (менеджер пропустив дзвінок)')
  }
  {
    const h = harness()
    const s = await toAi(h)
    const r = await s.tool('save_question_for_manager', { question: 'Дізнався все, дякую', callback: false })
    assert.equal(r.callback, false)
    assert.equal(h.callbacks.listPending('907').length, 0)
    s.end({ reason: 'tool', action: 'end' })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(h.journal[0].outcome, 'ai_noted')
    assert.equal(h.journal[0].callback.removed, true)
  }
  {
    const h = harness()
    const s = await toAi(h)
    s.end({ reason: 'idle' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    assert.equal(h.journal[0].outcome, 'ai_answered')
    assert.equal(h.journal[0].ai.endReason, 'idle')
  }
})

test('режим ai без фабрики ШІ — як busy; привітання ще грає — ШІ чекає його кінця; зупинка шлюзу — сесію закрито, aborted', async () => {
  {
    const h = harness({ ai: null })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    assert.equal(h.sent('play').at(-1).tag, 'busy')
  }
  {
    const h = harness()
    await answered(h) // привітання грає
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    assert.equal(h.ai.sessions.length, 0, 'поки грає привітання — ШІ не стартує')
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    assert.equal(h.ai.sessions.length, 1)
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/hold.wav', loop: true, tag: 'hold' })
    const s = h.ai.sessions[0]
    h.d.abortAll('shutdown')
    assert.equal(s.stopped, 'shutdown')
    assert.equal(h.journal[0].outcome, 'aborted')
    assert.equal(h.journal[0].abortReason, 'shutdown')
  }
})

const BUSY_PLAY = { cmd: 'play', call: 1, file: '/p/busy.wav', loop: false, tag: 'busy' }
const busyPlays = (h) => h.sent('play').filter((c) => c.tag === 'busy').length

test('сокет ШІ закрився раніше за DISCONNECTED клієнта: поклав у межах паузи → ai_client_hangup / ai_noted без «лінія зайнята»; audio closed hangup — команд на A немає; A жива після паузи → busy_callback', async () => {
  {
    // engine_closed, DISCONNECTED за 200 мс (рядок audio closed — перед ним, як шле рушій)
    const h = harness()
    const s = await toAi(h)
    s.end({ reason: 'engine_closed' })
    await h.clock.advance(200)
    await h.ev({ ev: 'audio', call: 1, state: 'closed', reason: 'hangup', played: 0, queued: 0, dropped_frames: 0 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    const e = h.journal[0]
    assert.equal(e.outcome, 'ai_client_hangup')
    assert.equal(e.ai.endReason, 'engine_closed')
    assert.equal(e.ai.error, null, 'це не помилка ШІ — клієнт поклав')
    assert.equal(e.clientCode, 200)
    assert.equal(busyPlays(h), 0)
    assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)
    assert.equal(h.callbacks.listPending('907').length, 1, 'передзвін (менеджер пропустив дзвінок) лишився')
  }
  {
    // ai_error, питання вже записано, DISCONNECTED за 100 мс → ai_noted
    const h = harness()
    const s = await toAi(h)
    await s.tool('save_question_for_manager', { question: 'Коли буде ремонт?', callback: true })
    s.end({ reason: 'ai_error' })
    await h.clock.advance(100)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(h.journal[0].outcome, 'ai_noted')
    assert.equal(busyPlays(h), 0)
  }
  {
    // рушій сказав «звук A закрито через розрив», DISCONNECTED так і не дійшов за паузу — клієнт пішов, команд на A немає
    const h = harness()
    const s = await toAi(h)
    await h.ev({ ev: 'audio', call: 1, state: 'closed', reason: 'hangup' })
    s.end({ reason: 'engine_closed' })
    const n = h.cmds.length
    await h.clock.advance(600)
    assert.equal(h.cmds.length, n, 'на розірвану ногу A команд немає')
    assert.equal(h.journal[0].outcome, 'ai_client_hangup')
  }
  {
    // A жива й після паузи — ШІ справді не вдався: «лінія зайнята», busy_callback
    const h = harness()
    const s = await toAi(h)
    s.end({ reason: 'engine_closed' })
    await h.clock.advance(499)
    assert.equal(busyPlays(h), 0)
    await h.clock.advance(1)
    assert.deepEqual(h.sent('play').at(-1), BUSY_PLAY)
    await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    const e = h.journal[0]
    assert.equal(e.outcome, 'busy_callback')
    assert.equal(e.ai.error, 'engine_closed')
    assert.equal(h.callbacks.listPending('907').length, 1)
  }
})

test('клієнт відмовився від передзвону (callback:false), потім ШІ не вдався → нового передзвону немає, «лінія зайнята» не звучить, просто відбій (ai_noted, ai.error)', async () => {
  {
    const h = harness()
    const s = await toAi(h)
    s.speak()
    await s.tool('save_question_for_manager', { question: 'Дізнався все, дякую', callback: false })
    assert.equal(h.callbacks.listPending('907').length, 0)
    s.end({ reason: 'ai_error' })
    await h.clock.advance(500)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    assert.equal(busyPlays(h), 0)
    assert.equal(h.callbacks.listPending('907').length, 0)
    const e = h.journal[0]
    assert.equal(e.outcome, 'ai_noted')
    assert.equal(e.ai.error, 'ai_error')
    assert.deepEqual([e.callback.stored, e.callback.removed], [false, true])
  }
  {
    // те саме з помилкою audio_start (без паузи — сесія звуку взагалі не почалась)
    const h = harness()
    const s = await toAi(h)
    await s.tool('save_question_for_manager', { question: 'Нічого не треба', callback: false })
    await h.ev({ ev: 'error', cmd: 'audio_start', call: 1, ref: null, msg: 'connect failed' })
    assert.equal(s.stopped, 'engine_error')
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    assert.equal(busyPlays(h), 0)
    assert.equal(h.callbacks.listPending('907').length, 0)
    assert.equal(h.journal[0].outcome, 'ai_noted')
  }
})

test('менеджер на запит ШІ не взяв, а клієнт раніше відмовився від передзвону → передзвін поставлено знову з питанням (перша фраза transfer_failed обіцяє передзвін); помилка ШІ потім — уже «лінія зайнята»', async () => {
  const h = harness()
  const s = await toAi(h)
  await s.tool('save_question_for_manager', { question: 'Хочу поговорити з людиною', topic: 'complaint', urgent: true, callback: false })
  assert.equal(h.callbacks.listPending('907').length, 0)
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 486 })
  const p = h.callbacks.listPending('907')
  assert.equal(p.length, 1, 'передзвін знову')
  assert.deepEqual(p[0].note, { question: 'Хочу поговорити з людиною', topic: 'complaint', urgent: true })
  assert.equal(h.ai.sessions.length, 2)
  const s2 = h.ai.sessions[1]
  assert.equal(s2.opts.kind, 'transfer_failed')
  s2.end({ reason: 'ai_error' })
  await h.clock.advance(500)
  assert.deepEqual(h.sent('play').at(-1), BUSY_PLAY, 'передзвін є — обіцянка правдива')
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.deepEqual([e.callback.stored, e.callback.restored, e.callback.removed], [true, true, undefined])
  assert.equal(h.callbacks.listPending('907').length, 1, 'дубля немає')
  // підсумок для заявки й дошки — «передзвонить», бо передзвін знову стоїть (а не «клієнт сказав, що не треба»)
  assert.equal(e.aiTranscript.note.callback, true)
  assert.equal(e.ai.note.callback, true)
})

test('режим ai: клієнт поклав, поки менеджеру дзвонили (ШІ ще не відповідав) → передзвін (missed), як у busy; до набору — ні; під час набору на запит ШІ — без дубля', async () => {
  {
    const h = harness()
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.clock.advance(5000)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 2 })
    const e = h.journal[0]
    assert.equal(e.outcome, 'client_hangup')
    assert.deepEqual([e.callback.stored, e.callback.missed, e.callback.managerKey], [true, true, '907'])
    assert.equal(e.ai, null)
    assert.equal(h.ai.sessions.length, 0)
    const p = h.callbacks.listPending('907')
    assert.deepEqual([p.length, p[0].clientNumber, p[0].missed], [1, '+380500000001', true])
  }
  {
    const h = harness()
    await h.ev(INCOMING)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual([h.journal[0].outcome, h.journal[0].callback, h.callbacks.listPending().length], ['client_hangup', null, 0])
  }
  {
    const h = harness()
    const s = await toAi(h)
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 3 })
    assert.equal(h.journal[0].outcome, 'client_hangup')
    const p = h.callbacks.listPending('907')
    assert.equal(p.length, 1)
    assert.equal(p[0].missed, undefined, 'той самий запис, що поставив ШІ')
  }
})

test('VG_AI_TRANSFER_MAX=2: з повторної сесії (transfer_failed) можна з\'єднати ще раз; третя сесія — вже ні', async () => {
  const h = harness({ config: { aiTransferMax: 2 } })
  const s = await toAi(h)
  assert.equal(s.opts.transferAllowed, true)
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 486 })
  const s2 = h.ai.sessions[1]
  assert.equal(s2.opts.kind, 'transfer_failed')
  assert.equal(s2.opts.transferAllowed, true)
  assert.deepEqual(await s2.tool('transfer_to_manager', { reason: 'наполягає' }), { ok: true })
  s2.end({ reason: 'tool', action: 'transfer' })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'mgr-1-3', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 4 })
  await h.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 486 })
  const s3 = h.ai.sessions[2]
  assert.equal(s3.opts.kind, 'transfer_failed')
  assert.equal(s3.opts.transferAllowed, false)
  assert.equal((await s3.tool('transfer_to_manager', {})).ok, false)
  s3.end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.equal(e.ai.transfers, 2)
  assert.deepEqual(e.dials.map((x) => [x.attempt, x.ai ?? 0]), [[1, 0], [2, 1], [3, 2]])
  assert.deepEqual(e.ai.sessions.map((x) => x.kind), ['busy', 'transfer_failed', 'transfer_failed'])
})

test('раунд набору на запит ШІ — з чистого аркуша: VG_DIAL_RETRIES=1 дає йому свій повтор; journal: retries за весь дзвінок, ai.firstRetries, ai.why — перший раунд', async () => {
  const h = harness({ config: { dialRetries: 1 } })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.clock.advance(1000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503 })
  await h.clock.advance(2000)
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'mgr-1-2', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 503 }) // ліміт повторів вичерпано → ШІ
  assert.equal(h.ai.sessions.length, 1)
  const s = h.ai.sessions[0]
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'mgr-1-3', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 4 })
  await h.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 503 })
  assert.equal(h.ai.sessions.length, 1, 'не одразу ШІ — спершу свій повтор')
  await h.clock.advance(2000)
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'mgr-1-4', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-4', call: 5 })
  await h.ev({ ev: 'state', call: 5, state: 'DISCONNECTED', code: 486 })
  assert.equal(h.ai.sessions.length, 2)
  h.ai.sessions[1].end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.equal(e.retries, 2)
  assert.equal(e.ai.firstRetries, 1)
  assert.equal(e.ai.why, 'manager_503')
  assert.equal(e.reason, 'manager_486')
  assert.equal(e.xferCode, null)
  assert.equal(e.ai.firstXferCode, null)
  assert.deepEqual(e.dials.map((x) => [x.attempt, x.code, x.ai ?? 0]), [[1, 503, 0], [2, 503, 0], [3, 503, 1], [4, 486, 1]])
})

test('рушій без звуку до мозку (ai.available() === false): уночі менеджеру дзвонимо, ШІ немає — рівно як busy', async () => {
  const ai = fakeAi()
  ai.available = () => false
  const h = harness({ start: NIGHT, ai })
  await answered(h)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/greeting.wav', loop: false, tag: 'greeting' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.clock.advance(1000)
  assert.deepEqual(h.sent('dial'), [{ cmd: 'dial', ref: 'mgr-1-1', uri: MGR }])
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.deepEqual(h.sent('play').at(-1), BUSY_PLAY)
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.equal(e.reason, 'manager_486')
  assert.equal(e.ai, null)
  assert.equal(ai.sessions.length, 0)
  assert.equal(h.sent('audio_start').length, 0)
  assert.equal(h.callbacks.listPending('907').length, 1)
  // available() === true — як і без методу: уночі одразу ШІ
  const ai2 = fakeAi()
  ai2.available = () => true
  const h2 = harness({ start: NIGHT, ai: ai2 })
  await answered(h2)
  await h2.clock.advance(2000)
  assert.equal(h2.sent('dial').length, 0)
  assert.equal(ai2.sessions.length, 1)
})

const MGR_IN = { ev: 'incoming', call: 10, from: 'sip:907@sip14.binotel.com', number: '907', name: 'Менеджер', gcid: null, to: 'sip:901@sip14.binotel.com' }
const CB_PROMPTS = { ...PROMPTS, cbClientBusy: '/p/cb-client-busy.wav', cbNoAnswer: '/p/cb-no-answer.wav', cbConnecting: '/p/cb-connecting.wav', cbNone: '/p/cb-none.wav' }

test('менеджер передзвонює, поки клієнт говорить із ШІ: не чекаємо й не набираємо — «Клієнт зараз розмовляє з віртуальним помічником…» (cbClientBusy), client_with_ai; є інший у черзі — набираємо його', async () => {
  {
    const h = harness({ config: { prompts: CB_PROMPTS } })
    const s = await toAi(h)
    s.speak()
    assert.equal(h.callbacks.listPending('907').length, 1)
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 10, code: 200 })
    await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 10, active: true })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/cb-client-busy.wav', loop: false, tag: 'cbClientBusy' })
    assert.equal(h.sent('play').filter((c) => c.call === 10 && c.tag === 'cbConnecting').length, 0)
    await h.ev({ ev: 'play_done', call: 10, tag: 'cbClientBusy' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
    const e = h.journal.find((x) => x.kind === 'callback')
    assert.deepEqual([e.outcome, e.reason], ['callback_no_answer', 'client_with_ai'])
    assert.equal(h.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
    assert.equal(h.callbacks.listPending('907')[0].attempts, undefined, 'спроба не рахується')
    assert.equal(s.ended, false, 'розмова клієнта з ШІ триває')
    assert.equal(h.journal.length, 1)
  }
  {
    // у черзі ще клієнт, якого ніхто не тримає, — менеджеру набираємо його
    const h = harness({ config: { prompts: CB_PROMPTS } })
    h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000002', ts: h.clock.now() - 3600000 })
    await toAi(h)
    await h.ev(MGR_IN)
    assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'cb-10-1', uri: 'sip:0500000002@sip14.binotel.com;transport=udp' })
  }
})
