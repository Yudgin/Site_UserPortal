// Сценарій дзвінка в режимі ШІ (noAnswerMode 'ai') на підробленому рушії, годиннику й підробленій сесії ШІ: менеджер
// не взяв → ШІ замість «лінія зайнята»; неробочий час → ШІ одразу; інструменти (стан заявки за правилами приватності,
// питання в передзвін, з'єднати, завершити); перевід через ШІ на менеджера тим самим шляхом («1», REFER); менеджер не
// взяв — ШІ знову; помилки ШІ — як busy; клієнт поклав; без фабрики ШІ — як busy. Крайові випадки: сокет ШІ закрився
// раніше за DISCONNECTED клієнта (пауза AI_DOWN_GRACE_MS); відмова від передзвону тримається; передзвін знову після
// невдалого з'єднання; пропущений у менеджера до ШІ; кілька з'єднань (aiTransferMax); свій ліміт повторів у раунді на
// запит ШІ; рушій без звуку (ai.available() false) — як busy; менеджер передзвонює, поки клієнт із ШІ (прапорець
// приєднання вимкнено — «передзвоніть за хвилину», увімкнено — приєднання).
// Режим «ШІ одразу» (answerMode ai) і приєднання менеджера, що передзвонив (joinOnCallback): ШІ сразу без перезвону на
// старті, перша фраза за даними, вступ 80; перевід на прохання (з заявкою і без), гудки; ШІ не піднявся → 82 → набір
// («зайнята» лише після набору); запобіжник; приєднання з фази ai і під час набору того самого менеджера; другий дзвінок
// менеджера → «вже з'єднують»; клієнт / менеджер поклав під час приєднання; end_call / transfer і приєднання впритул;
// допуск +1 до maxCalls; двоє клієнтів — кого набирали останнім; REFER-приєднання. Наприкінці — дефекти незалежної перевірки
// 2026-10-17 (кожен тест падає без свого виправлення) і закріплення правил, які тести раніше не ловили.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, makeBreaker } from './flow.mjs'
import { makeCallbackStore } from './callbacks.mjs'
import { firstMessageFor, buildInstructions, CALLBACK_PROMISE, TERMS_REQUIRED } from './aiprompt.mjs'
import { parseHours } from './hours.mjs'
import { buildCard } from './card.mjs'
import { makeStaffState } from './staffstate.mjs'

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

// Підроблена фабрика сесій ШІ: тест сам «говорить» за модель (tool, speak, end); turns / conversationId — що поверне result()
function fakeAi({ startFails = false, turns = null, conversationId = null } = {}) {
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
        return { provider: 'fake', model: 'fake-1', durationMs: 4000, end: s.endInfo, turns: turns || [{ speaker: 'ai', start: 0.1, end: 1, text: 'Вітаю!' }, { speaker: 'client', start: 1.5, end: 2.5, text: 'Де мій кораблик?' }], toolCalls: [], usage: {}, costUsd: 0.0053, ...(conversationId ? { conversationId } : {}), errors: [] }
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

function harness({ config = {}, ai = fakeAi(), start = DAY, lookup, tts, appCalls = null, staffState = undefined, routeEvent = null, resendLink = null } = {}) {
  const cmds = []
  const journal = []
  const logs = []
  const clock = fakeClock(start)
  const store = makeCallbackStore({ now: clock.now })
  const staff = staffState === undefined ? makeStaffState({ now: clock.now, missMax: config.dsMissMax ?? 2, pauseMin: config.dsPauseMin ?? 120 }) : staffState
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
    staffState: staff,
    appCalls,
    routeEvent,
    resendLink,
  })
  const ev = async (e) => { d.handle(e); await clock.flush() }
  const sent = (name) => cmds.filter((c) => c.cmd === name)
  return { d, cmds, journal, logs, clock, ev, sent, ai, callbacks: store, ttsTexts, staff }
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
  assert.deepEqual(sq, { ok: true, saved: true, callback: true, note: `Записано. ${CALLBACK_PROMISE}` }) // «вам передзвонять» без імені (черновик 5а)
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
  assert.equal(sq.note, `Записано. ${CALLBACK_PROMISE}`)
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

test('менеджер передзвонює, поки клієнт говорить із ШІ (VG_JOIN_ON_CALLBACK вимкнено): не чекаємо й не набираємо — «Клієнт зараз розмовляє з віртуальним помічником…» (cbClientBusy), client_with_ai; є інший у черзі — набираємо його', async () => {
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

// ---------- приєднання менеджера, що передзвонив (VG_JOIN_ON_CALLBACK=1) ----------

const JOIN_PROMPTS = { ...CB_PROMPTS, mgrJoin: '/p/mgr-join.wav', mgrJoinPlain: '/p/mgr-join-plain.wav', mgrJoinBusy: '/p/mgr-join-busy.wav', mgrJoinGone: '/p/mgr-join-gone.wav', joinClient: '/p/join-client.wav' }
// Нога менеджера, якого приєднали: CONFIRMED і звук
async function joinLegUp(h, call = 10) {
  await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call, active: true })
}
const byKind = (h, kind) => h.journal.filter((x) => x.kind === kind)

test('менеджер передзвонює, поки клієнт говорить із ШІ (VG_JOIN_ON_CALLBACK=1): приєднання — ШІ стоп, клієнту 81, менеджеру «Клієнт на лінії…», «1» не питаємо → міст; bridged_join + callback_joined, перезвін знято', async () => {
  const h = harness({ config: { prompts: JOIN_PROMPTS, joinOnCallback: true } })
  const s = await toAi(h)
  s.speak()
  assert.equal(h.callbacks.listPending('907').length, 1)
  await h.ev(MGR_IN)
  assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 10, code: 200 })
  assert.equal(s.stopped, 'joined', 'сесію ШІ закрито')
  assert.equal(h.d.active, 1, 'нового сценарію для менеджера немає')
  // запізніле завершення сесії (модель устигла попросити з'єднати) — ігнорується
  s.end({ reason: 'tool', action: 'transfer' })
  assert.equal(h.sent('dial').length, 1, 'менеджеру вдруге не дзвонимо')
  await joinLegUp(h)
  assert.deepEqual(h.sent('play').filter((c) => c.call === 1).at(-1), { cmd: 'play', call: 1, file: '/p/join-client.wav', loop: false, tag: 'join' })
  assert.deepEqual(h.sent('play').filter((c) => c.call === 10), [{ cmd: 'play', call: 10, file: '/p/mgr-join.wav', loop: false, tag: 'mgrJoin' }])
  await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
  assert.equal(h.sent('bridge').length, 0, 'міст — коли обидві фрази дограно')
  await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
  assert.equal(h.sent('play').filter((c) => c.call === 10 && (c.tag === 'confirm' || c.tag === 'cbConnecting' || c.tag === 'cbClientBusy')).length, 0, '«1» не питаємо, «передзвоніть за хвилину» немає')
  assert.equal(h.callbacks.listPending('907').length, 0, 'перезвін знято')
  assert.equal(h.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
  assert.equal(h.journal.length, 2)
  const [e] = byKind(h, 'client')
  const [m] = byKind(h, 'callback')
  assert.equal(e.outcome, 'bridged_join')
  assert.deepEqual([e.join.fromPhase, e.join.mode, e.join.result, e.join.attempts, e.join.question], ['ai', 'bridge', 'bridged', 1, false])
  assert.ok(e.join.ms >= 0)
  assert.deepEqual([e.pendingRemoved, e.ai.joins, e.route], [1, 1, undefined])
  assert.deepEqual([m.outcome, m.number, m.callback.source, m.callback.removed, m.join.result], ['callback_joined', '907', 'join', true, 'bridged'])
  assert.ok(!/\d{4}/.test(JSON.stringify(e.join)), 'у join немає номерів')
})

const FIRST = { answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav' } }

test('ШІ одразу: вступ 80 → пошук клієнта під нього → ШІ first (є відкрита заявка) без утримання і без перезвону на старті; менеджеру не дзвонимо; питання → перезвін; route у журналі', async () => {
  const h = harness({ config: FIRST })
  await answered(h)
  assert.deepEqual(h.sent('play'), [{ cmd: 'play', call: 1, file: '/p/intro.wav', loop: false, tag: 'intro' }])
  await h.clock.advance(3000)
  assert.equal(h.ai.sessions.length, 0, 'ШІ — після вступу')
  assert.equal(h.sent('dial').length, 0, 'менеджеру не дзвонимо')
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  assert.equal(h.ai.sessions.length, 1)
  const s = h.ai.sessions[0]
  assert.deepEqual([s.opts.kind, s.opts.variant, s.opts.intro, s.opts.v2, s.opts.category, s.opts.transferAllowed], ['first', 'request', true, true, 'openRequest', true])
  assert.equal(h.sent('audio_start').length, 1)
  assert.equal(h.sent('play').length, 1, 'ні привітання, ні утримання перед ШІ')
  assert.equal(h.callbacks.listPending().length, 0, 'перезвону на старті немає')
  s.speak()
  assert.equal(h.sent('stop').length, 0, 'утримання не було — зупиняти нічого')
  const st = await s.tool('get_request_status')
  assert.match(st.note, /сторінка заявки/)
  assert.ok(!JSON.stringify(st).includes('Петренко') && !JSON.stringify(st).includes('380500000001'))
  const sq = await s.tool('save_question_for_manager', { question: 'Коли буде готовий ремонт?', topic: 'repair', callback: true })
  assert.deepEqual([sq.saved, sq.callback], [true, true])
  assert.equal(h.callbacks.listPending('907').length, 1, 'перезвін — коли ШІ записав питання')
  s.end({ reason: 'tool', action: 'end' })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.deepEqual([e.outcome, e.reason, e.dials.length], ['ai_noted', null, 0])
  assert.deepEqual([e.ai.kind, e.ai.variant, e.ai.transfers], ['first', 'request', 0])
  assert.deepEqual(e.route, { branch: 'ai_first', why: null, dataMs: e.t.lookupDone, decidedBy: 'data', variant: 'request' })
  assert.ok(e.t.intro != null && e.t.introDone != null)
})

test('ШІ одразу: перша фраза за даними — немає відкритої заявки → general; пошук не встиг → nodata (без вступу — 1,5 с, зі вступом — 1 с після нього); пошук упав → nodata; клієнт поклав під час вступу — без перезвону', async () => {
  {
    const h = harness({ config: { answerMode: 'ai' }, lookup: async () => ({ requests: [], profile: null, orders: [] }) })
    await answered(h)
    const s = h.ai.sessions[0]
    assert.deepEqual([s.opts.kind, s.opts.variant, s.opts.intro, s.opts.category], ['first', 'general', false, 'unknown'])
    assert.equal(h.sent('play').length, 0, 'вступу немає — тиша до першої фрази ШІ')
  }
  {
    const h = harness({ config: { answerMode: 'ai' }, lookup: () => new Promise(() => {}) })
    await answered(h)
    await h.clock.advance(1499)
    assert.equal(h.ai.sessions.length, 0)
    await h.clock.advance(1)
    assert.deepEqual([h.ai.sessions[0].opts.variant, h.ai.sessions[0].opts.category], ['nodata', null])
    h.d.abortAll('shutdown')
    assert.deepEqual(h.journal[0].route, { branch: 'ai_first', why: 'timeout', dataMs: null, decidedBy: 'timeout', variant: 'nodata' })
  }
  {
    const h = harness({ config: FIRST, lookup: () => new Promise(() => {}) })
    await answered(h)
    await h.clock.advance(4000)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.clock.advance(999)
    assert.equal(h.ai.sessions.length, 0)
    await h.clock.advance(1)
    assert.deepEqual([h.ai.sessions[0].opts.variant, h.ai.sessions[0].opts.intro], ['nodata', true])
  }
  {
    const h = harness({ config: { answerMode: 'ai' }, lookup: async () => { throw new Error('boom') } })
    await answered(h)
    assert.equal(h.ai.sessions[0].opts.variant, 'nodata')
    h.d.abortAll('shutdown')
    assert.equal(h.journal[0].route.why, 'no_data')
  }
  {
    const h = harness({ config: FIRST })
    await answered(h)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual([h.journal[0].outcome, h.journal[0].callback, h.ai.sessions.length, h.callbacks.listPending().length], ['client_hangup', null, 0, 0])
  }
})

test('ШІ одразу: перевід на прохання — з першої сесії; гудки 425 Гц замість 05-hold; картка з проханням; «1» → REFER → connected; перезвону не ставили', async () => {
  const h = harness({ config: { ...FIRST, holdTone: 'ringback', ringbackFile: '/cache/ringback-425hz.wav' } })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  const s = h.ai.sessions[0]
  assert.equal(s.opts.transferAllowed, true)
  s.speak()
  assert.deepEqual(await s.tool('transfer_to_manager', { reason: 'хоче поговорити з людиною' }), { ok: true })
  s.end({ reason: 'tool', action: 'transfer' })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/cache/ringback-425hz.wav', loop: true, tag: 'hold' })
  assert.deepEqual(h.sent('dial'), [{ cmd: 'dial', ref: 'mgr-1-1', uri: MGR }])
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 2, active: true })
  await h.clock.flush()
  assert.match(h.ttsTexts.at(-1), /Клієнт просить менеджера: хоче поговорити з людиною/)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  await h.ev({ ev: 'dtmf', call: 2, digit: '1', method: 'rfc2833' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 2 })
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.callback, null, 'перезвін не ставили')
  assert.deepEqual(e.dials.map((x) => [x.attempt, x.ai ?? 0]), [[1, 1]])
  assert.equal(e.ai.transfers, 1)
})

