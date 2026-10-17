import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from './flow.mjs'
import { loadConfig } from './config.mjs'
import { makeCallbackStore } from './callbacks.mjs'
import { parseHours } from './hours.mjs'

const PHONE = '+380500000001'
const LEAD_UID = 'fictional-lead'
const OP_UID = 'fictional-operator'
const DAY = Date.parse('2026-10-16T10:00:00Z')
const NIGHT = Date.parse('2026-10-16T20:00:00Z')

function clockAt(start) {
  let now = start, sequence = 0
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

function harness({ legacyNight = false, operatorUid = null } = {}) {
  const now = legacyNight ? NIGHT : DAY
  const clock = clockAt(now), commands = [], sessions = []
  const callbacks = makeCallbackStore({ now: clock.now })
  const config = {
    ...loadConfig({}), answerMode: legacyNight ? 'manager' : 'ai', noAnswerMode: 'ai',
    managerUri: 'sip:907@127.0.0.1;transport=udp', managers: [['907']], sipServer: '127.0.0.1', allowedCallers: [PHONE],
    dsSource: legacyNight ? 'off' : 'calls', dsStaff: operatorUid ? { [operatorUid]: '907' } : {},
    workHours: parseHours('mon-fri 09:00-18:00'), aiAfterHours: !legacyNight,
    prompts: { intro: '/fake/80.wav', introShort: '/fake/80-short.wav' },
    dtmfSupported: true, dialDelayMs: 0, dialRetries: 0, dialRetryWindowSec: 0, afterCardMs: 0, greetingFile: null, holdFile: null,
  }
  const ai = (opts) => {
    const s = {
      opts, ended: false, start: () => ({ cmd: 'audio_start', call: opts.call, sock: '/fake/audio.sock', token: 'fake' }),
      stop(reason) { if (!s.ended) { s.ended = true; opts.onEnd({ reason }) } },
      end(info) { s.ended = true; opts.onEnd(info) },
      result: () => ({ provider: 'fake', durationMs: 1000, turns: [], toolCalls: [], usage: {}, errors: [] }),
    }
    sessions.push(s)
    return s
  }
  const dispatcher = createDispatcher({
    config, clock, ai, callbacks, send: (command) => commands.push(command),
    lookup: async () => ({ requests: [{ id: 'sr-fictional', status: 'new', createdAt: '2026-10-10T10:00:00Z' }] }),
    buildCard: () => ({ text: 'Дзвонить клієнт.', category: 'openRequest', serviceRequestId: 'sr-fictional' }),
    tts: async () => ({ file: '/fake/card.wav' }),
    appCalls: async () => [{ id: 'call-fictional', provider: 'binotel', direction: 'outbound', employeeUid: LEAD_UID, employeeLine: '909', status: 'summarized', disposition: 'ANSWER', durationSec: 30, createdAt: new Date(now - 60000).toISOString() }],
  })
  const ev = async (event) => { dispatcher.handle(event); await clock.flush() }
  return { config, clock, callbacks, sessions, ev, sent: (cmd) => commands.filter((x) => x.cmd === cmd) }
}

async function enter(h, intro = true) {
  await h.ev({ ev: 'incoming', call: 1, number: PHONE, from: 'sip:0500000001@127.0.0.1', gcid: 'gcid-fictional' })
  await h.ev({ ev: 'state', call: 1, state: 'CONFIRMED', code: 200 })
  await h.ev({ ev: 'media', call: 1, active: true })
  if (intro) await h.ev({ ev: 'play_done', call: 1, tag: 'intro' })
}

test('обговорення без маршруту ведучого: передзвін і останній клієнт оператора не отримують uid ведучого', async () => {
  for (const operatorUid of [null, OP_UID]) {
    const h = harness({ operatorUid })
    await enter(h)
    const session = h.sessions[0]
    assert.equal(session.opts.kind, 'discussion_unavailable')
    assert.equal(h.callbacks.pickTarget(['907']).ownerUid, operatorUid || undefined)
    assert.equal((await session.opts.onTool('transfer_to_manager', { topic: 'complaint' })).ok, true)
    session.end({ action: 'transfer' })
    await h.clock.flush()
    const dial = h.sent('dial').at(-1)
    assert.match(dial.uri, /sip:907@/)
    await h.ev({ ev: 'dialing', ref: dial.ref, call: 2 })
    await h.ev({ ev: 'state', call: 2, state: 'CONFIRMED', code: 200 })
    await h.ev({ ev: 'media', call: 2, active: true })
    assert.equal(h.callbacks.getLastClient(['907']).ownerUid, operatorUid || undefined)
  }
})

test('старий режим: VG_AI_AFTER_HOURS=0 зберігає звичайний перевід від busy ШІ навіть уночі', async () => {
  const h = harness({ legacyNight: true })
  await enter(h, false)
  await h.clock.advance(1)
  const dial = h.sent('dial').at(-1)
  await h.ev({ ev: 'dialing', ref: dial.ref, call: 2 })
  await h.ev({ ev: 'state', call: 2, state: 'DISCONNECTED', code: 486 })
  const session = h.sessions[0]
  assert.equal(session.opts.kind, 'busy')
  assert.equal(session.opts.transferAllowed, true)
  assert.equal((await session.opts.onTool('transfer_to_manager', { topic: 'other' })).ok, true)
})
