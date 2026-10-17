#!/usr/bin/env node
// Голосовий шлюз Binotel: запускає SIP-рушій, реєструє лінію і веде кожен вхідний дзвінок за сценарієм flow.mjs.
//   node voice-gateway/brain/gateway.mjs            — справжня лінія Binotel (логін/пароль питає або бере з Secret Manager)
//   node voice-gateway/brain/gateway.mjs --local --manager sip:mgr@127.0.0.1:5094 [--no-tts --no-lookup --card x.wav]
//                                                     — перевірка на Mac з pjsua без АТС
// Рядки статусу для оператора — російською; паролі й ключі не друкуються ніде, номери чужих абонентів — маскою.
// Рушій упав — шлюз сам перезапускає його і заново реєструє лінію (частіше 5 разів за 10 хв — вихід з кодом 1).
// Менеджер не взяв — типово клієнту «лінія зайнята, менеджер передзвонить» і відкладений передзвін; дзвінок менеджера
// на шлюз — передзвін клієнту (flow.mjs; із зовнішнього номера — лише з VG_MANAGERS_EXTERNAL=1 і VG_MANAGER_PIN).
// Рушій без DTMF при увімкненому підтвердженні «1» — шлюз не стартує (без «1» не переводимо, а з таким рушієм не
// з'єднався б жоден дзвінок).
// VG_NO_ANSWER_MODE=ai — замість «лінія зайнята» і в неробочий час відповідає ШІ-співрозмовник (ElevenLabs Agents):
// потрібен рушій зі звуком до мозку (engine/sip-engine-ai, ready.audio) і агент ElevenLabs (ai-setup-elevenlabs.mjs).
// VG_ANSWER_MODE=ai — ШІ бере трубку одразу (вступ 80, перша фраза за даними); VG_JOIN_ON_CALLBACK=1 — менеджер, що
// передзвонив, приєднується до клієнта (міст або REFER); VG_HOLD_TONE=ringback — гудки замість 05-hold у нових гілках.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { loadConfig, extUri, isOff, NO_ANSWER_MODES, CLIENT_PROMPT_KEYS } from './config.mjs'
import { startEngine } from './engine.mjs'
import { createDispatcher, callerAllowed, managerCaller, externalCallbackOn, maskNumber } from './flow.mjs'
import { makeCallbackStore, resolveManagers, isInternalKey, partyKey } from './callbacks.mjs'
import { buildCard } from './card.mjs'
import { makeTts, readWavInfo, isTelephonyWav } from './tts.mjs'
import { makeTokenSource, accessSecret } from './gcp.mjs'
import { makeJournal } from './journal.mjs'
import { ensurePrivateDir, makeDailyLog, pruneGatewayData, makeVoicemailPath, ensureBeep, ensureRingback, repairVoicemailHeaders, repairWavHeader, findGitRoot, saveAiTranscript } from './storage.mjs'
import { startAudioServer } from './audiosock.mjs'
import { createAgent } from './agent.mjs'
import { makeElevenLabsProvider } from './realtime-elevenlabs.mjs'
import { buildInstructions, firstMessageFor, TOOL_DEFS } from './aiprompt.mjs'
import { hoursText } from './hours.mjs'
import { makeAiCallStore } from './aicalls.mjs'

// ---------- аргументи ----------

const USAGE = `Использование:
  node gateway.mjs                         реальная линия Binotel (логин/пароль спросит; или env BINOTEL_LINE_SECRET)
  node gateway.mjs --local --manager URI   локальная проверка без АТС (аккаунт sip:gw@127.0.0.1:5092)
Флаги:
  --manager 907|URI   кому звонить с карточкой (по умолчанию 907)
  --fallback 906|URI  запасная линия (только --no-answer fallback): тоже набор, карточка, «1» и REFER/Replaces
                      (по умолчанию 906; в --local = --manager; none — без неё, сразу голосовая почта)
  --allow +380…,…     добавить разрешённых звонящих (внутренние — 3-значные без X-BINOTEL-GCID — разрешены всегда)
  --no-tts            без синтеза карточки        --no-lookup   без поиска клиента в Firestore
  --card file.wav     готовая карточка, если синтез выключен или не удался
  --server host       SIP-сервер (реальный режим, по умолчанию sip14.binotel.com)
  --bind IP --port N --user NAME   адрес локального режима (127.0.0.1, 5092, gw)
  --engine PATH       путь к sip-engine (или env VG_ENGINE_PATH; с DTMF «1»/«2» и голосовой почтой — engine/sip-engine-next)
  --max-calls N       одновременных звонков (по умолчанию 2)
  --no-answer MODE    менеджер не взял: busy (по умолчанию: «линия занята», перезвон), fallback (запасная, потом
                      голосовая почта), voicemail (сразу голосовая почта), ai (ИИ-собеседник; и в нерабочее время);
                      или env VG_NO_ANSWER_MODE
  --managers LIST     номера/линии менеджеров через запятую (один человек — через «=»: 907=0676575085); их звонок
                      на шлюз — перезвон клиенту. Линия --manager входит всегда. Или env VG_MANAGERS
  --client-uri TPL    как набирать клиента при перезвоне: {national} {e164} {digits} {server}
                      (по умолчанию sip:{national}@{server};transport=udp; или env VG_CLIENT_URI)`

export function parseArgs(argv) {
  const o = { local: false, tts: true, lookup: true, allow: [] }
  const need = (i, f) => {
    if (i + 1 >= argv.length) throw new Error(`флаг ${f} требует значение`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--local': o.local = true; break
      case '--no-tts': o.tts = false; break
      case '--no-lookup': o.lookup = false; break
      case '--manager': o.manager = need(i, a); i++; break
      case '--fallback': o.fallback = need(i, a); i++; break
      case '--allow': o.allow.push(...need(i, a).split(/[,;\s]+/).filter(Boolean)); i++; break
      case '--card': o.card = need(i, a); i++; break
      case '--server': o.server = need(i, a); i++; break
      case '--bind': o.bind = need(i, a); i++; break
      case '--port': o.port = Number(need(i, a)); i++; break
      case '--user': o.user = need(i, a); i++; break
      case '--engine': o.engine = need(i, a); i++; break
      case '--max-calls': o.maxCalls = Number(need(i, a)); i++; break
      case '--no-answer': o.noAnswer = need(i, a).trim().toLowerCase(); i++; break
      case '--managers': o.managers = need(i, a); i++; break
      case '--client-uri': o.clientUri = need(i, a); i++; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`неизвестный флаг ${a}`)
    }
  }
  return o
}

// ---------- консоль ----------

