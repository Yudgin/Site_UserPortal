// Процес SIP-рушія (voice-gateway/engine/sip-engine, pjsua2) і обмін з ним JSON-рядками:
// команди → stdin, події ← stdout (один об'єкт на рядок). stderr рушія (лог pjsip) — лише у файл, не в консоль.
// Трасу команд/подій за бажанням пишемо в окремий файл; поле password у трасі завжди замінене,
// вхідні дзвінки — без імені й URI абонента, номер — лише останні 4 цифри; у командах dial / xfer номер у URI (клієнт
// на передзвоні, мобільний менеджера) — теж лише 4 цифри; цифри DTMF у трасу не пишемо (це може бути PIN менеджера).
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const last4 = (n) => {
  const d = String(n ?? '').replace(/\D/g, '')
  return d ? `…${d.slice(-4)}` : null
}
// URI для траси: user-частина з 5+ цифр (номер телефону) → останні 4 цифри; внутрішні лінії (907) і імена — як є
export const maskUri = (uri) => String(uri ?? '').replace(/^((?:sips?|tel):)([^@;>]*)/i, (m, scheme, user) =>
  ((user.match(/\d/g) || []).length >= 5 ? `${scheme}${last4(user)}` : m))

// Команда для траси: пароль замінено, номер у URI набору / сліпого переведення — маскою
export const redact = (cmd) => {
  if (!cmd || typeof cmd !== 'object') return cmd
  let c = cmd
  if ('password' in c) c = { ...c, password: '<…>' }
  if ((c.cmd === 'dial' || c.cmd === 'xfer') && typeof c.uri === 'string') c = { ...c, uri: maskUri(c.uri) }
  return c
}

// Подія для траси: incoming — без from/name, номер маскою (gcid, to, src лишаємо для зіставлення з Binotel); dtmf — без
// цифри (менеджер набирає нею й PIN; що натиснули на питання «1 / 2», видно в журналі дзвінка, поле confirm).
export const redactEvent = (ev) => {
  if (!ev || typeof ev !== 'object') return ev
  if (ev.ev === 'dtmf') return { ...ev, digit: '<…>' }
  if (ev.ev !== 'incoming') return ev
  const { from, name, number, ...rest } = ev
  return { ...rest, number: last4(number) }
}

// Файл для дописування лише власнику (0600, тека 0700)
function fileWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const ws = fs.createWriteStream(file, { flags: 'a', mode: 0o600 })
  ws.on('error', () => {})
  return ws
}

// Події: 'event' (об'єкт від рушія), 'garbage' (рядок не-JSON у stdout), 'exit' ({code, signal}), 'spawn_error'.
// Лог рушія — logFile (шлях) або logWriter ({write, end}, напр. денний з ротацією); траса — traceFile / traceWriter.
// Файли за шляхами close() закриває сам; передані writer-и належать тому, хто викликає (спільні між перезапусками).
export function startEngine({ enginePath, args = [], logFile = null, logWriter = null, traceFile = null, traceWriter = null, spawnImpl = spawn }) {
  const ee = new EventEmitter()
  const errLog = logWriter || fileWriter(logFile)
  const trace = traceWriter || (traceFile ? fileWriter(traceFile) : null)
  let closed = false
  const tr = (dir, obj) => { if (trace && !closed) trace.write(`${new Date().toISOString()} ${dir} ${JSON.stringify(obj)}\n`) }
  errLog.write(`\n==== ${new Date().toISOString()} старт ${enginePath} ====\n`)

  // Окрема група процесів: Ctrl+C у терміналі дістається лише шлюзу, а той сам гасить рушій командою quit
  // (зняття реєстрації). Якщо шлюз упаде — рушій побачить кінець stdin.
  const child = spawnImpl(enginePath, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let exited = false
  const exitP = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true
      if (!closed) errLog.write(`==== ${new Date().toISOString()} вихід code=${code} signal=${signal} ====\n`)
      ee.emit('exit', { code, signal })
      resolve({ code, signal })
    })
  })
  child.on('error', (e) => {
    exited = true
    ee.emit('spawn_error', e)
  })
  // Спільний лог (logWriter) дописуємо й після close(): останні рядки рушія, що впав, приходять уже після 'exit'
  child.stderr.on('data', (chunk) => { if (!closed || logWriter) errLog.write(chunk) })
  child.stdin.on('error', (e) => { if (!closed) errLog.write(`stdin: ${e.message}\n`) }) // EPIPE, якщо рушій уже вийшов

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let ev
    try {
      ev = JSON.parse(t)
    } catch {
      ee.emit('garbage', t.slice(0, 200))
      return
    }
    if (!ev || typeof ev !== 'object' || typeof ev.ev !== 'string') {
      ee.emit('garbage', t.slice(0, 200))
      return
    }
    tr('<<', redactEvent(ev))
    ee.emit('event', ev)
  })

  ee.send = (cmd) => {
    if (exited || !child.stdin.writable) return false
    tr('>>', redact(cmd))
    child.stdin.write(`${JSON.stringify(cmd)}\n`)
    return true
  }
  // {code, signal} або null, якщо за ms не вийшов
  ee.waitExit = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    exitP.then((v) => { clearTimeout(t); resolve(v) })
  })
  ee.kill = (sig = 'SIGTERM') => { if (!exited) try { child.kill(sig) } catch { /* вже немає */ } }
  ee.close = () => {
    if (closed) return
    try { child.stdin.end() } catch { /* уже закрито */ }
    closed = true
    if (!logWriter) errLog.end()
    if (!traceWriter) trace?.end()
  }
  ee.child = child
  Object.defineProperty(ee, 'exited', { get: () => exited })
  return ee
}

export default startEngine
