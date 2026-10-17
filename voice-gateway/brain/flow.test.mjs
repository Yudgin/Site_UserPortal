// Сценарій дзвінка на підробленому рушії і підробленому годиннику: без мережі, без SIP, без Firestore.
// Перша половина — механіка переведення, повторів, запасної і пошти в старому режимі (noAnswerMode 'fallback', без
// підтвердження «1»): вона й далі працює через налаштування. Друга — типовий режим: підтвердження «1»/«2», «лінія
// зайнята» з відкладеним передзвоном і передзвін менеджера.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDispatcher, isAllowed, isInternal, maskNumber, isManagerCaller } from './flow.mjs'
import { makeCallbackStore, parseManagers, resolveManagers, managerKeyOf, partyKey, strictPhone, clientDialUri, CALLBACKS_FILE, LAST_CLIENTS_FILE } from './callbacks.mjs'
import { buildCard } from './card.mjs'

const MGR = 'sip:907@sip14.binotel.com;transport=udp'
const FALLBACK = 'sip:906@sip14.binotel.com;transport=udp'
// Старий режим: менеджер не взяв → запасна → пошта; переведення одразу після картки
const CONFIG = {
  managerUri: MGR,
  fallbackUri: FALLBACK,
  fallbackMode: 'consult',
  noAnswerMode: 'fallback',
  confirmEnabled: false,
  managers: [['907']],
  sipServer: 'sip14.binotel.com',
  clientUriTemplate: 'sip:{national}@{server};transport=udp',
  callbackDialTimeoutSec: 30,
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
  fallbackTimeoutSec: 20,
  mediaGraceMs: 1000,
  ttsWaitMs: 6000,
  afterCardMs: 700,
  cardMaxSec: 20,
  xferTimeoutMs: 8000,
  fallbackRingMs: 90000,
  xferClearMs: 4000,
  bridgeMaxMin: 60,
  lateEventsMs: 60000,
  allowedInternal: [],
  voicemailEnabled: true,
  voicemailPromptFile: '/p/voicemail.wav',
  beepFile: '/cache/beep.wav',
  voicemailMaxSec: 60,
}

// Годинник з ручним ходом: advance() виконує таймери по черзі й дає відпрацювати промісам між ними.
function fakeClock(start = Date.parse('2026-10-16T10:00:00Z')) {
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

function harness({ config = {}, lookup, tts, buildCard, voicemailPath, callbacks } = {}) {
  const cmds = []
  const journal = []
  const logs = []
  const vmCalls = []
  const clock = fakeClock()
  // Сховище передзвонів — у пам'яті, на тому самому підробленому годиннику (TTL)
  const store = callbacks === undefined ? makeCallbackStore({ now: clock.now }) : callbacks
  const d = createDispatcher({
    config: { ...CONFIG, ...config },
    send: (c) => cmds.push(c),
    clock,
    lookup: lookup === undefined ? async () => ({ requests: [{ id: 'sr1' }], profile: null, orders: [] }) : lookup,
    buildCard: buildCard || ((res, { number }) => ({ text: `Дзвонить ${number}.`, category: res ? 'openRequest' : null, serviceRequestId: res ? 'sr1' : null })),
    tts: tts === undefined ? async () => ({ file: '/cache/card-1.wav', cached: false }) : tts,
    voicemailPath: voicemailPath === undefined ? (o) => { vmCalls.push(o); return `/data/voicemail/2026-10-16/${o.gcid}-${String(o.number).slice(-4)}.wav` } : voicemailPath,
    callbacks: store,
    log: (m) => logs.push(m),
    onDone: (e) => journal.push(e),
  })
  const ev = async (e) => { d.handle(e); await clock.flush() }
  const sent = (name) => cmds.filter((c) => c.cmd === name)
  const has = (pred) => cmds.some(pred)
  return { d, cmds, journal, logs, clock, ev, sent, has, vmCalls, callbacks: store }
}

const INCOMING = { ev: 'incoming', call: 1, from: 'sip:0500000001@45.91.130.64', number: '0500000001', name: 'RUN Call Test', gcid: '6929148313', to: 'sip:901@sip14.binotel.com' }

// Клієнт подзвонив, відповіли, медіа піднялося, пішло привітання; через 1 с — набір менеджера (call 2).
async function answeredAndDialing(h, { bCall = 2 } = {}) {
  await h.ev(INCOMING)
  assert.deepEqual(h.cmds[0], { cmd: 'answer', call: 1, code: 200 })
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  assert.deepEqual(h.sent('play')[0], { cmd: 'play', call: 1, file: '/p/greeting.wav', loop: false, tag: 'greeting' })
  assert.equal(h.sent('dial').length, 0)
  await h.clock.advance(999)
  assert.equal(h.sent('dial').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('dial')[0], { cmd: 'dial', ref: 'mgr-1-1', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: bCall })
  await h.ev({ ev: 'state', call: bCall, state: 'CALLING', code: 0 })
}

async function managerAnswers(h, bCall = 2) {
  await h.ev({ ev: 'state', call: bCall, state: 'EARLY', code: 180 })
  await h.ev({ ev: 'state', call: bCall, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: bCall, active: true })
}

test('щасливий шлях: відповідь, привітання, утримання, набір, картка, xfer_replaces, з\'єднано', async () => {
  const h = harness()
  await answeredAndDialing(h)
  // привітання закінчилось → утримання по колу
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  assert.deepEqual(h.sent('play')[1], { cmd: 'play', call: 1, file: '/p/hold.wav', loop: true, tag: 'hold' })
  await managerAnswers(h)
  assert.deepEqual(h.sent('play')[2], { cmd: 'play', call: 2, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(699)
  assert.equal(h.sent('xfer_replaces').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Trying', final: false })
  await h.ev({ ev: 'xfer', call: 1, code: 200, reason: 'OK', final: true })
  assert.equal(h.journal.length, 0) // ноги ще живі — чекаємо, поки АТС їх погасить
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.journal.length, 1)
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.gcid, '6929148313')
  assert.equal(e.number, '+380500000001')
  assert.equal(e.category, 'openRequest')
  assert.equal(e.serviceRequestId, 'sr1')
  assert.equal(e.cardSource, 'tts')
  assert.equal(e.retries, 0)
  assert.equal(e.xferCode, 200)
  assert.equal(e.lookup, 'ok')
  assert.equal(e.answeredBy, 'manager')
  assert.equal(e.voicemail, null)
  assert.deepEqual(e.dials, [{ to: 'manager', attempt: 1, at: 1000, code: 200 }])
  for (const k of ['answer', 'greeting', 'hold', 'dial', 'managerAnswered', 'card', 'cardDone', 'xfer', 'xferFinal', 'end']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(e.t.xfer - e.t.cardDone, 700)
  assert.equal(h.sent('hangup').length, 0) // АТС сама поклала обидві ноги
  assert.equal(h.sent('bridge').length, 0)
  assert.equal(h.d.active, 0)
})

test('набір: 503 до відповіді → повтор через 2 с, далі успіх; жива нога через 4 с після переведення — кладемо', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503, reason: 'Service Unavailable' })
  await h.clock.advance(1999)
  assert.equal(h.sent('dial').length, 1)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('dial')[1], { cmd: 'dial', ref: 'mgr-1-2', uri: MGR })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await managerAnswers(h, 3)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 3, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 3 }])
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  await h.clock.advance(4000) // A так і не погасили
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }])
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.retries, 1)
  assert.deepEqual(e.dials.map((x) => x.code), [503, 200])
})

test('blind: менеджер не взяв за 25 с → кладемо B, сліпе переведення A на запасну лінію (старий шлях)', async () => {
  const h = harness({ config: { fallbackMode: 'blind' } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(24999)
  assert.equal(h.sent('xfer').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 2 }])
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'fallback')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(h.sent('xfer_replaces').length, 0)
})

test('blind: менеджер зайнятий (486) → одразу сліпе переведення, без повторів', async () => {
  const h = harness({ config: { fallbackMode: 'blind' } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486, reason: 'Busy Here' })
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  assert.equal(h.sent('hangup').length, 0) // B вже немає
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.clock.advance(4000)
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h.journal[0].outcome, 'fallback')
  assert.equal(h.journal[0].reason, 'manager_486')
  assert.equal(h.journal[0].retries, 0)
})

test('blind: VG_DIAL_RETRIES=2 обмежує повтори (503 тричі) → сліпе переведення', async () => {
  const h = harness({ config: { fallbackMode: 'blind', dialRetries: 2 } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503 })
  await h.clock.advance(2000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 503 })
  await h.clock.advance(2000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 4 })
  await h.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 503 })
  assert.equal(h.sent('dial').length, 3)
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  assert.equal(h.journal[0].retries, 2)
  assert.equal(h.journal[0].reason, 'manager_503')
  assert.equal(h.journal[0].fallbackMode, 'blind')
})

test('переведення не вдалося (фінальний 503) → локальний міст A↔B; менеджер поклав — кладемо клієнта', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 1, code: 202, final: false })
  await h.ev({ ev: 'xfer', call: 1, code: 503, reason: 'Service Unavailable', final: true })
  assert.deepEqual(h.sent('bridge'), [{ cmd: 'bridge', a: 1, b: 2 }])
  assert.equal(h.journal.length, 0)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }])
  const e = h.journal[0]
  assert.equal(e.outcome, 'bridged')
  assert.equal(e.xferCode, 503)
  assert.ok(e.errors.some((x) => x.where === 'xfer'))
})

test('клієнт поклав під час картки → кладемо B, переведення немає', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  assert.equal(h.sent('play').at(-1).tag, 'card')
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 2 }])
  await h.clock.advance(30000)
  assert.equal(h.sent('xfer_replaces').length, 0)
  assert.equal(h.sent('xfer').length, 0)
  assert.equal(h.journal.length, 1)
  assert.equal(h.journal[0].outcome, 'client_hangup')
})

test('клієнт поклав, поки набір менеджера ще не підтверджено рушієм → запізнілий dialing кладемо', async () => {
  const h = harness()
  await h.ev(INCOMING)
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED' })
  await h.clock.advance(1000)
  assert.equal(h.sent('dial').length, 1)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  assert.equal(h.journal[0].outcome, 'client_hangup')
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 2 }])
})

test('номер не з білого списку → 486 без відповіді; внутрішній тризначний — пропускаємо', async () => {
  const h = harness()
  await h.ev({ ...INCOMING, number: '0631234567', from: 'sip:0631234567@45.91.130.64' })
  assert.deepEqual(h.cmds, [{ cmd: 'hangup', call: 1, code: 486 }])
  assert.equal(h.journal[0].outcome, 'rejected')
  assert.equal(h.journal[0].reason, 'not_allowed')
  // чужий номер — у журналі й статусі лише останні 4 цифри
  assert.equal(h.journal[0].number, '…4567')
  assert.ok(!h.logs.some((l) => l.includes('0631234567') || l.includes('631234567')))
  assert.ok(!JSON.stringify(h.journal[0]).includes('631234567'))
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 486 })
  assert.equal(h.journal.length, 1)

  await h.ev({ ev: 'incoming', call: 5, number: '905', from: 'sip:905@sip14.binotel.com', gcid: null })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 5, code: 200 })
  assert.equal(isAllowed('907', []), true)
  assert.equal(isAllowed('+380 50 000 00 01', ['0500000001']), true)
  assert.equal(isAllowed('', ['+380500000001']), false)
  assert.equal(isAllowed('anonymous', ['+380500000001']), false)
})

test('синтез не вдався → загальна картка; немає і її → переведення одразу після afterCardMs', async () => {
  const h = harness({ config: { genericCardFile: '/p/generic.wav' }, tts: async () => { throw new Error('tts HTTP 401') } })
  await answeredAndDialing(h)
  await managerAnswers(h)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 2, file: '/p/generic.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED' })
  assert.equal(h.journal[0].cardSource, 'generic')
  assert.ok(h.journal[0].errors.some((x) => x.where === 'tts' && /401/.test(x.msg)))

  const h2 = harness({ tts: null })
  await answeredAndDialing(h2)
  await managerAnswers(h2)
  assert.equal(h2.sent('play').filter((c) => c.tag === 'card').length, 0)
  await h2.clock.advance(699)
  assert.equal(h2.sent('xfer_replaces').length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
})

test('синтез довший за 6 с → без картки; картка довша за 20 с → переведення за обмеженням', async () => {
  const h = harness({ tts: () => new Promise(() => {}) }) // ніколи не відповідає
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.clock.advance(5999)
  assert.equal(h.sent('xfer_replaces').length, 0)
  await h.clock.advance(1 + 700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])

  const h2 = harness()
  await answeredAndDialing(h2)
  await managerAnswers(h2)
  assert.equal(h2.sent('play').at(-1).tag, 'card')
  await h2.clock.advance(19999)
  assert.equal(h2.sent('xfer_replaces').length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
  await h2.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h2.clock.advance(4000)
  assert.equal(h2.journal[0].reason, 'card_cap')
})

test('картку граємо лише після CONFIRMED: медіа в EARLY (183) не рахується; без події media — через 1 с', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'media', call: 2, active: true }) // ранні медіа
  assert.equal(h.sent('play').filter((c) => c.tag === 'card').length, 0)
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  assert.equal(h.sent('play').filter((c) => c.tag === 'card').length, 1)

  const h2 = harness()
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  assert.equal(h2.sent('play').filter((c) => c.tag === 'card').length, 0)
  await h2.clock.advance(1000)
  assert.equal(h2.sent('play').filter((c) => c.tag === 'card').length, 1)
})

