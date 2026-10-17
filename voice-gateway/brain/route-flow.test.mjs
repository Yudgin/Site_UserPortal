// Події обговорення на межі flow/storage: підроблені дзвінки, ШІ та годинник, без SIP/HTTP/Firestore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from './flow.mjs'
import { loadConfig } from './config.mjs'
import { makeCallbackStore } from './callbacks.mjs'
import { makeStaffState } from './staffstate.mjs'

const NOW = Date.parse('2026-10-16T10:00:00Z')
const PHONE = '+380500000001'
const UID = 'fictional-route-owner'
const SR = { id: 'sr-fictional', status: 'new', createdAt: '2026-10-10T10:00:00Z' }
const CLIENT = { ev: 'incoming', call: 1, number: PHONE, from: 'sip:0500000001@127.0.0.1', gcid: 'gcid-fictional' }
const MANAGER = { ev: 'incoming', call: 10, number: '908', from: 'sip:908@127.0.0.1', gcid: null }
const prompts = { intro: '/fake/80.wav', introShort: '/fake/80-short.wav', dsTalked: '/fake/13.wav', dsTalkedShort: '/fake/13-short.wav', dsFailed: '/fake/16.wav', dsNoAi: '/fake/17.wav', dsNoAiShort: '/fake/17-short.wav', aiDown: '/fake/82.wav', cbGreeting: '/fake/cb.wav', confirm: '/fake/confirm.wav' }

function clockAt() {
  let now = NOW, sequence = 0
  const timers = new Map()
  const flush = () => new Promise((r) => setImmediate(r))
  return {
    now: () => now, flush,
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { at: now + Math.max(0, ms), fn }); return id },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms
      await flush()
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush()
      }
      now = end; await flush()
    },
  }
}
function fakeAi({ startFails = false, turns = [] } = {}) {
  const sessions = []
  const ai = (opts) => {
    const s = { opts, ended: false, start: () => startFails ? null : { cmd: 'audio_start', call: opts.call, sock: '/fake/ai.sock', token: 'fake' },
      stop(reason) { if (s.ended) return; s.ended = true; opts.onEnd({ reason }) },
      result: () => ({ provider: 'fake', durationMs: 1000, turns, toolCalls: [], usage: {}, costUsd: 0, errors: [] }),
    }
    sessions.push(s)
    return s
  }
  ai.sessions = sessions
  return ai
}
function harness({ ai = fakeAi(), callStatus = 'summarized', missingIntro = false } = {}) {
  const clock = clockAt(), commands = [], events = [], journal = []
  const callbacks = makeCallbackStore({ now: clock.now })
  const staff = makeStaffState({ now: clock.now })
  const config = { ...loadConfig({}), answerMode: 'ai', noAnswerMode: 'ai', managerUri: 'sip:907@127.0.0.1;transport=udp', managers: [['907'], ['908']], sipServer: '127.0.0.1', allowedCallers: [PHONE], dsSource: 'calls', dsStaff: {}, workHours: [], prompts: missingIntro ? { ...prompts, intro: null, introShort: null } : prompts, dtmfSupported: true, afterCardMs: 0, dialRetries: 0, callbackReferOn: 'manager', greetingFile: null, holdFile: null }
  const dispatcher = createDispatcher({ config, clock, ai, callbacks, staffState: staff, send: (c) => commands.push(c), routeEvent: (e) => events.push(e), onDone: (e) => journal.push(e),
    lookup: async () => ({ requests: [SR] }), buildCard: () => ({ text: 'Дзвонить клієнт.', category: 'openRequest', serviceRequestId: SR.id }), tts: async () => ({ file: '/fake/card.wav' }),
    appCalls: async () => [{ id: 'call-fictional', provider: 'binotel', direction: 'outbound', employeeUid: UID, employeeLine: '908', status: callStatus, disposition: 'ANSWER', durationSec: 30, createdAt: new Date(NOW - 60000).toISOString() }],
  })
  const ev = async (e) => { dispatcher.handle(e); await clock.flush() }
  return { config, clock, ai, callbacks, staff, commands, events, journal, ev, sent: (cmd) => commands.filter((c) => c.cmd === cmd) }
}
async function clientEnters(h) {
  await h.ev(CLIENT)
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 1, active: true })
  assert.equal(h.sent('play')[0].tag, 'intro')
  assert.equal(h.sent('dial').length, 0)
  await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
}
async function discussionFails(h) {
  await clientEnters(h)
  const dial = h.sent('dial')[0]
  assert.match(dial.uri, /sip:908@127\.0\.0\.1/)
  await h.ev({ ev: 'dialing', ref: dial.ref, call: 2 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'ds' })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 603 })
  await h.ev({ ev: 'play_done', call: 1, tag: 'dsFailed' })
}

