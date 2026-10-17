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
// допуск +1 до maxCalls; двоє клієнтів — кого набирали останнім; REFER-приєднання.
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

const JOIN_PROMPTS = { ...CB_PROMPTS, mgrJoin: '/p/mgr-join.wav', mgrJoinBusy: '/p/mgr-join-busy.wav', mgrJoinGone: '/p/mgr-join-gone.wav', joinClient: '/p/join-client.wav' }
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
  const h = harness({ config: { answerMode: 'ai', holdTone: 'ringback', ringbackFile: '/cache/ringback-425hz.wav' } })
  await answered(h)
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
    const h = harness({ config: { answerMode: 'ai', holdTone: 'ringback', ringbackFile: '/cache/rb.wav' } })
    await answered(h)
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
    const h = harness({ config: { answerMode: 'ai' } })
    await answered(h)
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
  const P = { ...PROMPTS, aiDown: '/p/ai-down.wav' }
  {
    const h = harness({ config: { answerMode: 'ai', prompts: P } })
    await answered(h)
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
  const h = harness({ ai, config: { answerMode: 'ai', aiBreaker: { fails: 2, windowMs: 600000, offMs: 1800000 } } })
  const call = async (id) => {
    await h.ev({ ...INCOMING, call: id })
    await h.ev({ ev: 'media', call: id, active: true })
    await h.ev({ ev: 'state', call: id, state: 'CONFIRMED', code: 200 })
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
  assert.equal(h.sent('play').filter((c) => c.call === 21)[0].tag, 'greeting')
  await h.clock.advance(1000)
  assert.equal(h.sent('dial').at(-1).ref, 'mgr-21-1')
  await h.ev({ ev: 'state', call: 21, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.journal[2].route, { branch: 'classic', why: 'breaker', dataMs: null, decidedBy: null })
  await h.clock.advance(30 * 60000)
  await call(31)
  assert.equal(ai.sessions.length, 3, 'через 30 хв — знову ШІ одразу')
  // без фабрики ШІ: старий режим, у журналі чому
  const h2 = harness({ ai: null, config: { answerMode: 'ai' } })
  await answered(h2)
  assert.equal(h2.sent('play')[0].tag, 'greeting')
  h2.d.abortAll('shutdown')
  assert.deepEqual(h2.journal[0].route, { branch: 'classic', why: 'no_ai', dataMs: null, decidedBy: null })
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

test('ШІ одразу + приєднання: ШІ записав питання → менеджер передзвонив → «Питання клієнта: …» менеджеру (без телефонів), якщо синтез устиг за 2 с → міст; не встиг — без питання', async () => {
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: JOIN_PROMPTS }
  {
    const h = harness({ config: cfg })
    await answered(h)
    const s = h.ai.sessions[0]
    s.speak()
    await s.tool('save_question_for_manager', { question: 'Передзвоніть на 050 000 00 09, мотор не крутиться', topic: 'repair', callback: true })
    await h.ev(MGR_IN)
    assert.equal(s.stopped, 'joined')
    assert.match(h.ttsTexts.at(-1), /^Питання клієнта: .*мотор не крутиться/)
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
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: JOIN_PROMPTS }
  {
    const h = harness({ config: cfg })
    await answered(h)
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
  const cfg = { answerMode: 'ai', joinOnCallback: true, prompts: JOIN_PROMPTS, allowedCallers: ['+380500000001', '+380500000003'] }
  const IN2 = { ...INCOMING, call: 20, number: '0500000003', gcid: '6929148399' }
  const up = async (h, inc) => {
    await h.ev(inc)
    await h.ev({ ev: 'media', call: inc.call, active: true })
    await h.ev({ ev: 'state', call: inc.call, state: 'CONFIRMED', code: 200 })
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