test('blind: менеджер поклав під час картки → сліпе переведення на запасну', async () => {
  const h = harness({ config: { fallbackMode: 'blind' } })
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  assert.equal(h.sent('hangup').length, 0)
  await h.ev({ ev: 'xfer', call: 1, code: 603, final: true })
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h.journal[0].outcome, 'failed')
  assert.equal(h.journal[0].reason, 'manager_hangup')
})

test('після REFER АТС погасила обидві ноги без фінального NOTIFY → connected_unconfirmed', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 1, code: 202, final: false })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED' })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  assert.equal(h.journal.length, 0)
  await h.clock.advance(1000)
  assert.equal(h.journal[0].outcome, 'connected_unconfirmed')
  assert.equal(h.sent('hangup').length, 0)
})

test('диспетчер: стан B раніше за dialing — не губиться; понад maxCalls — 486 busy', async () => {
  const h = harness({ config: { maxCalls: 1 } })
  await h.ev(INCOMING)
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED' })
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.clock.advance(1000)
  // рушій повідомив стан нового виклику до 'dialing'
  await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 2, active: true })
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  assert.equal(h.sent('play').filter((c) => c.tag === 'card' && c.call === 2).length, 1)

  await h.ev({ ...INCOMING, call: 7 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 7, code: 486 })
  assert.equal(h.journal.at(-1).reason, 'busy')

  // невідомий ref (наприклад, від попереднього запуску) — кладемо
  await h.ev({ ev: 'dialing', ref: 'zzz', call: 9 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 9 })
})

test('пошук клієнта впав → картка лише з номером, дзвінок іде далі; abortAll журналить незавершені', async () => {
  let seen = null
  const h = harness({
    lookup: async () => { throw new Error('unavailable') },
    buildCard: (res, o) => { seen = { res, ...o }; return { text: 'Дзвонить номер 050 000 00 01.', category: null, serviceRequestId: null } },
  })
  await answeredAndDialing(h)
  assert.equal(seen.res, null)
  assert.equal(seen.phone, '+380500000001')
  h.d.abortAll('shutdown')
  const e = h.journal[0]
  assert.equal(e.outcome, 'aborted')
  assert.equal(e.abortReason, 'shutdown')
  assert.equal(e.reason, null) // причину по менеджеру abort не затирає (тут її ще немає)
  assert.equal(e.lookup, 'error')
  assert.equal(e.cardChars, 'Дзвонить номер 050 000 00 01.'.length)
  // у журналі немає аудіо і тексту картки
  assert.ok(!JSON.stringify(e).includes('Дзвонить'))
})

test('внутрішній — лише тризначний БЕЗ GCID; з GCID (короткий номер оператора зі сценарію) — відхиляємо; список VG_ALLOWED_INTERNAL', async () => {
  assert.equal(isInternal('907', null), true)
  assert.equal(isInternal('112', '6929148313'), false)
  assert.equal(isAllowed('112', ['+380500000001'], { gcid: '6929148313' }), false)
  assert.equal(isAllowed('905', [], { allowedInternal: ['907', '906'] }), false)
  assert.equal(isAllowed('907', [], { allowedInternal: ['907', '906'] }), true)
  assert.equal(maskNumber('+380631234567'), '…4567')
  assert.equal(maskNumber(''), null)

  const h = harness()
  await h.ev({ ...INCOMING, number: '100', from: 'sip:100@45.91.130.64', name: 'friendly-scanner', gcid: '777' })
  assert.deepEqual(h.cmds, [{ cmd: 'hangup', call: 1, code: 486 }])
  assert.equal(h.journal[0].outcome, 'rejected')
  assert.equal(h.journal[0].internal, false)

  const h2 = harness({ config: { allowedInternal: ['906'] } })
  await h2.ev({ ...INCOMING, call: 3, number: '905', from: 'sip:905@sip14.binotel.com', gcid: null })
  assert.deepEqual(h2.cmds, [{ cmd: 'hangup', call: 3, code: 486 }])
  await h2.ev({ ...INCOMING, call: 4, number: '906', from: 'sip:906@sip14.binotel.com', gcid: null })
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'answer', call: 4, code: 200 })
})

// blind: менеджер не взяв → сліпий REFER на запасну.
const BLIND = { config: { fallbackMode: 'blind' } }
async function toFallback(h) {
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(25000)
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
}

test('blind: REFER прийнято (202, NOTIFY 100/180) — не кладемо клієнта через 8 с, чекаємо фінал (906 взяли на 10-й с)', async () => {
  const h = harness(BLIND)
  await toFallback(h)
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Trying', final: false })
  await h.ev({ ev: 'xfer', call: 1, code: 180, reason: 'Ringing', final: false })
  await h.clock.advance(9999)
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)
  assert.equal(h.journal.length, 0)
  await h.ev({ ev: 'xfer', call: 1, code: 200, reason: 'OK', final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'fallback')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.xferCode, 200)
  assert.ok(e.t.fallbackAccepted != null && e.t.fallbackFinal - e.t.fallback >= 9999)
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)
  // утримання не зупиняли: команд stop не було
  assert.equal(h.sent('stop').length, 0)
})

test('blind: REFER прийнято, АТС поклала A — fallback; фіналу немає 90 с — кладемо A (fallback_unconfirmed)', async () => {
  const h = harness(BLIND)
  await toFallback(h)
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // як Asterisk: BYE одразу після 202
  assert.equal(h.journal[0].outcome, 'fallback')
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)

  const h2 = harness(BLIND)
  await toFallback(h2)
  await h2.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h2.clock.advance(89999)
  assert.equal(h2.journal.length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.sent('hangup').filter((c) => c.call === 1), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h2.journal[0].outcome, 'fallback_unconfirmed')
  assert.ok(h2.journal[0].errors.some((x) => x.where === 'fallback_xfer' && /no final/.test(x.msg)))
})

test('blind: на REFER немає ні 202, ні NOTIFY за 8 с — кладемо A (failed)', async () => {
  const h = harness(BLIND)
  await toFallback(h)
  await h.clock.advance(7999)
  assert.equal(h.journal.length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup').filter((c) => c.call === 1), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h.journal[0].outcome, 'failed')
  assert.ok(h.journal[0].errors.some((x) => x.where === 'fallback_xfer' && x.msg === 'timeout'))
})

test('Replaces: 202 прийнято, АТС поклала B, а клієнт 8 с на нашій нозі без фінального NOTIFY — переведення не відбулося: запасна, потім пошта', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
  await h.ev({ ev: 'xfer', call: 1, code: 202, reason: 'Accepted', final: false })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 }) // АТС поклала B, A жива
  await h.clock.advance(7999)
  assert.equal(h.sent('dial').length, 1)
  await h.clock.advance(1)
  // клієнта не кладемо (раніше тут був connected_unconfirmed і відбій без пошти) — дзвонимо запасній
  assert.equal(h.sent('hangup').length, 0)
  assert.equal(h.sent('xfer').length, 0)
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await managerAnswers(h, 3)
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces').at(-1), { cmd: 'xfer_replaces', call: 1, dest: 3 })
  // із запасною те саме → голосова пошта (утримання зупиняємо, фраза)
  await h.ev({ ev: 'xfer', call: 1, code: 202, reason: 'Accepted', final: false })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  await h.clock.advance(8000)
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  h.d.abortAll('shutdown')
  const e = h.journal[0]
  assert.equal(e.reason, 'manager_xfer_unconfirmed')
  assert.equal(e.fallbackReason, 'fallback_xfer_unconfirmed')
  assert.ok(e.errors.filter((x) => x.where === 'xfer' && x.msg === 'no final NOTIFY').length === 2)

  // REFER прийнято, і АТС поклала обидві ноги (B, потім A) без фінального NOTIFY — це успіх Replaces
  const h3 = harness()
  await answeredAndDialing(h3)
  await managerAnswers(h3)
  await h3.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h3.clock.advance(700)
  await h3.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h3.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  await h3.clock.advance(3000)
  await h3.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h3.clock.advance(1000)
  assert.equal(h3.journal[0].outcome, 'connected_unconfirmed')
  assert.equal(h3.sent('hangup').length, 0)
  assert.equal(h3.sent('dial').length, 1)

  // REFER без жодної відповіді і менеджер поклав — тоді запасна, як і раніше (набір, без сліпого REFER)
  const h2 = harness()
  await answeredAndDialing(h2)
  await managerAnswers(h2)
  await h2.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h2.clock.advance(700)
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  await h2.clock.advance(8000)
  assert.equal(h2.sent('xfer').length, 0)
  assert.deepEqual(h2.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
})

test('міст A↔B не вічний: через bridgeMaxMin кладемо обидві ноги (BYE могли загубити)', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 1, code: 503, final: true })
  assert.deepEqual(h.sent('bridge'), [{ cmd: 'bridge', a: 1, b: 2 }])
  await h.clock.advance(60 * 60000 - 1)
  assert.equal(h.journal.length, 0)
  assert.equal(h.d.active, 1)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }, { cmd: 'hangup', call: 2 }])
  assert.equal(h.journal[0].outcome, 'bridged')
  assert.equal(h.journal[0].reason, 'bridge_cap')
  assert.equal(h.d.active, 0)
})

// ---------- повтори набору у вікні, запасна з карткою і REFER/Replaces, голосова пошта ----------

const VM_FILE = '/data/voicemail/2026-10-16/6929148313-0001.wav'
const VM_PROMPT = { cmd: 'play', call: 1, file: '/p/voicemail.wav', loop: false, tag: 'voicemail' }
const BEEP = { cmd: 'play', call: 1, file: '/cache/beep.wav', loop: false, tag: 'beep' }

test('Android-софтфон спить: 503 перші 6 с → повтори кожні 2 с, утримання грає далі → відповів → з\'єднано', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' }) // далі утримання по колу
  let call = 2
  for (let n = 2; n <= 4; n++) { // спроби о 0, 2, 4 с від першого набору — 503
    await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 503, reason: 'Service Unavailable' })
    await h.clock.advance(1999)
    assert.equal(h.sent('dial').length, n - 1)
    await h.clock.advance(1)
    assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: `mgr-1-${n}`, uri: MGR })
    call++
    await h.ev({ ev: 'dialing', ref: `mgr-1-${n}`, call })
  }
  // через 6 с після першого набору софтфон уже прокинувся: дзвонить і відповідає
  await managerAnswers(h, call)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: call }])
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.answeredBy, 'manager')
  assert.equal(e.retries, 3)
  assert.deepEqual(e.dials.map((x) => [x.to, x.at, x.code]), [['manager', 1000, 503], ['manager', 3000, 503], ['manager', 5000, 503], ['manager', 7000, 200]])
  // клієнт увесь час чув утримання: одна команда play hold (по колу), без stop
  assert.deepEqual(h.sent('play').filter((c) => c.call === 1).map((c) => c.tag), ['greeting', 'hold'])
  assert.equal(h.sent('stop').length, 0)
  assert.equal(h.sent('dial').filter((c) => c.uri === FALLBACK).length, 0)
})

test('503 до кінця вікна 12 с → набір запасної (без сліпого REFER), утримання не перериваємо; клієнт поклав — запізнілий набір кладемо', async () => {
  const h = harness()
  await answeredAndDialing(h)
  let call = 2
  for (let n = 2; n <= 7; n++) {
    await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 503 })
    await h.clock.advance(2000)
    call++
    await h.ev({ ev: 'dialing', ref: `mgr-1-${n}`, call })
  }
  assert.equal(h.sent('dial').length, 7)
  // сьома спроба почалась рівно через 12 с після першої — теж 503: наступна вийшла б за вікно
  await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 503 })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  assert.equal(h.sent('dial').filter((c) => c.uri === MGR).length, 7)
  assert.equal(h.sent('xfer').length, 0)
  assert.equal(h.sent('stop').length, 0)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  const e = h.journal[0]
  assert.equal(e.outcome, 'client_hangup')
  assert.equal(e.reason, 'manager_503')
  assert.equal(e.retries, 6)
  assert.deepEqual(e.dials.filter((x) => x.to === 'manager').map((x) => x.at), [1000, 3000, 5000, 7000, 9000, 11000, 13000])
  assert.equal(e.t.fallback, 13000)
  assert.equal(e.t.fbDial, 13000)
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 20 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 20 })
})

test('повтори не виходять за вікно (4 с): спроби о 0, 2, 4 с і одразу запасна; помилка рушія на dial — теж повтор', async () => {
  const h = harness({ config: { dialRetryWindowSec: 4 } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 480, reason: 'Temporarily Unavailable' })
  await h.clock.advance(2000)
  // рушій не зміг почати набір — {ev:error, cmd:dial, ref, call:null} без dialing
  await h.ev({ ev: 'error', cmd: 'dial', ref: 'mgr-1-2', call: null, msg: 'transport error' })
  await h.clock.advance(2000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 408 })
  assert.deepEqual(h.sent('dial').map((c) => c.ref), ['mgr-1-1', 'mgr-1-2', 'mgr-1-3', 'fb-1-1'])
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  const e = h.journal[0]
  assert.equal(e.reason, 'manager_408')
  assert.equal(e.retries, 2)
  assert.deepEqual(e.dials.filter((x) => x.to === 'manager').map((x) => x.code), [480, 0, 408])
  assert.ok(e.errors.some((x) => x.where === 'dial' && x.msg === 'transport error'))
})

