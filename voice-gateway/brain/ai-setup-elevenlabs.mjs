#!/usr/bin/env node
// Агент ElevenLabs для ШІ-співрозмовника шлюзу: клієнтські інструменти (aiprompt.mjs TOOL_DEFS), LLM, голос, розпізнавання
// й синтез у pcm_8000 (рушію нічого не перетворювати), українська, приватний (лише за підписаною адресою), дозвіл
// переозначати інструкції / першу фразу / мову / голос / тривалість / набір інструментів на кожен дзвінок, приватність
// (без запису голосу, зберігання розмов — retention_days), ліміт одночасних розмов = VG_MAX_CALLS без черги очікування.
// Ключ — Secret Manager elevenlabs-api-key (як і синтез фраз шлюзу). Після зміни цього файлу — знову --apply: шлюз
// переозначає tool_ids лише для агента з дозволом (toolIdsOverride у ai-elevenlabs.json).
//   node voice-gateway/brain/ai-setup-elevenlabs.mjs            — лише показати, що буде створено (нічого не змінює)
//   node voice-gateway/brain/ai-setup-elevenlabs.mjs --apply    — створити (або оновити) інструменти й агента;
//                                                                 agent_id і id інструментів — у <data>/ai-elevenlabs.json
//   node voice-gateway/brain/ai-setup-elevenlabs.mjs --show     — прочитати агента (перевірити налаштування)
// Прапорці: --llm <id> (типово VG_AI_EL_LLM або claude-sonnet-5-5), --retention-days N (30), --voice <id>.
// Створення агента нічого не коштує; розмови витрачають хвилини тарифу ElevenLabs Agents. Запускати — з дозволу власника.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { makeTokenSource, accessSecret } from './gcp.mjs'
import { TOOL_DEFS, buildInstructions } from './aiprompt.mjs'
import { ensurePrivateDir, FILE_MODE } from './storage.mjs'

const FORMAT = 'pcm_8000'
const NAME = 'runferry-voice-gateway'

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

// Інструмент ElevenLabs із нейтральної схеми aiprompt.mjs (OpenAPI ClientToolConfig-Input)
export function toolConfig(t) {
  const props = {}
  for (const [k, v] of Object.entries(t.parameters?.properties || {})) {
    props[k] = { type: v.type, description: v.description || k, ...(v.enum ? { enum: v.enum } : {}) }
  }
  return {
    tool_config: {
      type: 'client',
      name: t.name,
      description: t.description,
      // transfer / end_call: модель уже сказала фразу — сервер не чекає відповіді, дію робить шлюз після відтворення.
      // Відмову шлюзу (не робочий час, ліміт) адаптер повертає моделі contextual_update (realtime-elevenlabs.mjs toolResult)
      expects_response: !t.afterSpeech,
      response_timeout_secs: 10,
      pre_tool_speech: 'auto',
      // ToolExecutionMode: 'post_tool_speech' — виклик приходить, коли агент договорив фразу (інакше client_tool_call може
      // випередити звук «З'єдную…» / прощання й шлюз діятиме до неї); інформаційні — одразу ('immediate')
      execution_mode: t.afterSpeech ? 'post_tool_speech' : 'immediate',
      // ToolErrorHandlingMode: типове 'auto' для клієнтських інструментів = 'hide' — результат з is_error модель не бачить;
      // 'passthrough' — віддає як є (тексти помилок шлюзу вже придатні для моделі: note / say)
      tool_error_handling_mode: 'passthrough',
      parameters: { type: 'object', description: '', properties: props, required: t.parameters?.required || [] },
    },
  }
}

// concurrencyLimit — як VG_MAX_CALLS (config.maxCalls, 2): кожен дзвінок тримає не більше однієї розмови ШІ
export function agentBody({ llm, voiceId, toolIds, retentionDays, concurrencyLimit = 2 }) {
  return {
    name: NAME,
    conversation_config: {
      agent: {
        first_message: '', // на кожен дзвінок — переозначення (aiprompt.mjs FIRST_MESSAGES)
        language: 'uk',
        disable_first_message_interruptions: true, // повідомлення «це ШІ, розмова записується» звучить до кінця
        prompt: {
          prompt: buildInstructions({ kind: 'busy' }), // на кожен дзвінок — переозначення
          llm,
          temperature: 0.3,
          tool_ids: toolIds,
          built_in_tools: { end_call: null, language_detection: null, transfer_to_number: null, transfer_to_agent: null, skip_turn: null, play_keypad_touch_tone: null, voicemail_detection: null },
        },
      },
      asr: { provider: 'scribe_realtime', quality: 'high', user_input_audio_format: FORMAT, keywords: ['Runferry', 'кораблик', 'прикормочний', 'ехолот', 'пульт'] },
      tts: { model_id: 'eleven_v4_turbo', voice_id: voiceId, agent_output_audio_format: FORMAT, stability: 0.5, speed: 1.0, similarity_boost: 0.8 },
      turn: { turn_timeout: 7, turn_eagerness: 'normal', silence_end_call_timeout: -1 },
      conversation: {
        max_duration_seconds: 360,
        // ClientEvent; tentative_user_transcript — проміжне розпізнавання: довга репліка клієнта = активність (user_activity),
        // тайм-аут тиші шлюзу не спрацює посеред неї. queue_status вмикати не треба — його шлють завжди
        client_events: ['conversation_initiation_metadata', 'ping', 'audio', 'interruption', 'user_transcript', 'tentative_user_transcript', 'agent_response', 'agent_response_correction', 'client_tool_call', 'agent_response_complete'],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: {
        // ConversationConfigClientOverrideConfig-Input → AgentConfigOverrideConfig → PromptAgentAPIModelOverrideConfig:
        // tool_ids — набір інструментів на кожен дзвінок (без transfer_to_manager, коли з'єднувати не можна); без цього
        // дозволу ElevenLabs відхиляє розмову з переозначенням tool_ids
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true, tool_ids: true } },
          tts: { voice_id: true },
          conversation: { max_duration_seconds: true },
        },
      },
      privacy: { record_voice: false, retention_days: retentionDays },
      // AgentCallLimits: понад ліміт — відмова (без подвійного тарифу bursting)
      call_limits: { bursting_enabled: false, agent_concurrency_limit: concurrencyLimit },
      // AgentQueueingConfig: нові агенти створюються з чергою (до 180 с тону утримання, який адаптер сприйняв би як мову
      // агента) — вимикаємо явно: понад ліміт розмову відхилено одразу, шлюз грає «лінія зайнята»
      queueing_config: { enabled: false },
    },
  }
}