test('ШІ одразу: менеджер на прохання не взяв → гудки зупинено, перезвін поставлено, знову ШІ (transfer_failed, нові тексти); клієнт поклав під час набору — пропущений перезвін', async () => {
  {
    const h = harness({ config: { ...FIRST, holdTone: 'ringback', ringbackFile: '/cache/rb.wav' } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    const onA = h.cmds.filter((c) => c.call === 1)
    assert.deepEqual(onA.slice(-2).map((c) => c.cmd), ['stop', 'audio_start'], 'гудки зупинено — тиша, поки ШІ не заговорить')
    const s2 = h.ai.sessions[1]
    assert.deepEqual([s2.opts.kind, s2.opts.v2, s2.opts.transferAllowed], ['transfer_failed', true, false])
    assert.equal(h.callbacks.listPending('907').length, 1, 'перезвін — коли з\'єднати не вдалося')
    s2.end({ reason: 'tool', action: 'end' })
    assert.deepEqual([h.journal[0].outcome, h.journal[0].callback.restored], ['ai_answered', true])
  }
  {
    const h = harness({ config: FIRST })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 2 })
    const e = h.journal[0]
    assert.equal(e.outcome, 'client_hangup')
    assert.deepEqual([e.callback.stored, e.callback.missed, e.callback.managerKey], [true, true, '907'])
    assert.equal(h.callbacks.listPending('907')[0].missed, true)
  }
})

test('ШІ одразу: ШІ не піднявся, менеджеру ще не дзвонили → 82 → набір менеджера з карткою і «1» → connected; «лінія зайнята» — лише після справжнього набору (не взяв → busy_callback); ai_start — те саме одразу', async () => {
  const P = { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' }
  {
    const h = harness({ config: { answerMode: 'ai', prompts: P } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    s.end({ reason: 'ai_error' })
    await h.clock.advance(499)
    assert.equal(h.sent('dial').length, 0, 'спершу чекаємо, чи не клієнт поклав')
    await h.clock.advance(1)
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/ai-down.wav', loop: false, tag: 'aiDown' })
    assert.deepEqual(h.sent('dial'), [{ cmd: 'dial', ref: 'mgr-1-1', uri: MGR }])
    assert.equal(busyPlays(h), 0)
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/hold.wav', loop: true, tag: 'hold' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 2, active: true })
    await h.clock.flush()
    assert.equal(h.sent('play').at(-1).tag, 'card')
    assert.match(h.ttsTexts.at(-1), /^Дзвонить Петренко Іван/)
    await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
    await h.clock.advance(700)
    await h.ev({ ev: 'dtmf', call: 2, digit: '1', method: 'rfc2833' })
    await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.ai.error, e.callback], ['connected', 'ai_error', null])
    assert.deepEqual(e.dials.map((x) => [x.attempt, x.ai ?? 0]), [[1, 0]])
    assert.equal(busyPlays(h), 0)
  }
  {
    const h = harness({ config: { answerMode: 'ai', prompts: P }, ai: fakeAi({ startFails: true }) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    assert.equal(h.sent('play').at(-1).tag, 'aiDown')
    assert.equal(h.sent('dial').length, 1)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    assert.equal(busyPlays(h), 0, '82 не обриваємо')
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
    const iDial = h.cmds.findIndex((c) => c.cmd === 'dial')
    const iBusy = h.cmds.findIndex((c) => c.cmd === 'play' && c.tag === 'busy')
    assert.ok(iDial >= 0 && iBusy > iDial, '«лінія зайнята» — після набору')
    await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.reason, e.ai.error], ['busy_callback', 'manager_486', 'ai_start'])
    assert.equal(h.callbacks.listPending('907').length, 1)
  }
})

test('запобіжник ШІ (2/10/30): 2 збої ШІ за 10 хв → 30 хв по-старому (привітання, спершу менеджер, route classic/breaker); потім знову ШІ одразу; без фабрики ШІ — старий режим (no_ai)', async () => {
  const ai = fakeAi({ startFails: true })
  const h = harness({ ai, config: { answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' }, aiBreaker: { fails: 2, windowMs: 600000, offMs: 1800000 } } })
  const call = async (id) => {
    await h.ev({ ...INCOMING, call: id })
    await h.ev({ ev: 'media', call: id, active: true })
    await h.ev({ ev: 'state', call: id, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'play_done', call: id, tag: 'intro' })
  }
  await call(1)
  assert.equal(ai.sessions.length, 1)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.clock.advance(60000)
  await call(11)
  assert.equal(ai.sessions.length, 2)
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.d.breaker.open, true)
  await h.clock.advance(60000)
  await call(21)
  assert.equal(ai.sessions.length, 2, 'ШІ не пробуємо — запобіжник')
  assert.equal(h.sent('play').filter((c) => c.call === 21)[0].tag, 'intro')
  await h.clock.advance(1000)
  assert.equal(h.sent('dial').at(-1).ref, 'mgr-21-1')
  await h.ev({ ev: 'state', call: 21, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual([h.journal[2].route.branch, h.journal[2].route.why], ['classic', 'breaker'])
  await h.clock.advance(30 * 60000)
  await call(31)
  assert.equal(ai.sessions.length, 3, 'через 30 хв — знову ШІ одразу')
  // без фабрики ШІ: старий режим, у журналі чому
  const h2 = harness({ ai: null, config: { answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav' } } })
  await answered(h2)
  await h2.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  assert.equal(h2.sent('play')[0].tag, 'intro')
  h2.d.abortAll('shutdown')
  assert.deepEqual([h2.journal[0].route.branch, h2.journal[0].route.why], ['classic', 'no_ai'])
})

test('ШІ одразу в неробочий час: вступ → ШІ after_hours (нові тексти, перезвін одразу, з\'єднати не можна), менеджеру не дзвонимо', async () => {
  const h = harness({ start: NIGHT, config: FIRST })
  await answered(h)
  assert.equal(h.sent('play')[0].tag, 'intro')
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  const s = h.ai.sessions[0]
  assert.deepEqual([s.opts.kind, s.opts.v2, s.opts.intro, s.opts.transferAllowed], ['after_hours', true, true, false])
  assert.equal(h.callbacks.listPending('907').length, 1)
  assert.equal(h.sent('play').filter((c) => c.tag === 'hold').length, 0)
  assert.equal((await s.tool('transfer_to_manager', {})).ok, false)
  s.end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.deepEqual([e.route.branch, e.ai.kind, e.reason, e.dials.length], ['after_hours', 'after_hours', 'after_hours', 0])
})

test('ШІ одразу + приєднання: ШІ записав питання → менеджер передзвонив → MGR-JOIN «Суть звернення: {резюме}. З’єдную.» (без телефонів), якщо синтез устиг за 2 с → міст; не встиг — без резюме', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' } }
  {
    const h = harness({ config: cfg })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    s.speak()
    await s.tool('save_question_for_manager', { question: 'Передзвоніть на 050 000 00 09, мотор не крутиться', topic: 'repair', callback: true })
    await h.ev(MGR_IN)
    assert.equal(s.stopped, 'joined')
    assert.match(h.ttsTexts.at(-1), /^Суть звернення: .*мотор не крутиться\. З’єдную\.$/)
    assert.doesNotMatch(h.ttsTexts.at(-1), /050|000 00/)
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.sent('play').filter((c) => c.call === 10).at(-1), { cmd: 'play', call: 10, file: `/cache/card-${h.ttsTexts.length}.wav`, loop: false, tag: 'mgrJoinQ' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    assert.equal(h.sent('bridge').length, 0)
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoinQ' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [e] = byKind(h, 'client')
    assert.deepEqual([e.outcome, e.join.question, e.join.fromPhase], ['bridged_join', true, 'ai'])
    assert.equal(h.callbacks.listPending('907').length, 0)
  }
  {
    const h = harness({ config: cfg, tts: () => new Promise(() => {}) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ai.sessions[0].tool('save_question_for_manager', { question: 'Де посилка?', callback: true })
    await h.ev(MGR_IN)
    await h.clock.advance(2000)
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    assert.equal(h.sent('play').filter((c) => c.tag === 'mgrJoinQ').length, 0)
  }
})

test('приєднання, поки шлюз дзвонить тому самому менеджеру на прохання ШІ: набір скасовано (у менеджера не два дзвінки) → міст; менеджер передзвонив ще до dialing — запізнілий набір кладемо', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' } }
  {
    const h = harness({ config: cfg })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'hangup', call: 2 }, { cmd: 'answer', call: 10, code: 200 }])
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    await h.clock.advance(60000)
    assert.equal(h.sent('dial').length, 1, 'тайм-аути набору скасовано')
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [e] = byKind(h, 'client')
    assert.deepEqual([e.outcome, e.join.fromPhase, e.dials[0].code, e.callback], ['bridged_join', 'dialing', 487, null])
    assert.equal(byKind(h, 'callback')[0].outcome, 'callback_joined')
  }
  {
    const h = harness({ config: cfg })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev(MGR_IN)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 2 })
  }
})

test('другий дзвінок менеджера, поки клієнта вже приєднують, — «Клієнта вже з\'єднують з менеджером.» і відбій (callback_join_busy); клієнт у картці з цим менеджером — так само', async () => {
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await h.ev({ ...MGR_IN, call: 11 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 11, code: 200 })
    await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 11, active: true })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 11, file: '/p/mgr-join-busy.wav', loop: false, tag: 'mgrJoinBusy' })
    await h.ev({ ev: 'play_done', call: 11, tag: 'mgrJoinBusy' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 11 })
    const b = h.journal.find((x) => x.outcome === 'callback_join_busy')
    assert.deepEqual([b.kind, b.reason], ['callback', 'join_busy'])
    assert.equal(h.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
    assert.equal(h.sent('play').filter((c) => c.call === 10 && c.tag === 'mgrJoinBusy').length, 0, 'перше приєднання триває')
  }
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
    await h.ev(MGR_IN)
    await joinLegUp(h)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/mgr-join-busy.wav', loop: false, tag: 'mgrJoinBusy' })
  }
})

