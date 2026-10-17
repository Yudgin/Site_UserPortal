// Дрібні частини ШІ-співрозмовника: робочий час, інструкції й перші фрази, документ дзвінка kind 'ai', файл
// розшифровки (0600), інструменти й агент ElevenLabs (ai-setup-elevenlabs.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseHours, inHours, hoursText } from './hours.mjs'
import { buildInstructions, FIRST_MESSAGES, TOOL_DEFS, requestStatusFor, summaryText } from './aiprompt.mjs'
import { buildAiCallDoc, buildAiCallEvent, aiTalked, makeAiCallStore } from './aicalls.mjs'
import { saveAiTranscript, pruneGatewayData } from './storage.mjs'
import { toolConfig, agentBody } from './ai-setup-elevenlabs.mjs'

test('робочий час: пн–пт 9–18 за Києвом, кілька проміжків, помилки розбору, текст для моделі', () => {
  const h = parseHours('mon-fri 09:00-18:00')
  assert.equal(inHours(h, new Date('2026-10-16T05:59:00Z')), false) // пт 08:59 Київ
  assert.equal(inHours(h, new Date('2026-10-16T06:00:00Z')), true) // пт 09:00
  assert.equal(inHours(h, new Date('2026-10-16T14:59:00Z')), true) // пт 17:59
  assert.equal(inHours(h, new Date('2026-10-16T15:00:00Z')), false) // пт 18:00
  assert.equal(inHours(h, new Date('2026-10-17T10:00:00Z')), false) // субота
  const h2 = parseHours('mon-fri 09:00-18:00; sat 10:00-14:00')
  assert.equal(inHours(h2, new Date('2026-10-17T08:00:00Z')), true) // сб 11:00
  assert.equal(hoursText(h2), "з понеділка до п'ятниці, з 09:00 до 18:00; у суботу, з 10:00 до 14:00")
  assert.equal(inHours([], new Date()), true)
  assert.deepEqual(parseHours(''), [])
  assert.throws(() => parseHours('щодня'), /VG_WORK_HOURS/)
  assert.throws(() => parseHours('mon 18:00-09:00'), /VG_WORK_HOURS/)
  // через неділю: sat-mon
  const h3 = parseHours('sat-mon 10:00-12:00')
  assert.equal(inHours(h3, new Date('2026-10-18T08:30:00Z')), true) // нд 11:30
})