// Менеджер не взяв за 25 с → кладемо його ногу (CANCEL) і набираємо запасну (call 3).
async function toConsultFallback(h) {
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(24999)
  assert.equal(h.sent('dial').length, 1)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 2 }])
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  assert.equal(h.sent('xfer').length, 0) // сліпого REFER немає
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487, reason: 'Request Terminated' })
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'CALLING', code: 0 })
}

test('менеджер не взяв → запасна відповіла → картка їй → xfer_replaces → connected_fallback', async () => {
  const h = harness()
  await toConsultFallback(h)
  await managerAnswers(h, 3)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 3, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(699)
  assert.equal(h.sent('xfer_replaces').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 3 }])
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h.ev({ ev: 'xfer', call: 1, code: 200, reason: 'OK', final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected_fallback')
  assert.equal(e.answeredBy, 'fallback')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.fallbackReason, null)
  assert.equal(e.cardSource, null)
  assert.equal(e.fbCardSource, 'tts')
  assert.equal(e.managerCode, 487)
  assert.equal(e.fallbackCode, 200)
  assert.deepEqual(e.dials, [{ to: 'manager', attempt: 1, at: 1000, code: 487 }, { to: 'fallback', attempt: 1, at: 26000, code: 200 }])
  assert.equal(e.t.fbXfer - e.t.fbCardDone, 700)
  for (const k of ['fallback', 'fbDial', 'fbRinging', 'fbAnswered', 'fbCard', 'fbCardDone', 'fbXfer', 'fbXferAccepted', 'fbXferFinal']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(e.t.managerAnswered, undefined)
  assert.equal(h.sent('stop').length, 0) // клієнт до переведення на утриманні
  assert.equal(h.sent('xfer').length, 0)
})

test('запасна поклала до переведення → голосова пошта; запасна мовчить 20 с → голосова пошта', async () => {
  const h = harness()
  await toConsultFallback(h)
  await managerAnswers(h, 3)
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  h.d.abortAll('shutdown')
  assert.equal(h.journal[0].fallbackReason, 'fallback_hangup')

  const h2 = harness()
  await toConsultFallback(h2)
  await h2.ev({ ev: 'state', call: 3, state: 'EARLY', code: 180 })
  await h2.clock.advance(19999)
  assert.equal(h2.sent('stop').length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.cmds.slice(-3), [{ cmd: 'hangup', call: 3 }, { cmd: 'stop', call: 1 }, VM_PROMPT])
  await h2.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 487 })
  await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // поклав під час фрази — записувати нічого
  const e = h2.journal[0]
  assert.equal(e.outcome, 'client_hangup')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.fallbackReason, 'fallback_timeout')
  assert.equal(e.voicemail, null)
  assert.equal(h2.sent('record').length, 0)
})

test('запасна теж зайнята (486) → голосова пошта: стоп утримання → фраза → сигнал → запис до 60 с → voicemail', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486, reason: 'Busy Here' })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 486, reason: 'Busy Here' })
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  assert.deepEqual(h.cmds.at(-1), BEEP)
  await h.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record', call: 1, file: VM_FILE })
  assert.deepEqual(h.vmCalls, [{ gcid: '6929148313', number: '+380500000001' }])
  await h.clock.advance(59999)
  assert.equal(h.sent('record_stop').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('record_stop'), [{ cmd: 'record_stop', call: 1 }])
  assert.equal(h.journal.length, 0) // чекаємо, поки рушій закриє файл
  await h.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 60.02, reason: 'stop', final: true })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail')
  assert.equal(e.reason, 'manager_486')
  assert.equal(e.fallbackReason, 'fallback_486')
  assert.equal(e.answeredBy, null)
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: 60.02, stop: 'max' })
  assert.deepEqual(e.dials.map((x) => [x.to, x.code]), [['manager', 486], ['fallback', 486]])
  for (const k of ['voicemail', 'vmPrompt', 'vmBeep', 'vmRecord', 'vmDone']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(e.t.vmDone - e.t.vmRecord, 60000)
  assert.equal(h.sent('play').filter((c) => c.tag === 'hold').length, 1) // утримання після пошти не відновлювали
  assert.equal(h.sent('xfer').length + h.sent('xfer_replaces').length, 0)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.journal.length, 1)
})

test('клієнт поклав під час запису → зупиняє рушій, запис зберігся: voicemail (client_hangup)', async () => {
  const h = harness({ config: { fallbackUri: '' } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 603, reason: 'Decline' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record', call: 1, file: VM_FILE })
  await h.clock.advance(7000)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.sent('record_stop').length, 0) // ноги вже немає — запис закриває рушій сам
  assert.equal(h.journal.length, 0)
  await h.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 7.01, reason: 'hangup', final: true })
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail')
  assert.equal(e.reason, 'manager_603')
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: 7.01, stop: 'client_hangup' })
  assert.equal(e.clientCode, 200)
})

test('запасної немає (fallbackUri порожній) → менеджер не взяв за 25 с → одразу голосова пошта, запис до voicemailMaxSec', async () => {
  const h = harness({ config: { fallbackUri: '', voicemailMaxSec: 10 } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(25000)
  assert.deepEqual(h.cmds.slice(-3), [{ cmd: 'hangup', call: 2 }, { cmd: 'stop', call: 1 }, VM_PROMPT])
  assert.equal(h.sent('dial').length, 1) // запасній не дзвонили
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  await h.clock.advance(10000)
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record_stop', call: 1 })
  await h.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 10, reason: 'stop', final: true })
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.fallbackReason, null)
  assert.equal(e.managerCode, 487)
  assert.deepEqual(e.dials.map((x) => x.to), ['manager'])
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: 10, stop: 'max' })
})

test('пошта поки грає привітання: привітання догрує (не обриваємо), утримання вже не вмикається; без сигналу — запис одразу після фрази', async () => {
  const h = harness({ config: { fallbackUri: '', beepFile: null } })
  await answeredAndDialing(h) // привітання ще грає
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.equal(h.sent('stop').length, 0) // привітання на півслові не зупиняємо
  assert.equal(h.sent('play').filter((c) => c.tag === 'voicemail').length, 0)
  await h.clock.advance(3000)
  assert.equal(h.sent('play').filter((c) => c.tag === 'voicemail').length, 0)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' }) // привітання дограло — далі фраза пошти
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  assert.equal(h.sent('play').filter((c) => c.tag === 'hold').length, 0)
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record', call: 1, file: VM_FILE })
  // record_done після record_stop не прийшов за 3 с — завершуємо без нього, помилку пишемо
  await h.clock.advance(60000)
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record_stop', call: 1 })
  await h.clock.advance(3000)
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail')
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: null, stop: 'max' })
  assert.ok(e.errors.some((x) => x.where === 'voicemail' && /record_done/.test(x.msg)))

  // play_done привітання загубився — пошта не чекає вічно: через 30 с зупиняємо і граємо фразу
  const h2 = harness({ config: { fallbackUri: '' } })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h2.clock.advance(29999)
  assert.equal(h2.sent('stop').length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' }) // дуже запізнілий — нічого не змінює
  assert.equal(h2.sent('play').filter((c) => c.tag === 'voicemail').length, 1)
  assert.equal(h2.sent('play').filter((c) => c.tag === 'hold').length, 0)
})

test('пошта неможлива: рушій без record → кладемо клієнта (failed); помилка record → failed; фраза не грається → одразу сигнал', async () => {
  const h = harness({ config: { fallbackUri: '', recordSupported: false } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  assert.equal(h.sent('record').length + h.sent('stop').length, 0)
  assert.equal(h.journal[0].outcome, 'failed')
  assert.ok(h.journal[0].errors.some((x) => x.where === 'voicemail' && /without record/.test(x.msg)))

  const h2 = harness({ config: { fallbackUri: '' } })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  assert.deepEqual(h2.cmds.at(-1), VM_PROMPT)
  await h2.ev({ ev: 'error', cmd: 'play', call: 1, ref: null, msg: 'file not readable: /p/voicemail.wav' })
  assert.deepEqual(h2.cmds.at(-1), BEEP)
  await h2.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  await h2.ev({ ev: 'error', cmd: 'record', call: 1, ref: null, msg: 'Permission denied' })
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'hangup', call: 1 })
  const e = h2.journal[0]
  assert.equal(e.outcome, 'failed')
  assert.equal(e.voicemail, null)
  assert.ok(e.errors.some((x) => x.where === 'record' && x.msg === 'Permission denied'))

  // шлях для запису не вдалося підготувати (диск, права) — теж failed
  const h3 = harness({ config: { fallbackUri: '', beepFile: null, voicemailPromptFile: null }, voicemailPath: () => { throw new Error('EACCES') } })
  await answeredAndDialing(h3)
  await h3.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  // привітання не грається (помилка рушія) — пошта не чекає play_done, що вже не прийде
  await h3.ev({ ev: 'error', cmd: 'play', call: 1, ref: null, msg: 'file not readable: /p/greeting.wav' })
  assert.deepEqual(h3.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, { cmd: 'hangup', call: 1 }])
  assert.equal(h3.journal[0].outcome, 'failed')
  assert.ok(h3.journal[0].errors.some((x) => x.where === 'voicemail' && x.msg === 'EACCES'))
})

test('менеджер поклав під час картки → набір запасної (не сліпий REFER); синтез уже готовий — картка запасній одразу', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  assert.equal(h.sent('play').at(-1).tag, 'card')
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.sent('hangup').length, 0) // ноги менеджера вже немає
  assert.equal(h.sent('xfer').length, 0)
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await managerAnswers(h, 3)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 3, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 3 }])
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.clock.advance(4000) // АТС не погасила ноги — кладемо самі
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }, { cmd: 'hangup', call: 3 }])
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected_fallback')
  assert.equal(e.reason, 'manager_hangup')
  assert.equal(e.cardSource, 'tts')
  assert.equal(e.fbCardSource, 'tts')
  assert.ok(e.t.managerDown != null && e.t.managerAnswered != null && e.t.fbAnswered != null)
})

// ---------- живий Binotel 2026-10-17: Android прокидається, тайм-аут від 180, пусте повідомлення, зупинка шлюзу ----------

// Менеджер на Android-софтфоні спить: спроби 1–5 (0, 2, 4, 6, 8 с від першого набору) — 503, шоста (10 с) дзвонить.
async function androidWakesAt10s(h) {
  await answeredAndDialing(h)
  let call = 2
  for (let n = 2; n <= 6; n++) {
    await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 503, reason: 'Service Unavailable' })
    await h.clock.advance(2000)
    call++
    await h.ev({ ev: 'dialing', ref: `mgr-1-${n}`, call })
  }
  assert.equal(h.sent('dial').at(-1).ref, 'mgr-1-6')
  return call
}

test('Android прокинувся на 10-й с: повтор дзвонить, менеджер бере через 16 с після 180 — з\'єднано (тайм-аут від 180, не від першого набору)', async () => {
  const h = harness()
  const call = await androidWakesAt10s(h)
  await h.ev({ ev: 'state', call, state: 'EARLY', code: 180 })
  // старий тайм-аут (25 с від першого набору) поклав би менеджера на 15-й с дзвінка — саме коли він бере трубку
  await h.clock.advance(16000)
  assert.equal(h.sent('hangup').length, 0)
  assert.equal(h.sent('dial').filter((c) => c.uri === FALLBACK).length, 0)
  await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call, active: true })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: call }])
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected')
  assert.equal(e.reason, null)
  assert.equal(e.retries, 5)
  assert.deepEqual(e.dials.map((x) => [x.at, x.code]), [[1000, 503], [3000, 503], [5000, 503], [7000, 503], [9000, 503], [11000, 200]])
  assert.equal(e.t.managerRinging, 11000)
  assert.equal(e.t.managerAnswered, 27000) // 26 с від першого набору
})

test('тайм-аут сторони: 25 с від 180 спроби, що зазвонила; без 180 — від її INVITE; разом із повторами — не довше 12 + 25 с', async () => {
  const h = harness()
  const call = await androidWakesAt10s(h)
  await h.ev({ ev: 'state', call, state: 'EARLY', code: 180 }) // 11 с від вхідного
  await h.clock.advance(24999)
  assert.equal(h.sent('hangup').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call }])
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 487 })
  // запасна: INVITE пішов, 180 немає (CALLING) — 20 с від INVITE
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 20 })
  await h.ev({ ev: 'state', call: 20, state: 'CALLING', code: 0 })
  await h.clock.advance(19999)
  assert.equal(h.sent('hangup').length, 1)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup').at(-1), { cmd: 'hangup', call: 20 })
  h.d.abortAll('shutdown')
  const e = h.journal[0]
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.fallbackReason, 'fallback_timeout')
  assert.equal(e.t.fallback, 36000)
  assert.equal(e.t.voicemail, 56000)

  // 180 прийшов аж через 10 с після INVITE останньої спроби — обрізає межа сторони: 12 + 25 = 37 с від першого набору
  const h2 = harness()
  const call2 = await androidWakesAt10s(h2)
  await h2.clock.advance(10000)
  await h2.ev({ ev: 'state', call: call2, state: 'EARLY', code: 180 }) // 21 с від вхідного
  await h2.clock.advance(16999)
  assert.equal(h2.sent('hangup').length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.sent('hangup'), [{ cmd: 'hangup', call: call2 }])
  assert.deepEqual(h2.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  assert.ok(h2.logs.some((l) => /не ответил за 37 с вместе с повторами/.test(l)))
  h2.d.abortAll('shutdown')
  assert.equal(h2.journal[0].t.fallback, 38000)
  assert.equal(h2.journal[0].reason, 'manager_timeout')
})

