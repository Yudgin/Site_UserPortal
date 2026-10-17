// Адаптер ElevenLabs Agents (WebSocket, без SDK) для ШІ-співрозмовника (agent.mjs). Агент (LLM, голос, розпізнавання,
// клієнтські інструменти, формати pcm_8000) створює ai-setup-elevenlabs.mjs; на кожен дзвінок — підписана адреса
// (GET /v1/convai/conversation/get-signed-url, ключ із Secret Manager) і переозначення: інструкції, перша фраза, мова,
// голос, межа тривалості, набір інструментів (tool_ids). Звук в обидва боки — PCM16 8 кГц, рушію нічого не перетворюємо.
//   до сервера: conversation_initiation_client_data, {user_audio_chunk}, pong, client_tool_result, contextual_update
//   від сервера: conversation_initiation_metadata (+ немає queue_status) → ready, audio → audio, interruption →
//   interrupted, user_transcript / agent_response(_correction) → transcript, tentative_user_transcript → user_activity,
//   client_tool_call → tool_call, agent_response_complete → response_done, ping, queue_status 'waiting' → фатальна помилка
// Перебивання ElevenLabs помічає сам (своя модель черговості) і обрізає відповідь сам: ми лише скидаємо чергу рушія й
// відкидаємо запізнілий звук з event_id ≤ перебитого. Тишу він теж перепитує сам (selfPrompt).
// Інструменти без відповіді (transfer_to_manager, end_call: expects_response=false) client_tool_result не отримують —
// відмову шлюзу модель дізнається з contextual_update (toolResult).
import { EventEmitter } from 'node:events'

const READY_TIMEOUT_MS = 8000
// Після conversation_initiation_metadata: якщо агент на ліміті й черга ввімкнена, одразу йде queue_status 'waiting' (до
// будь-якого звуку). Звук / репліка / інструмент — розмову допущено; нічого за цей час (порожня перша фраза) — теж
const ADMIT_WAIT_MS = 300
const QUIET_DONE_MS = 1500 // немає agent_response_complete — відповідь вважаємо завершеною після такої паузи у звуці
const FORMAT = 'pcm_8000'

