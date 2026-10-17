// Дрібні частини ШІ-співрозмовника: робочий час, інструкції й перші фрази, документ дзвінка kind 'ai', файл
// розшифровки (0600), інструменти й агент ElevenLabs (ai-setup-elevenlabs.mjs); режим «ШІ одразу» — тексти й правила
// переводу, нові змінні, гудки 425 Гц, рядок підсумку в консолі.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseHours, inHours, hoursText } from './hours.mjs'
import { buildInstructions, AI_TEXTS, TOOL_DEFS, requestStatusFor, summaryText, firstMessageFor, REQUEST_PAGE_TEXT, SECOND_LINE_TEXT, speakable, CALLBACK_PROMISE, TERMS_REQUIRED, URGENT_CONNECTING, stripVoiceTags, toolsFor } from './aiprompt.mjs'
import { loadConfig, parseBreaker, CLIENT_TRIAL_TEXTS, JOIN_PROMPT_TEXTS } from './config.mjs'
import { ringbackWav, ensureRingback } from './storage.mjs'
import { readWavInfo, isTelephonyWav } from './tts.mjs'
import { summary, newModesLine } from './gateway.mjs'
import { buildAiCallDoc, buildAiCallEvent, aiTalked, makeAiCallStore } from './aicalls.mjs'
import { saveAiTranscript, updateAiTranscript, pruneGatewayData } from './storage.mjs'
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