// Голосова пошта до запису: менеджер зайнятий (486), запасної немає, привітання, фраза і сигнал доиграли.
async function toRecording(h) {
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'record', call: 1, file: VM_FILE })
}

test('пусте повідомлення: клієнт поклав одразу після сигналу (0 с) → voicemail_empty, а не voicemail; поріг voicemailMinSec', async () => {
  const h = harness({ config: { fallbackUri: '' } })
  await toRecording(h)
  await h.clock.advance(200)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 0, reason: 'hangup', final: false })
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail_empty')
  assert.equal(e.reason, 'manager_486')
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: 0, stop: 'client_hangup', empty: true })
  assert.ok(h.logs.some((l) => /сообщения нет \(запись 0\.0 с, клиент положил трубку сразу после сигнала\)/.test(l)))

  const cases = [
    [{}, { sec: 0, final: false, missing: true }, 'voicemail_empty'], // файла немає зовсім
    [{}, { sec: 0.6, final: true }, 'voicemail_empty'],
    [{}, { sec: 1.2, final: true }, 'voicemail'],
    [{ voicemailMinSec: 0 }, { sec: 0.3, final: true }, 'voicemail'],
    [{ voicemailMinSec: 3 }, { sec: 2.5, final: true }, 'voicemail_empty'],
  ]
  for (const [cfg, rd, outcome] of cases) {
    const h2 = harness({ config: { fallbackUri: '', ...cfg } })
    await toRecording(h2)
    await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    await h2.ev({ ev: 'record_done', call: 1, file: VM_FILE, reason: 'hangup', ...rd })
    const e2 = h2.journal[0]
    assert.equal(e2.outcome, outcome, JSON.stringify([cfg, rd]))
    assert.equal(e2.voicemail.empty === true, outcome === 'voicemail_empty')
  }

  // запис до кінця (60 с), але звуку в файлі немає (рушій не під'єднав запис) — теж порожнє
  const h3 = harness({ config: { fallbackUri: '' } })
  await toRecording(h3)
  await h3.clock.advance(60000)
  await h3.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 0, reason: 'stop', final: false })
  assert.equal(h3.journal[0].outcome, 'voicemail_empty')
  assert.equal(h3.journal[0].voicemail.stop, 'max')
  assert.deepEqual(h3.cmds.at(-1), { cmd: 'hangup', call: 1 })
})

test('шлюз зупинили під час запису пошти: voicemail зі stop aborted, причина по менеджеру лишається, abortReason окремо', async () => {
  const h = harness({ config: { fallbackUri: '' } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(25000)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  await h.clock.advance(5000)
  h.d.abortAll('shutdown')
  const e = h.journal[0]
  assert.equal(e.outcome, 'voicemail')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.abortReason, 'shutdown')
  assert.deepEqual(e.voicemail, { file: VM_FILE, sec: null, stop: 'aborted' })
  await h.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 5, reason: 'shutdown', final: true }) // після зупинки — нічого не змінює
  assert.equal(h.journal.length, 1)

  // клієнт уже поклав, чекаємо record_done — рушій упав: повідомлення є, stop лишається client_hangup
  const h2 = harness({ config: { fallbackUri: '' } })
  await toRecording(h2)
  await h2.clock.advance(4000)
  await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  h2.d.abortAll('engine_exit')
  assert.equal(h2.journal[0].outcome, 'voicemail')
  assert.equal(h2.journal[0].abortReason, 'engine_exit')
  assert.deepEqual(h2.journal[0].voicemail, { file: VM_FILE, sec: null, stop: 'client_hangup' })

  // упав на фразі пошти, до запису: aborted, без повідомлення, reason не затерто
  const h3 = harness({ config: { fallbackUri: '' } })
  await answeredAndDialing(h3)
  await h3.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h3.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  h3.d.abortAll('engine_exit')
  const e3 = h3.journal[0]
  assert.equal(e3.outcome, 'aborted')
  assert.equal(e3.reason, 'manager_486')
  assert.equal(e3.abortReason, 'engine_exit')
  assert.equal(e3.voicemail, null)
})

// ================= типовий режим: підтвердження «1», «лінія зайнята» + відкладений передзвін, передзвін менеджера =================

const PROMPTS = { confirm: '/p/confirm.wav', busy: '/p/busy.wav', cbConnecting: '/p/cb-connecting.wav', cbNone: '/p/cb-none.wav', cbGreeting: '/p/cb-greeting.wav', cbNoAnswer: '/p/cb-no-answer.wav' }
const NEW = { noAnswerMode: 'busy', confirmEnabled: true, confirmTimeoutSec: 10, confirmRepeats: 1, confirmDigit: '1', declineDigit: '2', dtmfSupported: true, prompts: PROMPTS }
const CONFIRM = { cmd: 'play', call: 2, file: '/p/confirm.wav', loop: false, tag: 'confirm' }
const BUSY = { cmd: 'play', call: 1, file: '/p/busy.wav', loop: false, tag: 'busy' }
const dtmf = (call, digit, method = 'rfc2833') => ({ ev: 'dtmf', call, digit, method })

// Клієнт → менеджер відповів → картка дограла → +700 мс питання «1 / 2» на B (call 2)
async function toConfirm(h) {
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await managerAnswers(h)
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 2, file: '/cache/card-1.wav', loop: false, tag: 'card' })
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(699)
  assert.equal(h.sent('play').filter((c) => c.tag === 'confirm').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('play').at(-1), CONFIRM)
}

test('підтвердження: картка → питання «1 / 2» → «1» → xfer_replaces → connected; клієнт став останнім клієнтом менеджера', async () => {
  const h = harness({ config: NEW })
  await toConfirm(h)
  // цифри клієнта (нога A) і «5» менеджера — не відповідь на питання
  await h.ev(dtmf(1, '1'))
  await h.ev(dtmf(2, '5'))
  assert.equal(h.sent('xfer_replaces').length, 0)
  await h.ev(dtmf(2, '1'))
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 2 }, { cmd: 'xfer_replaces', call: 1, dest: 2 }]) // питання не догравати
  await h.ev(dtmf(2, '1')) // друге натискання — нічого
  assert.equal(h.sent('xfer_replaces').length, 1)
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.v, 3)
  assert.equal(e.kind, 'client')
  assert.equal(e.outcome, 'connected')
  assert.equal(e.noAnswerMode, 'busy')
  assert.deepEqual(e.confirm, { manager: { plays: 1, digit: '1' } })
  assert.equal(e.lastClientFor, '907')
  assert.equal(e.callback, null)
  assert.ok(e.t.confirm != null && e.t.digit != null && e.t.xfer === e.t.digit)
  const last = h.callbacks.getLastClient('907')
  assert.deepEqual([last.number, last.gcid, last.srId], ['+380500000001', '6929148313', 'sr1'])
  assert.equal(h.callbacks.listPending().length, 0)
  assert.equal(h.sent('stop').filter((c) => c.call === 1).length, 0) // клієнт до переведення на утриманні
})

test('«1» ще під час картки — одразу переведення, картку не догравати; без підтвердження (VG_CONFIRM=0) — переведення після картки; рушій без DTMF — без «1» не переводимо', async () => {
  const h = harness({ config: NEW })
  await answeredAndDialing(h)
  await managerAnswers(h)
  assert.equal(h.sent('play').at(-1).tag, 'card')
  await h.ev(dtmf(2, '1', 'info'))
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 2 }, { cmd: 'xfer_replaces', call: 1, dest: 2 }])
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' }) // запізнілий кінець картки — нічого
  await h.clock.advance(5000)
  assert.equal(h.sent('play').filter((c) => c.tag === 'confirm').length, 0)

  const h2 = harness({ config: { ...NEW, confirmEnabled: false } })
  await answeredAndDialing(h2)
  await managerAnswers(h2)
  await h2.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h2.clock.advance(700)
  assert.deepEqual(h2.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
  assert.equal(h2.sent('play').filter((c) => c.tag === 'confirm').length, 0)

  // Старий рушій (dtmfSupported false) і підтвердження увімкнене: цифр не буде — питання, повтор, «лінія зайнята».
  // Переводити наосліп не можна: менеджера на мобільному могла «взяти» голосова пошта оператора.
  const h3 = harness({ config: { ...NEW, dtmfSupported: false } })
  await answeredAndDialing(h3)
  await managerAnswers(h3)
  await h3.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h3.clock.advance(700)
  assert.equal(h3.sent('play').filter((c) => c.tag === 'confirm').length, 1)
  await h3.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h3.clock.advance(10000)
  await h3.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h3.clock.advance(10000)
  assert.equal(h3.sent('xfer_replaces').length, 0)
  await h3.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h3.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.equal(h3.journal[0].outcome, 'busy_callback')
  assert.equal(h3.journal[0].reason, 'manager_no_confirm')
})

test('менеджер натиснув «2» → його кладемо, клієнту «лінія зайнята», відбій; відкладений передзвін збережено (busy_callback)', async () => {
  const h = harness({ config: NEW })
  await toConfirm(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h.ev(dtmf(2, '2', 'info'))
  assert.deepEqual(h.cmds.slice(-3), [{ cmd: 'hangup', call: 2 }, { cmd: 'stop', call: 1 }, BUSY])
  assert.equal(h.sent('dial').length, 1) // запасній у типовому режимі не дзвонимо
  const p = h.callbacks.listPending('907')
  assert.equal(p.length, 1)
  assert.deepEqual([p[0].managerKey, p[0].clientNumber, p[0].gcid, p[0].serviceRequestId, p[0].card], ['907', '+380500000001', '6929148313', 'sr1', 'Дзвонить 0500000001.'])
  assert.equal(h.journal.length, 0)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.equal(e.reason, 'manager_declined')
  assert.deepEqual(e.callback, { managerKey: '907', stored: true, id: p[0].id })
  assert.deepEqual(e.confirm, { manager: { plays: 1, digit: '2' } })
  assert.equal(e.lastClientFor, '907') // до картки дійшов — він і останній клієнт
  for (const k of ['notice', 'noticePlay', 'noticeDone', 'callbackStored']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(e.voicemail, null)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.journal.length, 1)
  assert.ok(h.logs.some((l) => /линия занята, менеджер перезвонит», перезвон сохранён/.test(l)))
})

test('менеджер поклав трубку під час питання (до переведення) → busy_callback (manager_hangup); клієнт поклав під час питання — менеджера кладемо', async () => {
  const h = harness({ config: NEW })
  await toConfirm(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, BUSY]) // ноги менеджера вже немає — не кладемо
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.equal(e.reason, 'manager_hangup')
  assert.ok(e.t.managerDown != null)
  assert.equal(h.callbacks.listPending('907').length, 1)

  const h2 = harness({ config: NEW })
  await toConfirm(h2)
  await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'hangup', call: 2 })
  assert.equal(h2.journal[0].outcome, 'client_hangup')
  // клієнт не дочекався, а менеджер його бачив — передзвін саме йому (missed)
  const p2 = h2.callbacks.listPending('907')
  assert.deepEqual([p2.length, p2[0].clientNumber, p2[0].missed, h2.journal[0].callback.missed, h2.journal[0].callback.stored], [1, '+380500000001', true, true, true])
  await h2.ev(dtmf(2, '1')) // запізніле «1» — нічого
  assert.equal(h2.sent('xfer_replaces').length, 0)
})

test('цифри немає: через 10 с після кінця питання — ще раз, знову 10 с тиші → busy_callback (no_confirm, і від голосової пошти оператора)', async () => {
  const h = harness({ config: NEW })
  await toConfirm(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h.clock.advance(9999)
  assert.equal(h.sent('play').filter((c) => c.tag === 'confirm').length, 1)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('play').filter((c) => c.tag === 'confirm'), [CONFIRM, CONFIRM])
  await h.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h.clock.advance(9999)
  assert.equal(h.sent('hangup').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.cmds.slice(-3), [{ cmd: 'hangup', call: 2 }, { cmd: 'stop', call: 1 }, BUSY])
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.equal(e.reason, 'manager_no_confirm')
  assert.deepEqual(e.confirm, { manager: { plays: 2, digit: null } })
  assert.ok(e.t.confirmRepeat - e.t.confirm >= 10000)
  assert.equal(h.callbacks.listPending('907').length, 1)

  // play_done питання загубився — чекаємо не довше 30 с, далі ті самі 10 с
  const h2 = harness({ config: NEW })
  await toConfirm(h2)
  await h2.clock.advance(30000 + 9999)
  assert.equal(h2.sent('play').filter((c) => c.tag === 'confirm').length, 1)
  await h2.clock.advance(1)
  assert.equal(h2.sent('play').filter((c) => c.tag === 'confirm').length, 2)

  // confirmRepeats 0 — без повтору
  const h3 = harness({ config: { ...NEW, confirmRepeats: 0, confirmTimeoutSec: 3 } })
  await toConfirm(h3)
  await h3.ev({ ev: 'play_done', call: 2, tag: 'confirm' })
  await h3.clock.advance(3000)
  assert.deepEqual(h3.cmds.at(-1), BUSY)
})