test('route-event callback: uid із calls збережено без VG_DS_STAFF; успішний передзвін скидає пропуски співробітника', async () => {
  const h = harness()
  await discussionFails(h)
  assert.deepEqual(h.config.dsStaff, {})
  assert.equal(h.callbacks.listPending('908')[0].ownerUid, UID)
  assert.equal(h.staff.get('908', { uid: UID }).misses, 1)
  await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
  await h.ev(MANAGER)
  const dial = h.sent('dial').at(-1)
  assert.match(dial.ref, /^cb-10-/)
  await h.ev({ ev: 'dialing', ref: dial.ref, call: 11 })
  for (const call of [10, 11]) {
    await h.ev({ ev: 'state', call, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call, active: true })
  }
  await h.ev({ ev: 'play_done', call: 11, tag: 'cbGreeting' })
  await h.clock.advance(1)
  assert.equal(h.sent('xfer_replaces').at(-1).call, 10)
  await h.ev({ ev: 'xfer', call: 10, code: 200, final: true })
  assert.equal(h.staff.get('908', { uid: UID }).misses, 0)
  assert.deepEqual(h.events.find((e) => e.event === 'callback_connected'), { serviceRequestId: SR.id, generalCallID: MANAGER.gcid, event: 'callback_connected', ownerUid: UID, at: new Date(h.clock.now()).toISOString() })
  assert.equal(h.callbacks.listPending('908').length, 0)
})

test('route-event ai_ended: немає на невдалому старті, без репліки клієнта й для pending; розмова клієнта дає одну подію', async () => {
  const clientTurn = { speaker: 'client', start: 0, end: 1, text: 'Де кораблик?' }
  for (const mode of ['failed', 'empty', 'ai_only', 'pending', 'talked']) {
    const ai = fakeAi({ startFails: mode === 'failed', turns: mode === 'empty' || mode === 'failed' ? [] : mode === 'ai_only' ? [{ speaker: 'ai', text: 'Вітаю!' }] : [clientTurn] })
    const h = harness({ ai, callStatus: mode === 'pending' ? 'dialing' : 'summarized' })
    if (mode === 'pending') { await clientEnters(h); assert.equal(h.sent('dial').length, 0) }
    else await discussionFails(h)
    if (mode === 'failed') await h.ev({ ev: 'play_done', call: 1, tag: 'dsNoAi' })
    await h.ev({ ev: 'state', call: 1, state: 'DISCONNECTED', code: 200 })
    assert.equal(h.events.filter((e) => e.event === 'ai_ended').length, mode === 'talked' ? 1 : 0, mode)
  }
})

test('B1/no AI: після завершеного 80 обговорення дзвонить ведучому; невдача → 16 → 17 без оператора та без ai_ended', async () => {
  const h = harness({ ai: null })
  await discussionFails(h)
  assert.equal(h.sent('dial').length, 1)
  assert.deepEqual(h.sent('play').filter((p) => p.call === 1).map((p) => p.tag), ['intro', 'ds', 'dsFailed', 'dsNoAi'])
  await h.ev({ ev: 'play_done', call: 1, tag: 'dsNoAi' })
  assert.equal(h.journal[0].outcome, 'ds_callback')
  assert.deepEqual(h.events.map((e) => e.event), ['route', 'fallback'])
})

test('B1/no AI без 80: не починаємо розмову з ведучим чи оператором без оголошення про запис', async () => {
  const h = harness({ ai: null, missingIntro: true })
  await h.ev(CLIENT)
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 1, active: true })
  await h.clock.advance(3000)
  assert.equal(h.sent('dial').length, 0)
  assert.equal(h.sent('xfer_replaces').length, 0)
  assert.equal(h.journal[0].outcome, 'intro_failed')
})
