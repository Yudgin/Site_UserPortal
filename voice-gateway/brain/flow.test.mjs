// Сценарій дзвінка на підробленому рушії і підробленому годиннику: без мережі, без SIP, без Firestore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, isAllowed, isInternal, maskNumber } from './flow.mjs'

const MGR = 'sip:907@sip14.binotel.com;transport=udp'
const FALLBACK = 'sip:906@sip14.binotel.com;transport=udp'
const CONFIG = {
  managerUri: MGR,
  fallbackUri: FALLBACK,
  allowedCallers: ['+380500000001'],
  maxCalls: 2,
  greetingFile: '/p/greeting.wav',
  holdFile: '/p/hold.wav',
  genericCardFile: null,
  dialDelayMs: 1000,
  dialRetries: 2,
  dialRetryDelayMs: 1000,
  retryCodes: [503, 408, 480],
  managerTimeoutSec: 25,
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

function harness({ config = {}, lookup, tts, buildCard } = {}) {
  const cmds = []
  const journal = []
  const logs = []
  const clock = fakeClock()
  const d = createDispatcher({
    config: { ...CONFIG, ...config },
    send: (c) => cmds.push(c),
    clock,
    lookup: lookup === undefined ? async () => ({ requests: [{ id: 'sr1' }], profile: null, orders: [] }) : lookup,
    buildCard: buildCard || ((res, { number }) => ({ text: `Дзвонить ${number}.`, category: res ? 'openRequest' : null, serviceRequestId: res ? 'sr1' : null })),
    tts: tts === undefined ? async () => ({ file: '/cache/card-1.wav', cached: false }) : tts,
    log: (m) => logs.push(m),
    onDone: (e) => journal.push(e),
  })
  const ev = async (e) => { d.handle(e); await clock.flush() }
  const sent = (name) => cmds.filter((c) => c.cmd === name)
  const has = (pred) => cmds.some(pred)
  return { d, cmds, journal, logs, clock, ev, sent, has }
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
  assert.deepEqual(e.dials, [{ attempt: 1, at: 1000, code: 200 }])
  for (const k of ['answer', 'greeting', 'hold', 'dial', 'managerAnswered', 'card', 'cardDone', 'xfer', 'xferFinal', 'end']) assert.ok(e.t[k] != null, `немає мітки ${k}`)
  assert.equal(e.t.xfer - e.t.cardDone, 700)
  assert.equal(h.sent('hangup').length, 0) // АТС сама поклала обидві ноги
  assert.equal(h.sent('bridge').length, 0)
  assert.equal(h.d.active, 0)
})

test('набір: 503 до відповіді → повтор через 1 с, далі успіх; жива нога через 4 с після переведення — кладемо', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503, reason: 'Service Unavailable' })
  await h.clock.advance(999)
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

test('менеджер не взяв за 25 с → кладемо B, сліпе переведення A на запасну лінію', async () => {
  const h = harness()
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

test('менеджер зайнятий (486) → одразу запасна лінія, без повторів', async () => {
  const h = harness()
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

test('повтори вичерпано (503 тричі) → запасна лінія', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 503 })
  await h.clock.advance(1000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-2', call: 3 })
  await h.ev({ ev: 'state', call: 3, state: 'DISCONNECTED', code: 503 })
  await h.clock.advance(1000)
  await h.ev({ ev: 'dialing', ref: 'mgr-1-3', call: 4 })
  await h.ev({ ev: 'state', call: 4, state: 'DISCONNECTED', code: 503 })
  assert.equal(h.sent('dial').length, 3)
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED' })
  assert.equal(h.journal[0].retries, 2)
  assert.equal(h.journal[0].reason, 'manager_503')
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

test('менеджер поклав під час картки → запасна лінія', async () => {
  const h = harness()
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
  assert.equal(e.reason, 'shutdown')
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

// Менеджер не взяв → сліпий REFER на запасну.
async function toFallback(h) {
  await answeredAndDialing(h)
  await h.ev({ ev: 'state', call: 2, state: 'EARLY', code: 180 })
  await h.clock.advance(25000)
  assert.deepEqual(h.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 487 })
}

test('запасна: REFER прийнято (202, NOTIFY 100/180) — не кладемо клієнта через 8 с, чекаємо фінал (906 взяли на 10-й с)', async () => {
  const h = harness()
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

test('запасна: REFER прийнято, АТС поклала A — fallback; фіналу немає 90 с — кладемо A (fallback_unconfirmed)', async () => {
  const h = harness()
  await toFallback(h)
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 }) // як Asterisk: BYE одразу після 202
  assert.equal(h.journal[0].outcome, 'fallback')
  assert.equal(h.sent('hangup').filter((c) => c.call === 1).length, 0)

  const h2 = harness()
  await toFallback(h2)
  await h2.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h2.clock.advance(89999)
  assert.equal(h2.journal.length, 0)
  await h2.clock.advance(1)
  assert.deepEqual(h2.sent('hangup').filter((c) => c.call === 1), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h2.journal[0].outcome, 'fallback_unconfirmed')
  assert.ok(h2.journal[0].errors.some((x) => x.where === 'fallback_xfer' && /no final/.test(x.msg)))
})

test('запасна: на REFER немає ні 202, ні NOTIFY за 8 с — кладемо A (failed)', async () => {
  const h = harness()
  await toFallback(h)
  await h.clock.advance(7999)
  assert.equal(h.journal.length, 0)
  await h.clock.advance(1)
  assert.deepEqual(h.sent('hangup').filter((c) => c.call === 1), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h.journal[0].outcome, 'failed')
  assert.ok(h.journal[0].errors.some((x) => x.where === 'fallback_xfer' && x.msg === 'timeout'))
})

test('Replaces: 202 прийнято, АТС поклала B, фінального NOTIFY і BYE на A немає — connected_unconfirmed, без запасної', async () => {
  const h = harness()
  await answeredAndDialing(h)
  await managerAnswers(h)
  await h.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h.clock.advance(700)
  assert.deepEqual(h.sent('xfer_replaces'), [{ cmd: 'xfer_replaces', call: 1, dest: 2 }])
  await h.ev({ ev: 'xfer', call: 1, code: 100, reason: 'Accepted', final: false })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 }) // заменённый диалог B
  await h.clock.advance(8000)
  assert.equal(h.sent('xfer').length, 0) // клієнта від менеджера не уводимо
  assert.deepEqual(h.sent('hangup'), [{ cmd: 'hangup', call: 1 }])
  assert.equal(h.journal[0].outcome, 'connected_unconfirmed')

  // REFER без жодної відповіді і менеджер поклав — тоді запасна, як і раніше
  const h2 = harness()
  await answeredAndDialing(h2)
  await managerAnswers(h2)
  await h2.ev({ ev: 'play_done', call: 2, tag: 'card' })
  await h2.clock.advance(700)
  await h2.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 200 })
  await h2.clock.advance(8000)
  assert.deepEqual(h2.sent('xfer'), [{ cmd: 'xfer', call: 1, uri: FALLBACK }])
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