test('інструкції: українська, заборони приватності, з\'єднання — лише коли дозволено; перші фрази старого режиму — оголошення про запис з метою і «штучний інтелект»', () => {
  // старий режим (VG_NO_ANSWER_MODE=ai): 80 перед ШІ не звучить — AI-FALLBACK-GREETING (запис з метою), потім «штучний інтелект»
  for (const [k, afterHours] of [['busy', false], ['after_hours', true]]) {
    const t = firstMessageFor({ kind: k, afterHours })
    assert.match(t, /^Вітаємо! Це віртуальний помічник компанії Runferry\./)
    assert.match(t, /записуємо розмову, щоб (точно )?опрацювати/)
    assert.match(t, /штучний інтелект/)
    assert.doesNotMatch(t, /Розмова записується|розмова записується|Вам відповідає/)
  }
  assert.match(firstMessageFor({ kind: 'transfer_failed' }), /вам передзвонять/)
  const a = buildInstructions({ kind: 'busy', transferAllowed: true, category: 'openRequest' })
  assert.match(a, /завжди відповідай українською/)
  assert.match(a, /transfer_to_manager/)
  assert.match(a, /відкрита заявка/)
  assert.match(a, /сто дванадцять/)
  assert.doesNotMatch(a, /етап \(за нашими/)
  const b = buildInstructions({ kind: 'after_hours', hoursText: "з понеділка до п'ятниці, з 09:00 до 18:00", transferAllowed: false, statusDetail: 'stage' })
  assert.match(b, /неробочий час: ми працюємо з понеділка/)
  assert.match(b, /З'єднати з людиною зараз не можна/)
  assert.match(b, /етап \(за нашими даними/)
  const c = buildInstructions({ kind: 'transfer_failed', note: { question: 'Де посилка?' } })
  assert.match(c, /ніхто не прийняв дзвінок/)
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

test('«ШІ одразу»: перші фрази — дослівно черновик 5а (днём короткий, уночі повний); після 80 — без оголошення про запис, без 80 — AI-FALLBACK-GREETING і без повторного «Вам відповідає…»; transfer_failed у двох варіантах', () => {
  assert.equal(firstMessageFor({ kind: 'first', variant: 'request', intro: true, v2: true }), 'Вам відповідає віртуальний помічник — штучний інтелект. За вашим номером є відкрита заявка — чим допомогти?')
  assert.equal(firstMessageFor({ kind: 'first', variant: 'request', intro: true, v2: true, afterHours: true }), 'Вам відповідає віртуальний помічник — штучний інтелект. Бачу, що за вашим номером є відкрита заявка. Чим можу допомогти?')
  assert.equal(firstMessageFor({ kind: 'first', variant: 'general', intro: false, v2: true, afterHours: true }), 'Вітаємо! Це віртуальний помічник компанії Runferry. Зверніть увагу: ми записуємо розмову, щоб точно опрацювати ваше звернення й контролювати якість обслуговування. Я — штучний інтелект. Ви телефонуєте щодо ремонту, купівлі чи налаштування кораблика?')
  assert.equal(firstMessageFor({ kind: 'first', variant: 'nodata', intro: true, v2: true }), 'Вам відповідає віртуальний помічник — штучний інтелект. Чим можу допомогти?')
  assert.equal(firstMessageFor({ kind: 'after_hours', intro: true, v2: true, afterHours: true }), `${speakable(AI_TEXTS.afterHours.full)} ${CALLBACK_PROMISE}`)
  // ніч + відкрита невиконана заявка — новий AI-AFTER-HOURS-REQUEST
  assert.equal(firstMessageFor({ kind: 'after_hours', intro: true, v2: true, afterHours: true, category: 'openRequest' }), `${speakable(AI_TEXTS.afterHoursRequest.full)} ${CALLBACK_PROMISE}`)
  assert.equal(firstMessageFor({ kind: 'transfer_failed', note: { question: 'Де?' }, v2: true, announced: true }), `З’єднати не вдалося — я передам ваше запитання, і вам передзвонять. ${CALLBACK_PROMISE}`)
  assert.equal(firstMessageFor({ kind: 'transfer_failed', note: null, v2: true, afterHours: true, announced: true }), `На жаль, з’єднати вас з оператором не вдалося. Ми вже повідомили про ваш дзвінок — вам передзвонять. Що передати? ${CALLBACK_PROMISE}`)
  // обговорення
  assert.equal(firstMessageFor({ kind: 'discussion_failed', intro: true, v2: true }), `${speakable(AI_TEXTS.dsFailed.short)} ${CALLBACK_PROMISE}`)
  assert.equal(firstMessageFor({ kind: 'discussion_unavailable', intro: true, v2: true }), `${speakable(AI_TEXTS.dsUnavailable.short)} ${CALLBACK_PROMISE}`)
  assert.equal(firstMessageFor({ kind: 'discussion_after_hours', intro: true, v2: true, afterHours: true }), `${speakable(AI_TEXTS.dsAfterHours.full)} ${CALLBACK_PROMISE}`)
  // кожна перша фраза каже «штучний інтелект»; «розмова записується» без мети немає ніде; без 80 — оголошення з метою першим
  const kinds = [['first', 'request'], ['first', 'general'], ['first', 'nodata'], ['after_hours'], ['discussion_failed'], ['discussion_unavailable'], ['discussion_after_hours'], ['busy']]
  for (const [kind, variant] of kinds) for (const intro of [true, false]) for (const afterHours of [true, false]) {
    const t = firstMessageFor({ kind, variant, intro, v2: true, afterHours })
    assert.match(t, /штучний інтелект/, `${kind}/${variant}/${intro}`)
    assert.doesNotMatch(t, /розмова записується|Розмова записується/)
    if (!intro) {
      assert.match(t, /^Вітаємо! Це віртуальний помічник компанії Runferry\. (Зверніть увагу: ми записуємо розмову, щоб точно опрацювати|Ми записуємо розмову, щоб опрацювати)/)
      assert.doesNotMatch(t, /Вам відповідає/)
      assert.equal(t.match(/віртуальний помічник/g).length, 1, 'після AI-FALLBACK-GREETING «віртуальний помічник» не повторюється')
    } else assert.doesNotMatch(t, /записуємо/, 'після 80 про запис ШІ не каже')
  }
})

test('«ШІ одразу»: правила переводу (рішення 20/21) — з відкритою заявкою раз сторінка заявки й винятки, без заявки одразу, always одразу; «сторінка заявки», друга лінія, «запитання/питання»; номера клієнта немає', () => {
  const open = buildInstructions({ kind: 'first', category: 'openRequest', transferAllowed: true, v2: true })
  assert.match(open, /один раз скажи/)
  assert.ok(open.includes(REQUEST_PAGE_TEXT))
  assert.match(open, /знову просить людину — з'єднай/)
  assert.match(open, /претензія щодо якості, гарантійне питання, небезпечна ситуація/)
  assert.match(open, /ми не відповіли вчасно або клієнту складно користуватися посиланням/)
  assert.doesNotMatch(open, /кабінет/)
  assert.match(open, /стежити за статусом заявки й замовити дзвінок майстра/)
  assert.match(open, /Залишайтеся на лінії — з’єдную з оператором\./) // AI-CONNECTING (днём короткий)
  // «друга лінія»: фраза AI-SECOND-LINE — лише коли шлюз знає про наш дзвінок клієнтові (pending_call)
  assert.ok(!open.includes(SECOND_LINE_TEXT))
  assert.match(open, /не стверджуй, що це наш співробітник/)
  assert.ok(buildInstructions({ kind: 'first', category: 'openRequest', transferAllowed: true, v2: true, secondLineConfirmed: true }).includes(SECOND_LINE_TEXT))
  assert.match(open, /«запитання» — коли про щось питають/)
  assert.match(open, /безкоштовну розмову з майстром/)
  const none = buildInstructions({ kind: 'first', category: 'unknown', transferAllowed: true, v2: true })
  assert.match(none, /Відкритої заявки за цим номером немає: клієнт просить людину — з'єднай з оператором одразу/)
  assert.doesNotMatch(none, /один раз скажи/)
  const nodata = buildInstructions({ kind: 'first', category: null, transferAllowed: true, v2: true })
  assert.match(nodata, /спершу перевір get_request_status/)
  const always = buildInstructions({ kind: 'first', category: 'openRequest', transferAllowed: true, v2: true, transferMode: 'always' })
  assert.match(always, /з'єднай з оператором одразу: transfer_to_manager/)
  assert.doesNotMatch(always, /один раз скажи/)
  const night = buildInstructions({ kind: 'after_hours', category: 'openRequest', transferAllowed: false, v2: true })
  assert.match(night, /З'єднати з людиною зараз не можна/)
  assert.doesNotMatch(night, /transfer_to_manager\. За номером/)
  for (const t of [open, none, nodata, always, night]) assert.doesNotMatch(t, /0500000001|380\d{9}/)
  // стан заявки в новому режимі — «сторінка заявки», без особистих даних
  const sr = { id: 'a', status: 'diagnostics', stage: 'diagnosed', clientName: 'Іван', onec: { number: '7' }, createdAt: '2026-10-10T00:00:00Z' }
  const r = requestStatusFor({ requests: [sr], profile: null, orders: [] }, { nowMs: Date.parse('2026-10-16T10:00:00Z'), v2: true })
  assert.match(r.note, /сторінка заявки/)
  assert.ok(!JSON.stringify(r).includes('Іван'))
})

test('config: нові змінні черги A — типово все вимкнено; VG_AI_BREAKER «збоїв/хв/хв»; клієнтські фрази — окремо від фраз менеджеру', () => {
  const c = loadConfig({})
  assert.deepEqual([c.answerMode, c.joinOnCallback, c.joinMode, c.holdTone, c.clientSynth, c.aiFirstTransfer, c.routeDecideGraceMs, c.ringbackFile],
    ['manager', false, 'bridge', 'phrase', 'off', 'ask', 1000, null])
  assert.deepEqual(c.aiBreaker, { fails: 3, windowMs: 600000, offMs: 1800000 })
  assert.ok(Object.values(c.aiFirstPromptFiles).every((v) => v === null))
  assert.deepEqual(Object.keys(c.aiFirstPromptFiles).sort(), ['aiDown', 'aiDownNight', 'aiDownShort', 'dsCalled', 'dsCalledShort', 'dsFailed', 'dsGeneral', 'dsGeneralShort', 'dsNoAi', 'dsNoAiShort', 'dsTalked', 'dsTalkedShort', 'intro', 'introShort', 'joinClient', 'mgrJoin', 'mgrJoinBusy', 'mgrJoinGone', 'mgrJoinPlain', 'mgrJoinTail'])
  const c2 = loadConfig({ VG_ANSWER_MODE: ' AI ', VG_JOIN_ON_CALLBACK: '1', VG_JOIN_MODE: 'refer', VG_HOLD_TONE: 'ringback', VG_CLIENT_SYNTH: 'trial', VG_AI_FIRST_TRANSFER: 'always', VG_INTRO_WAV: '/w/80.wav', VG_JOIN_CLIENT_WAV: '/w/81.wav', VG_AI_DOWN_WAV: '/w/82.wav', VG_MGR_JOIN_WAV: '/w/mj.wav', VG_ROUTE_DECIDE_GRACE_MS: '700' })
  assert.deepEqual([c2.answerMode, c2.joinOnCallback, c2.joinMode, c2.holdTone, c2.clientSynth, c2.aiFirstTransfer, c2.routeDecideGraceMs], ['ai', true, 'refer', 'ringback', 'trial', 'always', 700])
  assert.deepEqual([c2.aiFirstPromptFiles.intro, c2.aiFirstPromptFiles.joinClient, c2.aiFirstPromptFiles.aiDown, c2.aiFirstPromptFiles.mgrJoin], ['/w/80.wav', '/w/81.wav', '/w/82.wav', '/w/mj.wav'])
  const c3 = loadConfig({ VG_AI_DOWN_NIGHT_WAV: '/w/83.wav', VG_MGR_JOIN_PLAIN_WAV: '/w/mjp.wav' })
  assert.deepEqual([c3.aiFirstPromptFiles.aiDownNight, c3.aiFirstPromptFiles.mgrJoinPlain], ['/w/83.wav', '/w/mjp.wav'])
  assert.deepEqual(parseBreaker('2/5/15'), { fails: 2, windowMs: 300000, offMs: 900000 })
  assert.equal(parseBreaker('0'), null)
  assert.equal(parseBreaker('off'), null)
  assert.deepEqual(parseBreaker('щось'), { fails: 3, windowMs: 600000, offMs: 1800000 })
  // 80 — дослівно черновик 5а: оголошення про запис З МЕТОЮ (Правила №761), повний і короткий
  assert.equal(CLIENT_TRIAL_TEXTS.intro, 'Вітаємо! Це багатоканальна лінія компанії Runferry. ‖ Зверніть увагу: ми записуємо розмову, щоб точно опрацювати ваше звернення й контролювати якість обслуговування.')
  assert.equal(CLIENT_TRIAL_TEXTS.introShort, 'Вітаємо! Це багатоканальна лінія компанії Runferry. ‖ Ми записуємо розмову, щоб опрацювати звернення й контролювати якість.')
  assert.equal(CLIENT_TRIAL_TEXTS.joinClient, 'Менеджер уже на лінії — з’єдную вас.')
  assert.equal(CLIENT_TRIAL_TEXTS.aiDownShort, 'Залишайтеся на лінії — з’єднуємо з оператором.')
  assert.equal(CLIENT_TRIAL_TEXTS.dsFailed, 'На жаль, з’єднати вас не вдалося.')
  assert.equal(JOIN_PROMPT_TEXTS.mgrJoinBusy, 'Клієнта вже з’єднують з колегою.')
  assert.equal(JOIN_PROMPT_TEXTS.mgrJoin, 'Клієнт зараз говорить із віртуальним помічником.')
  // клієнт із ШІ не говорив — менеджеру без «віртуального помічника»; 83 (ніч, ШІ не піднявся) — без «зайнята»
  assert.equal(JOIN_PROMPT_TEXTS.mgrJoinPlain, "Клієнт на лінії — з'єдную.")
  assert.doesNotMatch(CLIENT_TRIAL_TEXTS.aiDownNight, /зайнят|з’єдну|з'єдну/)
  assert.match(CLIENT_TRIAL_TEXTS.aiDownNight, /неробочий час.*вам передзвонять/)
  assert.ok(!('intro' in c.promptTexts) && !('mgrJoin' in c.promptTexts), 'старий набір фраз (і їх синтез при старті) не змінився')
})

test('гудки 425 Гц: 1 с тону + 4 с тиші, WAV 8 кГц моно 16 біт, у кеші 0600', () => {
  const w = ringbackWav()
  assert.ok(isTelephonyWav(readWavInfo(w)))
  assert.equal(w.length, 44 + 8000 * 2 * 5)
  const pcm = w.subarray(44)
  const peak = (from, to) => { let m = 0; for (let i = from; i < to; i += 2) m = Math.max(m, Math.abs(pcm.readInt16LE(i))); return m }
  assert.ok(peak(0, 16000) > 5000, 'перша секунда — тон')
  assert.equal(peak(16000, pcm.length), 0, 'далі — тиша')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-vg-rb-'))
  const f = ensureRingback({ cacheDir: dir })
  assert.equal(path.basename(f), 'ringback-425hz.wav')
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.equal(ensureRingback({ cacheDir: dir }), f)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('консоль: підсумок — «ШІ одразу», старий режим через запобіжник, приєднання менеджера', () => {
  assert.match(summary({ number: '+380500000001', outcome: 'ai_noted', ai: { kind: 'first', sessions: [{ durationMs: 30000, costUsd: 0.05 }], note: { urgent: false } }, route: { branch: 'ai_first' }, t: {} }), /ИИ \(сразу\): 30\.0 с/)
  assert.match(summary({ number: '+380500000001', outcome: 'connected', route: { branch: 'classic', why: 'breaker' }, t: {} }), /«ИИ сразу» не включился \(предохранитель\)/)
  assert.match(summary({ number: '+380500000001', outcome: 'bridged_join', join: { fromPhase: 'ai', mode: 'bridge', result: 'bridged', ms: 4200 }, t: {} }), /присоединение менеджера \(из фазы ai, мост\): соединены мостом за 4\.2 с/)
})

test('повторна сесія після приєднаного менеджера, що поклав (failedBy join): перша фраза й інструкції без «не відповідає» / «пропущений дзвінок», в обох режимах; недозвон (dial) — як і раніше', () => {
  for (const v2 of [true, false]) {
    for (const note of [null, { question: 'Де посилка?' }]) {
      const t = firstMessageFor({ kind: 'transfer_failed', v2, note, failedBy: 'join' })
      assert.doesNotMatch(t, /пропущений|не відповідає|Ваш дзвінок записано/)
      assert.match(t, /менеджер не зміг продовжити розмову/)
      assert.match(t, /вам передзвонять/)
    }
    const ins = buildInstructions({ kind: 'transfer_failed', v2, failedBy: 'join', note: { question: 'Де посилка?' } })
    assert.match(ins, /приєднався до розмови, але поклав слухавку/)
    assert.doesNotMatch(ins, /менеджер не відповів/)
    assert.match(ins, /«Де посилка\?»/)
    assert.doesNotMatch(ins, /неробочий час/)
    assert.match(buildInstructions({ kind: 'transfer_failed', v2, failedBy: 'join', afterHours: true, hoursText: "з понеділка до п'ятниці, з 09:00 до 18:00" }), /Зараз неробочий час: ми працюємо з понеділка/)
  }
  // недозвон — AI-TRANSFER-FAILED в обох режимах (без «Ваш дзвінок записано» і «пропущений дзвінок»)
  assert.equal(firstMessageFor({ kind: 'transfer_failed', v2: false, announced: true }), `${speakable(AI_TEXTS.transferFailedNone.short)} ${CALLBACK_PROMISE}`)
  assert.match(firstMessageFor({ kind: 'transfer_failed', v2: true, announced: true }), /^З’єднати не вдалося — вам передзвонять/)
  const initial = firstMessageFor({ kind: 'transfer_failed', v2: true })
  assert.match(initial, /^Вітаємо! Це віртуальний помічник компанії Runferry\. Ми записуємо розмову, щоб опрацювати/)
  assert.match(initial, /штучний інтелект/)
  assert.match(buildInstructions({ kind: 'transfer_failed', v2: true }), /ніхто не прийняв дзвінок\. Про це клієнт щойно почув у першій фразі\./)
})

test('документ і картка дошки: приєднаний менеджер (bridged_join / connected_join) і міст — «З\'єднано з менеджером», перезвін знято — не «Менеджер передзвонить»', () => {
  const now = new Date('2026-10-16T10:01:31Z')
  for (const outcome of ['bridged_join', 'connected_join', 'bridged', 'connected_unconfirmed']) {
    const entry = { ...ENTRY, outcome, callback: { managerKey: '907', stored: true, id: 'x' }, pendingRemoved: 1 }
    const { doc } = buildAiCallDoc({ entry, transcript: TRANSCRIPT, now })
    assert.match(doc.summary.text, /Домовилися: З'єднано з менеджером\.\nДалі: немає/, outcome)
    assert.equal(doc.ai.callbackStored, false, outcome)
    const ev = buildAiCallEvent({ entry, transcript: TRANSCRIPT, callId: 'ai-x', now })
    assert.match(ev.summary, /Домовилися: З'єднано з менеджером\. Далі: немає/, outcome)
  }
  // питання записане, перезвін чекає — як і раніше
  const { doc } = buildAiCallDoc({ entry: ENTRY, transcript: TRANSCRIPT, now })
  assert.match(doc.summary.text, /Домовилися: Менеджер передзвонить\./)
  assert.equal(doc.ai.callbackStored, true)
  // ШІ вночі не піднявся — у документі «failed», перезвін чекає
  assert.equal(buildAiCallDoc({ entry: { ...ENTRY, outcome: 'ai_failed_callback' }, transcript: TRANSCRIPT, now }).doc.ai.outcome, 'failed')
})

test('консоль: «сначала менеджер» — лише якщо менеджеру дзвонили; ніч без ШІ — без «линия занята»; рядок нових режимів — пробний синтез вступу ще йде', () => {
  const night = summary({ number: '+380500000001', outcome: 'ai_answered', route: { branch: 'classic', why: 'breaker' }, ai: { kind: 'after_hours', sessions: [] }, dials: [], t: {} })
  assert.match(night, /«ИИ сразу» не включился \(предохранитель\)/)
  assert.doesNotMatch(night, /сначала менеджер/)
  assert.match(summary({ number: '+380500000001', outcome: 'connected', route: { branch: 'classic', why: 'breaker' }, dials: [{ to: 'manager', attempt: 1 }], t: {} }), /не включился \(предохранитель\) — сначала менеджер/)
  const down = summary({ number: '+380500000001', outcome: 'ai_failed_callback', reason: 'after_hours', callback: { stored: true }, ai: { kind: 'after_hours', error: 'ai_error', sessions: [] }, t: {} })
  assert.doesNotMatch(down, /клиенту «линия занята»/)
  assert.match(down, /менеджеру не звонили — «линия занята» не звучала, перезвон сохранён/)
  const c = loadConfig({ VG_ANSWER_MODE: 'ai', VG_CLIENT_SYNTH: 'trial', VG_ALLOWED_CALLERS: '+380500000001' })
  assert.match(newModesLine(c, { aiReady: true, clientTrial: true, introSynth: true }), /вступление пробный синтез/)
  assert.match(newModesLine(c, { aiReady: true, clientTrial: true }), /вступление нет/)
  assert.match(newModesLine({ ...c, prompts: { intro: '/w/80.wav' } }, { aiReady: true, clientTrial: true, introSynth: true }), /вступление есть/)
  assert.match(newModesLine(c, { aiReady: false }), /ИИ сразу \(ИИ не готов — по-старому\)/)
  assert.equal(newModesLine(loadConfig({})), null)
})

test('B6: латинські голосові теги забираємо при збереженні у файл, документ дзвінка й підсумок; слова клієнта та звичайні дужки лишаються', () => {
  const ai = '[slow] Вітаю! [laughs] Заявка [12] та [текст] готова.'
  const clean = 'Вітаю! Заявка [12] та [текст] готова.'
  const client = 'Я написав [slow] та [12] у коментарі.'
  assert.equal(stripVoiceTags(ai), clean)
  assert.equal(stripVoiceTags('Текст [sighs softly], [a-tag] далі [A_B].'), 'Текст, далі.')
  const transcript = { ...TRANSCRIPT, note: { question: '[slow] Де кораблик [12]?', callback: true }, turns: [{ speaker: 'ai', text: ai }, { speaker: 'client', text: client }] }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ai-tags-'))
  try {
    const file = saveAiTranscript({ dataDir: dir, gcid: 'gcid-fictional', record: transcript })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.turns[0].text, clean)
    assert.equal(saved.turns[1].text, client)
    const { doc } = buildAiCallDoc({ entry: ENTRY, transcript })
    assert.equal(doc.transcript.turns[0].text, clean)
    assert.equal(doc.transcript.turns[1].text, client)
    assert.match(doc.transcript.text, /ШІ-помічник: Вітаю! Заявка \[12\] та \[текст\] готова\./)
    assert.match(doc.summary.text, /^Суть: Де кораблик \[12\]\?/)
    assert.match(buildAiCallEvent({ entry: ENTRY, transcript, callId: 'ai-fictional' }).summary, /^Суть: Де кораблик \[12\]\?/)
    assert.equal(transcript.turns[0].text, ai, 'збереження не змінює вхідні дані')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C2/C3: перезвін — вісім робочих годин; нічний черговий лише safety, технічних порад немає навіть після невдалого переводу', () => {
  assert.equal(CALLBACK_PROMISE, 'Вам передзвонять протягом восьми робочих годин.')
  for (const kind of ['busy', 'after_hours', 'discussion_failed', 'discussion_unavailable', 'discussion_after_hours', 'transfer_failed']) assert.ok(firstMessageFor({ kind, v2: true, intro: true }).endsWith(CALLBACK_PROMISE), kind)
  assert.doesNotMatch(firstMessageFor({ kind: 'first', v2: true, intro: true }), /восьми робочих годин/, 'до записаного перезвону строку не обіцяємо')
  const active = buildInstructions({ kind: 'after_hours', afterHours: true, urgentOnly: true, transferAllowed: true, v2: true })
  assert.ok(active.includes(URGENT_CONNECTING))
  assert.match(active, /topic safety/)
  assert.match(active, /лише.*небезпечн|Лише небезпечн/)
  assert.match(active, /технічних порад не давай/)
  assert.doesNotMatch(active, /З'єднати з людиною (зараз|вночі) не можна/)
  const exhausted = buildInstructions({ kind: 'after_hours', afterHours: true, urgentOnly: true, transferAllowed: false, v2: true })
  assert.match(exhausted, /технічних порад не давай/)
  assert.match(exhausted, /сто дванадцять/)
  assert.doesNotMatch(exhausted, /Лише небезпечна ситуація — transfer_to_manager/, 'ліміт переводу вичерпано — лише терміновий передзвін')
  const off = buildInstructions({ kind: 'after_hours', afterHours: true, transferAllowed: false, v2: true })
  assert.doesNotMatch(off, /з’єдную з черговим/)
  assert.match(off, /сто дванадцять/)
})

test('B7: фактичну ціну дописуємо атомарно у розшифровку 0600; оцінка в підсумку явно лише за голос', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ai-cost-file-'))
  try {
    const file = saveAiTranscript({ dataDir: dir, gcid: 'gcid-fictional', record: TRANSCRIPT })
    const cost = [{ conversationId: 'conv-fictional', costCredits: 1300, callCharge: 1000, llmCharge: 300, llmPriceUsd: 0.06 }]
    assert.equal(updateAiTranscript(file, { elevenlabsCost: cost }), true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(saved.elevenlabsCost, cost)
    assert.deepEqual(saved.turns, TRANSCRIPT.turns)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')), false)
    assert.match(summary({ ...ENTRY, ai: { ...ENTRY.ai, sessions: [{ durationMs: 30000, costUsd: 0.05 }] } }), /≈\$0\.050 \(оценка: только голос, без LLM\)/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C4/C5: угода перед питанням про відкриту заявку; ознака без даних клієнта; повторне посилання лише за прапорцем', () => {
  for (const intro of [false, true]) {
    const text = firstMessageFor({ kind: 'first', variant: 'request', category: 'openRequest', intro, v2: true, needsTerms: true })
    assert.ok(text.includes(TERMS_REQUIRED))
    assert.ok(text.indexOf(TERMS_REQUIRED) < text.indexOf('чим допомогти?'))
  }
  const ordinary = firstMessageFor({ kind: 'first', variant: 'request', category: 'openRequest', intro: true, v2: true })
  assert.equal(ordinary.includes(TERMS_REQUIRED), false)
  const instructions = buildInstructions({ kind: 'discussion_unavailable', category: 'openRequest', needsTerms: true, v2: true })
  assert.match(instructions, /Угоду не прийнято/)
  assert.ok(instructions.includes(TERMS_REQUIRED))
  assert.doesNotMatch(instructions, /на сторінку заявки клієнта не відсилай/)
  assert.doesNotMatch(instructions, /clientAcceptedTerms|acceptedAt|agreement_at|380\d{9}/)
  assert.equal(toolsFor().some((t) => t.name === 'resend_request_link'), false)
  assert.equal(toolsFor({ resend: true }).some((t) => t.name === 'resend_request_link'), true)
  assert.match(buildInstructions({ resendAllowed: true }), /Доставку не обіцяй/)
  assert.match(buildInstructions({ resendAllowed: false }), /менеджер надішле посилання на сторінку заявки/)
})