async function main() {
  const config = loadConfig()
  const llm = arg('--llm', config.aiElLlm)
  const voiceId = arg('--voice', config.aiVoiceId)
  const retentionDays = Number(arg('--retention-days', '30'))
  const concurrencyLimit = Number(config.maxCalls) > 0 ? Number(config.maxCalls) : 2
  const file = path.join(config.dataDir, 'ai-elevenlabs.json')
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* ще не створено */ }
  const tools = TOOL_DEFS.map(toolConfig)

  if (!has('--apply') && !has('--show')) {
    process.stdout.write(`План (нічого не змінюю; створити — з --apply):\n`)
    process.stdout.write(`  ${saved?.agentId ? `оновити агента ${saved.agentId}` : 'створити агента'} «${NAME}», LLM ${llm}, голос ${voiceId}, ${FORMAT}, uk, retention_days ${retentionDays}, одночасно ${concurrencyLimit}, без черги\n`)
    process.stdout.write(`  інструменти: ${tools.map((t) => `${t.tool_config.name}${t.tool_config.expects_response ? '' : ' (без відповіді, після фрази)'}`).join(', ')}\n`)
    process.stdout.write(`  файл: ${file}\n\n${JSON.stringify(agentBody({ llm, voiceId, toolIds: ['<id…>'], retentionDays, concurrencyLimit }), null, 2)}\n`)
    return
  }

  const getAccessToken = makeTokenSource()
  const key = (await accessSecret({ project: config.gcpProject, name: config.ttsSecret, getAccessToken })).trim()
  const api = async (method, url, body) => {
    const r = await fetch(`${config.aiElApi}${url}`, { method, headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
    const text = await r.text()
    if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  }

  if (has('--show')) {
    if (!saved?.agentId) throw new Error(`агента ще немає (${file})`)
    const a = await api('GET', `/v1/convai/agents/${saved.agentId}`)
    const c = a.conversation_config || {}
    process.stdout.write(`${JSON.stringify({
      agent_id: a.agent_id, name: a.name, llm: c.agent?.prompt?.llm, language: c.agent?.language, tool_ids: c.agent?.prompt?.tool_ids,
      asr: c.asr?.user_input_audio_format, tts: { model: c.tts?.model_id, voice: c.tts?.voice_id, format: c.tts?.agent_output_audio_format },
      client_events: c.conversation?.client_events, privacy: a.platform_settings?.privacy, auth: a.platform_settings?.auth?.enable_auth,
      call_limits: a.platform_settings?.call_limits, queueing: a.platform_settings?.queueing_config?.enabled,
      overrides: a.platform_settings?.overrides?.conversation_config_override,
    }, null, 2)}\n`)
    return
  }

  // --apply: інструменти (оновити, якщо вже є), потім агент
  const toolIds = []
  for (const t of tools) {
    const old = saved?.toolIds?.[t.tool_config.name]
    const res = old ? await api('PATCH', `/v1/convai/tools/${old}`, t) : await api('POST', '/v1/convai/tools', t)
    toolIds.push(res.id || old)
    process.stdout.write(`інструмент ${t.tool_config.name}: ${res.id || old}\n`)
  }
  const body = agentBody({ llm, voiceId, toolIds, retentionDays, concurrencyLimit })
  let agentId = saved?.agentId || null
  if (agentId) await api('PATCH', `/v1/convai/agents/${agentId}`, body)
  else agentId = (await api('POST', '/v1/convai/agents/create', body)).agent_id
  ensurePrivateDir(config.dataDir)
  // toolIdsOverride: агента оновлено з дозволом переозначати tool_ids — лише тоді шлюз може звужувати набір інструментів
  // на дзвінок (makeElevenLabsProvider toolIds); файл старого формату без нього — переозначення ElevenLabs відхилить
  const out = { agentId, llm, voiceId, format: FORMAT, toolIds: Object.fromEntries(tools.map((t, i) => [t.tool_config.name, toolIds[i]])), toolIdsOverride: true, updatedAt: new Date().toISOString() }
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { mode: FILE_MODE })
  process.stdout.write(`агент ${agentId} готовий; записано ${file}\n`)
}

if (process.argv[1]?.endsWith('ai-setup-elevenlabs.mjs')) {
  main().catch((e) => {
    process.stdout.write(`ошибка: ${e.message}\n`)
    process.exit(1)
  })
}
