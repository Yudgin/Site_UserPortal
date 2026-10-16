// Сценарій дзвінка на підробленому рушії і підробленому годиннику: без мережі, без SIP, без Firestore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, isAllowed, isInternal, maskNumber } from './flow.mjs'

const MGR = 'sip:907@sip14.binotel.com;transport=udp'
const FALLBACK = 'sip:906@sip14.binotel.com;transport=udp'
const CONFIG = {
  managerUri: MGR,
  fallbackUri: FALLBACK,
  fallbackMode: 'consult',
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

function harness({ config = {}, lookup, tts, buildCard, voicemailPath } = {}) {
  const cmds = []
  const journal = []
  const logs = []
  const vmCalls = []
  const clock = fakeClock()
  const d = createDispatcher({
    config: { ...CONFIG, ...config },
    send: (c) => cmds.push(c),
    clock,
    lookup: lookup === undefined ? async () => ({ requests: [{ id: 'sr1' }], profile: null, orders: [] }) : lookup,
    buildCard: buildCard || ((res, { number }) => ({ text: `Дзвонить ${number}.`, category: res ? 'openRequest' : null, serviceRequestId: res ? 'sr1' : null })),
    tts: tts === undefined ? async () => ({ file: '/cache/card-1.wav', cached: false }) : tts,
    voicemailPath: voicemailPath === undefined ? (o) => { vmCalls.push(o); return `/data/voicemail/2026-10-16/${o.gcid}-${String(o.number).slice(-4)}.wav` } : voicemailPath,
    log: (m) => logs.push(m),
    onDone: (e) => journal.push(e),
  })
  const ev = async (e) => { d.handle(e); await clock.flush() }
  const sent = (name) => cmds.filter((c) => c.cmd === name)
  const has = (pred) => cmds.some(pred)
  return { d, cmds, journal, logs, clock, ev, sent, has, vmCalls }
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

  await h.ev({ ev: 'incoming', call: 5, number: '907', from: 'sip:907@sip14.binotel.com', gcid: null })
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

  const h2 = harness({ config: { allowedInternal: ['907'] } })
  await h2.ev({ ...INCOMING, call: 3, number: '905', from: 'sip:905@sip14.binotel.com', gcid: null })
  assert.deepEqual(h2.cmds, [{ cmd: 'hangup', call: 3, code: 486 }])
  await h2.ev({ ...INCOMING, call: 4, number: '907', from: 'sip:907@sip14.binotel.com', gcid: null })
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