test('інструкції: українська, заборони приватності, з\'єднання — лише коли дозволено; перші фрази кажуть «штучний інтелект» і про запис', () => {
  for (const k of ['busy', 'after_hours']) {
    assert.match(FIRST_MESSAGES[k], /штучний інтелект/)
    assert.match(FIRST_MESSAGES[k], /записується/)
  }
  assert.match(FIRST_MESSAGES.transfer_failed, /менеджер (вам )?передзвонить/)
  const a = buildInstructions({ kind: 'busy', transferAllowed: true, category: 'openRequest' })
  assert.match(a, /завжди відповідай українською/)
  assert.match(a, /transfer_to_manager/)
  assert.match(a, /відкрита заявка/)
  assert.match(a, /сто дванадцять/)
  assert.doesNotMatch(a, /етап \(за нашими/)
  const b = buildInstructions({ kind: 'after_hours', hoursText: "з понеділка до п'ятниці, з 09:00 до 18:00", transferAllowed: false, statusDetail: 'stage' })
  assert.match(b, /неробочий час: ми працюємо з понеділка/)
  assert.match(b, /З'єднати з менеджером зараз не можна/)
  assert.match(b, /етап \(за нашими даними/)
  const c = buildInstructions({ kind: 'transfer_failed', note: { question: 'Де посилка?' } })
  assert.match(c, /менеджер не відповів/)
  assert.match(c, /«Де посилка\?»/)
  assert.deepEqual(TOOL_DEFS.map((t) => t.name), ['get_request_status', 'save_question_for_manager', 'transfer_to_manager', 'end_call'])
})

test('стан заявки: закрита заявка — без номера; лише дозволені поля; підсумок «Суть / Домовилися / Далі»', () => {
  const closed = { id: 'a', status: 'done', stage: 'shipped', clientName: 'Іван', onec: { number: '7' }, createdAt: '2025-01-01T00:00:00Z' }
  const r = requestStatusFor({ requests: [closed], profile: null, orders: [] }, { nowMs: Date.parse('2026-10-16T10:00:00Z') })
  assert.equal(r.found, true)
  assert.equal(r.open, false)
  assert.equal(r.requestNumber, null)
  assert.ok(!JSON.stringify(r).includes('Іван'))
  assert.equal(requestStatusFor(null, { lookupState: 'off' }).found, false)
  assert.equal(summaryText({ note: { question: 'Де кораблик?', callback: true, urgent: true }, callbackStored: true }), 'Суть: Де кораблик?\nДомовилися: Менеджер передзвонить.\nДалі: Передзвонити клієнту (термінове).')
  assert.equal(summaryText({ note: null, transferred: true }), "Суть: Питання не записано.\nДомовилися: З'єднано з менеджером.\nДалі: немає")
})

const ENTRY = {
  startedAt: '2026-10-16T10:00:00.000Z', endedAt: '2026-10-16T10:01:30.000Z', durationMs: 90000, gcid: '6929148313', serviceRequestId: 'sr1',
  outcome: 'ai_noted', callback: { stored: true }, t: { ai: 26000, aiStart: 26050 },
  ai: { kind: 'busy', transfers: 0, sessions: [{ durationMs: 60000, toolCalls: [{ name: 'save_question_for_manager', at: 30000, ok: true, ms: 12 }] }] },
}
const TRANSCRIPT = { kind: 'busy', note: { question: 'Де кораблик?', topic: 'repair', urgent: false, callback: true }, turns: [{ speaker: 'ai', start: 26.1, end: 30, text: 'Вітаю!' }, { speaker: 'client', start: 31, end: 33, text: 'Де мій кораблик?' }], providers: ['elevenlabs/elevenlabs-agents/claude-sonnet-5-5'], costUsd: 0.08 }

test('документ дзвінка kind ai (формат конвеєра 17.10): є GCID — finished + recordingOnly + nextCheckAt зараз, без полів блокування; розшифровка з підписами, підсумок', () => {
  const { callId, doc } = buildAiCallDoc({ entry: ENTRY, transcript: TRANSCRIPT, sr: { clientPhone: '+380500000001', clientName: 'Іван', serviceCenterId: 'c1' }, now: new Date('2026-10-16T10:01:31Z') })
  assert.equal(callId, 'ai-6929148313')
  assert.equal(doc.id, callId)
  assert.equal(doc.kind, 'ai')
  assert.equal(doc.provider, 'voice-gateway')
  assert.equal(doc.status, 'finished')
  assert.equal(doc.recordingOnly, true)
  assert.equal(doc.nextCheckAt, '2026-10-16T10:01:31.000Z')
  assert.equal(doc.generalCallID, '6929148313')
  assert.equal(doc.finishedAt, '2026-10-16T10:01:30.000Z')
  for (const k of ['lockUntil', 'lockToken', 'attempts']) assert.ok(!(k in doc), `поле ${k} пише лише конвеєр`)
  assert.deepEqual([...new Set(doc.transcript.turns.map((t) => t.speaker))].sort(), ['ai', 'client'])
  // без GCID запису не буде — одразу summarized
  const noGcid = buildAiCallDoc({ entry: { ...ENTRY, gcid: null }, transcript: TRANSCRIPT, now: new Date('2026-10-16T10:01:31Z') })
  assert.match(noGcid.callId, /^ai-[0-9a-z]+-[0-9a-f]{4}$/)
  assert.equal(noGcid.doc.status, 'summarized')
  assert.equal(noGcid.doc.recordingOnly, false)
  assert.equal(noGcid.doc.nextCheckAt, null)
  assert.equal(doc.direction, 'inbound')
  assert.equal(doc.answeredAt, '2026-10-16T10:00:26.050Z')
  assert.equal(doc.durationSec, 90)
  assert.equal(doc.transcript.text, 'ШІ-помічник: Вітаю!\nКлієнт: Де мій кораблик?')
  assert.equal(doc.transcript.durationSec, 60)
  assert.match(doc.summary.text, /^Суть: Де кораблик\?/)
  assert.equal(doc.ai.outcome, 'noted')
  assert.deepEqual(doc.ai.toolCalls, [{ name: 'save_question_for_manager', at: 30000, ok: true }])
  assert.equal(doc.cost.aiUsd, 0.08)
  assert.equal(doc.recording, null)
  assert.equal(doc.serviceCenterId, 'c1')
})

test('картка дошки callEvents/ai-<gcid>: форма дзеркала originate, ШІ-помічник, підсумок ≤ 300; лише коли розмова з ШІ була; save() пише документ і картку', async () => {
  const ev = buildAiCallEvent({ entry: { ...ENTRY, number: '+380500000001' }, transcript: TRANSCRIPT, callId: 'ai-6929148313', sr: { clientName: 'Іван' }, now: new Date('2026-10-16T10:01:31Z') })
  assert.deepEqual(Object.keys(ev).sort(), ['at', 'callId', 'clientName', 'direction', 'employee', 'kind', 'lastType', 'phone', 'serviceRequestId', 'source', 'sourceCallId', 'summary', 'updatedAt'])
  assert.equal(ev.employee, 'ШІ-помічник')
  assert.equal(ev.lastType, 'call.ai')
  assert.equal(ev.phone, '+380500000001')
  assert.ok(ev.summary.length <= 300 && /^Суть: Де кораблик\?/.test(ev.summary))
  const long = buildAiCallEvent({ entry: ENTRY, transcript: { note: { question: 'а'.repeat(500), callback: true } }, callId: 'x' })
  assert.equal(long.summary.length, 300)
  assert.equal(aiTalked(ENTRY), true)
  assert.equal(aiTalked({ ai: { sessions: [{ durationMs: 3000, toolCalls: [] }] } }), false, 'поклав у перші секунди — картки немає')
  // підроблений Firestore: заявка є → документ і картка; заявки немає → лише картка
  const writes = []
  const fakeDb = {
    collection: (c) => ({
      doc: (id) => ({
        get: async () => ({ exists: id === 'sr1', data: () => ({ clientPhone: '+380500000001', clientName: 'Іван', serviceCenterId: 'c1' }) }),
        set: async (d, o) => { writes.push([`${c}/${id}`, d.kind, o]) },
        collection: (sub) => ({ doc: (sid) => ({ set: async (d, o) => { writes.push([`${c}/${id}/${sub}/${sid}`, d.kind, o]) } }) }),
      }),
    }),
  }
  const store = makeAiCallStore({ db: fakeDb })
  const r1 = await store.save({ ...ENTRY, number: '+380500000001', aiTranscript: TRANSCRIPT })
  assert.deepEqual(r1, { path: 'serviceRequests/sr1/calls/ai-6929148313', event: 'callEvents/ai-6929148313' })
  const r2 = await store.save({ ...ENTRY, serviceRequestId: null, aiTranscript: TRANSCRIPT })
  assert.deepEqual(r2, { skipped: 'no_request', event: 'callEvents/ai-6929148313' })
  assert.deepEqual(writes.map((w) => w[0]), ['serviceRequests/sr1/calls/ai-6929148313', 'callEvents/ai-6929148313', 'callEvents/ai-6929148313'])
  assert.ok(writes.every((w) => w[2]?.merge === true))
  assert.deepEqual(await store.save({ ...ENTRY }), { skipped: 'no_transcript' })
})

test('файл розшифровки: <data>/ai/<дата>/<gcid>-<4 цифри>.json, 0600 у теці 0700, не перезаписує; старі прибираються', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ai-'))
  try {
    const f = saveAiTranscript({ dataDir: dir, gcid: '6929148313', number: '+380500000001', record: TRANSCRIPT, now: new Date('2026-10-16T10:00:00Z') })
    assert.equal(f, path.join(dir, 'ai', '2026-10-16', '6929148313-0001.json'))
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700)
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).note, TRANSCRIPT.note)
    const f2 = saveAiTranscript({ dataDir: dir, gcid: '6929148313', number: '+380500000001', record: {}, now: new Date('2026-10-16T10:00:00Z') })
    assert.equal(path.basename(f2), '6929148313-0001-2.json')
    const old = Date.now() - 91 * 86400000
    fs.utimesSync(f, old / 1000, old / 1000)
    assert.equal(pruneGatewayData({ dataDir: dir, cacheDir: dir, retentionDays: { logs: 14, cache: 30, journal: 90, voicemail: 90, ai: 90 } }), 1)
    assert.ok(!fs.existsSync(f) && fs.existsSync(f2))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ElevenLabs: інструменти — client, з відповіддю лише інформаційні; агент — pcm_8000, uk, приватний, без системних інструментів, переозначення дозволено', () => {
  const tools = TOOL_DEFS.map(toolConfig)
  assert.deepEqual(tools.map((t) => [t.tool_config.name, t.tool_config.expects_response]), [['get_request_status', true], ['save_question_for_manager', true], ['transfer_to_manager', false], ['end_call', false]])
  const sq = tools[1].tool_config.parameters
  assert.deepEqual(sq.required, ['question', 'callback'])
  assert.deepEqual(sq.properties.topic.enum, ['repair', 'purchase', 'warranty', 'delivery', 'complaint', 'safety', 'other'])
  for (const p of Object.values(sq.properties)) assert.ok(p.description, 'опис властивості обов\'язковий для ElevenLabs')
  const a = agentBody({ llm: 'claude-sonnet-5-5', voiceId: 'v', toolIds: ['t1'], retentionDays: 30 })
  const c = a.conversation_config
  assert.equal(c.asr.user_input_audio_format, 'pcm_8000')
  assert.equal(c.tts.agent_output_audio_format, 'pcm_8000')
  assert.equal(c.agent.language, 'uk')
  assert.equal(c.agent.disable_first_message_interruptions, true)
  assert.ok(Object.values(c.agent.prompt.built_in_tools).every((x) => x === null))
  assert.ok(c.conversation.client_events.includes('client_tool_call') && c.conversation.client_events.includes('interruption'))
  assert.equal(a.platform_settings.auth.enable_auth, true)
  assert.equal(a.platform_settings.privacy.record_voice, false)
  assert.equal(a.platform_settings.overrides.conversation_config_override.agent.prompt.prompt, true)
})