// Керівні символи (ESC, BEL, C1, DEL) і перемикачі напрямку тексту з даних абонента (ім'я з From тощо)
// у термінал не пропускаємо: інакше чужий INVITE міг би змінити заголовок вікна, стерти екран чи підробити статус.
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export const clean = (s, max = 1000) => {
  const t = String(s ?? '').replace(CTRL, '?')
  return t.length > max ? `${t.slice(0, max)}…` : t
}
const hhmmss = () => new Date().toLocaleTimeString('ru-RU', { hour12: false })
const status = (msg) => process.stdout.write(`${hhmmss()}  ${clean(msg)}\n`)
const warn = (msg) => process.stdout.write(`${hhmmss()}  ! ${clean(msg)}\n`)

// Одне readline і черга рядків на всі питання: рядки, вставлені чи передані разом, не губляться.
// Відлуння: після кожного Enter вивід readline заглушено до наступного питання — readline обробляє вставлений
// шматок синхронно, і в «логін⏎пароль⏎» пароль інакше з'явився б на екрані ще до питання про пароль.
// hidden — питання пишемо самі (rl.prompt() перемалював би вже набране) і не вмикаємо відлуння зовсім.
export function makePrompter({ input = process.stdin, output = process.stdout } = {}) {
  let muted = false
  const out = new Writable({ write(chunk, enc, cb) { if (!muted) output.write(chunk, enc); cb() } })
  const rl = readline.createInterface({ input, output: out, terminal: !!input.isTTY, historySize: 0 })
  rl.on('SIGINT', () => { output.write('\n'); process.exit(130) }) // Ctrl+C під час питання — просто вихід
  const queue = []
  let waiting = null
  rl.on('line', (l) => {
    muted = true
    if (waiting) {
      const w = waiting
      waiting = null
      w(l)
    } else queue.push(l)
  })
  const ask = (question, { hidden = false } = {}) => new Promise((resolve) => {
    if (hidden) {
      muted = true
      output.write(question)
    } else {
      muted = false
      rl.setPrompt(question)
      rl.prompt()
    }
    const take = (l, queued) => {
      if (hidden || queued) output.write('\n') // Enter тут або заглушено, або це рядок із черги
      resolve(String(l).trim())
    }
    if (queue.length) take(queue.shift(), true)
    else waiting = (l) => take(l, false)
  })
  return { ask, close: () => rl.close() }
}

// Секрет лінії з Secret Manager: JSON {server?, user, password}. Помилки — лише фіксованими словами:
// повідомлення JSON.parse у Node містить сам текст, тобто пароль.
const SERVER_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/
export function parseLineSecret(raw, defaultServer) {
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error('секрет не JSON вида {"server":"…","user":"…","password":"…"}')
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('секрет не JSON-объект {"server","user","password"}')
  const scalar = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
  const server = scalar(j.server).trim() || defaultServer
  const user = scalar(j.user).trim()
  const password = scalar(j.password)
  if (!user || !password) throw new Error('в секрете нет непустых user и password (строки)')
  if (!SERVER_RE.test(server)) throw new Error('в секрете неверное поле server (нужно имя хоста, например sip14.binotel.com)')
  return { server, user, password }
}

// ---------- перевірки ----------

function checkPrompt(label, file, { required }) {
  if (!file) {
    if (required) throw new Error(`не задан файл «${label}»`)
    return null
  }
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    if (required) throw new Error(`нет файла «${label}»: ${file}`)
    warn(`нет файла «${label}» (${file}) — без него`)
    return null
  }
  if (!isTelephonyWav(readWavInfo(buf))) warn(`«${label}» не WAV PCM 16 бит моно 8 кГц — движок может не сыграть: ${file}`)
  return file
}