test('менеджер не взяв за 25 с (типовий режим) → «лінія зайнята» і передзвін; запасну не набираємо; клієнт поклав під час фрази — передзвін є', async () => {
  const h = harness({ config: NEW })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(24999)
  assert.equal(h.sent('hangup').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.cmds.slice(-3), [{ cmd: 'hangup', call: 2 }, { cmd: 'stop', call: 1 }, BUSY])
  assert.equal(h.sent('dial').filter((c) => c.uri === FALLBACK).length, 0)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // клієнт поклав, не дослухавши
  const e = h.journal[0]
  assert.equal(e.outcome, 'busy_callback')
  assert.equal(e.reason, 'manager_timeout')
  assert.equal(e.managerCode, 487)
  assert.equal(e.callback.stored, true)
  assert.equal(e.lastClientFor, null) // до картки не дійшло
  assert.equal(h.callbacks.getLastClient('907'), null)
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)
  assert.equal(h.callbacks.listPending('907')[0].clientNumber, '+380500000001')
})

test('менеджер зайнятий (486) за 0,1 с: привітання догрує, тоді «лінія зайнята»; 503 — спершу повтори у вікні', async () => {
  const h = harness({ config: NEW })
  await answeredAndDialing(h) // привітання ще грає
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486, reason: 'Busy Here' })
  assert.equal(h.sent('stop').length + h.sent('play').filter((c) => c.tag === 'busy').length, 0) // привітання не обриваємо
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  assert.deepEqual(h.cmds.at(-1), BUSY)
  assert.equal(h.sent('play').filter((c) => c.tag === 'hold').length, 0)
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 1 })
  assert.equal(h.journal[0].reason, 'manager_486')

  const h2 = harness({ config: { ...NEW, dialRetryWindowSec: 4 } })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503 })
  await h2.clock.advance(2000)
  await h2.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h2.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 503 })
  await h2.clock.advance(2000)
  await h2.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 4 })
  assert.equal(h2.sent('play').filter((c) => c.tag === 'busy').length, 0)
  await h2.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 503 })
  assert.deepEqual(h2.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, BUSY]) // повтори вичерпано
  assert.equal(h2.callbacks.listPending().length, 1)
})

test('фраз немає (синтез вимкнено): питання — мовчки, «1» усе одно з\'єднує; без «1» — «лінія зайнята» теж без фрази: одразу відбій', async () => {
  const h = harness({ config: { ...NEW, prompts: {} } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  assert.equal(h.sent('play').filter((c) => c.call === 2 && c.tag !== 'card').length, 0)
  await h.ev(dtmf(2, '1'))
  assert.deepEqual(h.cmds.at(-1), { cmd: 'xfer_replaces', call: 1, dest: 2 })

  const h2 = harness({ config: { ...NEW, prompts: {} } })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await managerAnswers(h2)
  await h2.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h2.clock.advance(700 + 10000 + 10000)
  assert.deepEqual(h2.cmds.slice(-3), [{ cmd: 'hangup', call: 2 }, { cmd: 'stop', call: 1 }, { cmd: 'hangup', call: 1 }])
  assert.equal(h2.journal[0].outcome, 'busy_callback')
  assert.deepEqual(h2.journal[0].confirm, { manager: { plays: 2, digit: null } })
  assert.ok(h2.logs.some((l) => /фразы подтверждения нет — жду «1» молча/.test(l)))
})

test('внутрішній дзвінок (без E.164) і без сховища: «лінія зайнята» є, передзвін не зберігаємо — у журналі чому', async () => {
  const h = harness({ config: NEW })
  await h.ev({ ...INCOMING, number: '905', from: 'sip:905@sip14.binotel.com', gcid: null })
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED' })
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.clock.advance(1000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.deepEqual(h.journal[0].callback, { managerKey: '907', stored: false, id: null, why: 'no_number' })
  assert.equal(h.callbacks.listPending().length, 0)

  const h2 = harness({ config: NEW, callbacks: null })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h2.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  assert.equal(h2.journal[0].outcome, 'busy_callback')
  assert.equal(h2.journal[0].callback.why, 'no_store')
})

test('старі шляхи через noAnswerMode: fallback — запасна теж питає «1» і з\'єднується; voicemail — одразу пошта, запасну не набираємо', async () => {
  const h = harness({ config: { ...NEW, noAnswerMode: 'fallback' } })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'fb-1-1', uri: FALLBACK })
  await h.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await managerAnswers(h, 3)
  await h.ev({ ev: 'play_done', call: 3, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('play').at(-1), { ...CONFIRM, call: 3 })
  await h.ev(dtmf(3, '1'))
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 3 }])
  await h.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected_fallback')
  assert.equal(e.noAnswerMode, 'fallback')
  assert.deepEqual(e.confirm, { fallback: { plays: 1, digit: '1' } })
  assert.ok(e.t.fbConfirm != null && e.t.fbDigit != null)
  assert.equal(h.callbacks.listPending().length, 0) // відкладений передзвін — лише в режимі busy

  // запасна натиснула «2» → далі пошта (як раніше)
  const h2 = harness({ config: { ...NEW, noAnswerMode: 'fallback' } })
  await answeredAndDialing(h2)
  await h2.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  await h2.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
  await managerAnswers(h2, 3)
  await h2.ev(dtmf(3, '2'))
  assert.deepEqual(h2.cmds.slice(-3), [{ cmd: 'hangup', call: 3 }, { cmd: 'stop', call: 1 }, VM_PROMPT])
  h2.d.abortAll('shutdown')
  assert.equal(h2.journal[0].fallbackReason, 'fallback_declined')

  const h3 = harness({ config: { ...NEW, noAnswerMode: 'voicemail' } })
  await answeredAndDialing(h3)
  await h3.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h3.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  assert.deepEqual(h3.cmds.slice(-2), [{ cmd: 'stop', call: 1 }, VM_PROMPT])
  assert.equal(h3.sent('dial').length, 1)
  await h3.ev({ ev: 'play_done', call: 1, tag: 'voicemail' })
  await h3.ev({ ev: 'play_done', call: 1, tag: 'beep' })
  assert.deepEqual(h3.cmds.at(-1), { cmd: 'record', call: 1, file: VM_FILE })
  await h3.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  await h3.ev({ ev: 'record_done', call: 1, file: VM_FILE, sec: 3, reason: 'hangup', final: true })
  assert.equal(h3.journal[0].outcome, 'voicemail')
  assert.equal(h3.journal[0].noAnswerMode, 'voicemail')
})

// ---------- передзвін менеджера ----------

const MGR_IN = { ev: 'incoming', call: 10, from: 'sip:907@sip14.binotel.com', number: '907', name: 'Менеджер', gcid: null, to: 'sip:901@sip14.binotel.com' }
const CB_URI = 'sip:0500000001@sip14.binotel.com;transport=udp'

// Менеджер подзвонив на шлюз: відповідь, одразу набір клієнта (call 11), «З'єднуємо з клієнтом.» → утримання
async function managerCallsBack(h, { uri = CB_URI } = {}) {
  await h.ev(MGR_IN)
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'answer', call: 10, code: 200 }, { cmd: 'dial', ref: 'cb-10-1', uri }])
  await h.ev({ ev: 'dialing', ref: 'cb-10-1', call: 11 })
  await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 10, active: true })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 10, file: '/p/cb-connecting.wav', loop: false, tag: 'cbConnecting' })
  await h.ev({ ev: 'play_done', call: 10, tag: 'cbConnecting' })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 10, file: '/p/hold.wav', loop: true, tag: 'hold' })
}

test('повний цикл: клієнт не дочекався («2») → менеджер передзвонює → набір клієнта одразу → привітання → xfer_replaces(менеджер, клієнт) → connected_callback, передзвін прибрано', async () => {
  const h = harness({ config: NEW })
  await toConfirm(h)
  await h.ev(dtmf(2, '2'))
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.callbacks.listPending('907').length, 1)
  const before = h.cmds.length

  await managerCallsBack(h)
  // менеджеру не дзвонимо (петля), питання «1 / 2» на передзвоні немає
  assert.ok(!h.cmds.slice(before).some((c) => c.cmd === 'dial' && c.uri === MGR))
  await h.ev({ ev: 'state', call: 11, state: 'EARLY', code: 180 })
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  assert.deepEqual(h.sent('play').at(-1), { cmd: 'play', call: 11, file: '/p/cb-greeting.wav', loop: false, tag: 'cbGreeting' })
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(699)
  assert.equal(h.sent('xfer_replaces').length, 0)
  await h.clock.advance(1)
  // REFER на нозі менеджера (вхідна) з Replaces ноги клієнта (вихідна) — та сама форма, що й A/B
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 10, dest: 11 }])
  assert.ok(!h.cmds.slice(before).some((c) => c.tag === 'confirm'))
  await h.ev({ ev: 'xfer', call: 10, code: 100, final: false })
  await h.ev({ ev: 'xfer', call: 10, code: 200, final: true })
  await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[1]
  assert.equal(e.kind, 'callback')
  assert.equal(e.outcome, 'connected_callback')
  assert.equal(e.number, '907')
  assert.equal(e.answeredBy, 'client')
  assert.equal(e.serviceRequestId, 'sr1')
  assert.equal(e.callback.source, 'pending')
  assert.equal(e.callback.client, '+380500000001') // тестовий номер з allowedCallers — повністю
  assert.equal(e.callback.gcid, '6929148313')
  assert.equal(e.callback.removed, true)
  assert.deepEqual(e.dials, [{ to: 'client', attempt: 1, at: 0, code: 200 }])
  for (const k of ['answer', 'cbDial', 'cbRinging', 'cbAnswered', 'cbGreeting', 'cbGreetingDone', 'xfer', 'xferFinal']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(h.callbacks.listPending().length, 0)
  assert.equal(h.d.active, 0)
})

test('передзвін без відкладеного → останній клієнт менеджера; номер не з білого списку — у журналі маскою; найсвіжіший відкладений — першим', async () => {
  const h = harness({ config: NEW })
  h.callbacks.setLastClient('907', { number: '+380631234567', gcid: 'g0', srId: 'sr9', ts: h.clock.now() })
  await managerCallsBack(h, { uri: 'sip:0631234567@sip14.binotel.com;transport=udp' })
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 10, code: 200, final: true })
  await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'connected_callback')
  assert.deepEqual([e.callback.source, e.callback.client, e.callback.removed, e.serviceRequestId], ['last', '…4567', false, 'sr9'])
  assert.ok(!JSON.stringify(e).includes('631234567'))
  assert.ok(!h.logs.some((l) => l.includes('631234567')))

  const h2 = harness({ config: NEW })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h2.clock.now() - 60000 })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '0500000002', ts: h2.clock.now() - 1000 })
  h2.callbacks.addPending({ managerKey: '905', clientNumber: '0500000003', ts: h2.clock.now() })
  h2.callbacks.setLastClient('907', { number: '0500000004' })
  await h2.ev(MGR_IN)
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'dial', ref: 'cb-10-1', uri: 'sip:0500000002@sip14.binotel.com;transport=udp' })
})

test('передзвонювати нікому → менеджеру «Зараз немає клієнтів…», відбій; нікому не дзвонимо (і менеджеру — теж)', async () => {
  const h = harness({ config: NEW })
  await h.ev(MGR_IN)
  assert.deepEqual(h.cmds, [{ cmd: 'answer', call: 10, code: 200 }])
  await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 10, active: true })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/cb-none.wav', loop: false, tag: 'cbNone' })
  assert.equal(h.sent('play').filter((c) => c.tag === 'cbConnecting' || c.tag === 'hold').length, 0)
  await h.ev({ ev: 'play_done', call: 10, tag: 'cbNone' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
  assert.equal(h.sent('dial').length, 0)
  const e = h.journal[0]
  assert.equal(e.kind, 'callback')
  assert.equal(e.outcome, 'callback_none')
  assert.equal(e.reason, 'no_target')
  assert.equal(e.callback.source, null)
})

test('клієнт не взяв за 30 с / зайнятий / 503 (без повторів) → менеджеру «Клієнт не відповідає.», відбій; передзвін лишається', async () => {
  const seed = (h) => h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', gcid: 'g1', serviceRequestId: 'sr1', card: 'Дзвонить клієнт.', ts: h.clock.now() })
  const h = harness({ config: NEW })
  seed(h)
  await managerCallsBack(h)
  await h.ev({ ev: 'state', call: 11, state: 'EARLY', code: 180 })
  await h.clock.advance(29999)
  assert.equal(h.sent('hangup').length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.cmds.slice(-3), [{ cmd: 'hangup', call: 11 }, { cmd: 'stop', call: 10 }, { cmd: 'play', call: 10, file: '/p/cb-no-answer.wav', loop: false, tag: 'cbNoAnswer' }])
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 487 })
  await h.ev({ ev: 'play_done', call: 10, tag: 'cbNoAnswer' })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 10 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'callback_no_answer')
  assert.equal(e.reason, 'client_timeout')
  assert.equal(e.calleeCode, 487)
  assert.equal(e.callback.removed, false)
  assert.equal(h.callbacks.listPending('907').length, 1)

  for (const code of [486, 503, 404]) {
    const h2 = harness({ config: NEW })
    seed(h2)
    await managerCallsBack(h2)
    await h2.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code })
    assert.equal(h2.sent('dial').length, 1, `${code}: клієнту не повторюємо`)
    assert.deepEqual(h2.cmds.slice(-2), [{ cmd: 'stop', call: 10 }, { cmd: 'play', call: 10, file: '/p/cb-no-answer.wav', loop: false, tag: 'cbNoAnswer' }])
    await h2.ev({ ev: 'play_done', call: 10, tag: 'cbNoAnswer' })
    assert.equal(h2.journal[0].reason, `client_${code}`)
    assert.equal(h2.callbacks.listPending('907').length, 1)
  }

  // клієнт узяв і поклав, не дослухавши привітання — теж «не відповідає», передзвін лишається
  const h3 = harness({ config: NEW })
  seed(h3)
  await managerCallsBack(h3)
  await h3.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h3.ev({ ev: 'media', call: 11, active: true })
  await h3.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h3.cmds.at(-1).tag, 'cbNoAnswer')
  await h3.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 }) // менеджер поклав під час фрази
  assert.equal(h3.journal[0].outcome, 'callback_no_answer')
  assert.equal(h3.journal[0].reason, 'client_hangup')
})

