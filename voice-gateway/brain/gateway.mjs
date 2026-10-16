#!/usr/bin/env node
// Голосовий шлюз Binotel: запускає SIP-рушій, реєструє лінію і веде кожен вхідний дзвінок за сценарієм flow.mjs.
//   node voice-gateway/brain/gateway.mjs            — справжня лінія Binotel (логін/пароль питає або бере з Secret Manager)
//   node voice-gateway/brain/gateway.mjs --local --manager sip:mgr@127.0.0.1:5094 [--no-tts --no-lookup --card x.wav]
//                                                     — перевірка на Mac з pjsua без АТС
// Рядки статусу для оператора — російською; паролі й ключі не друкуються ніде, номери чужих абонентів — маскою.
// Рушій упав — шлюз сам перезапускає його і заново реєструє лінію (частіше 5 разів за 10 хв — вихід з кодом 1).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { loadConfig, extUri, isOff } from './config.mjs'
import { startEngine } from './engine.mjs'
import { createDispatcher, callerAllowed, maskNumber } from './flow.mjs'
import { buildCard } from './card.mjs'
import { makeTts, readWavInfo, isTelephonyWav } from './tts.mjs'
import { makeTokenSource, accessSecret } from './gcp.mjs'
import { makeJournal } from './journal.mjs'
import { ensurePrivateDir, makeDailyLog, pruneGatewayData, makeVoicemailPath, ensureBeep, repairVoicemailHeaders, repairWavHeader, findGitRoot } from './storage.mjs'

// ---------- аргументи ----------

const USAGE = `Использование:
  node gateway.mjs                         реальная линия Binotel (логин/пароль спросит; или env BINOTEL_LINE_SECRET)
  node gateway.mjs --local --manager URI   локальная проверка без АТС (аккаунт sip:gw@127.0.0.1:5092)
Флаги:
  --manager 907|URI   кому звонить с карточкой (по умолчанию 907)
  --fallback 906|URI  запасная линия, если менеджер не взял: тоже набор, карточка и REFER/Replaces
                      (по умолчанию 906; в --local = --manager; none — без неё, сразу голосовая почта)
  --allow +380…,…     добавить разрешённых звонящих (внутренние — 3-значные без X-BINOTEL-GCID — разрешены всегда)
  --no-tts            без синтеза карточки        --no-lookup   без поиска клиента в Firestore
  --card file.wav     готовая карточка, если синтез выключен или не удался
  --server host       SIP-сервер (реальный режим, по умолчанию sip14.binotel.com)
  --bind IP --port N --user NAME   адрес локального режима (127.0.0.1, 5092, gw)
  --engine PATH       путь к sip-engine (или env VG_ENGINE_PATH; с записью голосовой почты — engine/sip-engine-next)
  --max-calls N       одновременных звонков (по умолчанию 2)`

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
  if (e.cardSource) bits.push(`карточка: ${e.cardSource}`)
  if (e.voicemail?.empty) bits.push(`сообщения нет (запись ${e.voicemail.sec != null ? `${e.voicemail.sec.toFixed(1)} с` : '—'}${e.voicemail.removed ? ', пустой файл удалён' : ''})`)
  else if (e.voicemail?.file) bits.push(`сообщение ${e.voicemail.sec != null ? `${e.voicemail.sec.toFixed(1)} с` : '(длина неизвестна)'}: ${e.voicemail.file}`)
  if (e.errors?.length) bits.push(`ошибок ${e.errors.length}`)
  return bits.join(', ')
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
  }

  // Синтез і пошук — необов'язкові: не вдалося підготувати → дзвінки йдуть без картки / лише з номером
  let tts = null
  if (config.ttsEnabled) {
    let keyP = null
    const getApiKey = () => {
      keyP = keyP || accessSecret({ project: config.gcpProject, name: config.ttsSecret, getAccessToken }).then((k) => k.trim())
      keyP.catch(() => { keyP = null }) // наступний дзвінок спробує ще раз
      return keyP
    }
    tts = makeTts({ cacheDir: config.cacheDir, getApiKey, voiceId: config.ttsVoiceId, model: config.ttsModel, timeoutMs: config.ttsTimeoutMs })
    getApiKey().then(() => status('ключ синтеза получен'), (e) => warn(`ключ синтеза: ${e.message} — карточки будут без синтеза, пока не получится`))
  }
  let lookup = null
  if (config.lookupEnabled) {
    const { makeLookup } = await import('./lookup.mjs')
    const l = makeLookup({ projectId: config.firebaseProject, budgetMs: config.lookupBudgetMs, log: warn })
    lookup = l.lookup
    l.warm().then(() => status('Firestore: соединение готово'), (e) => warn(`Firestore: ${e.message} — карточка будет только с номером`))
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
  const prune = () => {
    try {
      repairVoicemailHeaders({ dataDir: config.dataDir, minAgeMs: 120000 }) // свіжі файли ще може писати рушій
      const n = pruneGatewayData({ dataDir: config.dataDir, cacheDir: config.cacheDir, retentionDays: config.retentionDays })
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

  status(`режим: ${args.local ? 'локальный' : 'линия Binotel'}; менеджер ${config.managerUri}; запасная ${config.fallbackUri || 'нет'}${config.fallbackUri ? (config.fallbackMode === 'blind' ? ' (слепой перевод)' : ' (набор, карточка, REFER/Replaces)') : ''}; голосовая почта ${config.voicemailEnabled ? `до ${config.voicemailMaxSec} с` : 'выкл'}; движок ${config.enginePath}`)
  const internal = config.allowedInternal.length ? `внутренние ${config.allowedInternal.join(', ')}` : 'внутренние'
  if (!config.allowedCallers.length) status('ВНИМАНИЕ: список разрешённых звонящих пуст — все внешние звонки получат «занято» и пойдут дальше по сценарию Binotel. Задайте VG_ALLOWED_CALLERS или --allow.')
  status(`разрешены: ${config.allowedCallers.join(', ') || 'никто'} + ${internal}; синтез ${config.ttsEnabled ? 'вкл' : 'выкл'}; поиск ${config.lookupEnabled ? 'вкл' : 'выкл'}${config.genericCardFile ? '; общая карточка есть' : ''}${config.trace ? '; трасса вкл' : ''}`)

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
      log: status,
      onDone: (entry) => {
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
          if (!config.recordSupported && config.voicemailEnabled && !warnedNoRecord) {
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
          if (callerAllowed(ev, config)) status(`входящий: ${clean(ev.number || ev.from || '?', 40)}${ev.name ? ` «${clean(ev.name, 60)}»` : ''}${gcid}`)
          else status(`входящий с номера не из списка: ${maskNumber(ev.number) || '?'}${gcid}`) // чужих не показуємо повністю
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
        exitNow(0)
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
  process.on('exit', () => engine?.kill('SIGKILL')) // шлюз завершується будь-як — рушій не лишаємо сиротою
  boot()
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gateway.mjs')) {
  main().catch((e) => {
    warn(`ошибка: ${e?.message || e}`)
    process.exit(1)
  })
}