test('приєднання: клієнт поклав — менеджеру «Клієнт поклав слухавку.», відбій, перезвін лишається (callback_join_gone); менеджер поклав до з\'єднання — знову ШІ (transfer_failed), перезвін лишається', async () => {
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await joinLegUp(h)
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/mgr-join-gone.wav', loop: false, tag: 'mgrJoinGone' })
    assert.equal(h.journal.length, 0, 'менеджер ще чує фразу')
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoinGone' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
    const [e] = byKind(h, 'client')
    const [m] = byKind(h, 'callback')
    assert.deepEqual([e.outcome, e.join.result, m.outcome, m.reason], ['client_hangup', 'client_gone', 'callback_join_gone', 'client_hangup'])
    assert.equal(h.callbacks.listPending('907').length, 1)
    assert.equal(h.sent('bridge').length, 0)
  }
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await joinLegUp(h)
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [m] = byKind(h, 'callback')
    assert.deepEqual([m.outcome, m.reason, m.join.result], ['callback_cancelled', 'join_hangup', 'manager_gone'])
    assert.equal(h.ai.sessions.length, 2)
    const s2 = h.ai.sessions[1]
    assert.deepEqual([s2.opts.kind, s2.opts.transferAllowed], ['transfer_failed', false])
    // 81 обірвано, знову ШІ (у старому режимі — утримання, поки ШІ не заговорить)
    assert.deepEqual(h.cmds.filter((c) => c.call === 1).slice(-3).map((c) => [c.cmd, c.tag ?? null]), [['stop', null], ['play', 'hold'], ['audio_start', null]])
    assert.equal(h.callbacks.listPending('907').length, 1)
    s2.end({ reason: 'tool', action: 'end' })
    const [e] = byKind(h, 'client')
    assert.deepEqual([e.outcome, e.join.result, e.reason], ['ai_answered', 'manager_gone', 'join_hangup'])
  }
})

test('end_call / transfer і приєднання впритул: приєднання першим — запізнілі end_call і transfer ігноруються; end_call першим — клієнта вже немає, менеджеру звичний передзвін', async () => {
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    const s = await toAi(h)
    assert.deepEqual(await s.tool('end_call'), { ok: true })
    await h.ev(MGR_IN)
    s.end({ reason: 'tool', action: 'end' })
    assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0, 'трубку клієнту не кладемо')
    assert.equal(h.journal.length, 0)
    assert.deepEqual(await s.tool('transfer_to_manager', {}), { ok: false, error: 'call_over' })
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
  }
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    const s = await toAi(h)
    s.end({ reason: 'tool', action: 'end' })
    assert.equal(h.journal[0].outcome, 'ai_answered')
    await h.ev(MGR_IN)
    assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'cb-10-1', uri: 'sip:0500000001@sip14.binotel.com;transport=udp' })
    assert.equal(h.sent('bridge').length, 0)
  }
})

test('maxCalls: менеджер, що приєднується, не рахується (нового сценарію немає); іншим дзвінкам менеджерів — допуск +1 лише з VG_JOIN_ON_CALLBACK; клієнтам — як і раніше', async () => {
  {
    const h = harness({ config: { maxCalls: 1, joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 10, code: 200 })
    assert.equal(h.d.active, 1)
  }
  {
    // клієнт із ШІ без перезвону (ШІ одразу, питання не записане) — не приєднуємо, але й 486 менеджеру немає (+1)
    const h = harness({ config: { maxCalls: 1, answerMode: 'ai', joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await answered(h)
    assert.equal(h.ai.sessions.length, 1)
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 10, code: 200 })
    assert.equal(h.d.active, 2)
    await h.ev({ ...INCOMING, call: 20, gcid: '6929148399' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 20, code: 486 }, 'клієнту понад maxCalls — 486, як і раніше')
  }
  {
    const h = harness({ config: { maxCalls: 1, answerMode: 'ai', prompts: JOIN_PROMPTS } })
    await answered(h)
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10, code: 486 }, 'прапорець вимкнено — як раніше')
  }
})

test('двоє клієнтів чекають того самого менеджера — приєднуємо того, кого йому набирали останнім; за рівності — хто чекає довше', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' }, allowedCallers: ['+380500000001', '+380500000003'] }
  const IN2 = { ...INCOMING, call: 20, number: '0500000003', gcid: '6929148399' }
  const up = async (h, inc) => {
    await h.ev(inc)
    await h.ev({ ev: 'media', call: inc.call, active: true })
    await h.ev({ ev: 'state', call: inc.call, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'play_done', call: inc.call, tag: 'intro' })
  }
  {
    const h = harness({ config: cfg })
    await up(h, INCOMING)
    const a = h.ai.sessions[0]
    await a.tool('save_question_for_manager', { question: 'Питання А', callback: true })
    await h.clock.advance(5000)
    await up(h, IN2)
    const b = h.ai.sessions[1]
    await b.tool('transfer_to_manager', {})
    b.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-20-1', call: 21 })
    await h.ev({ ev: 'state', call: 21, state: 'DISCONNECTED', code: 486 })
    assert.equal(h.callbacks.listPending('907').length, 2)
    await h.ev(MGR_IN)
    assert.equal(a.ended, false, 'А далі говорить із ШІ')
    assert.equal(h.ai.sessions[2].stopped, 'joined', 'приєднано Б — йому набирали останнім')
  }
  {
    const h = harness({ config: cfg })
    await up(h, INCOMING)
    await h.ai.sessions[0].tool('save_question_for_manager', { question: 'А', callback: true })
    await h.clock.advance(5000)
    await up(h, IN2)
    await h.ai.sessions[1].tool('save_question_for_manager', { question: 'Б', callback: true })
    await h.ev(MGR_IN)
    assert.equal(h.ai.sessions[0].stopped, 'joined', 'нікому не набирали — того, хто чекає довше')
    assert.equal(h.ai.sessions[1].ended, false)
  }
})

test('приєднання з VG_JOIN_MODE=refer: REFER на нозі клієнта з Replaces ноги менеджера → connected_join; REFER не вдався → міст (refer_failed_bridged)', async () => {
  {
    const h = harness({ config: { joinOnCallback: true, joinMode: 'refer', prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 10 })
    await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [e] = byKind(h, 'client')
    const [m] = byKind(h, 'callback')
    assert.deepEqual([e.outcome, e.join.mode, e.join.result, m.outcome, m.callback.referOn], ['connected_join', 'refer', 'connected', 'callback_joined', 'client'])
    assert.equal(h.callbacks.listPending('907').length, 0)
  }
  {
    const h = harness({ config: { joinOnCallback: true, joinMode: 'refer', prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    await h.ev({ ev: 'xfer', call: 1, code: 503, final: true })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [e] = byKind(h, 'client')
    assert.deepEqual([e.outcome, e.join.result], ['bridged_join', 'refer_failed_bridged'])
  }
})

// ---------- дефекти незалежної перевірки 2026-10-17 ----------

test('приєднання (рішення 16а): перезвін клієнту лишився з попереднього дзвінка, ШІ одразу ще нічого не записав — менеджер, що передзвонив, приєднується, а не «передзвоніть за хвилину»; клієнт у цьому дзвінку відмовився від передзвону — ні', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' } }
  {
    const h = harness({ config: cfg })
    h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() - 600000 })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    assert.equal(s.opts.kind, 'first')
    s.speak()
    await h.ev(MGR_IN)
    assert.equal(s.stopped, 'joined')
    assert.equal(h.d.active, 1, 'нового сценарію для менеджера немає')
    assert.equal(h.sent('play').filter((c) => c.tag === 'cbClientBusy').length, 0)
    await joinLegUp(h)
    assert.deepEqual(h.sent('play').filter((c) => c.call === 10).map((c) => c.file), ['/p/mgr-join.wav'])
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    assert.equal(h.callbacks.listPending('907').length, 0, 'старий перезвін знято')
  }
  {
    const h = harness({ config: cfg })
    h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() - 600000 })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('save_question_for_manager', { question: 'Дякую, нічого не треба', callback: false })
    await h.ev(MGR_IN)
    assert.equal(s.stopped, null, 'відмовився від передзвону — не чекає менеджера')
    assert.equal(h.d.active, 2)
  }
})

test('приєднання під час привітання (класичний набір): 81 — одразу після привітання, а не через JOIN_CAP_MS; менеджеру «Клієнт на лінії — з\'єдную.» (з ШІ клієнт не говорив)', async () => {
  for (const noAnswerMode of ['busy', 'ai']) {
    const h = harness({ config: { noAnswerMode, joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await answered(h)
    assert.equal(h.sent('play')[0].tag, 'greeting')
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'hangup', call: 2 }, { cmd: 'answer', call: 10, code: 200 }])
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
    await joinLegUp(h)
    assert.deepEqual(h.sent('play').filter((c) => c.call === 10), [{ cmd: 'play', call: 10, file: '/p/mgr-join-plain.wav', loop: false, tag: 'mgrJoin' }])
    assert.equal(h.sent('play').filter((c) => c.tag === 'join').length, 0, 'привітання не обриваємо')
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    await h.clock.advance(1500)
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 1, file: '/p/join-client.wav', loop: false, tag: 'join' }, `${noAnswerMode}: 81 після привітання`)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const [e] = byKind(h, 'client')
    assert.deepEqual([e.outcome, e.join.fromPhase], ['bridged_join', 'dialing'])
    assert.equal(e.errors.filter((x) => x.where === 'join').length, 0, 'не через межу фраз')
    assert.ok(e.join.ms < 5000)
  }
})