test('менеджер поклав, поки набираємо клієнта → набір скасовано (CANCEL), запізнілий dialing кладемо; передзвін лишається', async () => {
  const h = harness({ config: NEW })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h.clock.now() })
  await managerCallsBack(h)
  await h.ev({ ev: 'state', call: 11, state: 'EARLY', code: 180 })
  await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 11 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'callback_cancelled')
  assert.equal(h.callbacks.listPending('907').length, 1)
  await h.clock.advance(60000)
  assert.equal(h.sent('play').filter((c) => c.tag === 'cbNoAnswer').length, 0)

  // ще до dialing від рушія
  const h2 = harness({ config: NEW })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h2.clock.now() })
  await h2.ev(MGR_IN)
  await h2.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  assert.equal(h2.journal[0].outcome, 'callback_cancelled')
  await h2.ev({ ev: 'dialing', ref: 'cb-10-1', call: 11 })
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'hangup', call: 11 })
})

test('менеджер ніколи не набирає сам себе: 907 — передзвін; зовнішній номер менеджера без VG_MANAGERS_EXTERNAL і PIN — 486 (не клієнт, не передзвін); 907 з GCID — це клієнт; номер — лише цілком', async () => {
  const managers = resolveManagers('907=0676575085,905', MGR)
  assert.deepEqual(managers, [['907', '+380676575085'], ['905']])
  assert.deepEqual(resolveManagers('', 'sip:0676575085@sip14.binotel.com;transport=udp'), [['+380676575085']])
  assert.deepEqual(resolveManagers('905', MGR), [['905'], ['907']]) // лінія менеджера — завжди
  assert.deepEqual(parseManagers(' , ;'), [])
  assert.equal(partyKey('sip:0500000002@127.0.0.1:5093'), '+380500000002')
  assert.equal(partyKey('anonymous'), null)
  assert.equal(managerKeyOf('380676575085', managers), '907')
  assert.equal(managerKeyOf('+380 67 657 50 85', managers), '907')
  assert.equal(managerKeyOf('0500000001', managers), null)
  // чужі іноземні номери з цифрами менеджера всередині — НЕ менеджер (раніше normPhone шукав підрядок 380XXXXXXXXX)
  for (const n of ['+49380676575085', '4930380676575085', '+1380676575085', '00380676575085', '380676575085999', '67657508']) {
    assert.equal(partyKey(n), null, n)
    assert.equal(managerKeyOf(n, managers), null, n)
    assert.equal(isManagerCaller({ number: n, gcid: 'g' }, { managers }), false, n)
  }
  assert.deepEqual(['0676575085', '380676575085', '+380676575085', '+38 (067) 657-50-85'].map(strictPhone), Array(4).fill('+380676575085'))
  assert.equal(isAllowed('+49380500000001', ['+380500000001'], { gcid: 'g' }), false) // і білий список клієнтів — цілком
  assert.equal(isAllowed('380500000001', ['0500000001'], { gcid: 'g' }), true)

  const cfg = { ...NEW, managers, allowedCallers: [] }
  // внутрішні лінії менеджерів — передзвін одразу (передзвонювати нікому — лише answer)
  for (const number of ['907', '905']) {
    const h = harness({ config: cfg })
    await h.ev({ ...MGR_IN, number, from: `sip:${number}@sip14.binotel.com`, gcid: null })
    assert.deepEqual(h.cmds, [{ cmd: 'answer', call: 10, code: 200 }], number)
    assert.ok(isManagerCaller({ number, gcid: null }, cfg), number)
    h.d.abortAll('shutdown')
    assert.equal(h.journal[0].kind, 'callback', number)
  }
  // мобільний менеджера (будь-який формат) без VG_MANAGERS_EXTERNAL / PIN — 486: номер можна підробити, а клієнтом
  // його не вважаємо (інакше шлюз набрав би менеджера йому ж)
  for (const extra of [{}, { managersExternal: true }, { managerPin: '2468' }, { managersExternal: true, managerPin: '12' }]) {
    for (const number of ['0676575085', '380676575085']) {
      const h = harness({ config: { ...cfg, ...extra } })
      h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() })
      await h.ev({ ...MGR_IN, number, from: `sip:${number}@sip14.binotel.com`, gcid: '6929148313' })
      assert.deepEqual(h.cmds, [{ cmd: 'hangup', call: 10, code: 486 }], `${number} ${JSON.stringify(extra)}`)
      const e = h.journal[0]
      assert.deepEqual([e.kind, e.outcome, e.reason, e.number], ['callback', 'rejected', 'manager_external', '…5085'])
      assert.equal(h.callbacks.listPending().length, 1) // передзвін на місці
    }
  }
  // з VG_MANAGERS_EXTERNAL=1 і PIN — передзвін після PIN; 905 має свої відкладені передзвони, 907 (=мобільний) — свої
  const h = harness({ config: { ...cfg, managersExternal: true, managerPin: '2468' } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() })
  h.callbacks.addPending({ managerKey: '905', clientNumber: '0500000003', ts: h.clock.now() + 1 })
  await h.ev({ ...MGR_IN, number: '0676575085', gcid: 'g' })
  assert.deepEqual(h.cmds, [{ cmd: 'answer', call: 10, code: 200 }]) // спершу PIN, нікому не дзвонимо
  for (const d of '2468') await h.ev(dtmf(10, d))
  assert.deepEqual(h.cmds.at(-1), { cmd: 'dial', ref: 'cb-10-1', uri: CB_URI })
  assert.ok(!h.sent('dial').some((c) => c.uri === MGR))
  // «907» з X-BINOTEL-GCID — дзвінок зі сценарію (короткий номер оператора), тобто клієнт: не з білого списку → 486
  const h2 = harness({ config: cfg })
  await h2.ev({ ...MGR_IN, gcid: '6929148313' })
  assert.deepEqual(h2.cmds, [{ cmd: 'hangup', call: 10, code: 486 }])
  assert.equal(h2.journal[0].kind, 'client')
  assert.equal(isManagerCaller({ number: '907', gcid: '6929148313' }, cfg), false)
  // іноземний номер із цифрами менеджера — звичайний (чужий) клієнт: 486 not_allowed, передзвону немає
  const h3 = harness({ config: { ...cfg, managersExternal: true, managerPin: '2468' } })
  h3.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h3.clock.now() })
  await h3.ev({ ...MGR_IN, number: '+49380676575085', from: 'sip:+49380676575085@sip14.binotel.com', gcid: 'g' })
  assert.deepEqual(h3.cmds, [{ cmd: 'hangup', call: 10, code: 486 }])
  assert.deepEqual([h3.journal[0].kind, h3.journal[0].reason], ['client', 'not_allowed'])
  // а клієнтський дзвінок у такій конфігурації набирає менеджера як завжди
  assert.equal(clientDialUri('+380500000001', 'sip:{national}@{server};transport=udp', 'sip14.binotel.com'), CB_URI)
  assert.equal(clientDialUri('0500000001', 'sip:{e164}@{server}', 'x'), 'sip:+380500000001@x')
  assert.equal(clientDialUri('907', 'sip:{national}@{server}', 'x'), null)
})

test('передзвін: переведення не вдалося → міст менеджер↔клієнт (bridged_callback), передзвін прибрано; без привітання (фрази немає) — одразу переведення', async () => {
  const h = harness({ config: NEW })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h.clock.now() })
  await managerCallsBack(h)
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 10, code: 503, final: true })
  assert.deepEqual(h.sent('bridge'), [{ cmd: 'bridge', a: 10, b: 11 }])
  assert.equal(h.callbacks.listPending().length, 0)
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  assert.equal(h.journal[0].outcome, 'bridged_callback')

  const h2 = harness({ config: { ...NEW, prompts: {} } })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h2.clock.now() })
  await h2.ev(MGR_IN)
  await h2.ev({ ev: 'dialing', ref: 'cb-10-1', call: 11 })
  await h2.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h2.ev({ ev: 'media', call: 10, active: true })
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/hold.wav', loop: true, tag: 'hold' }) // без «З'єднуємо»
  await h2.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h2.ev({ ev: 'media', call: 11, active: true })
  await h2.clock.advance(700)
  assert.deepEqual(h2.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 10, dest: 11 }])
  // АТС погасила обидві ноги без фінального NOTIFY — теж успіх
  await h2.ev({ ev: 'xfer', call: 10, code: 202, final: false })
  await h2.ev({ ev: 'state', call: 11, state: 'DISCONNECTED' })
  await h2.ev({ ev: 'state', call: 10, state: 'DISCONNECTED' })
  await h2.clock.advance(1000)
  assert.equal(h2.journal[0].outcome, 'connected_callback_unconfirmed')
  assert.equal(h2.callbacks.listPending().length, 0)
})

test('передзвін: клієнт узяв раніше, ніж дійшов ACK менеджера — REFER на нозі менеджера лише після її CONFIRMED', async () => {
  const h = harness({ config: { ...NEW, prompts: { ...PROMPTS, cbGreeting: null } } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h.clock.now() })
  await h.ev(MGR_IN)
  await h.ev({ ev: 'dialing', ref: 'cb-10-1', call: 11 })
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  await h.clock.advance(700 + 1000)
  assert.equal(h.sent('xfer_replaces').length, 0) // діалог менеджера ще не підтверджено
  await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h.clock.advance(200)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 10, dest: 11 }])
})

test('картка вголос не каже номер клієнта: невідомий — «новий клієнт», ім\'я з номера і телефон у скарзі — прибрано; у передзвоні той самий текст', async () => {
  const lookups = [
    { requests: [], profile: null, orders: [] },
    { requests: [], profile: { source: 'telegram' }, orders: [] },
    { requests: [{ id: 'sr1', clientName: '050 000 00 01', status: 'in_work', stage: 'diagnosed', onec: { number: '0001234' }, boat: 'R3', complaint: 'Передзвоніть на +38 (050) 000-00-01', createdAt: '2026-10-10T08:00:00Z' }], profile: null, orders: [] },
    null,
  ]
  const noPhone = (t) => !/(\d[\s()+.-]*){9,}/.test(t) && !t.includes('050') && !/0{3}\s?0{2}\s?01/.test(t)
  for (const res of lookups) {
    const texts = []
    const h = harness({ config: NEW, buildCard, lookup: async () => res, tts: async (t) => { texts.push(t); return { file: '/cache/card-x.wav', cached: false } } })
    await answeredAndDialing(h)
    await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
    await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
    await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
    assert.equal(texts.length, 1)
    assert.ok(noPhone(texts[0]), texts[0])
    const p = h.callbacks.listPending('907')[0]
    assert.ok(p.card && noPhone(p.card), p.card)
    if (res && !res.requests.length && !res.profile) assert.equal(texts[0], 'Дзвонить новий клієнт, у базі порталу немає.')
  }
})

test('сховище передзвонів на диску: 0600 і атомарний запис (без .tmp), TTL 24 год і 30 діб, той самий клієнт — один запис, зіпсований файл не валить', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cb-'))
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = Date.parse('2026-10-17T10:00:00Z')
  const logs = []
  const s = makeCallbackStore({ dataDir: path.join(dir, 'data'), now: () => now, log: (m) => logs.push(m) })
  const e1 = s.addPending({ managerKey: '907', clientNumber: '0500000001', gcid: 'g1', serviceRequestId: 'sr1', card: 'Дзвонить Петренко Іван.' })
  const f = path.join(dir, 'data', CALLBACKS_FILE)
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'data')).mode & 0o777, 0o700)
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.deepEqual(j, { v: 1, pending: [{ id: e1.id, managerKey: '907', clientNumber: '+380500000001', gcid: 'g1', serviceRequestId: 'sr1', card: 'Дзвонить Петренко Іван.', ts: now }] })
  now += 1000
  const e2 = s.addPending({ managerKey: '907', clientNumber: '+380500000001', gcid: 'g2' }) // той самий клієнт ще раз
  assert.deepEqual(s.listPending('907').map((x) => [x.id, x.gcid]), [[e2.id, 'g2']])
  assert.equal(s.updatePending(e2.id, { serviceRequestId: 'sr2', card: 'x' }), true)
  assert.equal(s.listPending()[0].serviceRequestId, 'sr2')
  s.setLastClient('907', { number: '0500000009', gcid: 'g9', srId: 'sr9' })
  const lf = path.join(dir, 'data', LAST_CLIENTS_FILE)
  assert.equal(fs.statSync(lf).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(lf, 'utf8')), { v: 1, managers: { 907: { number: '+380500000009', gcid: 'g9', srId: 'sr9', ts: now } } })
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data')).sort(), [CALLBACKS_FILE, LAST_CLIENTS_FILE]) // тимчасових файлів не лишилось
  // інший процес (шлюз після перезапуску) бачить те саме
  const s2 = makeCallbackStore({ dataDir: path.join(dir, 'data'), now: () => now, log: (m) => logs.push(m) })
  assert.equal(s2.pickTarget('907').source, 'pending')
  // 24 год — передзвін прострочений: його немає і на диску, тоді — останній клієнт
  now += 24 * 3600000
  assert.deepEqual(s2.pickTarget('907'), { source: 'last', id: null, number: '+380500000009', gcid: 'g9', serviceRequestId: 'sr9', ts: now - 24 * 3600000, attempts: 0 })
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).pending, [])
  // 30 діб — і останнього клієнта немає
  now += 30 * 86400000
  assert.equal(s2.pickTarget('907'), null)
  assert.deepEqual(JSON.parse(fs.readFileSync(lf, 'utf8')).managers, {})
  // prune рахує прибране
  s2.addPending({ managerKey: '905', clientNumber: '0500000001' })
  s2.setLastClient('905', { number: '0500000001' })
  now += 31 * 86400000
  assert.equal(s2.prune(), 2)
  assert.equal(s2.removePending('nope'), false)
  // зіпсований файл: попередження, порожньо, наступний запис — уже нормальний JSON
  fs.writeFileSync(f, '{oops')
  assert.deepEqual(s2.listPending(), [])
  assert.ok(logs.some((l) => /callbacks\.json не JSON/.test(l)), logs.join('; '))
  assert.ok(!logs.join(' ').includes('0500000001')) // у попередженні — без номерів
  const e3 = s2.addPending({ managerKey: '907', clientNumber: '0500000001' })
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pending[0].id, e3.id)
  assert.throws(() => s2.addPending({ managerKey: '907', clientNumber: '907' }), /E\.164/)
  // TTL 0 — не прострочувати
  const s3 = makeCallbackStore({ callbackTtlHours: 0, now: () => now })
  s3.addPending({ managerKey: '907', clientNumber: '0500000001', ts: 0 })
  assert.equal(s3.listPending().length, 1)
})