test('ElevenLabs: дії після фрази — post_tool_speech, помилки інструментів — passthrough; агент без черги, ліміт = VG_MAX_CALLS, tool_ids переозначаються, проміжне розпізнавання', () => {
  const tools = TOOL_DEFS.map(toolConfig)
  // ToolExecutionMode: transfer / end_call — коли агент договорив фразу; інформаційні — одразу
  assert.deepEqual(tools.map((t) => [t.tool_config.name, t.tool_config.execution_mode]), [['get_request_status', 'immediate'], ['save_question_for_manager', 'immediate'], ['transfer_to_manager', 'post_tool_speech'], ['end_call', 'post_tool_speech']])
  for (const t of tools) {
    assert.equal(t.tool_config.tool_error_handling_mode, 'passthrough', t.tool_config.name)
    // post_tool_speech — лише для інструментів без відповіді (afterSpeech)
    assert.equal(t.tool_config.execution_mode === 'post_tool_speech', t.tool_config.expects_response === false, t.tool_config.name)
  }
  const a = agentBody({ llm: 'claude-sonnet-5-5', voiceId: 'v', toolIds: ['t1'], retentionDays: 30 })
  const ps = a.platform_settings
  assert.deepEqual(ps.queueing_config, { enabled: false })
  assert.deepEqual(ps.call_limits, { bursting_enabled: false, agent_concurrency_limit: 2 })
  assert.equal(agentBody({ llm: 'x', voiceId: 'v', toolIds: [], retentionDays: 30, concurrencyLimit: 3 }).platform_settings.call_limits.agent_concurrency_limit, 3)
  assert.deepEqual(ps.overrides.conversation_config_override.agent.prompt, { prompt: true, tool_ids: true })
  const ce = a.conversation_config.conversation.client_events
  assert.ok(ce.includes('tentative_user_transcript'))
  assert.ok(!ce.includes('queue_status'), 'queue_status шлють завжди — у ClientEvent його немає')
  assert.equal(new Set(ce).size, ce.length)
  assert.deepEqual(a.conversation_config.agent.prompt.tool_ids, ['t1'])
})