const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} с`)
const ABORTED = { shutdown: 'остановка шлюза', engine_exit: 'движок упал' }
const CB_SOURCE = { pending: 'ждал перезвона', last: 'последний клиент менеджера' }

export function summary(e) {
  const t = e.t || {}
  const why = [e.reason, e.fallbackReason].filter(Boolean).join(', ')
  const bits = [`итог ${e.number || 'без номера'}: ${e.outcome}${why ? ` (${why})` : ''}`]
  if (e.abortReason) bits.push(`прерван: ${ABORTED[e.abortReason] || e.abortReason}`)
  if (t.managerAnswered != null) bits.push(`менеджер ответил через ${secs(t.managerAnswered)}`)
  if (t.fbAnswered != null) bits.push(`запасная ответила через ${secs(t.fbAnswered)}`)
  if (t.xfer != null || t.fbXfer != null) bits.push(`перевод на ${secs(t.fbXfer ?? t.xfer)}`)
  if (e.retries) bits.push(`повторов набора ${e.retries}`)
  if (e.fallbackRetries) bits.push(`повторов набора запасной ${e.fallbackRetries}`)
  if (e.cardSource && e.kind !== 'callback') bits.push(`карточка: ${e.cardSource}`)
  for (const [side, c] of Object.entries(e.confirm || {})) {
    const who = side === 'fallback' ? 'запасная' : 'менеджер'
    bits.push(c.digit ? `${who} нажал «${c.digit}»` : `${who} не нажал «1» (вопрос ${c.plays} раз)`)
  }
  if (e.outcome === 'busy_callback') bits.push(e.callback?.stored ? 'клиенту «линия занята», перезвон сохранён' : `клиенту «линия занята», перезвон не сохранён (${e.callback?.why || 'ошибка'})`)
  if (e.outcome === 'ai_failed_callback') bits.push(e.callback?.stored ? 'ИИ недоступен в нерабочее время, менеджеру не звонили — «линия занята» не звучала, перезвон сохранён' : `ИИ недоступен в нерабочее время, менеджеру не звонили, перезвон не сохранён (${e.callback?.why || 'ошибка'})`)
  if (e.outcome === 'client_hangup' && e.callback?.missed) bits.push(e.callback.stored ? 'у менеджера пропущенный — перезвон сохранён' : `перезвон не сохранён (${e.callback.why || 'ошибка'})`)
  if (e.pin) bits.push(`PIN: ${{ ok: 'верный', wrong: 'неверный', timeout: 'не введён' }[e.pin] || e.pin}`)
  if (e.kind === 'callback' && e.outcome !== 'rejected' && e.outcome !== 'callback_denied') {
    const c = e.callback || {}
    bits.push(c.source ? `перезвон: ${CB_SOURCE[c.source] || c.source} ${c.client || ''}`.trim() : 'перезвон: некому')
    if (c.removed) bits.push('ожидание перезвона снято')
    if (c.dropped) bits.push(`клиент не ответил ${c.attempts} раз — перезвон снят`)
    else if (c.attempts && e.outcome === 'callback_no_answer') bits.push(`попыток ${c.attempts}`)
  }
  if (e.kind !== 'callback' && e.pendingRemoved) bits.push(`ожидание перезвона снято (${e.pendingRemoved})`)
  if (e.voicemail?.empty) bits.push(`сообщения нет (запись ${e.voicemail.sec != null ? `${e.voicemail.sec.toFixed(1)} с` : '—'}${e.voicemail.removed ? ', пустой файл удалён' : ''})`)
  else if (e.voicemail?.file) bits.push(`сообщение ${e.voicemail.sec != null ? `${e.voicemail.sec.toFixed(1)} с` : '(длина неизвестна)'}: ${e.voicemail.file}`)
  // «сначала менеджер» — лишь если менеджеру правда звонили (ночью при открытом предохранителе отвечает ИИ, набора нет)
  if (e.route?.branch === 'classic') bits.push(`«ИИ сразу» не включился (${e.route.why === 'breaker' ? 'предохранитель' : 'ИИ недоступен'})${(e.dials || []).some((d) => d.to === 'manager') ? ' — сначала менеджер' : ''}`)
  if (e.join) {
    const j = e.join
    const res = { bridged: 'соединены мостом', connected: 'соединены переводом', connected_unconfirmed: 'соединены переводом', refer_failed_bridged: 'перевод не прошёл — мост', client_gone: 'клиент положил трубку', manager_gone: 'менеджер положил трубку' }[j.result] || j.result || 'не завершено'
    bits.push(`присоединение менеджера (из фазы ${j.fromPhase}, ${j.mode === 'refer' ? 'REFER' : 'мост'}): ${res}${j.ms != null ? ` за ${secs(j.ms)}` : ''}`)
  }
  if (e.ai) {
    const a = e.ai
    const cost = (a.sessions || []).reduce((x, y) => x + (Number(y.costUsd) || 0), 0)
    const secsAi = (a.sessions || []).reduce((x, y) => x + (y.durationMs || 0), 0)
    bits.push(`ИИ (${a.kind === 'after_hours' ? 'нерабочее время' : a.kind === 'first' ? 'сразу' : 'вместо «линия занята»'}): ${secs(secsAi)}, ≈$${cost.toFixed(3)}` +
      `${a.note ? `, вопрос записан${a.note.urgent ? ' (срочно)' : ''}${a.note.callback === false ? ', без перезвона' : ''}` : ''}` +
      `${a.transfers ? `, передал менеджеру ${a.transfers} раз` : ''}${a.error ? `, ошибка ${a.error}` : ''}`)
  }
  if (e.errors?.length) bits.push(`ошибок ${e.errors.length}`)
  return bits.join(', ')
}

// Рядок «новые режимы» при старті — лише коли щось увімкнено. aiReady — фабрика ШІ готова; clientTrial — пробний синтез
// клієнтських фраз дозволено; introSynth — вступ 80 саме синтезується пробно (файла ще немає, за секунди буде)
export function newModesLine(config, { aiReady = false, clientTrial = false, introSynth = false } = {}) {
  const m = []
  if (config.answerMode === 'ai') m.push(`ИИ сразу${aiReady ? '' : ' (ИИ не готов — по-старому)'} (вступление ${config.prompts?.intro ? 'есть' : introSynth ? 'пробный синтез' : 'нет'}, перевод по просьбе ${config.aiFirstTransfer === 'always' ? 'сразу' : 'по правилам заявки'}, предохранитель ${config.aiBreaker ? `${config.aiBreaker.fails}/${config.aiBreaker.windowMs / 60000}/${config.aiBreaker.offMs / 60000}` : 'выкл'})`)
  if (config.joinOnCallback) m.push(`присоединение перезвонившего менеджера (${config.joinMode === 'refer' ? 'REFER, при сбое мост' : 'мост'})`)
  if (config.holdTone === 'ringback') m.push(`гудки${config.ringbackFile ? '' : ' (файла нет)'}`)
  if (config.clientSynth === 'trial') m.push(`пробный синтез клиентских фраз${clientTrial ? '' : ' — выключен: нет VG_ALLOWED_CALLERS'}`)
  return m.length ? `новые режимы: ${m.join('; ')}` : null
}

// ---------- головне ----------

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stdout.write(`${e.message}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const config = loadConfig()
  if (args.server) config.sipServer = args.server
  if (args.engine) config.enginePath = path.resolve(args.engine)
  if (Number.isFinite(args.maxCalls) && args.maxCalls > 0) config.maxCalls = args.maxCalls
  if (args.allow.length) config.allowedCallers = [...config.allowedCallers, ...args.allow]
  if (args.noAnswer != null) {
    if (!NO_ANSWER_MODES.includes(args.noAnswer)) {
      process.stdout.write(`--no-answer: ${NO_ANSWER_MODES.join(' | ')}\n\n${USAGE}\n`)
      process.exit(2)
    }
    config.noAnswerMode = args.noAnswer
  }
  if ((config.noAnswerMode === 'ai' || config.answerMode === 'ai') && config.workHoursError) {
    process.stdout.write(`${config.workHoursError}\n`)
    process.exit(2)
  }
  if (args.managers != null) config.managersSpec = args.managers
  if (args.clientUri) config.clientUriTemplate = args.clientUri
  if (!args.tts) config.ttsEnabled = false
  if (!args.lookup) config.lookupEnabled = false
  if (args.card) config.genericCardFile = path.resolve(args.card)
  if (args.local) {
    if (!args.manager) {
      process.stdout.write(`В локальном режиме нужен --manager (например sip:mgr@127.0.0.1:5094)\n\n${USAGE}\n`)
      process.exit(2)
    }
    config.managerUri = args.manager
    config.fallbackUri = isOff(args.fallback) ? '' : args.fallback || args.manager
    config.managers = resolveManagers(config.managersSpec, config.managerUri)
  }
  // Реальний режим: номер лінії або URI як задано (прапорець → VG_* → 907/906); URI — коли відомий сервер лінії
  const managerRaw = args.manager || config.manager
  const fallbackRaw = args.fallback != null ? (isOff(args.fallback) ? '' : args.fallback) : config.fallback

  try {
    config.greetingFile = checkPrompt('приветствие', config.greetingFile, { required: true })
    config.holdFile = checkPrompt('ожидание', config.holdFile, { required: true })
    config.genericCardFile = checkPrompt('общая карточка', config.genericCardFile, { required: false })
    config.voicemailPromptFile = checkPrompt('голосовая почта', config.voicemailPromptFile, { required: false })
    if (config.beepFile) config.beepFile = checkPrompt('сигнал перед записью', config.beepFile, { required: false })
  } catch (e) {
    warn(e.message)
    process.exit(2)
  }
  if (!fs.existsSync(config.enginePath)) {
    warn(`движок не найден: ${config.enginePath}. Соберите: make -C voice-gateway/engine`)
    process.exit(2)
  }

  // Облік: токен Google (метадані ВМ або gcloud) — для секретів
  const getAccessToken = makeTokenSource()

  // Логін лінії — до старту рушія: питання в консоль не змішуються з подіями
  let line = null
  if (!args.local) {
    if (config.lineSecret) {
      let raw
      try {
        raw = await accessSecret({ project: config.gcpProject, name: config.lineSecret, getAccessToken })
      } catch (e) {
        warn(`не удалось прочитать ${config.lineSecret}: ${e.message}`) // HTTP-код / сеть — без значения секрета
        process.exit(2)
      }
      try {
        line = parseLineSecret(raw, config.sipServer)
      } catch (e) {
        warn(`${config.lineSecret}: ${e.message}`)
        process.exit(2)
      }
      status(`учётка линии из Secret Manager (${config.lineSecret})`)
    } else {
      const pr = makePrompter()
      const server = (await pr.ask(`SIP-сервер [${config.sipServer}]: `)) || config.sipServer
      const user = await pr.ask('Логин линии (SIP): ')
      const password = await pr.ask('Пароль линии (не отображается): ', { hidden: true })
      pr.close()
      line = { server, user, password }
      if (!SERVER_RE.test(server)) {
        warn('неверный SIP-сервер (нужно имя хоста, например sip14.binotel.com)')
        process.exit(2)
      }
    }
    if (!line.user || !line.password) {
      warn('нужны логин и пароль линии')
      process.exit(2)
    }
    config.sipServer = line.server
    config.managerUri = extUri(managerRaw, config.sipServer)
    config.fallbackUri = fallbackRaw ? extUri(fallbackRaw, config.sipServer) : ''
    config.managers = resolveManagers(config.managersSpec, config.managerUri)
  }

  // Синтез і пошук — необов'язкові: не вдалося підготувати → дзвінки йдуть без картки / лише з номером
  // Ключ ElevenLabs (Secret Manager elevenlabs-api-key) — і для синтезу, і для ШІ-співрозмовника
  let keyP = null
  const getApiKey = () => {
    keyP = keyP || accessSecret({ project: config.gcpProject, name: config.ttsSecret, getAccessToken }).then((k) => k.trim())
    keyP.catch(() => { keyP = null }) // наступний дзвінок спробує ще раз
    return keyP
  }
  let tts = null
  if (config.ttsEnabled) {
    tts = makeTts({ cacheDir: config.cacheDir, getApiKey, voiceId: config.ttsVoiceId, model: config.ttsModel, timeoutMs: config.ttsTimeoutMs })
    getApiKey().then(() => status('ключ синтеза получен'), (e) => warn(`ключ синтеза: ${e.message} — карточки будут без синтеза, пока не получится`))
  }
  // Фрази підтвердження й передзвону: свій WAV (VG_*_WAV) або синтез тим самим голосом (кеш cache/prompt-<sha1>.wav).
  // Не вийшло — фразу пропускаємо (дзвінок іде далі); синтез пробуємо знову з наступним дзвінком, не частіше раз на хвилину.
  const PROMPT_LABELS = { confirm: 'вопрос менеджеру «1 / 2»', busy: '«линия занята» клиенту', cbConnecting: '«соединяем с клиентом» менеджеру', cbNone: '«нет ждущих клиентов» менеджеру', cbGreeting: 'приветствие клиенту при перезвоне', cbNoAnswer: '«клиент не отвечает» менеджеру', pin: '«введите пин-код» менеджеру', cbClientBusy: '«клиент говорит с ИИ, перезвоните» менеджеру',
    mgrJoin: '«клиент на линии с ИИ — соединяю» менеджеру', mgrJoinPlain: '«клиент на линии — соединяю» менеджеру', mgrJoinBusy: '«клиента уже соединяют» менеджеру', mgrJoinGone: '«клиент положил трубку» менеджеру',
    intro: 'вступление 80 клиенту', joinClient: '«менеджер уже на линии» клиенту (81)', aiDown: '«соединяем с менеджером» клиенту (82)', aiDownNight: '«нерабочее время, менеджер перезвонит» клиенту (83)' }
  for (const [name, file] of [...Object.entries(config.promptFiles), ...Object.entries(config.aiFirstPromptFiles || {})]) {
    if (file) config.prompts[name] = checkPrompt(PROMPT_LABELS[name] || name, path.resolve(file), { required: false })
  }
  let promptsAt = 0
  let promptsBusy = false
  // Клієнтські фрази 80–83 шлюз синтезує лише як ПРОБНІ (VG_CLIENT_SYNTH=trial) і лише для тестових номерів
  // (VG_ALLOWED_CALLERS непорожній) — правило власника «аудіо лише після погодження текстів»
  const clientTrial = config.clientSynth === 'trial' && config.allowedCallers.length > 0
  if (config.clientSynth === 'trial' && !clientTrial) warn('VG_CLIENT_SYNTH=trial без VG_ALLOWED_CALLERS — клиентские фразы 80–83 не синтезирую (проба — только на тестовых номерах)')
  const promptText = (k) => config.promptTexts[k] ?? config.joinPromptTexts?.[k] ?? (CLIENT_PROMPT_KEYS.includes(k) ? config.clientTrialTexts?.[k] : null)
  // Фраза PIN потрібна лише з передзвоном із зовнішніх номерів; «клієнт говорить із ШІ» — лише в режимі ai; фрази
  // приєднання — лише з VG_JOIN_ON_CALLBACK; клієнтські 80/82/83 — лише з VG_ANSWER_MODE=ai, 81 — з приєднанням, і всі —
  // лише пробним синтезом
  const promptNeeded = (k) => (k !== 'pin' || externalCallbackOn(config)) && (k !== 'cbClientBusy' || config.noAnswerMode === 'ai' || config.answerMode === 'ai') &&
    (!(k in (config.joinPromptTexts || {})) || config.joinOnCallback === true) &&
    (!CLIENT_PROMPT_KEYS.includes(k) || (clientTrial && (k === 'joinClient' ? config.joinOnCallback === true : config.answerMode === 'ai')))
  const allPromptKeys = [...Object.keys(config.promptTexts), ...Object.keys(config.joinPromptTexts || {}), ...CLIENT_PROMPT_KEYS]
  const missingPrompts = () => allPromptKeys.filter((k) => !config.prompts[k] && promptNeeded(k) && promptText(k))
  const synthPrompts = async (first = false) => {
    const missing = missingPrompts()
    if (!tts || !missing.length || promptsBusy || (!first && Date.now() - promptsAt < 60000)) return
    promptsBusy = true
    promptsAt = Date.now()
    const failed = []
    for (const k of missing) { // по черзі: не впираємось у ліміт одночасних запитів ElevenLabs
      try {
        config.prompts[k] = (await tts(promptText(k), { prefix: 'prompt' })).file
      } catch (e) {
        failed.push(`${PROMPT_LABELS[k] || k}: ${e.message}`)
      }
    }
    promptsBusy = false
    if (failed.length) warn(`фразы не синтезированы (${failed.length}): ${failed.join('; ')} — звонки без них, попробую снова со следующим звонком`)
    else status(`фразы подтверждения и перезвона готовы: ${missing.length} (синтез или кэш)`)
  }
  if (tts) synthPrompts(true)
  else if (missingPrompts().length) warn(`синтез выключен — нет фраз: ${missingPrompts().map((k) => PROMPT_LABELS[k] || k).join(', ')} (их WAV: VG_CONFIRM_WAV, VG_BUSY_WAV, VG_CB_*_WAV${config.joinOnCallback ? ', VG_MGR_JOIN*_WAV' : ''}); звонки идут без них`)

  let lookup = null
  if (config.lookupEnabled) {
    const { makeLookup } = await import('./lookup.mjs')
    const l = makeLookup({ projectId: config.firebaseProject, budgetMs: config.lookupBudgetMs, log: warn })
    lookup = l.lookup
    l.warm().then(() => status('Firestore: соединение готово'), (e) => warn(`Firestore: ${e.message} — карточка будет только с номером`))
  }

  // ШІ-співрозмовник: сокет звуку для рушія, провайдер (ElevenLabs Agents), фабрика сесій для сценарію. Не вийшло
  // підготувати — режим ai працює як busy («лінія зайнята»), шлюз про це пише.
  let aiFactory = null
  let audioServer = null
  let aiStore = null
  if (config.noAnswerMode === 'ai' || config.answerMode === 'ai') {
    let agentFile = null
    try {
      agentFile = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'ai-elevenlabs.json'), 'utf8'))
    } catch { /* агент не налаштовано — нижче попередження */ }
    const agentId = config.aiElAgent || agentFile?.agentId || null
    if (config.aiProvider !== 'elevenlabs') warn(`ИИ: провайдер ${config.aiProvider} не поддерживается (есть elevenlabs) — режим ai работает как busy`)
    else if (!agentId && !config.aiElUrl) warn('ИИ: агент ElevenLabs не настроен (VG_AI_EL_AGENT или node voice-gateway/brain/ai-setup-elevenlabs.mjs) — режим ai работает как busy')
    else {
      try {
        audioServer = await startAudioServer({ log: warn })
      } catch (e) {
        warn(`ИИ: сокет звука не создан (${e.message}) — режим ai работает как busy`)
      }
    }
    if (audioServer) {
      const provider = makeElevenLabsProvider({
        getApiKey, agentId, apiBase: config.aiElApi, wsUrl: config.aiElUrl, voiceId: config.aiVoiceId, language: 'uk',
        llm: agentFile?.llm || config.aiElLlm, maxDurationSec: config.aiMaxSec + 60, pricePerMin: config.aiPricePerMin, log: warn,
        // назва інструмента → id інструмента ElevenLabs (ai-setup-elevenlabs.mjs) — лише для агента, оновленого з дозволом
        // переозначати tool_ids (toolIdsOverride): інакше ElevenLabs відхилить розмову з переозначенням
        // (і лише для того самого агента: VG_AI_EL_AGENT може вказувати на іншого, без такого дозволу)
        toolIds: agentFile?.toolIdsOverride === true && (!config.aiElAgent || config.aiElAgent === agentFile.agentId) ? agentFile.toolIds || null : null,
      })
      if (agentFile?.toolIds && agentFile.toolIdsOverride !== true) warn('ИИ: агент ElevenLabs без разрешения переопределять инструменты — «соединить с менеджером» модель видит всегда (откажет сценарий). Обновите агента: node voice-gateway/brain/ai-setup-elevenlabs.mjs --apply')
      const hours = hoursText(config.workHours)
      const allTools = TOOL_DEFS.map((t) => t.name)
      aiFactory = (o) => createAgent({
        call: o.call,
        server: audioServer,
        provider,
        connectOpts: {
          // v2 — режим «ШІ одразу»: нові перші фрази (за даними, з вступом 80 і без) і правила переводу (VG_AI_FIRST_TRANSFER)
          // failedBy — повторна сесія після менеджера, що приєднався й поклав (join), а не після недозвону (dial)
          instructions: buildInstructions({ kind: o.kind, hoursText: hours, category: o.category, transferAllowed: o.transferAllowed, statusDetail: config.aiStatusDetail, note: o.note, v2: o.v2 === true, transferMode: config.aiFirstTransfer, failedBy: o.failedBy, afterHours: o.afterHours === true }),
          firstMessage: firstMessageFor({ kind: o.kind, variant: o.variant, intro: o.intro === true, note: o.note, v2: o.v2 === true, failedBy: o.failedBy }),
          // Інструменти цієї сесії: без права з'єднати (неробочий час, ліміт з'єднань) модель transfer_to_manager не бачить
          tools: o.transferAllowed ? allTools : allTools.filter((n) => n !== 'transfer_to_manager'),
        },
        onTool: o.onTool,
        onSpeaking: o.onSpeaking,
        onEnd: o.onEnd,
        clock: { now: Date.now, setTimeout, clearTimeout },
        log: status,
        limits: { maxSec: config.aiMaxSec, idleSec: config.aiIdleSec, wrapSec: config.aiWrapSec },
      })
      if (config.aiSave === 'firestore') aiStore = makeAiCallStore({ projectId: config.firebaseProject, log: status })
      status(`ИИ-собеседник: ElevenLabs Agents ${config.aiElUrl ? `(локально ${config.aiElUrl})` : `агент ${agentId}`}, LLM ${agentFile?.llm || config.aiElLlm}; рабочее время ${hours || 'всегда'} (Киев)${config.aiAfterHours ? ', в нерабочее — сразу ИИ' : ''}; про заявку — ${config.aiStatusDetail === 'stage' ? 'есть/номер/этап' : 'есть/номер'}; до ${config.aiMaxSec} с; соединить с менеджером — до ${config.aiTransferMax} раз; разговоры — ${config.aiSave === 'firestore' ? 'в заявку (Firestore) и локально' : 'локально'}`)
    }
    if (config.answerMode === 'ai' && !aiFactory) warn('VG_ANSWER_MODE=ai, но ИИ не готов (агент, провайдер или сокет звука) — работаю по-старому: сначала менеджер')
  }

  // Дані шлюзу (номери, імена голосом у кеші) — лише власнику; старе прибираємо на старті й раз на 6 год
  const logDir = path.join(config.dataDir, 'logs')
  for (const d of [config.dataDir, logDir, config.cacheDir]) ensurePrivateDir(d)
  status(`данные шлюза (журнал, логи, голосовые сообщения): ${config.dataDir}`)
  const gitRoot = findGitRoot(config.dataDir)
  if (gitRoot) warn(`данные шлюза лежат внутри рабочей копии git (${gitRoot}): удалят её (worktree после слияния) — пропадут журнал и голосовые сообщения клиентов. Задайте VG_DATA_DIR вне репозитория`)
  // Рушій упав під час запису минулого разу — WAV без довжини в заголовку: лагодимо (звук у файлі є)
  try {
    const fixed = repairVoicemailHeaders({ dataDir: config.dataDir })
    if (fixed) status(`исправлен заголовок WAV у голосовых сообщений после падения движка: ${fixed}`)
  } catch (e) {
    warn(`проверка голосовых сообщений: ${e.message}`)
  }
  // Сигнал перед записом голосової пошти: свій файл (VG_BEEP_WAV) або один раз згенерований тон 1 кГц 0,4 с у кеші
  if (!config.beepFile) {
    try {
      config.beepFile = ensureBeep({ cacheDir: config.cacheDir })
    } catch (e) {
      warn(`сигнал перед записью: ${e.message} — запись без сигнала`)
    }
  }
  // Гудки, поки шлюз дзвонить менеджеру в нових гілках (VG_HOLD_TONE=ringback): свій файл (VG_RINGBACK_WAV) або один раз
  // згенерований тон 425 Гц (1 с звук / 4 с тиша) у кеші
  if (config.holdTone === 'ringback') {
    if (config.ringbackFile) config.ringbackFile = checkPrompt('гудки', path.resolve(config.ringbackFile), { required: false })
    if (!config.ringbackFile) {
      try {
        config.ringbackFile = ensureRingback({ cacheDir: config.cacheDir })
      } catch (e) {
        warn(`гудки: ${e.message} — вместо гудков обычное ожидание`)
      }
    }
  }
  // Відкладені передзвони й «останній клієнт» менеджера: <data>/callbacks.json і last-clients.json (номери клієнтів, 0600)
  const callbacks = makeCallbackStore({ dataDir: config.dataDir, callbackTtlHours: config.callbackTtlHours, lastClientTtlDays: config.lastClientTtlDays, maxAttempts: config.callbackMaxAttempts, maxDialsPerDay: config.callbackMaxDialsPerDay, log: warn })
  try {
    const waiting = callbacks.listPending().length
    if (waiting) status(`ждут перезвона менеджера: ${waiting}`)
    // Записи під ключами, яких немає серед поточних менеджерів (VG_MANAGER / VG_MANAGERS змінили) — їх ніхто не побачить
    const orphans = callbacks.orphanKeys(config.managers)
    if (orphans.length) warn(`в callbacks.json / last-clients.json есть записи менеджеров, которых нет среди текущих (${orphans.join(', ')}): их перезвоны недоступны. Добавьте этот номер в группу менеджера в VG_MANAGERS (например 907=0676575085)`)
  } catch (e) {
    warn(`передзвоны: ${e.message}`)
  }
  // Хто може передзвонювати: внутрішні лінії менеджерів — завжди; зовнішні номери — лише з VG_MANAGERS_EXTERNAL=1 і PIN
  const externalNums = config.managers.flat().filter((k) => !isInternalKey(k))
  const internalNums = config.managers.flat().filter((k) => isInternalKey(k))
  if (config.managerPinInvalid) warn('VG_MANAGER_PIN должен быть 4–8 цифр — PIN не задан')
  if (externalNums.length && !externalCallbackOn(config)) warn(`звонки на шлюз с внешних номеров менеджеров (${externalNums.join(', ')}) получат «занято» (486): номер можно подделать. Перезвон с них — только VG_MANAGERS_EXTERNAL=1 и VG_MANAGER_PIN (4–8 цифр)`)
  if (config.managersExternal && !config.managerPin && !config.managersExternalNoPin) warn('VG_MANAGERS_EXTERNAL=1 без VG_MANAGER_PIN — внешние номера менеджеров всё равно получат 486')
  if (config.managersExternalNoPin && !config.managerPin) warn('перезвон с внешних номеров менеджеров БЕЗ PIN (VG_MANAGERS_EXTERNAL=nopin): номер звонящего можно подделать')
  const mgrK = partyKey(config.managerUri)
  if (mgrK && !isInternalKey(mgrK) && !internalNums.length) warn(`менеджер — внешний номер (${mgrK}), а внутренних линий менеджеров нет: звонок с 907 шлюз примет за клиента и наберёт менеджеру. Для перезвона с внутренней линии: VG_MANAGERS=907=${mgrK.replace('+380', '0')}`)
  const prune = () => {
    try {
      repairVoicemailHeaders({ dataDir: config.dataDir, minAgeMs: 120000 }) // свіжі файли ще може писати рушій
      const n = pruneGatewayData({ dataDir: config.dataDir, cacheDir: config.cacheDir, retentionDays: config.retentionDays })
      callbacks.prune() // прострочені передзвони (> callbackTtlHours) і останні клієнти (> lastClientTtlDays)
      if (n) status(`удалено старых файлов: ${n} (логи > ${config.retentionDays.logs} дн, карточки > ${config.retentionDays.cache} дн, журнал > ${config.retentionDays.journal} дн, голосовые сообщения > ${config.retentionDays.voicemail} дн)`)
    } catch (e) {
      warn(`очистка старых файлов: ${e.message}`)
    }
  }
  prune()
  setInterval(prune, 6 * 3600 * 1000).unref()

  const journal = makeJournal({ dataDir: config.dataDir, timeZone: config.timeZone })
  // Денні логи з ротацією за київською датою — спільні для всіх запусків рушія
  const engineLog = makeDailyLog({ dir: logDir, prefix: 'engine', timeZone: config.timeZone })
  const traceLog = config.trace ? makeDailyLog({ dir: logDir, prefix: 'brain', timeZone: config.timeZone }) : null

  const noAnswer = {
    busy: 'клиенту «линия занята», перезвон менеджера',
    fallback: `запасная ${config.fallbackUri || 'нет'}${config.fallbackUri ? (config.fallbackMode === 'blind' ? ' (слепой перевод)' : ' (набор, карточка, REFER/Replaces)') : ''}, потом голосовая почта ${config.voicemailEnabled ? `до ${config.voicemailMaxSec} с` : 'выкл'}`,
    voicemail: `голосовая почта ${config.voicemailEnabled ? `до ${config.voicemailMaxSec} с` : 'выкл'}`,
    ai: aiFactory ? 'ИИ-собеседник (перезвон менеджера сохраняется)' : 'клиенту «линия занята», перезвон менеджера (ИИ не настроен)',
  }[config.noAnswerMode]
  status(`режим: ${args.local ? 'локальный' : 'линия Binotel'}; менеджер ${config.managerUri}; ${config.confirmEnabled ? `подтверждение «1» (ждём ${config.confirmTimeoutSec} с, вопрос ещё ${config.confirmRepeats} раз)` : 'без подтверждения «1»'}; не взял/«2»/без «1» → ${noAnswer}; движок ${config.enginePath}`)
  status(`перезвон: менеджеры ${config.managers.map((g) => g.join('=')).join(', ') || 'нет'} (внешние номера — ${externalCallbackOn(config) ? 'с PIN' : 'нет, 486'}); ждёт ${config.callbackTtlHours} ч, не взял ${config.callbackMaxAttempts || '∞'} раз — снят, не чаще ${config.callbackMaxDialsPerDay || '∞'} наборов клиента в сутки; последний клиент — ${config.lastClientTtlDays} дн; клиента набираю ${config.clientUriTemplate}; REFER на ноге ${config.callbackReferOn === 'client' ? 'клиента' : 'менеджера'}`)
  // Нові режими (черга A записки 2026-10-17) — рядок лише коли щось увімкнено. Пробний синтез вступу 80 іде у фоні
  // (synthPrompts) і ще не встиг — «пробный синтез», а не «нет»
  const modes = newModesLine(config, { aiReady: !!aiFactory, clientTrial, introSynth: !!tts && !config.prompts.intro && promptNeeded('intro') && !!promptText('intro') })
  if (modes) status(modes)
  const internal = config.allowedInternal.length ? `внутренние ${config.allowedInternal.join(', ')}` : 'внутренние'
  if (!config.allowedCallers.length) status('ВНИМАНИЕ: список разрешённых звонящих пуст — все внешние звонки получат «занято» и пойдут дальше по сценарию Binotel. Задайте VG_ALLOWED_CALLERS или --allow.')
  status(`разрешены: ${config.allowedCallers.join(', ') || 'никто'} + ${internal} + менеджеры; синтез ${config.ttsEnabled ? 'вкл' : 'выкл'}; поиск ${config.lookupEnabled ? 'вкл' : 'выкл'}${config.genericCardFile ? '; общая карточка есть' : ''}${config.trace ? '; трасса вкл' : ''}`)

  // ---------- рушій: запуск і перезапуск після падіння ----------
  // Упав сам (не Ctrl+C) — журналимо незавершені дзвінки як aborted і за RESTART_MS піднімаємо новий рушій із
  // новим диспетчером (номери викликів у нового рушія знову з 1) і новою реєстрацією. Частіше MAX_CRASHES за
  // CRASH_WINDOW_MS — виходимо з кодом 1: далі хай вирішує надзирач (systemd/launchd) або людина.
  const RESTART_MS = Number(process.env.VG_ENGINE_RESTART_MS) || 3000
  const MAX_CRASHES = 5
  const CRASH_WINDOW_MS = 10 * 60 * 1000
  const crashes = []
  let engine = null
  let dispatcher = null
  let stopping = false
  let restartTimer = null
  const untrustedSeen = new Map() // IP → коли востаннє показували (сканери шлють сотні INVITE)
  let warnedNoRecord = false
  let warnedNoDtmf = false
  let fatalCode = null // шлюз зупиняється з цим кодом (рушій без DTMF при увімкненому підтвердженні)

  // Перед виходом дописати логи на диск (process.exit не чекає на потоки), але не довше 1 с
  const flushLogs = () => Promise.race([
    Promise.all([engineLog, traceLog].filter(Boolean).map((w) => w.end())),
    new Promise((r) => setTimeout(r, 1000)),
  ])
  const exitNow = (code) => flushLogs().then(() => process.exit(code))

  function boot() {
    let lastReg = ''
    const eng = startEngine({ enginePath: config.enginePath, logWriter: engineLog, traceWriter: traceLog })
    engine = eng
    const d = createDispatcher({
      config,
      send: (cmd) => { if (!eng.send(cmd)) warn(`движок не принял команду ${cmd.cmd}`) },
      clock: { now: Date.now, setTimeout, clearTimeout },
      lookup,
      buildCard: (res, o) => buildCard(res, { ...o, nowMs: Date.now() }),
      tts,
      voicemailPath: (o) => makeVoicemailPath({ dataDir: config.dataDir, timeZone: config.timeZone, ...o }),
      callbacks,
      // Рушій без звуку до мозку (ready.audio) — сесії ШІ немає: available() === false, і сценарій іде рівно як busy
      // (у неробочий час теж набирає менеджера, а не каже клієнту «лінія зайнята» без жодного дзвінка)
      ai: aiFactory
        ? Object.assign((o) => (config.audioSupported ? aiFactory(o) : null), { available: () => config.audioSupported === true })
        : null,
      log: status,
      onDone: (entry) => {
        // Розшифровка розмови з ШІ — особисті дані: окремим файлом 0600 (і в заявку, якщо VG_AI_SAVE=firestore), у журнал — ні
        const tr = entry.aiTranscript
        delete entry.aiTranscript
        if (tr && entry.ai) {
          try {
            entry.ai.transcriptFile = saveAiTranscript({ dataDir: config.dataDir, gcid: entry.gcid, number: entry.number, timeZone: config.timeZone, record: { startedAt: entry.startedAt, gcid: entry.gcid, serviceRequestId: entry.serviceRequestId, outcome: entry.outcome, ...tr } })
          } catch (e) {
            warn(`ИИ: расшифровка не сохранена: ${e.message}`)
          }
          if (aiStore) {
            aiStore.save({ ...entry, aiTranscript: tr }).then((r) => {
              if (r.skipped && r.skipped !== 'no_request') warn(`ИИ: в заявку не записано (${r.skipped})`)
            }, (e) => warn(`ИИ: запись в Firestore не удалась: ${e.message}`))
          }
        }
        const vm = entry.voicemail
        if (vm?.file && vm.empty) {
          // Порожнє повідомлення (клієнт поклав одразу після сигналу): файл без звуку не лишаємо, у журналі — підсумок
          try {
            fs.unlinkSync(vm.file)
            vm.file = null
            vm.removed = true
          } catch (e) {
            if (e.code === 'ENOENT') vm.file = null
            else warn(`пустое голосовое сообщение не удалено: ${e.message}`)
          }
        } else if (vm?.file) {
          // запис голосу клієнта — лише власнику (рушій створює його з umask 077; страховка для інших збірок)
          try { fs.chmodSync(vm.file, 0o600) } catch { /* файлу немає */ }
          // рушій упав під час запису — заголовок без довжини: рушія вже немає, лагодимо одразу
          if (entry.abortReason === 'engine_exit' && repairWavHeader(vm.file)) status('заголовок WAV сообщения исправлен после падения движка')
        }
        try {
          journal(entry)
        } catch (e) {
          warn(`журнал: ${e.message}`)
        }
        status(summary(entry))
      },
    })
    dispatcher = d
    const readyTimer = setTimeout(() => {
      warn('движок не ответил ready за 10 с — смотрите лог движка')
      eng.kill()
    }, 10000)

    eng.on('event', (ev) => {
      switch (ev.ev) {
        case 'ready':
          clearTimeout(readyTimer)
          // Старий рушій (без команди record) — голосової пошти немає: дзвінок, який ніхто не взяв, кладемо
          config.recordSupported = ev.record === true
          // Старий рушій не повідомляє DTMF (pjsua2 віддає цифри лише в onDtmfEvent). Переводити без «1» не можна
          // (голосова пошта мобільного оператора забрала б клієнта), а чекати «1», якої не буде, — жоден дзвінок не
          // з'єднався б. Тому з увімкненим підтвердженням не стартуємо; без «1» — лише явне VG_CONFIRM=0.
          config.dtmfSupported = ev.dtmf === true
          // Звук до мозку (audio_start) — для ШІ-співрозмовника: рушій engine/sip-engine-ai
          config.audioSupported = ev.audio === true
          if (aiFactory && !config.audioSupported) warn(`движок ${config.enginePath} не умеет поток звука (audio_start) — ИИ не будет, режим ai работает как busy. Новый движок: make -C voice-gateway/engine sip-engine-ai и VG_ENGINE_PATH=voice-gateway/engine/sip-engine-ai`)
          if (!config.dtmfSupported && config.confirmEnabled) {
            warn(`движок ${config.enginePath} не сообщает DTMF: подтверждение «1» невозможно, а переводить без «1» нельзя — шлюз не запускается. Новый движок: make -C voice-gateway/engine sip-engine-next и VG_ENGINE_PATH=voice-gateway/engine/sip-engine-next (переводить без «1» — только явно VG_CONFIRM=0)`)
            fatalCode = 2
            stopping = true
            if (!eng.send({ cmd: 'quit' })) eng.kill()
            break
          }
          if (!config.dtmfSupported && externalCallbackOn(config) && !warnedNoDtmf) {
            warnedNoDtmf = true
            warn(`движок ${config.enginePath} не сообщает DTMF — PIN не ввести: перезвон с внешних номеров менеджеров невозможен`)
          }
          if (!config.recordSupported && config.voicemailEnabled && ['fallback', 'voicemail'].includes(config.noAnswerMode) && !warnedNoRecord) {
            warnedNoRecord = true
            warn(`движок ${config.enginePath} не умеет запись — голосовой почты не будет. Новый движок: make -C voice-gateway/engine sip-engine-next и VG_ENGINE_PATH=voice-gateway/engine/sip-engine-next`)
          }
          if (args.local) {
            const bind = args.bind || '127.0.0.1'
            const port = args.port || 5092
            const user = args.user || 'gw'
            eng.send({ cmd: 'local', bind, port, user })
            status(`локальный режим: sip:${user}@${bind}:${port}, жду звонков`)
          } else {
            eng.send({ cmd: 'register', server: line.server, user: line.user, password: line.password, expires: config.sipExpires, ...(config.sipTrust ? { trust: config.sipTrust } : {}) })
            status(`регистрирую линию ${line.user} на ${line.server}…`)
          }
          break
        case 'reg': {
          const key = `${ev.code}|${ev.active}`
          if (ev.local) break // локальний режим без реєстратора — рядок уже надруковано
          if (key !== lastReg) {
            lastReg = key
            if (ev.active && Number(ev.code) === 200) status(`линия зарегистрирована (${ev.code} ${ev.reason || ''}), жду звонков`)
            else warn(`регистрация: ${ev.code} ${ev.reason || ''}${ev.active ? '' : ' (не активна)'}`)
          }
          break
        }
        case 'incoming': {
          const gcid = ev.gcid ? `, gcid ${clean(ev.gcid, 32)}` : ''
          const mc = managerCaller(ev, config)
          if (mc?.external && !externalCallbackOn(config)) status(`входящий с внешнего номера менеджера ${maskNumber(ev.number) || '?'} — отклоняю (486): перезвон с внешних номеров выключен${gcid}`)
          else if (mc) status(`входящий от менеджера ${clean(ev.number || '?', 40)} — перезвон клиенту${mc.external ? ' (нужен PIN)' : ''}${gcid}`)
          else if (callerAllowed(ev, config)) status(`входящий: ${clean(ev.number || ev.from || '?', 40)}${ev.name ? ` «${clean(ev.name, 60)}»` : ''}${gcid}`)
          else status(`входящий с номера не из списка: ${maskNumber(ev.number) || '?'}${gcid}`) // чужих не показуємо повністю
          synthPrompts() // якщо якоїсь фрази ще немає — ще спроба синтезу (не частіше раз на хвилину)
          break
        }
        case 'untrusted': {
          const ip = String(ev.src || '?').replace(/:\d+$/, '')
          const now = Date.now()
          if (!untrustedSeen.has(ip) || now - untrustedSeen.get(ip) > 60000) {
            untrustedSeen.set(ip, now)
            warn(`отклонён INVITE с адреса ${clean(ev.src, 64)} (403): это не сервер Binotel. Если всё же Binotel — добавьте адрес в VG_SIP_TRUST`)
          }
          break
        }
        case 'error':
          if (ev.call == null && ev.ref == null) warn(`движок: ${ev.cmd || ''} ${ev.msg || ''}`.trim())
          break
        default:
      }
      d.handle(ev)
    })
    eng.on('garbage', (t) => warn(`движок вывел не-JSON: ${t.slice(0, 80)}`))
    eng.on('spawn_error', (e) => {
      clearTimeout(readyTimer)
      warn(`не удалось запустить движок: ${e.message}`)
      exitNow(1)
    })
    eng.on('exit', ({ code, signal }) => {
      clearTimeout(readyTimer)
      d.abortAll(stopping ? 'shutdown' : 'engine_exit')
      eng.close()
      if (stopping) {
        status('шлюз остановлен')
        exitNow(fatalCode ?? 0)
        return
      }
      warn(`движок завершился (code ${code}${signal ? `, ${signal}` : ''}) — смотрите ${engineLog.file || logDir}`)
      const now = Date.now()
      crashes.push(now)
      while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift()
      if (crashes.length > MAX_CRASHES) {
        warn(`движок падал ${crashes.length} раз за ${CRASH_WINDOW_MS / 60000} мин — выхожу`)
        exitNow(1)
        return
      }
      warn(`перезапускаю движок через ${(RESTART_MS / 1000).toFixed(0)} с (${args.local ? 'локальный режим' : 'заново регистрирую линию'})`)
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (!stopping) boot()
      }, RESTART_MS)
    })
  }

  const stop = async () => {
    if (stopping) {
      warn('принудительная остановка')
      engine?.kill('SIGKILL')
      process.exit(1)
    }
    stopping = true
    if (restartTimer) {
      // рушій упав і ще не піднятий — знімати нічого
      clearTimeout(restartTimer)
      restartTimer = null
      status('шлюз остановлен')
      return exitNow(0)
    }
    status('останавливаю: снимаю регистрацию и кладу звонки…')
    dispatcher.abortAll('shutdown') // у журнал — «зупинка шлюзу», а не «клієнт поклав» від розривів після quit
    if (!engine.send({ cmd: 'quit' })) engine.kill()
    const r = await engine.waitExit(8000)
    if (!r) {
      warn('движок не вышел за 8 с — завершаю')
      engine.kill('SIGKILL')
      await engine.waitExit(2000)
      dispatcher.abortAll('shutdown')
      engine.close()
      exitNow(1)
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('exit', () => {
    engine?.kill('SIGKILL') // шлюз завершується будь-як — рушій не лишаємо сиротою
    audioServer?.close()
  })
  boot()
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gateway.mjs')) {
  main().catch((e) => {
    warn(`ошибка: ${e?.message || e}`)
    process.exit(1)
  })
}