// ================= після ревізії: обслужений клієнт, черга, пропущений, зайнята лінія, групи, PIN, REFER, ліміти =================

// Клієнт → менеджер не взяв (486) → «лінія зайнята» → відбій: відкладений передзвін збережено
async function clientBusyOnce(h, { call = 1, b = 2, number = '0500000001', gcid = 'g1' } = {}) {
  await h.ev({ ...INCOMING, call, number, from: `sip:${number}@45.91.130.64`, gcid })
  await h.ev({ ev: 'media', call, active: true })
  await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
  await h.clock.advance(1000)
  const ref = h.sent('dial').at(-1).ref
  await h.ev({ ev: 'dialing', ref, call: b })
  await h.ev({ ev: 'state', call: b, state: 'DISCONNECTED', code: 486 })
  await h.ev({ ev: 'play_done', call, tag: 'greeting' })
  await h.ev({ ev: 'play_done', call, tag: 'busy' })
  await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 200 })
}

test('обслужений клієнт: передзвонив сам і з\'єднався з менеджером («1», міст, запасна) — його відкладений передзвін знято; перезвон його вже не набирає', async () => {
  const h = harness({ config: { ...NEW, allowedCallers: ['+380500000001', '+380500000009'] } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000009', ts: h.clock.now() - 3600000 }) // інший клієнт чекає з ранку
  await clientBusyOnce(h)
  assert.deepEqual(h.callbacks.listPending('907').map((x) => x.clientNumber), ['+380500000001', '+380500000009'])
  // 10:01 той самий клієнт дзвонить знову, менеджер тисне «1»
  await h.ev({ ...INCOMING, call: 3 })
  await h.ev({ ev: 'media', call: 3, active: true })
  await h.ev({ ev: 'state', call: 3, state: 'CONFIRMED', code: 200 })
  await h.clock.advance(1000)
  await h.ev({ ev: 'dialing', ref: 'mgr-3-1', call: 4 })
  await managerAnswers(h, 4)
  await h.ev(dtmf(4, '1'))
  assert.deepEqual(h.sent('xfer_replaces').at(-1), { cmd: 'xfer_replaces', call: 3, dest: 4 })
  await h.ev({ ev: 'xfer', call: 3, code: 200, final: true })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 200 })
  const e = h.journal.at(-1)
  assert.deepEqual([e.outcome, e.pendingRemoved], ['connected', 1])
  assert.deepEqual(h.callbacks.listPending('907').map((x) => x.clientNumber), ['+380500000009']) // інший лишився
  // менеджер передзвонює — набираємо того, хто чекає, а не вже обслуженого
  await h.ev({ ...MGR_IN, call: 20 })
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'cb-20-1', uri: 'sip:0500000009@sip14.binotel.com;transport=udp' })

  // міст (REFER не вдався) і запасна (режим fallback) — теж «обслужено»
  for (const mode of ['bridge', 'fallback']) {
    const h2 = harness({ config: mode === 'fallback' ? { ...NEW, noAnswerMode: 'fallback' } : NEW })
    h2.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h2.clock.now() })
    await answeredAndDialing(h2)
    if (mode === 'fallback') {
      await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
      await h2.ev({ ev: 'dialing', ref: 'fb-1-1', call: 3 })
      await managerAnswers(h2, 3)
      await h2.ev(dtmf(3, '1'))
      await h2.ev({ ev: 'xfer', call: 1, code: 200, final: true })
      assert.equal(h2.callbacks.listPending().length, 0, mode)
      await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
      await h2.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 200 })
      assert.deepEqual([h2.journal[0].outcome, h2.journal[0].pendingRemoved], ['connected_fallback', 1])
    } else {
      await managerAnswers(h2)
      await h2.ev(dtmf(2, '1'))
      await h2.ev({ ev: 'xfer', call: 1, code: 503, final: true })
      assert.deepEqual(h2.sent('bridge'), [{ cmd: 'bridge', a: 1, b: 2 }])
      assert.equal(h2.callbacks.listPending().length, 0, mode)
      await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
      assert.deepEqual([h2.journal[0].outcome, h2.journal[0].pendingRemoved], ['bridged', 1])
    }
  }
})

test('черга передзвонів: клієнт, що не бере, не закриває чергу — спроба +1 і в кінець; ще не пробувані — найсвіжіші першими; після 3 спроб знято', async () => {
  const h = harness({ config: NEW })
  const t0 = h.clock.now()
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: t0 - 3600000 }) // X з 09:00
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000002', ts: t0 - 60000 }) // Y з 09:59, телефон вимкнено
  const uri = (n) => `sip:${n}@sip14.binotel.com;transport=udp`
  let call = 10
  // менеджер передзвонює: набір → 480 (вимкнено) → «Клієнт не відповідає.» → відбій
  async function attempt(want) {
    call += 10
    await h.ev({ ...MGR_IN, call })
    const d = h.sent('dial').at(-1)
    assert.equal(d.uri, uri(want), `спроба ${call}`)
    await h.ev({ ev: 'dialing', ref: d.ref, call: call + 1 })
    await h.ev({ ev: 'state', call: call + 1, state: 'DISCONNECTED', code: 480 })
    await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call, active: true })
    await h.ev({ ev: 'play_done', call, tag: 'cbNoAnswer' })
    await h.clock.advance(60000)
    return h.journal.at(-1)
  }
  let e = await attempt('0500000002') // найсвіжіший, ще не пробуваний
  assert.deepEqual([e.outcome, e.reason, e.callback.attempts, e.callback.dropped], ['callback_no_answer', 'client_480', 1, false])
  e = await attempt('0500000001') // Y уже пробували — тепер X
  assert.equal(e.callback.attempts, 1)
  e = await attempt('0500000002') // обидва пробувані: найдавніше пробуваний першим
  assert.equal(e.callback.attempts, 2)
  // новий клієнт Z (ще не пробуваний) — першим
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000003', ts: h.clock.now() })
  e = await attempt('0500000003')
  e = await attempt('0500000001')
  e = await attempt('0500000002')
  assert.deepEqual([e.callback.attempts, e.callback.dropped], [3, true]) // третя невдала спроба — знято
  assert.ok(h.logs.some((l) => /попыток 3 — перезвон снят/.test(l)))
  assert.deepEqual(h.callbacks.listPending('907').map((x) => [x.clientNumber, x.attempts]), [['+380500000003', 1], ['+380500000001', 2]])
  const raw = h.callbacks.listPending('907')[0]
  assert.ok(Number.isFinite(raw.lastTriedAt))
  // клієнт подзвонив знову і не дочекався — запис новий, лічильник із нуля
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() })
  assert.equal(h.callbacks.listPending('907')[0].clientNumber, '+380500000001')
  assert.equal(h.callbacks.listPending('907')[0].attempts, undefined)
})

test('клієнт поклав, поки менеджеру дзвонили (у менеджера пропущений) — передзвін саме йому; до набору менеджера і в режимі fallback — ні', async () => {
  const h = harness({ config: { ...NEW, allowedCallers: ['+380500000001', '+380500000009'] } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000009', ts: h.clock.now() - 3600000 }) // X чекає з ранку
  h.callbacks.setLastClient('907', { number: '0500000008', ts: h.clock.now() - 7 * 86400000 })
  await answeredAndDialing(h) // клієнт Y, менеджеру дзвонимо
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(8000)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // Y не дочекався
  assert.deepEqual(h.cmds.at(-1), { cmd: 'hangup', call: 2 })
  const e = h.journal[0]
  assert.equal(e.outcome, 'client_hangup')
  assert.deepEqual([e.callback.stored, e.callback.missed, e.callback.managerKey], [true, true, '907'])
  assert.ok(h.logs.some((l) => /перезвон сохранён \(у менеджера пропущенный\)/.test(l)))
  // менеджер бачить пропущений і передзвонює — набираємо Y, а не X і не «останнього» тижневої давнини
  await h.ev({ ...MGR_IN, call: 20 })
  assert.deepEqual(h.sent('dial').at(-1).uri, CB_URI)

  // поклав ще до набору менеджера (dialDelayMs) — пропущеного в менеджера немає, передзвону теж
  const h2 = harness({ config: NEW })
  await h2.ev(INCOMING)
  await h2.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual([h2.journal[0].outcome, h2.journal[0].callback, h2.callbacks.listPending().length], ['client_hangup', null, 0])
  // режим fallback — передзвонів не відкладаємо; VG_CALLBACK_ON_HANGUP=0 — теж
  for (const cfg of [{ noAnswerMode: 'fallback' }, { callbackOnHangup: false }]) {
    const h3 = harness({ config: { ...NEW, ...cfg } })
    await answeredAndDialing(h3)
    await h3.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.deepEqual([h3.journal[0].outcome, h3.callbacks.listPending().length], ['client_hangup', 0], JSON.stringify(cfg))
  }
})

test('перезвон, поки клієнт ще на лінії шлюзу («лінія зайнята…»): менеджер на утриманні, набір — коли клієнт поклав (+1 с); другий одночасний перезвон того самого клієнта не набирає', async () => {
  const h = harness({ config: NEW })
  await answeredAndDialing(h)
  await h.ev({ ev: 'play_done', call: 1, tag: 'greeting' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 603 }) // менеджер відхилив
  assert.deepEqual(h.cmds.at(-1), BUSY) // клієнт слухає «лінія зайнята…»
  assert.equal(h.callbacks.listPending('907').length, 1)
  // за 2 с менеджер передзвонює: клієнт ще на лінії — не набираємо (інакше 486 і «не відповідає»)
  await h.clock.advance(2000)
  await h.ev({ ...MGR_IN, call: 10 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 10, code: 200 })
  await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 10, active: true })
  assert.deepEqual(h.cmds.at(-1).tag, 'cbConnecting') // менеджер чує «З'єднуємо…», потім утримання
  await h.clock.advance(3000)
  assert.equal(h.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
  assert.ok(h.logs.some((l) => /ещё на линии шлюза — жду/.test(l)))
  // клієнт дослухав і шлюз його поклав → через ~1 с набір
  await h.ev({ ev: 'play_done', call: 1, tag: 'busy' })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.clock.advance(400)
  assert.equal(h.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
  await h.clock.advance(1200)
  assert.deepEqual(h.sent('dial').at(-1), { cmd: 'dial', ref: 'cb-10-1', uri: CB_URI })
  // ще один «менеджер» (905) з тим самим клієнтом у черзі — поки 907 його набирає, не набираємо вдруге
  const cfg2 = { ...NEW, managers: [['907'], ['905']], maxCalls: 3 }
  const h2 = harness({ config: cfg2 })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h2.clock.now() })
  h2.callbacks.addPending({ managerKey: '905', clientNumber: '0500000001', ts: h2.clock.now() })
  h2.callbacks.addPending({ managerKey: '905', clientNumber: '0500000002', ts: h2.clock.now() - 1000 })
  await h2.ev(MGR_IN)
  assert.deepEqual(h2.sent('dial').at(-1).uri, CB_URI)
  await h2.ev({ ...MGR_IN, call: 20, number: '905', from: 'sip:905@sip14.binotel.com' })
  assert.deepEqual(h2.sent('dial').at(-1), { cmd: 'dial', ref: 'cb-20-1', uri: 'sip:0500000002@sip14.binotel.com;transport=udp' })
  // ціль так і не звільнилась за callbackLineWaitSec — інших немає: «Клієнт не відповідає.», client_on_line
  const h3 = harness({ config: { ...NEW, callbackLineWaitSec: 5 } })
  await answeredAndDialing(h3)
  await h3.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 }) // привітання ще грає — фраза чекає
  await h3.ev({ ...MGR_IN, call: 10 })
  await h3.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h3.ev({ ev: 'media', call: 10, active: true })
  await h3.ev({ ev: 'play_done', call: 10, tag: 'cbConnecting' }) // далі утримання
  await h3.clock.advance(5600)
  assert.deepEqual(h3.cmds.at(-1), { cmd: 'play', call: 10, file: '/p/cb-no-answer.wav', loop: false, tag: 'cbNoAnswer' })
  await h3.ev({ ev: 'play_done', call: 10, tag: 'cbNoAnswer' })
  const e3 = h3.journal.find((x) => x.kind === 'callback')
  assert.deepEqual([e3.outcome, e3.reason], ['callback_no_answer', 'client_on_line'])
  assert.equal(h3.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
})