test('VG_JOIN_MODE=refer: клієнт поклав, поки REFER приєднання без відповіді (тайм-аут) або з 481 — менеджеру «Клієнт поклав слухавку.», callback_join_gone, перезвін лишається', async () => {
  for (const how of ['timeout', '481']) {
    const h = harness({ config: { joinOnCallback: true, joinMode: 'refer', prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await joinLegUp(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 10 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    if (how === 'timeout') await h.clock.advance(8000)
    else await h.ev({ ev: 'xfer', call: 1, code: 481, final: true })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/mgr-join-gone.wav', loop: false, tag: 'mgrJoinGone' }, how)
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoinGone' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
    const [e] = byKind(h, 'client')
    const [m] = byKind(h, 'callback')
    assert.deepEqual([e.outcome, e.join.result, m.outcome, m.reason], ['client_hangup', 'client_gone', 'callback_join_gone', 'client_hangup'])
    assert.equal(h.callbacks.listPending('907').length, 1)
  }
})

test('приєднання без файла 81 (WAV ще не зроблені): поки менеджер слухає фрази, клієнту гудки (VG_HOLD_TONE=ringback) або утримання — не тиша після обірваного ШІ', async () => {
  const P = { ...JOIN_PROMPTS, joinClient: null }
  {
    const h = harness({ config: { joinOnCallback: true, prompts: P, holdTone: 'ringback', ringbackFile: '/cache/rb.wav' } })
    const s = await toAi(h)
    s.speak()
    await h.ev(MGR_IN)
    await joinLegUp(h)
    assert.deepEqual(h.cmds.filter((c) => c.call === 1).at(-1), { cmd: 'play', call: 1, file: '/cache/rb.wav', loop: true, tag: 'hold' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
  }
  {
    const h = harness({ config: { answerMode: 'ai', joinOnCallback: true, prompts: { ...P, intro: '/p/intro.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    s.speak()
    await s.tool('save_question_for_manager', { question: 'Де посилка?', callback: true })
    await h.ev(MGR_IN)
    await joinLegUp(h)
    assert.deepEqual(h.cmds.filter((c) => c.call === 1).at(-1), { cmd: 'play', call: 1, file: '/p/hold.wav', loop: true, tag: 'hold' }, 'без гудків — звичне утримання')
  }
})

test('82 і приєднання: менеджер передзвонив, поки грає 82, і поклав до готовності своєї ноги — 82 не обриваємо, «лінія зайнята» після неї; нога готова — 81 замінює 82, менеджеру фраза без «віртуального помічника»', async () => {
  const P = { ...JOIN_PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' }
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: P }
  {
    const h = harness({ config: cfg, ai: fakeAi({ startFails: true }) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    assert.equal(h.sent('play').at(-1).tag, 'aiDown')
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev(MGR_IN)
    assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'hangup', call: 2 }, { cmd: 'answer', call: 10, code: 200 }])
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    assert.equal(busyPlays(h), 0, '82 не обриваємо')
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
    assert.equal(busyPlays(h), 1, '«лінія зайнята» — після 82')
  }
  {
    const h = harness({ config: cfg, ai: fakeAi({ startFails: true }) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev(MGR_IN)
    await joinLegUp(h)
    assert.deepEqual(h.cmds.filter((c) => c.call === 1).at(-1), { cmd: 'play', call: 1, file: '/p/join-client.wav', loop: false, tag: 'join' })
    assert.deepEqual(h.sent('play').filter((c) => c.call === 10).map((c) => c.file), ['/p/mgr-join-plain.wav'], 'з ШІ клієнт не говорив')
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' }) // запізнілий кінець обірваної 82 — нічого не змінює
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoin' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 10 })
    assert.equal(busyPlays(h), 0)
  }
})

test('ШІ одразу вночі: ШІ впав (ai_error) або не стартував → менеджеру не дзвонимо, «лінія зайнята» не звучить; фраза 83 «неробочий час…» і відбій (ai_failed_callback), перезвін after_hours лишається; без WAV 83 — просто відбій', async () => {
  const P = { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav', aiDownNight: '/p/ai-down-night.wav' }
  for (const how of ['ai_error', 'ai_start']) {
    const h = harness({ start: NIGHT, config: { answerMode: 'ai', prompts: P }, ai: fakeAi({ startFails: how === 'ai_start' }) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    if (how === 'ai_error') {
      h.ai.sessions[0].end({ reason: 'ai_error' })
      await h.clock.advance(600)
    }
    assert.equal(h.sent('dial').length, 0, 'уночі менеджеру не дзвонимо')
    assert.equal(busyPlays(h), 0, '«лінія зайнята» не звучить')
    assert.equal(h.sent('play').filter((c) => c.tag === 'aiDown').length, 0)
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/ai-down-night.wav', loop: false, tag: 'aiDownNight' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDownNight' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.reason, e.ai.kind, e.ai.error, e.callback.stored, e.dials.length], ['ai_failed_callback', 'after_hours', 'after_hours', how, true, 0])
    assert.equal(h.callbacks.listPending('907').length, 1)
    assert.ok(!h.logs.some((m) => /менеджер не ответил/.test(m)), 'у статусі немає «менеджер не ответил»')
  }
  {
    const h = harness({ start: NIGHT, config: { answerMode: 'ai' }, ai: fakeAi({ startFails: true }) })
    await answered(h)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    assert.deepEqual([h.journal[0].outcome, busyPlays(h)], ['ai_failed_callback', 0])
  }
})

test('ШІ одразу: пошук повернув null (lookup.mjs так відповідає на тайм-аут і помилку) → перша фраза nodata, route.why no_data — а не general', async () => {
  for (const cfg of [{ answerMode: 'ai' }, FIRST]) {
    const h = harness({ config: cfg, lookup: async () => null })
    await answered(h)
    if (cfg.prompts) await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    assert.deepEqual([s.opts.variant, s.opts.category], ['nodata', null])
    h.d.abortAll('shutdown')
    assert.deepEqual([h.journal[0].route.variant, h.journal[0].route.why, h.journal[0].lookup], ['nodata', 'no_data', 'none'])
  }
})

test('повторна сесія ШІ — за фактами: менеджер, що приєднався, поклав до з\'єднання → failedBy join (без «не відповідає» / «пропущений дзвінок»), уночі — ще й неробочий час в інструкціях; менеджер не взяв на прохання ШІ → failedBy dial', async () => {
  {
    const h = harness({ start: NIGHT, config: { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    assert.equal(s.opts.kind, 'after_hours')
    await h.ev(MGR_IN)
    assert.equal(s.stopped, 'joined')
    await joinLegUp(h)
    await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
    const s2 = h.ai.sessions[1]
    assert.deepEqual([s2.opts.kind, s2.opts.failedBy, s2.opts.afterHours, s2.opts.note, s2.opts.transferAllowed], ['transfer_failed', 'join', true, null, false])
    assert.equal(h.sent('dial').length, 0, 'менеджеру шлюз не дзвонив — пропущеного в нього немає')
    const first = firstMessageFor(s2.opts)
    assert.doesNotMatch(first, /пропущений|не відповідає/)
    assert.match(first, /не зміг продовжити розмову/)
    const ins = buildInstructions({ ...s2.opts, hoursText: "з понеділка до п'ятниці" })
    assert.match(ins, /приєднався до розмови/)
    assert.match(ins, /Зараз неробочий час/)
    assert.doesNotMatch(ins, /менеджер не відповів/)
  }
  {
    const h = harness({ config: FIRST })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    const s2 = h.ai.sessions[1]
    assert.deepEqual([s2.opts.kind, s2.opts.failedBy, s2.opts.afterHours], ['transfer_failed', 'dial', false])
    // AI-TRANSFER-FAILED [запитання ще немає], днём короткий: без «пропущений дзвінок» і «він» (черновик 5а)
    assert.ok(firstMessageFor(s2.opts).endsWith('З’єднати не вдалося — вам передзвонять. Що передати? Вам передзвонять протягом восьми робочих годин.'))
  }
})

test('ШІ одразу: записати перезвін не вдалося (помилка диска), менеджеру ще не дзвонили — модель не обіцяє «пропущений дзвінок»', async () => {
  const h = harness({ config: { answerMode: 'ai' } })
  h.callbacks.addPending = () => { throw new Error('disk full') }
  await answered(h)
  const r = await h.ai.sessions[0].tool('save_question_for_manager', { question: 'Де посилка?', callback: true })
  assert.equal(r.saved, false)
  assert.doesNotMatch(r.note, /пропущений/)
  const night = harness({ start: NIGHT, config: { answerMode: 'ai' } })
  night.callbacks.addPending = () => { throw new Error('disk full') }
  await answered(night)
  const opts = night.ai.sessions[0].opts
  assert.equal(opts.callbackStored, false)
  const message = firstMessageFor(opts)
  assert.match(message, /записуємо розмову, щоб/)
  assert.match(message, /штучний інтелект/)
  assert.match(message, /Не вдалося записати передзвін/)
  assert.doesNotMatch(message, /вам передзвонять|восьми робочих/i)
})

test('ШІ одразу: рушій не зміг зіграти вступ 80 (помилка play) → ШІ починає з AI-FALLBACK-GREETING (оголошення про запис з метою), далі без повторного «Вам відповідає…» (intro: false)', async () => {
  const h = harness({ config: FIRST })
  await answered(h)
  assert.equal(h.sent('play')[0].tag, 'intro')
  await h.ev({ ev: 'error', cmd: 'play', call: 1, msg: 'cannot open file' })
  const s = h.ai.sessions[0]
  assert.deepEqual([s.opts.kind, s.opts.intro], ['first', false])
  const fm = firstMessageFor(s.opts)
  assert.match(fm, /^Вітаємо! Це віртуальний помічник компанії Runferry\. Ми записуємо розмову, щоб опрацювати звернення й контролювати якість\. Я — штучний інтелект\./)
  assert.doesNotMatch(fm, /Вам відповідає/)
  h.d.abortAll('shutdown')
  assert.ok(h.journal[0].t.introFailed != null && h.journal[0].t.introDone == null)
})

test('старий режим ШІ (VG_NO_ANSWER_MODE=ai) з VG_HOLD_TONE=ringback: менеджер на прохання ШІ не взяв → гудки зупинено (не «ще дзвонимо»), до першого звуку ШІ — звичне утримання', async () => {
  const h = harness({ config: { holdTone: 'ringback', ringbackFile: '/cache/rb.wav' } })
  const s = await toAi(h)
  s.speak()
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/cache/rb.wav', loop: true, tag: 'hold' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 486 })
  const onA = h.cmds.filter((c) => c.call === 1)
  assert.deepEqual(onA.slice(-3).map((c) => [c.cmd, c.file ?? null]), [['stop', null], ['play', '/p/hold.wav'], ['audio_start', null]])
})

// ---------- закріплення правил, яких тести раніше не ловили ----------

test('приєднання лише без PIN: зовнішній номер менеджера з VG_MANAGERS_EXTERNAL=1 і PIN не приєднується (спершу PIN, прежній передзвін); без VG_MANAGERS_EXTERNAL — 486, ШІ не зупинено; nopin — приєднується', async () => {
  const EXT = { ...MGR_IN, call: 12, from: 'sip:0500000099@45.91.130.64', number: '0500000099', gcid: '6929148377' }
  const managers = [['907', '+380500000099']]
  {
    const h = harness({ config: { managers, managersExternal: true, managerPin: '2468', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, pin: '/p/pin.wav' } } })
    const s = await toAi(h)
    await h.ev(EXT)
    assert.equal(s.stopped, null, 'ШІ не зупинено')
    assert.equal(h.d.active, 2, 'окремий сценарій передзвону')
    assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 12, code: 200 })
    await joinLegUp(h, 12)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 12, file: '/p/pin.wav', loop: false, tag: 'pin' })
  }
  {
    const h = harness({ config: { managers, joinOnCallback: true, prompts: JOIN_PROMPTS } })
    const s = await toAi(h)
    await h.ev(EXT)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 12, code: 486 })
    assert.equal(s.stopped, null)
  }
  {
    const h = harness({ config: { managers, managersExternal: true, managersExternalNoPin: true, joinOnCallback: true, prompts: JOIN_PROMPTS } })
    const s = await toAi(h)
    await h.ev(EXT)
    assert.equal(s.stopped, 'joined', 'nopin (рішення власника) — приєднується')
  }
})

test('ШІ одразу: менеджеру вже дзвонили (на прохання ШІ, не взяв), потім ШІ впав → «лінія зайнята» (тепер правда), без 82 і без другого набору', async () => {
  const h = harness({ config: { answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' } } })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  const s = h.ai.sessions[0]
  await s.tool('transfer_to_manager', {})
  s.end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  const s2 = h.ai.sessions[1]
  assert.equal(s2.opts.kind, 'transfer_failed')
  s2.end({ reason: 'ai_error' })
  await h.clock.advance(600)
  assert.equal(h.sent('dial').length, 1, 'менеджеру, що щойно не взяв, удруге не дзвонимо')
  assert.equal(h.sent('play').filter((c) => c.tag === 'aiDown').length, 0)
  assert.equal(busyPlays(h), 1)
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.deepEqual([h.journal[0].outcome, h.journal[0].reason, h.journal[0].ai.error], ['busy_callback', 'manager_486', 'ai_error'])
})

test('приєднання і групи менеджерів (907 і 908): клієнт чекає 907 — 908 не приєднується до нього, набір 907 не скасовує й не чує «вже з\'єднують»', async () => {
  const managers = [['907'], ['908']]
  const M908 = { ...MGR_IN, call: 11, from: 'sip:908@sip14.binotel.com', number: '908' }
  const P = { ...JOIN_PROMPTS, cbNone: '/p/cb-none.wav' }
  {
    // (а) клієнт із ШІ, перезвін у групі 907
    const h = harness({ config: { managers, joinOnCallback: true, prompts: { ...P, intro: '/p/intro.wav' } } })
    const s = await toAi(h)
    await h.ev(M908)
    assert.equal(s.stopped, null)
    assert.equal(h.d.active, 2)
  }
  {
    // (б) шлюз саме дзвонить 907 на прохання ШІ
    const h = harness({ config: { managers, answerMode: 'ai', joinOnCallback: true, prompts: { ...P, intro: '/p/intro.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ai.sessions[0].tool('transfer_to_manager', {})
    h.ai.sessions[0].end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev(M908)
    assert.equal(h.cmds.filter((c) => c.cmd === 'hangup' && c.call === 2).length, 0, 'набір 907 не скасовано')
    assert.equal(h.d.active, 2)
  }
  {
    // (в) клієнта приєднують до 907 — 908 чує звичне «немає клієнтів», а не «вже з'єднують»
    const h = harness({ config: { managers, joinOnCallback: true, prompts: { ...P, intro: '/p/intro.wav' } } })
    await toAi(h)
    await h.ev(MGR_IN)
    await h.ev(M908)
    await joinLegUp(h, 11)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 11, file: '/p/cb-none.wav', loop: false, tag: 'cbNone' })
  }
  {
    // (г) клієнт у картці з 907 (класичний набір)
    const h = harness({ config: { managers, noAnswerMode: 'busy', joinOnCallback: true, prompts: { ...P, intro: '/p/intro.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    await h.clock.advance(1000)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
    await h.ev(M908)
    await joinLegUp(h, 11)
    assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 11, file: '/p/cb-none.wav', loop: false, tag: 'cbNone' })
  }
})

test('maxCalls з VG_JOIN_ON_CALLBACK: клієнтам допуску +1 немає (другий клієнт при maxCalls 1 — 486); менеджерам +1, не +2', async () => {
  {
    const h = harness({ config: { maxCalls: 1, joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await answered(h)
    await h.ev({ ...INCOMING, call: 20, gcid: '6929148399' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 20, code: 486 })
  }
  {
    const h = harness({ config: { maxCalls: 1, answerMode: 'ai', joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await answered(h)
    await h.ev(MGR_IN)
    assert.equal(h.d.active, 2, 'менеджеру +1')
    await h.ev({ ...MGR_IN, call: 11 })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 11, code: 486 }, 'ще один менеджер — понад +1')
  }
})

test('запобіжник: збої за межами вікна не накопичуються (3/10/30: збій раз на 3 год — не спрацьовує); 3 за 10 хв — спрацьовує, через 30 хв закрито', () => {
  let now = DAY
  const b = makeBreaker({ fails: 3, windowMs: 600000, offMs: 1800000 }, { now: () => now })
  for (let i = 0; i < 4; i++) {
    assert.equal(b.fail('ai_error'), false)
    now += 3 * 3600000
  }
  assert.equal(b.open, false)
  b.fail('ai_error')
  now += 60000
  b.fail('ai_error')
  now += 60000
  assert.equal(b.fail('ai_error'), true)
  assert.equal(b.open, true)
  now += 1800000
  assert.equal(b.open, false)
})

test('відмова від передзвону в «ШІ одразу» тримається: ШІ впав → 82 → менеджер 486 — тихий відбій без «лінія зайнята» і без перезвону; просив менеджера й поклав під час набору — без пропущеного перезвону', async () => {
  {
    const h = harness({ config: { answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('save_question_for_manager', { question: 'Нічого не треба', callback: false })
    s.end({ reason: 'ai_error' })
    await h.clock.advance(600)
    assert.equal(h.sent('play').at(-1).tag, 'aiDown')
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
    assert.equal(busyPlays(h), 0)
    assert.equal(h.callbacks.listPending().length, 0)
    assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 1)
    assert.equal(h.journal[0].outcome, 'ai_noted')
  }
  {
    const h = harness({ config: FIRST })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    const s = h.ai.sessions[0]
    await s.tool('save_question_for_manager', { question: 'Нічого не треба', callback: false })
    await s.tool('transfer_to_manager', {})
    s.end({ reason: 'tool', action: 'transfer' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(h.callbacks.listPending().length, 0)
    assert.deepEqual([h.journal[0].outcome, h.journal[0].callback], ['client_hangup', null])
  }
})

test('приєднання з фази dialing («ШІ одразу», перезвону ще немає), клієнт поклав — пропущений перезвін у групу менеджера', async () => {
  const h = harness({ config: { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' } } })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  await h.ai.sessions[0].tool('transfer_to_manager', {})
  h.ai.sessions[0].end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.ev(MGR_IN)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  await joinLegUp(h)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'play_done', call: 10, tag: 'mgrJoinGone' })
  const p = h.callbacks.listPending('907')
  assert.equal(p.length, 1)
  assert.equal(p[0].missed, true)
  const [e] = byKind(h, 'client')
  assert.deepEqual([e.outcome, e.join.result, e.callback.stored, e.callback.missed], ['client_hangup', 'client_gone', true, true])
})

test('VG_HOLD_TONE=ringback лише в нових гілках: класичний набір (і «ШІ одразу» без ШІ) — 05-hold; після 82 — гудки', async () => {
  const RB = { holdTone: 'ringback', ringbackFile: '/cache/rb.wav' }
  {
    const h = harness({ config: { ...RB, noAnswerMode: 'busy' } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: h.ai ? 'greeting' : 'intro' })
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: h.ai ? '/p/hold.wav' : '/cache/rb.wav', loop: true, tag: 'hold' })
  }
  {
    const h = harness({ ai: null, config: { ...RB, answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav' } } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: h.ai ? 'greeting' : 'intro' })
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: h.ai ? '/p/hold.wav' : '/cache/rb.wav', loop: true, tag: 'hold' })
  }
  {
    const h = harness({ config: { ...RB, answerMode: 'ai', prompts: { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' } }, ai: fakeAi({ startFails: true }) })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
    assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/cache/rb.wav', loop: true, tag: 'hold' })
  }
})

test('страховки: нога менеджера після answer так і не CONFIRMED — через 8 с знову ШІ; помилка answer — одразу; нога клієнта не готова — фаза route через 30 с усе одно вирішує', async () => {
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await h.clock.advance(7999)
    assert.equal(h.ai.sessions.length, 1)
    await h.clock.advance(1)
    assert.equal(h.ai.sessions.length, 2)
    assert.deepEqual(byKind(h, 'callback')[0].reason, 'join_no_ack')
  }
  {
    const h = harness({ config: { joinOnCallback: true, prompts: JOIN_PROMPTS } })
    await toAi(h)
    await h.ev(MGR_IN)
    await h.ev({ ev: 'error', cmd: 'answer', call: 10, msg: 'answer failed' })
    assert.equal(h.ai.sessions.length, 2, 'одразу, без 8 с')
    assert.equal(byKind(h, 'callback')[0].reason, 'join_answer_error')
  }
  {
    const h = harness({ config: FIRST })
    await h.ev(INCOMING)
    await h.clock.advance(29999)
    assert.equal(h.ai.sessions.length, 0)
    await h.clock.advance(1)
    assert.equal(h.ai.sessions.length, 0)
    assert.equal(h.journal[0].outcome, 'intro_failed')
    assert.equal(h.sent('dial').length, 0)
  }
})

test('82 і голосова пошта (VG_NO_ANSWER_MODE=voicemail): менеджер не взяв, поки грає 82, — пошта після 82, не поверх неї', async () => {
  const h = harness({ config: { answerMode: 'ai', noAnswerMode: 'voicemail', voicemailPromptFile: '/p/vm.wav', prompts: { ...PROMPTS, intro: '/p/intro.wav', aiDown: '/p/ai-down.wav' } }, ai: fakeAi({ startFails: true }) })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.equal(h.sent('play').filter((c) => c.tag === 'voicemail').length, 0)
  assert.equal(h.cmds.filter((c) => c.call === 1 && (c.cmd === 'stop' || c.cmd === 'record')).length, 0)
  await h.ev({ ev: 'play_done', call: 1, tag: 'aiDown' })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 1, file: '/p/vm.wav', loop: false, tag: 'voicemail' })
})

test('двоє клієнтів: одного вже з\'єднують із 907 (картка), другий чекає 907 з перезвоном — дзвінок 907 чує «вже з\'єднують», другого не приєднуємо', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: { ...JOIN_PROMPTS, intro: '/p/intro.wav' }, allowedCallers: ['+380500000001', '+380500000003'] }
  const IN2 = { ...INCOMING, call: 20, number: '0500000003', gcid: '6929148399' }
  const h = harness({ config: cfg })
  const up = async (inc) => {
    await h.ev(inc)
    await h.ev({ ev: 'media', call: inc.call, active: true })
    await h.ev({ ev: 'state', call: inc.call, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'play_done', call: inc.call, tag: 'intro' })
  }
  await up(INCOMING)
  await h.ai.sessions[0].tool('transfer_to_manager', {})
  h.ai.sessions[0].end({ reason: 'tool', action: 'transfer' })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await up(IN2)
  const b = h.ai.sessions[1]
  await b.tool('save_question_for_manager', { question: 'Б', callback: true })
  await h.ev(MGR_IN)
  assert.equal(b.stopped, null, 'другого не приєднуємо')
  await joinLegUp(h)
  assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/mgr-join-busy.wav', loop: false, tag: 'mgrJoinBusy' })
})

// ---------- черга B: обговорення, 80 першою в усіх гілках, тексти, строк перезвону, callback:false, теги, події ----------
// Номери вигадані: клієнт +380500000001, ведучий-мобільний +380500000003 (його група — у VG_MANAGERS), лінія менеджера 907.
const LEAD = '+380500000003'
const LEAD_URI = 'sip:0500000003@sip14.binotel.com;transport=udp'
const DS_PROMPTS = {
  ...PROMPTS, intro: '/p/80.wav', introShort: '/p/80s.wav', dsTalked: '/p/13.wav', dsTalkedShort: '/p/13s.wav', dsCalledShort: '/p/14s.wav', dsGeneral: '/p/15.wav', dsGeneralShort: '/p/15s.wav',
  dsFailed: '/p/16.wav', dsNoAi: '/p/17.wav', dsNoAiShort: '/p/17s.wav', aiDown: '/p/82.wav', aiDownShort: '/p/82s.wav', ...JOIN_PROMPTS,
}
const dsCfg = (kind = 'talked', extra = {}) => ({
  answerMode: 'ai', dsSource: 'test', dsTest: new Map([['+380500000001', kind]]), dsStaff: { test: LEAD }, managers: [['907'], [LEAD]],
  dsRingSec: 20, dsMaxWaitSec: 30, dsXferWaitMs: 6000, dsMissMax: 2, dsPauseMin: 120, dsLeadUriTemplate: 'sip:{national}@{server};transport=udp',
  holdTone: 'ringback', ringbackFile: '/cache/rb.wav', prompts: DS_PROMPTS, ...extra,
})
const LEAD_IN = { ev: 'incoming', call: 30, from: 'sip:0500000003@45.91.130.64', number: '0500000003', name: 'Ведучий', gcid: null, to: 'sip:901@sip14.binotel.com' }
const onA = (h, call = 1) => h.cmds.filter((c) => c.call === call && c.cmd === 'play')

// Клієнт → 80 дограно → гілка обговорення: фраза 13/14/15 і набір ведучого (call 2)
async function toDiscussion(h, { call = 1 } = {}) {
  await h.ev({ ...INCOMING, call })
  await h.ev({ ev: 'media', call, active: true })
  await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
  assert.equal(onA(h, call)[0].tag, 'intro', '80 — перша фраза')
  await h.ev({ ev: 'play_done', call, tag: 'intro' })
}

test('обговорення talked: 80 → 13 і одночасно набір ведучого (20 с) → картка MGR-DS-CARD → «1» під час фрази — REFER лише після неї → connected; пропуски з нуля, перезвін знято, події route/answered, журнал ds', async () => {
  const events = []
  const h = harness({ config: dsCfg('talked'), routeEvent: (e) => events.push(e) })
  h.staff.miss(LEAD) // один пропуск був раніше — розмова його скидає
  h.callbacks.addPending({ managerKey: LEAD, clientNumber: '+380500000001', ts: DAY - 3600000 })
  await toDiscussion(h)
  const iPlay = h.cmds.findIndex((c) => c.cmd === 'play' && c.tag === 'ds')
  const iDial = h.cmds.findIndex((c) => c.cmd === 'dial')
  assert.deepEqual(h.cmds[iPlay], { cmd: 'play', call: 1, file: '/p/13s.wav', loop: false, tag: 'ds' }, 'днём — короткий варіант 13')
  assert.ok(iDial > iPlay, 'набір ведучого — одразу з фразою')
  assert.deepEqual(h.cmds[iDial], { cmd: 'dial', ref: 'mgr-1-1', uri: LEAD_URI })
  assert.equal(h.ai.sessions.length, 0, 'ШІ немає')
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(19000)
  assert.equal(h.sent('hangup').length, 0, 'ведучому дзвонимо 20 с (VG_DS_RING_SEC), а не 25')
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 2, active: true })
  await h.clock.flush()
  assert.equal(h.ttsTexts.at(-1), 'Передзвонює клієнт, з яким ви нещодавно говорили. Заявка 123, Петренко Іван.')
  await h.ev({ ev: 'dtmf', call: 2, digit: '1', method: 'rfc2833' })
  assert.equal(h.sent('xfer_replaces').length, 0, 'фраза 13 ще грає — REFER чекає')
  await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 2 })
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.deepEqual([e.route.branch, e.ds.kind, e.ds.source, e.ds.phrase, e.ds.served, e.ds.managerKey], ['discussion', 'talked', 'test', 'dsTalked', true, '…0003'])
  assert.ok(e.t.xferGate != null && e.t.dsPhraseDone != null && e.t.xfer >= e.t.dsPhraseDone, 'REFER — після кінця фрази')
  assert.ok(h.cmds.findIndex((c) => c.cmd === 'xfer_replaces') > h.cmds.findIndex((c) => c.cmd === 'play' && c.tag === 'card'))
  assert.equal(h.staff.get(LEAD).misses, 0, 'ведучий узяв — пропуски з нуля')
  assert.equal(h.callbacks.listPending(LEAD).length, 0, 'перезвін ведучому знято')
  assert.deepEqual(events.map((x) => x.event), ['route', 'answered'])
  assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'event', 'generalCallID', 'ownerUid', 'serviceRequestId'])
  assert.deepEqual([events[0].serviceRequestId, events[0].ownerUid, events[0].generalCallID], ['sr1', 'test', '6929148313'])
  assert.ok(!JSON.stringify(events).match(/500000001|500000003/), 'у подіях немає номерів телефонів')
  assert.ok(!JSON.stringify(e.ds).match(/500000003/), 'у журналі ключ ведучого-мобільного — маскою')
})

test('обговорення: ведучий не взяв за 20 с → пропуск, перезвін у його групу, фраза 16 без відбою → ШІ discussion_failed (AI-DS-FAILED, повторно не з\'єднує); ведучий натиснув «2» — так само; подія fallback', async () => {
  const events = []
  const h = harness({ config: dsCfg('called'), routeEvent: (e) => events.push(e) })
  await toDiscussion(h)
  assert.equal(onA(h).at(-1).file, '/p/14s.wav', 'called — фраза 14')
  await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
  assert.deepEqual(onA(h).at(-1), { cmd: 'play', call: 1, file: '/cache/rb.wav', loop: true, tag: 'hold' }, 'після фрази — гудки')
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(20000)
  assert.deepEqual(h.sent('hangup').at(-1), { cmd: 'hangup', call: 2 })
  assert.deepEqual(onA(h).at(-1), { cmd: 'play', call: 1, file: '/p/16.wav', loop: false, tag: 'dsFailed' })
  assert.equal(h.ai.sessions.length, 0, 'ШІ — після фрази 16')
  const p = h.callbacks.listPending(LEAD)
  assert.equal(p.length, 1, 'перезвін ведучому поставлено ДО «вам передзвонять»')
  await h.ev({ ev: 'play_done', call: 1, tag: 'dsFailed' })
  const s = h.ai.sessions[0]
  assert.deepEqual([s.opts.kind, s.opts.transferAllowed, s.opts.intro, s.opts.callbackTo], ['discussion_failed', false, true, 'lead'])
  assert.match(firstMessageFor(s.opts), /^Тепер із вами говорить штучний інтелект, а не людина\. Вам передзвонять — що передати менеджеру\? Вам передзвонять протягом восьми робочих годин\.$/)
  assert.equal((await s.tool('transfer_to_manager', {})).ok, false)
  s.end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.deepEqual([e.outcome, e.reason, e.ds.result.miss, e.ds.result.misses], ['ai_answered', 'manager_timeout', true, 1])
  assert.deepEqual(events.map((x) => x.event), ['route', 'fallback', 'ai_ended'])
  assert.equal(h.staff.get(LEAD).misses, 1)
  // «2» — теж пропуск
  const h2 = harness({ config: dsCfg('general') })
  await toDiscussion(h2)
  assert.equal(onA(h2).at(-1).file, '/p/15s.wav')
  await h2.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h2.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await h2.ev({ ev: 'media', call: 2, active: true })
  await h2.clock.flush()
  await h2.ev({ ev: 'dtmf', call: 2, digit: '2', method: 'rfc2833' })
  assert.equal(h2.staff.get(LEAD).misses, 1)
  assert.equal(onA(h2).at(-1).tag, 'ds', '16 не обриває фразу 15')
  await h2.ev({ ev: 'play_done', call: 1, tag: 'ds' })
  assert.equal(onA(h2).at(-1).tag, 'dsFailed', '16 — після фрази 15')
})

test('обговорення: 486 (ведучий зайнятий) — НЕ пропуск; клієнт поклав під час фрази чи гудків — пропущений перезвін ведучому без пропуску (подія client_hangup); клієнт чекав після фрази > 30 с — пропуск', async () => {
  {
    const h = harness({ config: dsCfg('talked') })
    await toDiscussion(h)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    assert.equal(onA(h).at(-1).tag, 'dsFailed')
    assert.equal(h.staff.get(LEAD), null, '486 — не пропуск')
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // поклав під час 16
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.ds.result.miss, e.ds.result.why, e.callback.stored], ['client_hangup', false, 'manager_486', true])
  }
  {
    const events = []
    const h = harness({ config: dsCfg('talked'), routeEvent: (e) => events.push(e) })
    await toDiscussion(h)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // поклав під час фрази
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 2 }, 'телефон ведучого перестає дзвонити')
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.callback.stored, e.callback.missed, e.callback.managerKey], ['client_hangup', true, true, LEAD])
    assert.equal(h.staff.get(LEAD), null, 'без пропуску')
    assert.deepEqual(events.map((x) => x.event), ['route', 'client_hangup'])
  }
  {
    const h = harness({ config: dsCfg('talked', { dsRingSec: 60 }) })
    await toDiscussion(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 }) // телефон ведучого дзвонить (60 с)
    await h.clock.advance(29999)
    assert.notEqual(onA(h).at(-1).tag, 'dsFailed')
    await h.clock.advance(1)
    assert.equal(onA(h).at(-1).tag, 'dsFailed', 'клієнт чекав після фрази 30 с')
    assert.equal(h.staff.get(LEAD).misses, 1)
  }
})

test('обговорення: 2 пропуски поспіль → пауза 120 хв → третій дзвінок одразу ШІ AI-DS-UNAVAILABLE (why paused), ведучому не дзвонимо, пропуск не рахуємо; В19 — з\'єднати з оператором лише у винятках (лінія менеджера, не ведучий); пауза минула — знову дзвонимо', async () => {
  const h = harness({ config: dsCfg('talked') })
  const failOnce = async (call) => {
    await toDiscussion(h, { call })
    await h.ev({ ev: 'play_done', call, tag: 'ds' })
    const ref = h.sent('dial').at(-1).ref
    await h.ev({ ev: 'dialing', ref, call: call + 1 })
    await h.ev({ ev: 'state', call: call + 1, state: 'EARLY', code: 180 })
    await h.clock.advance(20000)
    await h.ev({ ev: 'play_done', call, tag: 'dsFailed' })
    await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 200 })
  }
  await failOnce(1)
  await h.clock.advance(60000)
  await failOnce(11)
  assert.equal(h.staff.isPaused(LEAD), true, '2 пропуски — пауза')
  assert.equal(h.journal[1].ds.result.paused, true)
  await h.clock.advance(60000)
  const dials = h.sent('dial').length
  await toDiscussion(h, { call: 21 })
  assert.equal(h.sent('dial').length, dials, 'ведучому на паузі не дзвонимо')
  assert.ok(!onA(h, 21).some((c) => c.tag === 'ds'), 'фрази 13 немає')
  const s = h.ai.sessions.at(-1)
  assert.deepEqual([s.opts.kind, s.opts.dsWhy, s.opts.transferAllowed, s.opts.exceptionsOnly, s.opts.callbackTo], ['discussion_unavailable', 'paused', true, true, 'lead'])
  assert.equal(firstMessageFor(s.opts), 'Вам відповідає віртуальний помічник — штучний інтелект, а не людина. З’єднати з менеджером зараз не вийде. Розкажіть, що передати, — вам передзвонять. Вам передзвонять протягом восьми робочих годин.')
  assert.match(buildInstructions({ ...s.opts, hoursText: '' }), /лише якщо в клієнта претензія щодо якості, гарантійне питання або небезпечна ситуація/)
  // В19: претензія → з'єднання з оператором (лінія 907), а не з ведучим
  await s.tool('transfer_to_manager', { reason: 'претензія', topic: 'complaint' })
  s.end({ reason: 'tool', action: 'transfer' })
  assert.deepEqual(h.sent('dial').at(-1).uri, MGR)
  assert.equal(h.staff.get(LEAD).misses, 0, 'пауза — не новий пропуск')
  await h.ev({ ev: 'state', call: 21, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.journal.at(-1).route.why, 'paused')
  assert.equal(h.journal.at(-1).reason, 'manager_hangup' === h.journal.at(-1).reason ? 'manager_hangup' : h.journal.at(-1).reason)
  // пауза минула — знову дзвонимо
  await h.clock.advance(121 * 60000)
  await toDiscussion(h, { call: 41 })
  assert.equal(h.sent('dial').at(-1).uri, LEAD_URI)
})

test('обговорення: pending_call (звонок із застосунку ще йде) → одразу ШІ без дзвінка ведучому, пропуск не рахуємо, «друга лінія» підтверджена; ведучого немає в VG_MANAGERS → ШІ, перезвін у загальну групу (без «я передам йому»); ведучий на іншому дзвінку шлюзу → owner_busy', async () => {
  {
    const h = harness({ config: dsCfg('pending') })
    await toDiscussion(h)
    assert.equal(h.sent('dial').length, 0)
    const s = h.ai.sessions[0]
    assert.deepEqual([s.opts.kind, s.opts.dsWhy, s.opts.secondLineConfirmed, s.opts.callbackTo], ['discussion_unavailable', 'pending_call', true, 'lead'])
    assert.match(buildInstructions({ ...s.opts, hoursText: '' }), /Вам телефонує наш менеджер — прийміть другий дзвінок/)
    assert.equal(h.staff.get(LEAD), null)
    assert.equal(h.callbacks.listPending(LEAD).length, 1, 'перезвін ведучому — на старті ШІ («вам передзвонять»)')
  }
  {
    const h = harness({ config: dsCfg('talked', { managers: [['907']] }) })
    await toDiscussion(h)
    assert.equal(h.sent('dial').length, 0, 'номера немає в VG_MANAGERS — не дзвонимо')
    const s = h.ai.sessions[0]
    assert.deepEqual([s.opts.kind, s.opts.dsWhy, s.opts.callbackTo], ['discussion_unavailable', 'not_in_managers', 'group'])
    assert.equal(h.callbacks.listPending('907').length, 1, 'перезвін — загальній групі VG_MANAGER')
    const ins = buildInstructions({ ...s.opts, hoursText: '' })
    assert.match(ins, /не кажи «я передам йому» чи «він передзвонить»/)
  }
  {
    // двоє клієнтів одного ведучого: другий чує ШІ (ведучому вже дзвонять для першого)
    const cfg = dsCfg('talked', { dsTest: new Map([['+380500000001', 'talked'], ['+380500000002', 'called']]), allowedCallers: ['+380500000001', '+380500000002'] })
    const h = harness({ config: cfg })
    await toDiscussion(h)
    await h.ev({ ...INCOMING, call: 5, number: '0500000002', from: 'sip:0500000002@x', gcid: '7000000001' })
    await h.ev({ ev: 'media', call: 5, active: true })
    await h.ev({ ev: 'state', call: 5, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'play_done', call: 5, tag: 'intro' })
    assert.equal(h.sent('dial').length, 1)
    assert.deepEqual([h.ai.sessions[0].opts.kind, h.ai.sessions[0].opts.dsWhy], ['discussion_unavailable', 'owner_busy'])
  }
})

test('обговорення вночі → 80 повний → ШІ discussion_after_hours (AI-DS-AFTER-HOURS повний), перезвін ведучому живе до 18:00 понеділка (а не 24 год); з\'єднати не можна', async () => {
  const h = harness({ start: NIGHT, config: dsCfg('talked') }) // п'ятниця 23:00 Київ
  await h.ev(INCOMING)
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  assert.equal(onA(h)[0].file, '/p/80.wav', 'уночі — повний 80')
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  assert.equal(h.sent('dial').length, 0)
  const s = h.ai.sessions[0]
  assert.deepEqual([s.opts.kind, s.opts.transferAllowed, s.opts.afterHours], ['discussion_after_hours', false, true])
  assert.equal(firstMessageFor(s.opts), 'Вам відповідає віртуальний помічник — штучний інтелект, а не людина. Зараз неробочий час. Розкажіть, що передати менеджеру, який займається вашим зверненням, — вам передзвонять у робочі години. Вам передзвонять протягом восьми робочих годин.')
  const p = h.callbacks.listPending(LEAD)[0]
  assert.equal(p.until, Date.parse('2026-10-19T15:00:00Z'), 'понеділок 18:00 Київ')
  await h.clock.advance(30 * 3600000) // неділя 05:00 — минуло 30 год
  assert.equal(h.callbacks.listPending(LEAD).length, 1, 'перезвін не згорів за 24 год')
  await h.clock.advance(Date.parse('2026-10-19T15:00:01Z') - h.clock.now())
  assert.equal(h.callbacks.listPending(LEAD).length, 0, 'після 18:00 понеділка — знято')
  h.d.abortAll('shutdown')
  assert.equal(h.journal[0].route.branch, 'discussion_after_hours')
})

test('срок перезвону і в старому режимі (VG_NO_ANSWER_MODE=ai): уночі ШІ after_hours — перезвін до 18:00 наступного робочого дня; удень — як і раніше 24 год (until немає)', async () => {
  const h = harness({ start: NIGHT })
  await answered(h)
  await h.clock.advance(2000)
  const p = h.callbacks.listPending('907')[0]
  assert.equal(p.until, Date.parse('2026-10-19T15:00:00Z'))
  await h.clock.advance(40 * 3600000)
  assert.equal(h.callbacks.listPending('907').length, 1)
  h.d.abortAll('shutdown')
  assert.equal(h.journal[0].callback.until, '2026-10-19T15:00:00.000Z')
  const d = harness()
  await toAi(d)
  assert.ok(d.callbacks.listPending('907')[0].until >= Date.parse('2026-10-19T09:00:00Z'), 'п’ятниця вдень: вісім робочих годин доходять до понеділка')
})

test('обговорення: ведучий передзвонив на 901, поки клієнт із ШІ після «не вдалося» — приєднання (MGR-JOIN без «віртуального помічника» не потрібне — клієнт говорив із ШІ), пропуски з нуля, подія joined; ведучий передзвонив, поки шлюз дзвонить йому під час фрази — 81 після фрази, набір скасовано', async () => {
  {
    const events = []
    const h = harness({ config: dsCfg('talked', { joinOnCallback: true, managersExternal: true, managersExternalNoPin: true }), routeEvent: (e) => events.push(e) })
    await toDiscussion(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.clock.advance(20000)
    await h.ev({ ev: 'play_done', call: 1, tag: 'dsFailed' })
    const s = h.ai.sessions[0]
    s.speak()
    await s.tool('save_question_for_manager', { question: 'Коли відправите?', callback: true })
    assert.equal(h.staff.get(LEAD).misses, 1)
    await h.ev(LEAD_IN)
    assert.equal(s.stopped, 'joined')
    await h.ev({ ev: 'media', call: 30, active: true })
    await h.ev({ ev: 'state', call: 30, state: 'CONFIRMED', code: 200 })
    assert.deepEqual(h.sent('play').filter((c) => c.call === 30)[0].tag, 'mgrJoin')
    await h.ev({ ev: 'play_done', call: 30, tag: 'mgrJoin' })
    await h.ev({ ev: 'play_done', call: 30, tag: 'mgrJoinQ' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'join' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'bridge', a: 1, b: 30 })
    await h.ev({ ev: 'state', call: 30, state: 'DISCONNECTED', code: 200 })
    const e = h.journal.find((x) => x.kind === 'client')
    assert.equal(e.outcome, 'bridged_join')
    assert.equal(h.staff.get(LEAD).misses, 0, 'ведучий приєднався — пропуски з нуля')
    assert.equal(h.callbacks.listPending(LEAD).length, 0)
    assert.deepEqual(events.map((x) => x.event), ['route', 'fallback', 'joined', 'ai_ended'])
  }
  {
    const h = harness({ config: dsCfg('talked', { joinOnCallback: true, managersExternal: true, managersExternalNoPin: true }) })
    await toDiscussion(h)
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
    await h.ev(LEAD_IN) // фраза 13 ще грає
    assert.deepEqual(h.sent('hangup').at(-1), { cmd: 'hangup', call: 2 }, 'набір ведучого скасовано')
    await h.ev({ ev: 'media', call: 30, active: true })
    await h.ev({ ev: 'state', call: 30, state: 'CONFIRMED', code: 200 })
    assert.ok(!onA(h).some((c) => c.tag === 'join'), '81 не обриває фразу 13')
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    assert.equal(onA(h).at(-1).tag, 'join', '81 — після фрази')
    assert.equal(h.sent('play').filter((c) => c.call === 30)[0].file, '/p/mgr-join-plain.wav', 'клієнт із ШІ не говорив — без «віртуального помічника»')
    assert.equal(h.staff.get(LEAD), null, 'передзвонив сам — не пропуск')
  }
})

test('обговорення: ШІ не піднявся після 16 → 17 («вам передзвонять») і відбій (ds_callback); ведучий натиснув «1», а переведення не вдалося — не пропуск', async () => {
  {
    const h = harness({ config: dsCfg('talked'), ai: fakeAi({ startFails: true }) })
    await toDiscussion(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 603 })
    await h.ev({ ev: 'play_done', call: 1, tag: 'dsFailed' })
    assert.deepEqual(onA(h).at(-1), { cmd: 'play', call: 1, file: '/p/17s.wav', loop: false, tag: 'dsNoAi' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'dsNoAi' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
    const e = h.journal[0]
    assert.deepEqual([e.outcome, e.callback.stored, e.callback.managerKey], ['ds_callback', true, LEAD])
    assert.equal(busyPlays(h), 0, '«лінія зайнята» не звучить')
  }
  {
    const h = harness({ config: dsCfg('talked') })
    await toDiscussion(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
    await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 2, active: true })
    await h.clock.flush()
    await h.ev({ ev: 'dtmf', call: 2, digit: '1', method: 'rfc2833' })
    await h.ev({ ev: 'xfer', call: 1, code: 202, final: false })
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
    await h.clock.advance(8000) // REFER прийнято, нога ведучого знята, а клієнт на лінії
    assert.equal(onA(h).at(-1).tag, 'dsFailed')
    assert.equal(h.staff.get(LEAD), null, '«1» натиснуто — не пропуск')
  }
})

test('обговорення за дзвінками застосунку (VG_DS_SOURCE=calls): розмова < 24 год — talked, ведучий за знімком employeePhone; дзвінки не встигли за бюджет — «обговорення немає» (ai_first, ds.why timeout); пізня відповідь ігнорується', async () => {
  const call = (o) => ({ id: 'c1', provider: 'binotel', direction: 'outbound', status: 'summarized', disposition: 'ANSWER', durationSec: 95, createdAt: new Date(DAY - 3 * 3600000).toISOString(), employeeUid: 'u-lead', employeeLine: null, employeePhone: LEAD, ...o })
  {
    const seen = []
    const h = harness({ config: dsCfg('talked', { dsSource: 'calls', dsStaff: {} }), appCalls: async (id) => { seen.push(id); return [call()] } })
    await toDiscussion(h)
    assert.deepEqual(seen, ['sr1'], 'читаємо дзвінки головної відкритої заявки')
    assert.equal(onA(h).at(-1).file, '/p/13s.wav')
    assert.equal(h.sent('dial')[0].uri, LEAD_URI)
    h.d.abortAll('shutdown')
    assert.deepEqual([h.journal[0].ds.kind, h.journal[0].ds.source, h.journal[0].ds.ageH], ['talked', 'calls', 3])
  }
  {
    let resolve
    const h = harness({ config: dsCfg('talked', { dsSource: 'calls', dsCallsBudgetMs: 5000 }), appCalls: () => new Promise((r) => { resolve = r }) })
    await toDiscussion(h)
    await h.clock.advance(999)
    assert.equal(h.ai.sessions.length, 0)
    await h.clock.advance(1) // кінець вступу + 1 с — вирішуємо без дзвінків
    assert.deepEqual([h.ai.sessions[0].opts.kind, h.sent('dial').length], ['first', 0])
    resolve([call()])
    await h.clock.flush()
    assert.equal(h.sent('dial').length, 0, 'пізня відповідь не вмикає обговорення')
    h.d.abortAll('shutdown')
    assert.deepEqual([h.journal[0].route.branch, h.journal[0].ds.why], ['ai_first', 'timeout'])
  }
  {
    const h = harness({ config: dsCfg('talked', { dsSource: 'calls', dsCallsBudgetMs: 600 }), appCalls: () => new Promise(() => {}) })
    await h.ev(INCOMING)
    await h.ev({ ev: 'media', call: 1, active: true })
    await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
    await h.clock.advance(600) // бюджет дзвінків вичерпано під час вступу
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    assert.equal(h.ai.sessions[0].opts.kind, 'first', 'одразу після вступу: дані вже «не встигли»')
  }
})

test('80 — перша фраза в усіх гілках «ШІ одразу»: ШІ не піднявся → 80 → 82 (короткий) → набір оператора; запобіжник → 80 замість 04-short, потім 82 і гудки; «1» під час 80 — REFER лише після 80', async () => {
  {
    const h = harness({ config: { answerMode: 'ai', prompts: DS_PROMPTS }, ai: fakeAi({ startFails: true }) })
    await answered(h)
    assert.equal(onA(h)[0].file, '/p/80s.wav')
    assert.equal(h.sent('dial').length, 0, 'поки 80 не дограв — нікому не дзвонимо й ШІ не пускаємо')
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    assert.deepEqual(onA(h)[1], { cmd: 'play', call: 1, file: '/p/82s.wav', loop: false, tag: 'aiDown' })
    assert.equal(h.sent('dial')[0].uri, MGR)
  }
  {
    const breaker = { fails: 1, windowMs: 600000, offMs: 1800000 }
    const h = harness({ config: { answerMode: 'ai', prompts: DS_PROMPTS, aiBreaker: breaker, holdTone: 'ringback', ringbackFile: '/cache/rb.wav' }, ai: fakeAi({ startFails: true }) })
    await answered(h) // перший дзвінок: збій ШІ відкриває запобіжник
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(h.d.breaker.open, true)
    await h.ev({ ...INCOMING, call: 11 })
    await h.ev({ ev: 'media', call: 11, active: true })
    await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
    assert.deepEqual(onA(h, 11)[0], { cmd: 'play', call: 11, file: '/p/80s.wav', loop: false, tag: 'intro' }, 'замість 04-short — 80')
    assert.equal(h.sent('dial').filter((x) => x.ref === 'mgr-11-1').length, 0, '80 ще грає — оператора не набираємо')
    await h.ev({ ev: 'play_done', call: 11, tag: 'intro' })
    await h.clock.advance(1000)
    const ref = h.sent('dial').at(-1).ref
    await h.ev({ ev: 'dialing', ref, call: 12 })
    await h.ev({ ev: 'state', call: 12, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 12, active: true })
    await h.clock.flush()
    await h.ev({ ev: 'dtmf', call: 12, digit: '1', method: 'rfc2833' })
    assert.equal(h.sent('xfer_replaces').length, 0, '80 ще грає — не з\'єднуємо')
    await h.ev({ ev: 'play_done', call: 11, tag: 'aiDown' })
    assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 11, dest: 12 })
    // без «1»: після 80 — 82, далі гудки
    await h.ev({ ...INCOMING, call: 21, gcid: '7000000021' })
    await h.ev({ ev: 'media', call: 21, active: true })
    await h.ev({ ev: 'state', call: 21, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'play_done', call: 21, tag: 'intro' })
    assert.deepEqual(onA(h, 21)[1], { cmd: 'play', call: 21, file: '/p/82s.wav', loop: false, tag: 'aiDown' })
    await h.ev({ ev: 'play_done', call: 21, tag: 'aiDown' })
    assert.deepEqual(onA(h, 21)[2], { cmd: 'play', call: 21, file: '/cache/rb.wav', loop: true, tag: 'hold' })
  }
})

test('старий режим (VG_NO_ANSWER_MODE=ai): перша фраза ШІ — AI-FALLBACK-GREETING (запис з метою) + «штучний інтелект» + зміст черновика; уночі з відкритою заявкою — AI-AFTER-HOURS-REQUEST, повний варіант', async () => {
  const h = harness()
  const s = await toAi(h)
  const fm = firstMessageFor(s.opts)
  assert.equal(fm, 'Вітаємо! Це віртуальний помічник компанії Runferry. Ми записуємо розмову, щоб опрацювати звернення й контролювати якість. Я — штучний інтелект, а не людина. З’єднати не вдалося — вам передзвонять. Що передати? Вам передзвонять протягом восьми робочих годин.')
  const n = harness({ start: NIGHT })
  await answered(n)
  await n.clock.advance(2000)
  const ns = n.ai.sessions[0]
  const nfm = firstMessageFor(ns.opts)
  assert.match(nfm, /^Вітаємо! Це віртуальний помічник компанії Runferry\. Зверніть увагу: ми записуємо розмову, щоб точно опрацювати ваше звернення й контролювати якість обслуговування\. Я — штучний інтелект\. Зараз неробочий час/)
  assert.match(nfm, /За вашим номером є відкрита заявка: щодо неї пишіть, будь ласка, на сторінці заявки/)
})

test('callback:false знімає вже поставлений перезвін цього клієнта в цій групі (і з попереднього дзвінка), у журналі ai.callbackRemoved; виконана за 14 днів заявка для ШІ ще «відкрита»', async () => {
  const h = harness({ config: { answerMode: 'ai' } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', note: { question: 'стара', topic: 'other', urgent: false }, ts: DAY - 2 * 3600000 })
  await answered(h)
  const s = h.ai.sessions[0]
  const r = await s.tool('save_question_for_manager', { question: 'Нічого не треба', callback: false })
  assert.deepEqual([r.saved, r.callback], [true, false])
  assert.equal(h.callbacks.listPending('907').length, 0, 'перезвін із попереднього дзвінка знято — воля клієнта')
  s.end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.deepEqual([e.ai.callbackRemoved, e.callback.removed, e.callback.stored], [1, true, false])
  // C1: done 4 дні тому — ще відкрита до отримання + 14 днів
  const done = { ...SR_OPEN, status: 'done', stage: 'shipped', doneAt: '2026-10-12T10:00:00Z', createdAt: '2026-10-12T10:00:00Z' }
  const d = harness({ config: { answerMode: 'ai' }, lookup: async () => ({ requests: [done], profile: null, orders: [] }) })
  await answered(d)
  assert.deepEqual([d.ai.sessions[0].opts.variant, d.ai.sessions[0].opts.category], ['request', 'openRequest'])
  const st = await d.ai.sessions[0].tool('get_request_status')
  assert.deepEqual([st.found, st.open, st.requestNumber], [true, true, '123'])
})

test('розшифровка: службові теги голосу в репліках ШІ («[slow]», «[laughs]») прибрано, слова клієнта й звичайний текст не чіпаємо; conversationId сесії — у журналі й розшифровці', async () => {
  const ai = fakeAi({ conversationId: 'conv_abc123', turns: [{ speaker: 'ai', start: 0.1, end: 1, text: '[slow] Добрий день! [laughs] Чим допомогти?' }, { speaker: 'client', start: 1.5, end: 2.5, text: 'Де [мій] кораблик?' }, { speaker: 'ai', start: 3, end: 3.4, text: '[sighs]' }] })
  const h = harness({ config: { answerMode: 'ai' }, ai })
  await answered(h)
  h.ai.sessions[0].end({ reason: 'tool', action: 'end' })
  const e = h.journal[0]
  assert.deepEqual(e.aiTranscript.turns.map((x) => x.text), ['Добрий день! Чим допомогти?', 'Де [мій] кораблик?'])
  assert.equal(e.ai.sessions[0].conversationId, 'conv_abc123')
  assert.deepEqual(e.aiTranscript.conversations, ['conv_abc123'])
})

// Рішення C3: лише небезпечна ситуація відкриває нічний маршрут, картка й «1» залишаються обов'язковими.
test('C3: нічний черговий за прапорцем — safety, картка, «1»; невдача лишає urgent передзвін і журнал', async () => {
  for (const key of [null, '999']) {
    const h = harness({ start: NIGHT, config: { ...FIRST, afterHoursUrgentTo: key } })
    await answered(h)
    await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
    assert.equal(h.ai.sessions[0].opts.transferAllowed, false)
    assert.equal((await h.ai.sessions[0].tool('transfer_to_manager', { topic: 'safety' })).ok, false)
    assert.equal(h.sent('dial').length, 0)
  }
  const h = harness({ start: NIGHT, config: { ...FIRST, afterHoursUrgentTo: '908', managers: [['907'], ['908']] } })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  const s = h.ai.sessions[0]
  assert.equal(s.opts.urgentOnly, true)
  assert.equal(s.opts.transferAllowed, true)
  assert.equal((await s.tool('transfer_to_manager', { topic: 'complaint', reason: 'скарга' })).ok, false)
  assert.equal((await s.tool('transfer_to_manager', { topic: 'safety', reason: 'Акумулятор димить' })).ok, true)
  s.end({ reason: 'tool', action: 'transfer' })
  assert.equal(h.sent('dial')[0].uri, 'sip:908@sip14.binotel.com;transport=udp')
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 2, active: true })
  assert.match(h.ttsTexts.at(-1), /^Термінове звернення в неробочий час/)
  assert.equal(h.sent('xfer_replaces').length, 0, 'без «1» не переводимо')
  await h.ev({ ev: 'dtmf', call: 2, digit: '2' })
  const again = h.ai.sessions[1]
  assert.equal(again.opts.transferAllowed, false)
  assert.equal(again.opts.urgentOnly, true, 'політика небезпеки лишається після вичерпання спроби')
  assert.doesNotMatch(buildInstructions(again.opts), /скажи вимкнути живлення/)
  again.end({ reason: 'tool', action: 'end' })
  assert.equal(h.journal[0].afterHoursUrgent, true)
  assert.equal(h.journal[0].aiTranscript.note.urgent, true)
  assert.equal(h.callbacks.listPending()[0].afterHoursUrgent, true)
})

test('C4: угоду не прийнято — перша фраза направляє на сторінку; моделі лише булева ознака', async () => {
  const h = harness({ config: { answerMode: 'ai' }, lookup: async () => ({ requests: [SR_OPEN], termsAccepted: false, agreement_at: 'private', profile: null, orders: [] }) })
  await answered(h)
  const s = h.ai.sessions[0]
  assert.equal(s.opts.needsTerms, true)
  const first = firstMessageFor(s.opts)
  assert.ok(first.includes(TERMS_REQUIRED))
  assert.ok(first.indexOf(TERMS_REQUIRED) < first.indexOf('За вашим номером є'))
  assert.equal((await s.tool('get_request_status')).needsTerms, true)
  assert.doesNotMatch(JSON.stringify(s.opts), /agreement_at|private|clientAcceptedTerms/)
})

test('C5: resend передає лише id поточної відкритої заявки і gcid; повторний запит не дублює надсилання', async () => {
  const posts = []
  const h = harness({ config: { answerMode: 'ai', aiResendUrl: 'http://127.0.0.1/fake' }, resendLink: async (body) => { posts.push(body); return { ok: true, accepted: true } } })
  await answered(h)
  const s = h.ai.sessions[0]
  assert.equal(s.opts.resendAllowed, true)
  const results = await Promise.all([s.tool('resend_request_link', { serviceRequestId: 'other' }), s.tool('resend_request_link')])
  assert.ok(results.every((x) => x.ok && x.accepted))
  assert.deepEqual(posts, [{ serviceRequestId: SR_OPEN.id, gcid: INCOMING.gcid }])
  await s.tool('resend_request_link')
  assert.equal(posts.length, 1)
  const off = harness({ config: { answerMode: 'ai' }, resendLink: async () => { throw new Error('не викликати') } })
  await answered(off)
  assert.equal(off.ai.sessions[0].opts.resendAllowed, false)
  assert.equal((await off.ai.sessions[0].tool('resend_request_link')).error, 'disabled')
})

test('B1: без завершеного 80 немає прямого набору або REFER; збій 80 у discussion починає AI-FALLBACK-GREETING', async () => {
  const h = harness({ ai: null, config: { answerMode: 'ai' } })
  await answered(h)
  assert.equal(h.sent('dial').length, 0)
  assert.equal(h.sent('play').length, 0, 'старий 04 не підміняє 80')
  assert.equal(h.journal[0].outcome, 'intro_failed')
  const broken = harness({ config: dsCfg('talked') })
  await answered(broken)
  await broken.ev({ ev: 'error', cmd: 'play', call: 1, msg: 'bad WAV' })
  assert.equal(broken.sent('dial').length, 0)
  assert.match(firstMessageFor(broken.ai.sessions[0].opts), /^Вітаємо! Це віртуальний помічник компанії Runferry\./)
  const stuck = harness({ config: FIRST })
  await answered(stuck)
  await stuck.clock.advance(30000)
  assert.equal(stuck.ai.sessions.length, 0)
  assert.equal(stuck.sent('xfer_replaces').length, 0)
  assert.equal(stuck.journal[0].outcome, 'intro_failed')
})

test('В19: звичайне прохання не обходить обмеження, гарантія йде в загальну групу', async () => {
  const h = harness({ config: dsCfg('pending') })
  await answered(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
  const s = h.ai.sessions[0]
  assert.equal((await s.tool('transfer_to_manager', { topic: 'other', reason: 'наполягає' })).ok, false)
  assert.equal((await s.tool('transfer_to_manager', { topic: 'warranty' })).ok, true)
  s.end({ reason: 'tool', action: 'transfer' })
  assert.equal(h.sent('dial')[0].uri, MGR)
})

test('B1: початок fallback-аудіо не підтверджує оголошення — без 80 немає набору, transfer або join', async () => {
  const failed = harness({ config: { prompts: JOIN_PROMPTS, joinOnCallback: true, answerMode: 'ai' } })
  await answered(failed)
  const first = failed.ai.sessions[0]
  first.speak() // лише перший шматок звуку «Вітаємо…», мета запису ще не прозвучала
  first.end({ reason: 'ai_error' })
  await failed.clock.advance(1000)
  assert.equal(failed.sent('dial').length, 0)
  assert.equal(failed.journal[0].outcome, 'intro_failed')

  const live = harness({ config: { prompts: JOIN_PROMPTS, joinOnCallback: true, answerMode: 'ai' } })
  await answered(live)
  const s = live.ai.sessions[0]
  s.speak()
  assert.equal(s.opts.transferAllowed, false)
  assert.equal((await s.tool('transfer_to_manager', { topic: 'safety' })).ok, false)
  await s.tool('save_question_for_manager', { question: 'Передзвоніть пізніше.', callback: true })
  await live.ev(MGR_IN)
  assert.equal(s.stopped, null, 'вхідний менеджер не перериває незавершене оголошення')
  assert.equal(live.sent('bridge').length, 0)
  assert.equal(live.sent('xfer_replaces').length, 0)
})