export function makeElevenLabsProvider({
  getApiKey = null, // async () => ключ xi-api-key (Secret Manager elevenlabs-api-key)
  agentId = null,
  apiBase = 'https://api.elevenlabs.io',
  wsUrl = null, // готова адреса WebSocket (тести, локальний підроблений сервер) — без підписаної адреси
  voiceId = null,
  language = 'uk',
  llm = null, // лише для журналу: яку LLM налаштовано в агенті
  maxDurationSec = null,
  // { назва інструмента → id ElevenLabs } з <data>/ai-elevenlabs.json — лише коли там toolIdsOverride (агента оновлено
  // з дозволом переозначати tool_ids, ai-setup-elevenlabs.mjs), інакше ElevenLabs відхилить розмову
  toolIds = null,
  pricePerMin = 0.08, // ElevenLabs Agents, $/хв (Creator/Pro), без LLM
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  log = () => {},
} = {}) {
  async function signedUrl() {
    if (wsUrl) return wsUrl
    if (!agentId) throw new Error('ElevenLabs: не задан agent_id (VG_AI_EL_AGENT или ai-setup-elevenlabs.mjs)')
    const key = await getApiKey()
    const r = await fetchImpl(`${apiBase}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) throw new Error(`ElevenLabs get-signed-url: HTTP ${r.status}`)
    const j = await r.json()
    if (!j?.signed_url) throw new Error('ElevenLabs get-signed-url: немає signed_url')
    return j.signed_url
  }

  // Дозволені на цей дзвінок інструменти → id для conversation_config_override.agent.prompt.tool_ids
  // (AsyncAPI ConversationInitiationClientDataConversationConfigOverrideAgentPrompt.tool_ids: замінює набір агента;
  // tool_ids_strict потрібен лише для вузлів workflow — їх немає). Немає id якогось інструмента (старий файл) — набір не
  // звужуємо: зайвий інструмент шлюз відхилить сам, а без потрібного (end_call) модель не змогла б завершити розмову
  function toolOverride(tools) {
    if (!toolIds || !Array.isArray(tools)) return null
    const names = [...new Set(tools.map(String))]
    const missing = names.filter((n) => !toolIds[n])
    if (missing.length) {
      log(`ElevenLabs: нет id инструмента ${missing.join(', ')} в ai-elevenlabs.json — набор инструментов не сужаю (ai-setup-elevenlabs.mjs --apply)`)
      return null
    }
    return names.map((n) => toolIds[n])
  }

  // tools — назви інструментів, дозволених на цей дзвінок (aiprompt.mjs TOOL_DEFS); null — усі інструменти агента
  function connect({ instructions, firstMessage, dynamicVariables = null, tools = null } = {}) {
    const s = new EventEmitter()
    let ws = null
    let ready = false // розмову допущено (не в черзі) — лише тоді звук в обидва боки
    let metaSeen = false
    let admitTimer = null
    let closed = false
    let lastInterrupt = -1
    let responding = false
    let quietTimer = null
    let readyTimer = null
    let conversationId = null
    let lastAgentText = null
    const calls = new Map() // tool_call_id → { name, expectsResponse } (ClientToolCallClientToolCall)

    const fail = (msg, fatal = true) => s.emit('error', Object.assign(new Error(msg), { fatal }))
    const sendJson = (o) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(o))
    }
    const admit = () => {
      if (ready || closed) return
      clearTimeout(admitTimer)
      admitTimer = null
      ready = true
      s.emit('ready', { conversationId })
    }
    // Розмова непридатна ще до початку (інший формат, черга): закриваємо самі, далі нічого не віддаємо — фатальна помилка
    const reject = (msg) => {
      s.close()
      fail(msg)
    }
    const done = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = null
      if (!responding) return
      responding = false
      s.emit('response_done', {})
    }

    function onMessage(raw) {
      let m
      try {
        m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
      } catch {
        return
      }
      if (closed) return // закрито (зокрема reject): хвіст звуку, тон утримання черги — нікуди
      const type = m?.type
      // Будь-яка подія розмови після metadata без queue_status перед нею — розмову допущено (ping і помилка — не ознака)
      if (metaSeen && !ready && type !== 'queue_status' && type !== 'ping' && type !== 'client_error') admit()
      switch (type) {
        case 'conversation_initiation_metadata': {
          const e = m.conversation_initiation_metadata_event || {}
          conversationId = e.conversation_id || null
          clearTimeout(readyTimer)
          if ((e.agent_output_audio_format && e.agent_output_audio_format !== FORMAT) || (e.user_input_audio_format && e.user_input_audio_format !== FORMAT)) {
            return reject(`ElevenLabs: агент работает в ${e.user_input_audio_format}/${e.agent_output_audio_format}, нужен ${FORMAT} — запустите ai-setup-elevenlabs.mjs`)
          }
          metaSeen = true
          admitTimer = setTimeout(admit, ADMIT_WAIT_MS)
          return
        }
        case 'queue_status': {
          // QueueStatus (AsyncAPI; шлють завжди, client_events не потрібні): агент на ліміті одночасних розмов, клієнта
          // тримають у черзі — 'waiting' одразу після metadata, далі тон утримання звичайними audio до 'admitted' або
          // 'timed_out' (і закриття 4300) через ≤ 180 с. Тримати абонента під тоном не будемо: фатальна помилка, шлюз
          // грає «лінія зайнята». Черга вимкнена в агенті (queueing_config) — сюди потрапимо лише зі старим агентом
          const st = m.queue_status_event?.status
          if (st === 'admitted') return admit()
          return reject(`ElevenLabs: разговор поставлен в очередь (${st || '?'}; агент на пределе одновременных разговоров) — отказ; очередь выключает ai-setup-elevenlabs.mjs --apply`)
        }
        case 'audio': {
          if (!ready) return // до допуску (до metadata) звук не віддаємо
          const e = m.audio_event || {}
          const id = Number(e.event_id)
          // Запізнілий звук перебитої відповіді. Як у Python SDK (conversation.py: event_id <= _last_interrupt_id → пропуск);
          // JS SDK пропускає лише < (рівний грає) — беремо суворіше: interruption несе event_id перебитої відповіді,
          // наступна відповідь має більший (специфікація AsyncAPI значення event_id не визначає)
          if (Number.isFinite(id) && id <= lastInterrupt) return
          if (!e.audio_base_64) return
          if (!responding) {
            responding = true
            s.emit('response_started', { id: String(e.event_id ?? '') })
          }
          if (quietTimer) clearTimeout(quietTimer)
          quietTimer = setTimeout(done, QUIET_DONE_MS)
          s.emit('audio', { data: Buffer.from(e.audio_base_64, 'base64'), itemId: String(e.event_id ?? '') })
          if (e.is_final === true) done()
          return
        }
        case 'agent_response_complete':
          return done()
        case 'interruption': {
          const id = Number(m.interruption_event?.event_id)
          if (Number.isFinite(id)) lastInterrupt = Math.max(lastInterrupt, id)
          if (quietTimer) clearTimeout(quietTimer)
          quietTimer = null
          responding = false
          s.emit('interrupted', {})
          return
        }
        case 'user_transcript':
          s.emit('user_activity')
          s.emit('transcript', { role: 'user', text: m.user_transcription_event?.user_transcript || '' })
          return
        case 'tentative_user_transcript':
          s.emit('user_activity')
          return
        case 'agent_response':
          lastAgentText = m.agent_response_event?.agent_response || ''
          s.emit('transcript', { role: 'assistant', text: lastAgentText, itemId: String(m.agent_response_event?.event_id ?? '') })
          return
        case 'agent_response_correction': {
          const e = m.agent_response_correction_event || {}
          s.emit('transcript', { role: 'assistant', text: e.corrected_agent_response || '', itemId: String(e.event_id ?? ''), correction: true })
          return
        }
        case 'client_tool_call': {
          const c = m.client_tool_call || {}
          const expectsResponse = c.expects_response !== false
          if (c.tool_call_id != null) calls.set(c.tool_call_id, { name: c.tool_name, expectsResponse })
          s.emit('tool_call', { callId: c.tool_call_id, name: c.tool_name, args: c.parameters || {}, expectsResponse })
          return
        }
        case 'ping':
          sendJson({ type: 'pong', event_id: m.ping_event?.event_id })
          return
        case 'client_error':
          fail(`ElevenLabs: ${m.error_event?.message || m.error_event?.error_name || 'client_error'}`, false)
          return
        default:
      }
    }

    ;(async () => {
      let url
      try {
        url = await signedUrl()
      } catch (e) {
        return fail(e.message)
      }
      if (closed) return
      try {
        ws = new WebSocketImpl(url)
      } catch (e) {
        return fail(`ElevenLabs WebSocket: ${e.message}`)
      }
      readyTimer = setTimeout(() => { if (!ready) fail('ElevenLabs: нет conversation_initiation_metadata за 8 с') }, READY_TIMEOUT_MS)
      ws.addEventListener('open', () => {
        const override = { agent: { language } }
        if (instructions) override.agent.prompt = { prompt: instructions }
        const ids = toolOverride(tools)
        if (ids) override.agent.prompt = { ...(override.agent.prompt || {}), tool_ids: ids }
        if (firstMessage != null) override.agent.first_message = firstMessage
        if (voiceId) override.tts = { voice_id: voiceId }
        if (maxDurationSec) override.conversation = { max_duration_seconds: Math.max(60, Math.round(maxDurationSec)) }
        sendJson({ type: 'conversation_initiation_client_data', conversation_config_override: override, ...(dynamicVariables ? { dynamic_variables: dynamicVariables } : {}) })
      })
      ws.addEventListener('message', (ev) => onMessage(ev.data))
      ws.addEventListener('error', () => { if (!closed) fail('ElevenLabs WebSocket: ошибка соединения') })
      ws.addEventListener('close', (ev) => {
        clearTimeout(readyTimer)
        clearTimeout(admitTimer)
        if (quietTimer) clearTimeout(quietTimer)
        if (closed) return
        closed = true
        s.emit('close', { code: ev.code, reason: ev.reason })
      })
    })()

    s.sendAudio = (buf) => {
      if (!ready || closed) return
      sendJson({ user_audio_chunk: buf.toString('base64') })
    }
    // Підказка моделі без репліки клієнта (наприклад, «час спливає»): contextual_update не перериває розмову
    s.respond = ({ instructions: text } = {}) => {
      if (text) sendJson({ type: 'contextual_update', text })
    }
    s.greet = () => {} // перша фраза — first_message у переозначенні
    s.truncate = () => {} // обрізання ElevenLabs робить сам
    s.toolResult = ({ callId, name = null, output, continue: cont = true }) => {
      const c = calls.get(callId)
      calls.delete(callId)
      if (c && !c.expectsResponse) {
        // expects_response=false (transfer / end_call): сервер client_tool_result не чекає й моделі його не віддасть.
        // Виконано — мовчимо; відмова шлюзу (ok:false: неробочий час, ліміт з'єднань, збій) — моделі contextual_update
        // (ContextualUpdate.text), інакше вона думатиме, що з'єднує. Нової відповіді він не просить: модель скаже це
        // в наступній репліці (або після turn_timeout агента)
        if (output?.ok === false) {
          const tool = name || c.name || 'інструмент'
          const why = output.note || output.say || null
          sendJson({ type: 'contextual_update', text: why ? `Інструмент ${tool} не виконано: ${why}` : `Інструмент ${tool} не виконано (${output.reason || output.error || 'відмова'}).` })
        }
        return
      }
      if (!cont) return // дію (transfer / end_call) зробить шлюз після фрази — нової відповіді моделі не просимо
      const isError = output?.error === 'internal_error'
      sendJson({ type: 'client_tool_result', tool_call_id: callId, result: JSON.stringify(output ?? {}), is_error: isError })
    }
    s.close = () => {
      if (closed) return
      closed = true
      clearTimeout(readyTimer)
      clearTimeout(admitTimer)
      if (quietTimer) clearTimeout(quietTimer)
      try { ws?.close(1000, 'call end') } catch { /* уже закрито */ }
    }
    Object.defineProperty(s, 'conversationId', { get: () => conversationId })
    return s
  }

  return {
    name: 'elevenlabs',
    model: `elevenlabs-agents${llm ? `/${llm}` : ''}`,
    engineRate: 8000,
    inputFormat: { encoding: 'pcm16', rate: 8000 },
    outputFormat: { encoding: 'pcm16', rate: 8000 },
    selfPrompt: true,
    cost: (usage, durationMs) => Math.round((durationMs / 60000) * pricePerMin * 10000) / 10000,
    connect,
  }
}

export default makeElevenLabsProvider