test('ключ менеджера: записи шукаємо за всією групою — порядок у VG_MANAGERS не важливий; записи чужих ключів — orphanKeys', async () => {
  // шлюз писав передзвони під ключем '907' (VG_MANAGERS=907=0676575085), потім його перезапустили з 0676575085=907
  const h = harness({ config: { ...NEW, managerUri: 'sip:0676575085@sip14.binotel.com;transport=udp', managers: [['+380676575085', '907']] } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() })
  h.callbacks.setLastClient('907', { number: '0500000005', ts: h.clock.now() })
  await h.ev(MGR_IN) // з 907
  assert.deepEqual(h.sent('dial').at(-1).uri, CB_URI)
  assert.deepEqual(h.callbacks.listPending(['+380676575085', '907']).length, 1)
  assert.equal(h.callbacks.getLastClient(['+380676575085', '907']).number, '+380500000005')
  assert.deepEqual(h.callbacks.orphanKeys([['+380676575085', '907']]), [])
  assert.deepEqual(h.callbacks.orphanKeys([['905']]).sort(), ['907'])
  // клієнтський дзвінок у цій конфігурації: передзвін — під першим ключем групи, клієнт з'єднався — знято за групою
  const h2 = harness({ config: { ...NEW, managerUri: 'sip:0676575085@sip14.binotel.com;transport=udp', managers: [['+380676575085', '907']] } })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h2.clock.now() })
  await h2.ev(INCOMING)
  await h2.ev({ ev: 'media', call: 1, active: true })
  await h2.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  await h2.clock.advance(1000)
  await h2.ev({ ev: 'dialing', ref: 'mgr-1-1', call: 2 })
  await managerAnswers(h2)
  await h2.ev(dtmf(2, '1'))
  await h2.ev({ ev: 'xfer', call: 1, code: 200, final: true })
  assert.equal(h2.journal.length, 0)
  assert.equal(h2.callbacks.listPending().length, 0)
  assert.equal(h2.callbacks.getLastClient('+380676575085').number, '+380500000001')
})

test('PIN зовнішнього менеджера: фраза → цифри (і під час фрази) → передзвін; невірний / немає за 10 с — відбій без набору; «*» — заново; цифр PIN немає ніде', async () => {
  const cfg = { ...NEW, managers: [['907', '+380676575085']], managersExternal: true, managerPin: '2468', prompts: { ...PROMPTS, pin: '/p/pin.wav' } }
  const MOB = { ...MGR_IN, number: '0676575085', from: 'sip:0676575085@sip14.binotel.com', gcid: '6929148313' }
  const answeredMob = async (h) => {
    h.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h.clock.now() })
    await h.ev(MOB)
    await h.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 10, active: true })
    assert.deepEqual(h.cmds, [{ cmd: 'answer', call: 10, code: 200 }, { cmd: 'play', call: 10, file: '/p/pin.wav', loop: false, tag: 'pin' }])
  }
  // вірний PIN після фрази
  const h = harness({ config: cfg })
  await answeredMob(h)
  await h.ev({ ev: 'play_done', call: 10, tag: 'pin' })
  for (const d of '246') await h.ev(dtmf(10, d))
  assert.equal(h.sent('dial').length, 0)
  await h.ev(dtmf(10, '8'))
  assert.deepEqual(h.cmds.slice(-2), [{ cmd: 'dial', ref: 'cb-10-1', uri: CB_URI }, { cmd: 'play', call: 10, file: '/p/cb-connecting.wav', loop: false, tag: 'cbConnecting' }])
  await h.ev({ ev: 'dialing', ref: 'cb-10-1', call: 11 })
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(700)
  await h.ev({ ev: 'xfer', call: 10, code: 200, final: true })
  await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.deepEqual([e.kind, e.outcome, e.pin], ['callback', 'connected_callback', 'ok'])
  assert.ok(e.t.pin != null && e.t.pinPrompt != null && e.t.pinOk != null && e.t.pinOk <= e.t.cbDial)
  assert.ok(!JSON.stringify(e).includes('2468') && !h.logs.join('\n').includes('2468'))
  // PIN під час фрази — фразу зупиняємо; «*» — почати знову; «#» — перевірити раніше
  const h2 = harness({ config: cfg })
  await answeredMob(h2)
  for (const d of '13*2468') await h2.ev(dtmf(10, d))
  assert.deepEqual(h2.cmds.slice(2, 4), [{ cmd: 'stop', call: 10 }, { cmd: 'dial', ref: 'cb-10-1', uri: CB_URI }])
  // невірний PIN — відбій, нікому не дзвонимо, передзвін на місці
  const h3 = harness({ config: cfg })
  await answeredMob(h3)
  await h3.ev({ ev: 'play_done', call: 10, tag: 'pin' })
  for (const d of '12#') await h3.ev(dtmf(10, d))
  assert.deepEqual(h3.cmds.at(-1), { cmd: 'hangup', call: 10 })
  assert.equal(h3.sent('dial').length, 0)
  assert.deepEqual([h3.journal[0].outcome, h3.journal[0].reason, h3.journal[0].pin], ['callback_denied', 'pin_wrong', 'wrong'])
  assert.equal(h3.callbacks.listPending().length, 1)
  await h3.ev(dtmf(10, '2')) // запізнілі цифри — нічого
  // немає цифр 10 с після фрази — відбій
  const h4 = harness({ config: cfg })
  await answeredMob(h4)
  await h4.ev({ ev: 'play_done', call: 10, tag: 'pin' })
  await h4.clock.advance(9999)
  assert.equal(h4.journal.length, 0)
  await h4.clock.advance(1)
  assert.deepEqual([h4.cmds.at(-1), h4.journal[0].outcome, h4.journal[0].reason], [{ cmd: 'hangup', call: 10 }, 'callback_denied', 'pin_timeout'])
  // менеджер поклав під час PIN — callback_cancelled, нікому не дзвонимо
  const h5 = harness({ config: cfg })
  await answeredMob(h5)
  await h5.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  assert.deepEqual([h5.journal[0].outcome, h5.journal[0].pin, h5.sent('dial').length], ['callback_cancelled', 'unfinished', 0])
  // фрази PIN немає (синтез вимкнено) — чекаємо цифри мовчки; внутрішня лінія 907 PIN не питає
  const h6 = harness({ config: { ...cfg, prompts: PROMPTS } })
  h6.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h6.clock.now() })
  await h6.ev(MOB)
  await h6.ev({ ev: 'state', call: 10, state: 'CONFIRMED', code: 200 })
  await h6.ev({ ev: 'media', call: 10, active: true })
  assert.deepEqual(h6.cmds, [{ cmd: 'answer', call: 10, code: 200 }])
  for (const d of '2468') await h6.ev(dtmf(10, d))
  assert.deepEqual(h6.sent('dial').at(-1).uri, CB_URI)
  const h7 = harness({ config: cfg })
  h7.callbacks.addPending({ managerKey: '907', clientNumber: '0500000001', ts: h7.clock.now() })
  await h7.ev(MGR_IN)
  assert.deepEqual(h7.cmds.at(-1).uri, CB_URI)
  // цифри клієнта (нога A звичайного дзвінка) PIN-ом не вважаються
  const h8 = harness({ config: cfg })
  await answeredAndDialing(h8)
  for (const d of '2468') await h8.ev(dtmf(1, d))
  assert.equal(h8.sent('dial').filter((c) => c.ref.startsWith('cb-')).length, 0)
})

test('передзвін з callbackReferOn client: REFER на нозі клієнта з Replaces ноги менеджера (у Refer-To — менеджер, не номер клієнта)', async () => {
  const h = harness({ config: { ...NEW, callbackReferOn: 'client' } })
  h.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h.clock.now() })
  await managerCallsBack(h)
  await h.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 11, active: true })
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 11, dest: 10 }])
  await h.ev({ ev: 'xfer', call: 10, code: 200, final: true }) // не та нога — не рахуємо
  assert.equal(h.journal.length, 0)
  await h.ev({ ev: 'xfer', call: 11, code: 100, final: false })
  await h.ev({ ev: 'xfer', call: 11, code: 200, final: true })
  await h.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  await h.ev({ ev: 'state', call: 11, state: 'DISCONNECTED', code: 200 })
  const e = h.journal[0]
  assert.deepEqual([e.outcome, e.callback.referOn, e.callback.removed, e.xferCode], ['connected_callback', 'client', true, 200])
  // Binotel замінив діалог менеджера (BYE на A), фінального NOTIFY немає — теж успіх
  const h2 = harness({ config: { ...NEW, callbackReferOn: 'client' } })
  h2.callbacks.addPending({ managerKey: '907', clientNumber: '+380500000001', ts: h2.clock.now() })
  await managerCallsBack(h2)
  await h2.ev({ ev: 'state', call: 11, state: 'CONFIRMED', code: 200 })
  await h2.ev({ ev: 'media', call: 11, active: true })
  await h2.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h2.clock.advance(700)
  await h2.ev({ ev: 'xfer', call: 11, code: 202, final: false })
  await h2.ev({ ev: 'state', call: 10, state: 'DISCONNECTED', code: 200 })
  await h2.clock.advance(8000)
  assert.deepEqual(h2.cmds.at(-1), { cmd: 'hangup', call: 11 })
  assert.equal(h2.journal[0].outcome, 'connected_callback_unconfirmed')
})

test('ліміт наборів одного клієнта на передзвоні: не більше 5 за 24 год (далі «немає клієнтів», dial_cap); за добу — знову можна', async () => {
  const h = harness({ config: { ...NEW, callbackMaxDialsPerDay: 5 } })
  h.callbacks.setLastClient('907', { number: '0500000001', ts: h.clock.now() })
  for (let i = 0; i < 5; i++) {
    const call = 10 + i * 10
    await h.ev({ ...MGR_IN, call })
    assert.deepEqual(h.cmds.at(-1).uri, CB_URI, `набір ${i + 1}`)
    await h.ev({ ev: 'state', call, state: 'DISCONNECTED', code: 200 }) // менеджер передумав
    await h.clock.advance(1000)
  }
  assert.equal(h.callbacks.dialsToday('0500000001'), 5)
  await h.ev({ ...MGR_IN, call: 90 })
  assert.deepEqual(h.cmds.at(-1), { cmd: 'answer', call: 90, code: 200 })
  await h.ev({ ev: 'state', call: 90, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 90, active: true })
  assert.deepEqual(h.cmds.at(-1).tag, 'cbNone')
  await h.ev({ ev: 'play_done', call: 90, tag: 'cbNone' })
  assert.deepEqual([h.journal.at(-1).outcome, h.journal.at(-1).reason], ['callback_none', 'dial_cap'])
  await h.clock.advance(86400000)
  assert.equal(h.callbacks.dialsToday('0500000001'), 0)
  assert.equal(h.callbacks.canDial('0500000001'), true)
  const s0 = makeCallbackStore({ maxDialsPerDay: 0 })
  for (let i = 0; i < 20; i++) s0.noteDial('0500000001')
  assert.equal(s0.canDial('0500000001'), true) // 0 — без ліміту
})

test('сховище: тимчасові файли, що лишились після падіння між записом і rename, prune() прибирає (свіжі — ні); dials у callbacks.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cbtmp-'))
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const data = path.join(dir, 'data')
  let now = Date.now()
  const s = makeCallbackStore({ dataDir: data, now: () => now })
  s.addPending({ managerKey: '907', clientNumber: '0500000001' })
  const stale = path.join(data, `${CALLBACKS_FILE}.12345.ab12cd34.tmp`)
  const stale2 = path.join(data, `${LAST_CLIENTS_FILE}.777.00ff.tmp`)
  const freshTmp = path.join(data, `${CALLBACKS_FILE}.999.deadbeef.tmp`)
  const other = path.join(data, 'calls-2026-10-17.jsonl.1.ab.tmp')
  for (const f of [stale, stale2, freshTmp, other]) fs.writeFileSync(f, '{"pending":[{"clientNumber":"+380500000001"}]}', { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60000)
  for (const f of [stale, stale2, other]) fs.utimesSync(f, old, old)
  assert.equal(s.prune(), 2)
  assert.deepEqual([fs.existsSync(stale), fs.existsSync(stale2), fs.existsSync(freshTmp), fs.existsSync(other)], [false, false, true, true])
  // історія наборів — у тому самому файлі, 0600; без наборів поля немає
  s.noteDial('0500000001')
  const j = JSON.parse(fs.readFileSync(path.join(data, CALLBACKS_FILE), 'utf8'))
  assert.deepEqual(Object.keys(j.dials), ['+380500000001'])
  assert.equal(fs.statSync(path.join(data, CALLBACKS_FILE)).mode & 0o777, 0o600)
  now += 86400000
  s.listPending()
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, CALLBACKS_FILE), 'utf8')).dials, undefined)
})
