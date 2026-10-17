// Локальний димовий тест sip-engine без Binotel: лише 127.0.0.1.
// Учасники: рушій (локальний режим 127.0.0.1:5092), pjsua P1 (127.0.0.1:5091) і P2 (127.0.0.1:5093),
// сирий SIP через UDP (127.0.0.1:5095) і фальшивий реєстратор/проксі (127.0.0.1:5096) для режиму register.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ENGINE = process.env.ENGINE || path.join(HERE, 'sip-engine')
const PJSUA = process.env.PJSUA || '/opt/homebrew/bin/pjsua'
const WORK = process.env.WORK || path.join(HERE, '.smoke')
const PROMPTS = '/Users/yevhenyushchenko/Documents/GitHub/runferry-briefs/telephony/voice-prompts/wav-8k/mila'
const GREETING = process.env.GREETING || path.join(PROMPTS, '04-greeting-unknown-short.wav')
const HOLD = process.env.HOLD || path.join(PROMPTS, '05-hold-short.wav')
const TEST_PW = 'SECRET-TEST-PW-123' // тестовий пароль лише для фальшивого реєстратора

fs.mkdirSync(WORK, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`
const say = (s) => console.log(`${ts()} ${s}`)
const redact = (c) => ('password' in c ? { ...c, password: '<redacted>' } : c)

// ---------- рушій ----------
function startEngine(name) {
  const errLog = fs.createWriteStream(path.join(WORK, `${name}.stderr.log`))
  const child = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SIP_ENGINE_LOG_LEVEL: '4' } })
  child.stderr.pipe(errLog)
  const events = []
  const raw = []
  const garbage = []
  const waiters = new Set()
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    raw.push(line)
    let ev
    try { ev = JSON.parse(line) } catch { garbage.push(line); say(`  !! не JSON у stdout: ${line}`); return }
    events.push(ev)
    say(`  <- ${line}`)
    for (const w of [...waiters]) w()
  })
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  return {
    name, child, events, raw, garbage, exited, errLogPath: path.join(WORK, `${name}.stderr.log`),
    send(cmd) { say(`  -> ${JSON.stringify(redact(cmd))}`); child.stdin.write(`${JSON.stringify(cmd)}\n`) },
    sendRaw(text) { say(`  -> (raw) ${text}`); child.stdin.write(`${text}\n`) },
    wait(pred, ms, label) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const ev = events.find((e) => !e.__used && pred(e))
          if (!ev) return false
          ev.__used = true
          clearTimeout(timer)
          waiters.delete(check)
          resolve(ev)
          return true
        }
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`тайм-аут ${ms} мс: ${label}`)) }, ms)
        if (!check()) waiters.add(check)
      })
    },
    seen(pred) { return events.some(pred) },
  }
}

// ---------- pjsua-співрозмовник ----------
async function startPeer(name, port, rtpPort, { id, autoPlay } = {}) {
  const logPath = path.join(WORK, `${name}.log`)
  const recPath = path.join(WORK, `${name}-rec.wav`)
  const args = ['--null-audio', `--local-port=${port}`, '--no-tcp', '--auto-answer=200', '--max-calls=4',
    '--ip-addr=127.0.0.1', '--bound-addr=127.0.0.1', '--no-vad', `--rtp-port=${rtpPort}`,
    `--rec-file=${recPath}`, '--auto-rec', `--log-file=${logPath}`, '--log-level=5', '--app-log-level=0']
  if (id) args.push(`--id=${id}`)
  if (autoPlay) args.push(`--play-file=${autoPlay}`, '--auto-play')
  const out = fs.openSync(path.join(WORK, `${name}.out`), 'w')
  // Консоль pjsua читає команди зі stdin — пишемо в нього, як у FIFO
  const child = spawn(PJSUA, args, { stdio: ['pipe', out, out] })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  // Журнал pjsua буферизований (дописується при виході), тож готовність перевіряємо SIP OPTIONS
  if (!(await sipPing(port))) { child.kill('SIGKILL'); throw new Error(`${name}: pjsua не відповідає на 127.0.0.1:${port}`) }
  const log = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
  say(`  ${name}: pjsua на 127.0.0.1:${port}`)
  return {
    name, logPath, recPath, log,
    cmd(s) { say(`  ${name} <- ${s}`); child.stdin.write(`${s}\n`) },
    async quit() {
      try { child.stdin.write('ha\n'); await sleep(300); child.stdin.write('q\n') } catch { /* вже закрито */ }
      const code = await Promise.race([exited, sleep(5000).then(() => null)])
      if (code === null) child.kill('SIGKILL')
    },
  }
}

// OPTIONS на порт, доки не відповість (до ~5 с)
async function sipPing(port) {
  const sock = dgram.createSocket('udp4')
  await new Promise((r) => sock.bind(0, '127.0.0.1', r))
  const lport = sock.address().port
  let got = false
  sock.on('message', (b) => { if (/^SIP\/2\.0 /.test(b.toString())) got = true })
  for (let i = 0; i < 25 && !got; i++) {
    const msg = [`OPTIONS sip:ping@127.0.0.1:${port} SIP/2.0`, `Via: SIP/2.0/UDP 127.0.0.1:${lport};branch=z9hG4bK-ping-${port}-${i};rport`,
      'Max-Forwards: 70', `From: <sip:smoke@127.0.0.1:${lport}>;tag=ping${i}`, `To: <sip:ping@127.0.0.1:${port}>`,
      `Call-ID: ping-${port}-${Date.now()}-${i}@127.0.0.1`, `CSeq: ${i + 1} OPTIONS`, 'Content-Length: 0', '', ''].join('\r\n')
    sock.send(Buffer.from(msg), port, '127.0.0.1')
    await sleep(200)
  }
  sock.close()
  return got
}

// Частка «гучних» 20-мс кадрів у записі WAV (PCM16) → секунди звуку
function wavActiveSeconds(file) {
  const b = fs.readFileSync(file)
  let off = 12
  let rate = 8000
  let dataOff = -1
  let dataLen = 0
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const len = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') { dataOff = off + 8; dataLen = len && off + 8 + len <= b.length ? len : b.length - off - 8; break }
    off += 8 + len + (len & 1)
  }
  if (dataOff < 0) return { active: 0, total: 0 }
  const n = Math.floor(dataLen / 2)
  const frame = Math.round(rate * 0.02)
  let active = 0
  for (let i = 0; i + frame <= n; i += frame) {
    let sum = 0
    for (let k = 0; k < frame; k++) { const v = b.readInt16LE(dataOff + 2 * (i + k)); sum += v * v }
    if (Math.sqrt(sum / frame) > 300) active++
  }
  return { active: active * 0.02, total: n / rate }
}

// ---------- сирий SIP через UDP ----------
function udpEndpoint(port, bindHost = '127.0.0.1') {
  const sock = dgram.createSocket('udp4')
  const msgs = []
  const waiters = new Set()
  let onMsg = null
  sock.on('message', (buf, rinfo) => {
    const s = buf.toString('utf8')
    if (!s.trim()) return // CRLF keep-alive
    msgs.push({ s, rinfo })
    if (onMsg) onMsg(s, rinfo)
    for (const w of [...waiters]) w()
  })
  const ready = new Promise((r) => sock.bind(port, bindHost, r))
  return {
    ready, msgs,
    get port() { return sock.address().port },
    set handler(fn) { onMsg = fn },
    send(text, toPort, toHost = '127.0.0.1') { sock.send(Buffer.from(text), toPort, toHost) },
    wait(pred, ms, label) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = msgs.find((x) => !x.used && pred(x.s))
          if (!m) return false
          m.used = true
          clearTimeout(timer)
          waiters.delete(check)
          resolve(m)
          return true
        }
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`тайм-аут ${ms} мс: ${label}`)) }, ms)
        if (!check()) waiters.add(check)
      })
    },
    close() { sock.close() },
  }
}

const hdr = (msg, name) => {
  const re = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'im')
  const m = msg.match(re)
  return m ? m[1].trim() : null
}
const allHdrs = (msg, name) => msg.split(/\r?\n/).filter((l) => new RegExp(`^${name}\\s*:`, 'i').test(l))
const firstLine = (msg) => msg.split(/\r?\n/)[0]

function sipResponse(req, code, reason, extra = [], rinfo = null) {
  const vias = allHdrs(req, 'Via').map((v, i) => {
    if (i || !rinfo) return v
    return v.replace(/;rport(?=;|$)/, `;rport=${rinfo.port};received=${rinfo.address}`)
  })
  let to = hdr(req, 'To')
  if (!/;tag=/.test(to)) to += `;tag=fake${crypto.randomBytes(3).toString('hex')}`
  return [`SIP/2.0 ${code} ${reason}`, ...vias, `From: ${hdr(req, 'From')}`, `To: ${to}`,
    `Call-ID: ${hdr(req, 'Call-ID')}`, `CSeq: ${hdr(req, 'CSeq')}`, ...extra, 'Content-Length: 0', '', ''].join('\r\n')
}

// ---------- прогін ----------
const results = []
async function step(name, fn) {
  say(`=== ${name}`)
  try {
    await fn()
    results.push({ name, ok: true })
    say(`PASS ${name}`)
  } catch (e) {
    results.push({ name, ok: false, msg: e.message })
    say(`FAIL ${name}: ${e.message}`)
  } finally {
    await quitPeers()
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const GW = 'sip:gw@127.0.0.1:5092'
let eng
let peers = []
async function quitPeers() { await Promise.all(peers.map((p) => p.quit())); peers = [] }

await step('0. старт рушія, локальний режим, помилки на невідомі виклики', async () => {
  eng = startEngine('engine-local')
  const ready = await eng.wait((e) => e.ev === 'ready', 3000, 'ready')
  assert(ready.record === true, `ready без record: ${JSON.stringify(ready)}`)
  assert(ready.dtmf === true, `ready без dtmf: ${JSON.stringify(ready)}`)
  eng.send({ cmd: 'local', bind: '127.0.0.1', port: 5092, user: 'gw' })
  const reg = await eng.wait((e) => e.ev === 'reg', 3000, 'reg (local)')
  assert(reg.active === true && reg.code === 200, 'local: reg.active')
  eng.send({ cmd: 'play', call: 999, file: GREETING, loop: false, tag: 'x' })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'play' && e.call === 999, 2000, 'error на невідомий виклик')
  eng.send({ cmd: 'xfer_replaces', call: 998, dest: 997 })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'xfer_replaces', 2000, 'error xfer_replaces')
  eng.sendRaw('це не json')
  await eng.wait((e) => e.ev === 'error' && e.cmd === null && /json/.test(e.msg), 2000, 'error bad json')
  eng.send({ cmd: 'dial', ref: 'bad-1', uri: 'not a sip uri' })
  const de = await eng.wait((e) => e.ev === 'error' && e.cmd === 'dial', 2000, 'error dial')
  assert(de.ref === 'bad-1' && de.call === null, `error dial: ${JSON.stringify(de)}`)
  assert(!eng.seen((e) => e.ev === 'dialing' && e.ref === 'bad-1'), 'dialing для невдалого набору не очікується')
})

await step('1a. сирий INVITE: X-BINOTEL-GCID (інший регістр), ім\'я, номер, відмова 486', async () => {
  const u = udpEndpoint(5095)
  await u.ready
  const callId = `smoke-${Date.now()}@127.0.0.1`
  const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 'c=IN IP4 127.0.0.1', 't=0 0',
    'm=audio 5098 RTP/AVP 8 101', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n')
  const via = 'Via: SIP/2.0/UDP 127.0.0.1:5095;branch=z9hG4bK-smoke-1;rport'
  const from = 'From: "RUN Call Petro" <sip:0500000001@127.0.0.1:5095>;tag=smk1'
  u.send([`INVITE ${GW} SIP/2.0`, via, 'Max-Forwards: 70', from, `To: <${GW}>`, `Call-ID: ${callId}`,
    'CSeq: 1 INVITE', 'Contact: <sip:0500000001@127.0.0.1:5095>', 'X-Binotel-Gcid: 6929148313',
    'X-BINOTEL-SET-CALLER-ID: 0443338049', 'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp].join('\r\n'), 5092)
  const inc = await eng.wait((e) => e.ev === 'incoming', 3000, 'incoming')
  assert(inc.gcid === '6929148313', `gcid=${inc.gcid}`)
  assert(inc.number === '0500000001', `number=${inc.number}`)
  assert(inc.name === 'RUN Call Petro', `name=${inc.name}`)
  assert(inc.from === 'sip:0500000001@127.0.0.1:5095', `from=${inc.from}`)
  assert(inc.set_caller_id === '0443338049', `set_caller_id=${inc.set_caller_id}`)
  eng.send({ cmd: 'hangup', call: inc.call, code: 486 })
  const resp = await u.wait((s) => /^SIP\/2\.0 486/.test(s), 3000, '486 у відповідь')
  const to = hdr(resp.s, 'To')
  u.send([`ACK ${GW} SIP/2.0`, via, 'Max-Forwards: 70', from, `To: ${to}`, `Call-ID: ${callId}`, 'CSeq: 1 ACK', 'Content-Length: 0', '', ''].join('\r\n'), 5092)
  const st = await eng.wait((e) => e.ev === 'state' && e.call === inc.call && e.state === 'DISCONNECTED', 3000, 'DISCONNECTED')
  assert(st.code === 486, `code=${st.code}`)
  say(`  сирий клієнт отримав: ${u.msgs.map((m) => firstLine(m.s)).join(' | ')}`)
  u.close()
})

await step('1. P1 дзвонить на шлюз → incoming → answer → привітання → media, play_done', async () => {
  const p1 = await startPeer('s1-p1', 5091, 6000, { id: '"RUN Call Test" <sip:0500000001@127.0.0.1:5091>' })
  peers.push(p1)
  p1.cmd('m')
  p1.cmd(GW)
  const inc = await eng.wait((e) => e.ev === 'incoming', 5000, 'incoming від P1')
  assert(inc.gcid === null, 'gcid має бути null')
  assert(inc.number === '0500000001', `number=${inc.number}`)
  eng.send({ cmd: 'answer', call: inc.call, code: 200 })
  eng.send({ cmd: 'play', call: inc.call, file: GREETING, loop: false, tag: 'greeting' }) // ще до media — має стартувати пізніше
  await eng.wait((e) => e.ev === 'state' && e.call === inc.call && e.state === 'CONFIRMED', 5000, 'CONFIRMED')
  await eng.wait((e) => e.ev === 'media' && e.call === inc.call && e.active, 5000, 'media')
  const tMedia = Date.now()
  await eng.wait((e) => e.ev === 'play_done' && e.call === inc.call && e.tag === 'greeting', 12000, 'play_done greeting')
  const dur = (Date.now() - tMedia) / 1000
  say(`  привітання тривало ${dur.toFixed(2)} с (файл 4.84 с)`)
  assert(dur > 3.5 && dur < 7.5, `тривалість ${dur}`)
  eng.send({ cmd: 'hangup', call: inc.call })
  await eng.wait((e) => e.ev === 'state' && e.call === inc.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED')
  await quitPeers()
  const a = wavActiveSeconds(p1.recPath)
  say(`  P1 записав ${a.total.toFixed(1)} с, із них звуку ${a.active.toFixed(2)} с`)
  assert(a.active >= 2, 'P1 не почув привітання')
  // pjsua пропонує PCMU раніше за PCMA — рушій має відповісти своїм порядком (PCMA)
  const offer = (p1.log().match(/^m=audio \d+ RTP\/AVP [\d ]+$/m) || [''])[0]
  const codec = (p1.log().match(/stream #0: ([A-Za-z0-9]+)/) || [])[1]
  say(`  пропозиція P1: ${offer} → кодек ${codec}`)
  assert(codec === 'PCMA', `кодек ${codec}`)
})

await step('2. рушій дзвонить P1 → CONFIRMED → утримання по колу → заміна привітанням → hangup', async () => {
  const p1 = await startPeer('s2-p1', 5091, 6000)
  peers.push(p1)
  // user-частина — номер телефону (як клієнт на передзвоні): у рядку рушія «dialing» — лише останні 4 цифри
  eng.send({ cmd: 'dial', ref: 'out-1', uri: 'sip:0501234567@127.0.0.1:5091;transport=udp' })
  const d = await eng.wait((e) => e.ev === 'dialing' && e.ref === 'out-1', 3000, 'dialing')
  {
    let log = ''
    for (let i = 0; i < 10 && !/dialing sip:/.test(log); i++) { await sleep(100); log = fs.readFileSync(eng.errLogPath, 'utf8') }
    const own = log.split('\n').filter((l) => l.includes('[engine]'))
    const line = own.find((l) => /call \d+: dialing /.test(l)) || ''
    say(`  лог рушія: ${line.trim()}`)
    assert(/dialing sip:…4567@127\.0\.0\.1:5091;transport=udp \(ref out-1\)/.test(line), `рядок dialing: ${line}`)
    assert(!own.some((l) => l.includes('0501234567')), 'повний номер у рядках [engine]')
  }
  const firstForCall = eng.events.find((e) => e.call === d.call)
  assert(firstForCall === d, 'першою подією виклику має бути dialing')
  await eng.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'CONFIRMED', 5000, 'CONFIRMED')
  await eng.wait((e) => e.ev === 'media' && e.call === d.call && e.active, 5000, 'media')
  eng.send({ cmd: 'play', call: d.call, file: HOLD, loop: true, tag: 'hold' })
  await sleep(1500)
  eng.send({ cmd: 'play', call: d.call, file: GREETING, loop: false, tag: 'greeting' })
  await eng.wait((e) => e.ev === 'play_done' && e.call === d.call && e.tag === 'greeting', 10000, 'play_done greeting')
  assert(!eng.seen((e) => e.ev === 'play_done' && e.tag === 'hold'), 'play_done для hold (loop) не очікується')
  eng.send({ cmd: 'stop', call: d.call })
  eng.send({ cmd: 'hangup', call: d.call })
  const st = await eng.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED')
  say(`  DISCONNECTED code=${st.code} ${st.reason}`)
  eng.send({ cmd: 'play', call: d.call, file: GREETING })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'play' && e.call === d.call, 2000, 'error на завершений виклик')
  await quitPeers()
  const a = wavActiveSeconds(p1.recPath)
  say(`  P1 записав ${a.total.toFixed(1)} с, із них звуку ${a.active.toFixed(2)} с`)
  assert(a.active >= 3, 'P1 не почув утримання + привітання')
  const codec = (p1.log().match(/stream #0: ([A-Za-z0-9]+)/) || [])[1]
  say(`  кодек: ${codec}`)
  assert(codec === 'PCMA', `кодек ${codec}`)
})

await step('3. сліпе переведення (REFER) виклику P1 → sip:x@127.0.0.1:5093 (P2)', async () => {
  const p1 = await startPeer('s3-p1', 5091, 6000)
  const p2 = await startPeer('s3-p2', 5093, 7000)
  peers.push(p1, p2)
  p1.cmd('m')
  p1.cmd(GW)
  const inc = await eng.wait((e) => e.ev === 'incoming', 5000, 'incoming від P1')
  eng.send({ cmd: 'answer', call: inc.call })
  await eng.wait((e) => e.ev === 'media' && e.call === inc.call && e.active, 5000, 'media')
  eng.send({ cmd: 'xfer', call: inc.call, uri: 'sip:x@127.0.0.1:5093;transport=udp' })
  const fin = await eng.wait((e) => e.ev === 'xfer' && e.call === inc.call && e.final, 8000, 'фінальний xfer')
  const all = eng.events.filter((e) => e.ev === 'xfer' && e.call === inc.call)
  say(`  xfer-події: ${all.map((e) => `${e.code}${e.final ? '(final)' : ''}`).join(', ')}`)
  assert(fin.code >= 200 && fin.code < 300, `фінальний код ${fin.code}`)
  await eng.wait((e) => e.ev === 'state' && e.call === inc.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED після переведення')
  await sleep(500)
  await quitPeers() // журнали pjsua дописуються при виході
  const inv = p2.log().split('\n').filter((l) => /^INVITE sip:x@127\.0\.0\.1:5093/.test(l.trim()))
  assert(inv.length > 0, 'P2 не отримав INVITE від P1 після REFER')
  assert(/state changed to CONFIRMED/.test(p2.log()), 'виклик P1→P2 не дійшов до CONFIRMED')
  say(`  P2 отримав від P1: ${inv[0].trim()} → CONFIRMED`)
})

await step('4. супроводжуване переведення xfer_replaces: клієнт P1 (A) ↔ менеджер P2 (B)', async () => {
  const p1 = await startPeer('s4-p1', 5091, 6000)
  const p2 = await startPeer('s4-p2', 5093, 7000)
  peers.push(p1, p2)
  p1.cmd('m')
  p1.cmd(GW)
  const A = (await eng.wait((e) => e.ev === 'incoming', 5000, 'incoming A')).call
  eng.send({ cmd: 'answer', call: A })
  eng.send({ cmd: 'play', call: A, file: HOLD, loop: true, tag: 'hold' })
  eng.send({ cmd: 'dial', ref: 'mgr-1', uri: 'sip:mgr@127.0.0.1:5093;transport=udp' })
  const B = (await eng.wait((e) => e.ev === 'dialing' && e.ref === 'mgr-1', 3000, 'dialing B')).call
  await eng.wait((e) => e.ev === 'state' && e.call === B && e.state === 'CONFIRMED', 5000, 'B CONFIRMED')
  await eng.wait((e) => e.ev === 'media' && e.call === B && e.active, 5000, 'B media')
  eng.send({ cmd: 'play', call: B, file: GREETING, loop: false, tag: 'card' })
  await eng.wait((e) => e.ev === 'play_done' && e.call === B && e.tag === 'card', 10000, 'картка на B')
  eng.send({ cmd: 'xfer_replaces', call: A, dest: B })
  const fin = await eng.wait((e) => e.ev === 'xfer' && e.call === A && e.final, 8000, 'фінальний xfer на A')
  const all = eng.events.filter((e) => e.ev === 'xfer' && e.call === A)
  say(`  xfer-події: ${all.map((e) => `${e.code}${e.final ? '(final)' : ''}`).join(', ')}`)
  assert(fin.code >= 200 && fin.code < 300, `фінальний код ${fin.code}`)
  await eng.wait((e) => e.ev === 'state' && e.call === B && e.state === 'DISCONNECTED', 5000, 'B DISCONNECTED')
  await eng.wait((e) => e.ev === 'state' && e.call === A && e.state === 'DISCONNECTED', 5000, 'A DISCONNECTED')
  await sleep(1500)
  await quitPeers() // журнали pjsua дописуються при виході
  const repl = p2.log().split('\n').filter((l) => /^Replaces:/i.test(l.trim()))
  say(`  P2 отримав INVITE з ${repl[0] ? repl[0].trim().slice(0, 70) + '…' : '— (немає Replaces)'}`)
  assert(repl.length > 0, 'P2 не отримав INVITE з Replaces')
  const a = wavActiveSeconds(p2.recPath)
  say(`  P2 записав ${a.total.toFixed(1)} с, із них звуку ${a.active.toFixed(2)} с (картка)`)
})

await step('5. локальний міст bridge A↔B: звук P2 доходить до P1 через шлюз', async () => {
  const p1 = await startPeer('s5-p1', 5091, 6000)
  const p2 = await startPeer('s5-p2', 5093, 7000, { autoPlay: HOLD })
  peers.push(p1, p2)
  p1.cmd('m')
  p1.cmd(GW)
  const A = (await eng.wait((e) => e.ev === 'incoming', 5000, 'incoming A')).call
  eng.send({ cmd: 'answer', call: A })
  await eng.wait((e) => e.ev === 'media' && e.call === A && e.active, 5000, 'A media')
  eng.send({ cmd: 'dial', ref: 'mgr-2', uri: 'sip:mgr@127.0.0.1:5093;transport=udp' })
  const B = (await eng.wait((e) => e.ev === 'dialing' && e.ref === 'mgr-2', 3000, 'dialing B')).call
  await eng.wait((e) => e.ev === 'media' && e.call === B && e.active, 5000, 'B media')
  eng.send({ cmd: 'bridge', a: A, b: B })
  await sleep(4000)
  eng.send({ cmd: 'hangup', call: A })
  eng.send({ cmd: 'hangup', call: B })
  await eng.wait((e) => e.ev === 'state' && e.call === A && e.state === 'DISCONNECTED', 5000, 'A DISCONNECTED')
  await eng.wait((e) => e.ev === 'state' && e.call === B && e.state === 'DISCONNECTED', 5000, 'B DISCONNECTED')
  await quitPeers()
  const a = wavActiveSeconds(p1.recPath)
  say(`  P1 записав ${a.total.toFixed(1)} с, із них звуку ${a.active.toFixed(2)} с (утримання від P2 через міст)`)
  assert(a.active >= 1.5, 'звук через міст не дійшов')
})

// Формат WAV із заголовка: {rate, channels, bits, dataLen} (dataLen — поле data-чанка)
function wavHeader(file) {
  const b = fs.readFileSync(file)
  let off = 12
  const h = { riff: b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' }
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const len = b.readUInt32LE(off + 4)
    if (id === 'fmt ') Object.assign(h, { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) })
    if (id === 'data') { h.dataLen = len; break }
    off += 8 + len + (len & 1)
  }
  return h
}

await step('5b. запис record/record_stop: голос P1 у WAV 0600 і record_done з тривалістю; відбій під час запису — record_done hangup', async () => {
  const recDir = path.join(WORK, 'rec')
  fs.mkdirSync(recDir, { recursive: true, mode: 0o700 })
  const p1 = await startPeer('s5b-p1', 5091, 6000, { autoPlay: HOLD }) // P1 безперервно «говорить» записом утримання
  peers.push(p1)
  eng.send({ cmd: 'record', call: 996, file: path.join(recDir, 'x.wav') })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'record' && e.call === 996, 2000, 'error record на невідомий виклик')
  eng.send({ cmd: 'dial', ref: 'rec-1', uri: 'sip:peer@127.0.0.1:5091;transport=udp' })
  const d = await eng.wait((e) => e.ev === 'dialing' && e.ref === 'rec-1', 3000, 'dialing')
  await eng.wait((e) => e.ev === 'media' && e.call === d.call && e.active, 5000, 'media')
  eng.send({ cmd: 'record', call: d.call, file: 'rel.wav' })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'record' && e.call === d.call && /absolute/.test(e.msg), 2000, 'error: відносний шлях')
  const f1 = path.join(recDir, 'vm-1.wav')
  eng.send({ cmd: 'record', call: d.call, file: f1 })
  eng.send({ cmd: 'record', call: d.call, file: path.join(recDir, 'vm-dup.wav') })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'record' && /already/.test(e.msg), 2000, 'error: запис уже йде')
  await sleep(2500)
  eng.send({ cmd: 'record_stop', call: d.call })
  const r1 = await eng.wait((e) => e.ev === 'record_done' && e.call === d.call, 4000, 'record_done після record_stop')
  say(`  record_done: ${JSON.stringify(r1)}`)
  assert(r1.file === f1 && r1.reason === 'stop' && r1.final === true, `record_done ${JSON.stringify(r1)}`)
  assert(r1.sec > 1.8 && r1.sec < 3.6, `тривалість ${r1.sec}`)
  const h1 = wavHeader(f1)
  assert(h1.riff && h1.format === 1 && h1.channels === 1 && h1.rate === 8000 && h1.bits === 16, `формат ${JSON.stringify(h1)}`)
  assert(Math.abs(h1.dataLen / 16000 - r1.sec) < 0.05, `заголовок ${h1.dataLen} Б ≠ ${r1.sec} с`)
  const mode = fs.statSync(f1).mode & 0o777
  assert(mode === 0o600, `права файлу ${mode.toString(8)}`)
  const a1 = wavActiveSeconds(f1)
  say(`  запис 1: ${a1.total.toFixed(2)} с, звуку ${a1.active.toFixed(2)} с, права ${mode.toString(8)}`)
  assert(a1.active >= 1.5, 'у записі немає голосу P1')
  eng.send({ cmd: 'record_stop', call: d.call })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'record_stop' && /not recording/.test(e.msg), 2000, 'error: запису немає')
  eng.send({ cmd: 'record', call: d.call, file: f1 })
  await eng.wait((e) => e.ev === 'error' && e.cmd === 'record' && /exists/.test(e.msg), 2000, 'error: файл уже є')
  assert(wavHeader(f1).dataLen === h1.dataLen, 'наявний запис перезаписано')
  // другий запис того ж виклику, і P1 кладе трубку посеред нього — рушій сам закриває файл
  const f2 = path.join(recDir, 'vm-2.wav')
  eng.send({ cmd: 'record', call: d.call, file: f2 })
  await sleep(1500)
  p1.cmd('h')
  await eng.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED')
  const r2 = await eng.wait((e) => e.ev === 'record_done' && e.call === d.call, 4000, 'record_done після відбою')
  say(`  record_done: ${JSON.stringify(r2)}`)
  assert(r2.file === f2 && r2.reason === 'hangup' && r2.final === true, `record_done ${JSON.stringify(r2)}`)
  assert(r2.sec > 0.8 && r2.sec < 2.6, `тривалість ${r2.sec}`)
  const iDown = eng.events.findIndex((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED')
  assert(iDown >= 0 && iDown < eng.events.indexOf(r2), 'record_done має йти після DISCONNECTED')
  const a2 = wavActiveSeconds(f2)
  say(`  запис 2: ${a2.total.toFixed(2)} с, звуку ${a2.active.toFixed(2)} с`)
  assert(a2.active >= 0.8, 'у другому записі немає голосу P1')
})

await step('5c. DTMF від pjsua: RFC 2833 (консоль «#») і SIP INFO («*») → одна подія dtmf на натискання', async () => {
  const p1 = await startPeer('s5c-p1', 5091, 6000)
  peers.push(p1)
  eng.send({ cmd: 'dial', ref: 'dtmf-1', uri: 'sip:mgr@127.0.0.1:5091;transport=udp' })
  const d = await eng.wait((e) => e.ev === 'dialing' && e.ref === 'dtmf-1', 3000, 'dialing')
  await eng.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'CONFIRMED', 5000, 'CONFIRMED')
  await eng.wait((e) => e.ev === 'media' && e.call === d.call && e.active, 5000, 'media')
  await sleep(300)
  // RFC 2833: консоль pjsua «#» питає рядок цифр — менеджер натискає 1
  p1.cmd('#')
  p1.cmd('1')
  const e1 = await eng.wait((e) => e.ev === 'dtmf' && e.call === d.call, 4000, 'dtmf (RFC 2833)')
  say(`  RFC 2833: ${JSON.stringify(e1)}`)
  assert(e1.digit === '1' && e1.method === 'rfc2833', `dtmf ${JSON.stringify(e1)}`)
  await sleep(1200) // кінець події, оновлення тривалості — не нові натискання
  assert(eng.events.filter((e) => e.ev === 'dtmf' && e.call === d.call).length === 1, 'одне натискання → одна подія dtmf')
  // SIP INFO (application/dtmf-relay): консоль «*» — менеджер натискає 2
  p1.cmd('*')
  p1.cmd('2')
  const e2 = await eng.wait((e) => e.ev === 'dtmf' && e.call === d.call && e.digit === '2', 4000, 'dtmf (SIP INFO)')
  say(`  SIP INFO: ${JSON.stringify(e2)}`)
  assert(e2.method === 'info', `dtmf ${JSON.stringify(e2)}`)
  await sleep(800)
  assert(eng.events.filter((e) => e.ev === 'dtmf' && e.call === d.call).length === 2, 'SIP INFO: одна подія на натискання')
  // два натискання поспіль «11» — дві події
  p1.cmd('#')
  p1.cmd('11')
  await eng.wait((e) => e.ev === 'dtmf' && e.call === d.call && e.digit === '1', 4000, 'перша «1» з двох')
  await eng.wait((e) => e.ev === 'dtmf' && e.call === d.call && e.digit === '1', 4000, 'друга «1» з двох')
  eng.send({ cmd: 'hangup', call: d.call })
  await eng.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED')
  let log = ''
  for (let i = 0; i < 10 && !(/dtmf via rfc2833/.test(log) && /dtmf via info/.test(log)); i++) { await sleep(100); log = fs.readFileSync(eng.errLogPath, 'utf8') }
  assert(/dtmf via rfc2833/.test(log) && /dtmf via info/.test(log), 'у лозі рушія — метод DTMF')
})

await step('6. quit: рушій виходить з кодом 0, stdout — лише JSON', async () => {
  eng.send({ cmd: 'quit' })
  const r = await Promise.race([eng.exited, sleep(8000).then(() => null)])
  assert(r, 'рушій не вийшов за 8 с')
  say(`  вихід: code=${r.code} signal=${r.signal}`)
  assert(r.code === 0, `код виходу ${r.code}`)
  assert(eng.garbage.length === 0, `сміття у stdout: ${eng.garbage.length}`)
})

await step('7. register через фальшивий реєстратор 127.0.0.1:5096: digest, 503 на dial, зняття реєстрації, пароль не в логах', async () => {
  const fake = udpEndpoint(5096)
  await fake.ready
  const realm = 'binotel-test'
  const nonce = crypto.randomBytes(8).toString('hex')
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
  const seen = { challenged: 0, authOk: 0, authBad: 0, unregister: 0, invite: null }
  fake.handler = (s, rinfo) => {
    const method = firstLine(s).split(' ')[0]
    if (/^SIP\//.test(method)) return
    if (method === 'REGISTER') {
      const auth = hdr(s, 'Authorization')
      if (!auth) {
        seen.challenged++
        fake.send(sipResponse(s, 401, 'Unauthorized', [`WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}", algorithm=MD5`], rinfo), rinfo.port, rinfo.address)
        return
      }
      const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]))
      const ha1 = md5(`${p.username}:${realm}:${TEST_PW}`)
      const ha2 = md5(`REGISTER:${p.uri}`)
      const good = p.username === '901' && p.response === md5(`${ha1}:${p.nonce}:${ha2}`)
      if (!good) { seen.authBad++; fake.send(sipResponse(s, 403, 'Forbidden', [], rinfo), rinfo.port, rinfo.address); return }
      seen.authOk++
      const exp = hdr(s, 'Expires') ?? ((hdr(s, 'Contact') || '').match(/expires=(\d+)/) || [])[1] ?? '120'
      if (String(exp) === '0') seen.unregister++
      fake.send(sipResponse(s, 200, 'OK', [`Contact: ${hdr(s, 'Contact')};expires=${exp}`, `Expires: ${exp}`], rinfo), rinfo.port, rinfo.address)
      return
    }
    if (method === 'INVITE') {
      seen.invite = s
      fake.send(sipResponse(s, 503, 'Service Unavailable', [], rinfo), rinfo.port, rinfo.address)
      return
    }
    if (method === 'ACK') return
    fake.send(sipResponse(s, 200, 'OK', [], rinfo), rinfo.port, rinfo.address)
  }
  const e2 = startEngine('engine-register')
  await e2.wait((e) => e.ev === 'ready', 3000, 'ready')
  e2.send({ cmd: 'register', server: '127.0.0.1:5096', user: '901', password: TEST_PW, expires: 120 })
  const reg = await e2.wait((e) => e.ev === 'reg' && e.active, 6000, 'reg active')
  assert(reg.code === 200, `reg code ${reg.code}`)
  assert(seen.challenged >= 1 && seen.authOk >= 1 && seen.authBad === 0, `digest: ${JSON.stringify(seen)}`)
  const regReq = fake.msgs.find((m) => /^REGISTER /.test(m.s)).s
  say(`  ${firstLine(regReq)} | ${hdr(regReq, 'Contact')}`)
  assert(firstLine(regReq).startsWith('REGISTER sip:127.0.0.1:5096;transport=udp '), 'Request-URI REGISTER')
  e2.send({ cmd: 'dial', ref: 'mgr-503', uri: 'sip:907@127.0.0.1:5096;transport=udp' })
  const d = await e2.wait((e) => e.ev === 'dialing' && e.ref === 'mgr-503', 3000, 'dialing')
  const st = await e2.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED 503')
  assert(st.code === 503, `code ${st.code}`)
  assert(seen.invite, 'INVITE не дійшов до проксі')
  say(`  ${firstLine(seen.invite)} | Route: ${hdr(seen.invite, 'Route')}`)
  assert(/^INVITE sip:907@127\.0\.0\.1:5096;transport=udp /.test(firstLine(seen.invite)), 'Request-URI INVITE')
  assert(/<sip:127\.0\.0\.1:5096;transport=udp;lr>/.test(hdr(seen.invite, 'Route') || ''), 'Route outbound proxy')
  assert(/PCMA/.test(seen.invite) && !/ speex| G722| opus/i.test(seen.invite.split('m=audio')[1] || ''), 'SDP: лише PCMA/PCMU')
  say(`  SDP m=: ${(seen.invite.match(/^m=audio.*$/m) || [''])[0]}`)
  e2.send({ cmd: 'quit' })
  await e2.wait((e) => e.ev === 'reg' && e.active === false, 5000, 'reg inactive (зняття)')
  const r = await Promise.race([e2.exited, sleep(8000).then(() => null)])
  assert(r && r.code === 0, `вихід ${JSON.stringify(r)}`)
  assert(seen.unregister >= 1, 'не було REGISTER з expires=0')
  await sleep(200)
  const errLog = fs.readFileSync(e2.errLogPath, 'utf8')
  assert(!errLog.includes(TEST_PW), 'ПАРОЛЬ у stderr рушія!')
  assert(!e2.raw.join('\n').includes(TEST_PW), 'ПАРОЛЬ у stdout рушія!')
  assert(fake.msgs.every((m) => !m.s.includes(TEST_PW)), 'ПАРОЛЬ відкритим текстом у SIP!')
  say('  пароль не знайдено ні в stderr, ні в stdout, ні в SIP-пакетах')
  fake.close()
})

// Сирий INVITE на рушій з udp-ендпоінта u (з його адреси) на host:port
function rawInvite(u, host, toPort, tag) {
  const callId = `smoke-src-${tag}-${Date.now()}@x`
  const lh = u.host
  const sdp = ['v=0', `o=- 1 1 IN IP4 ${lh}`, 's=-', `c=IN IP4 ${lh}`, 't=0 0', 'm=audio 5098 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000', ''].join('\r\n')
  const via = `Via: SIP/2.0/UDP ${lh}:${u.port};branch=z9hG4bK-src-${tag};rport`
  const from = `From: "friendly-scanner" <sip:100@${lh}:${u.port}>;tag=src${tag}`
  const ruri = `sip:901@${host}:${toPort}`
  u.send([`INVITE ${ruri} SIP/2.0`, via, 'Max-Forwards: 70', from, `To: <${ruri}>`, `Call-ID: ${callId}`, 'CSeq: 1 INVITE',
    `Contact: <sip:100@${lh}:${u.port}>`, 'Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp].join('\r\n'), toPort, host)
  return { ack: (resp) => u.send([`ACK ${ruri} SIP/2.0`, via, 'Max-Forwards: 70', from, `To: ${hdr(resp, 'To')}`, `Call-ID: ${callId}`, 'CSeq: 1 ACK', 'Content-Length: 0', '', ''].join('\r\n'), toPort, host) }
}

await step('7b. реальний режим: INVITE лише з адреси реєстратора (DNS/200 на REGISTER) або з trust; чужим — 403 без incoming', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
  const fake = udpEndpoint(5096)
  await fake.ready
  fake.handler = (s, rinfo) => {
    const method = firstLine(s).split(' ')[0]
    if (/^SIP\//.test(method) || method === 'ACK') return
    const extra = method === 'REGISTER' ? [`Contact: ${hdr(s, 'Contact')};expires=120`, 'Expires: 120'] : []
    fake.send(sipResponse(s, 200, 'OK', extra, rinfo), rinfo.port, rinfo.address)
  }
  const run = async (name, trust) => {
    const e = startEngine(name)
    await e.wait((x) => x.ev === 'ready', 3000, 'ready')
    fake.msgs.length = 0
    e.send({ cmd: 'register', server: '127.0.0.1:5096', user: '901', password: TEST_PW, expires: 120, ...(trust ? { trust } : {}) })
    await e.wait((x) => x.ev === 'reg' && x.active, 6000, 'reg active')
    const port = fake.msgs.find((m) => /^REGISTER /.test(m.s)).rinfo.port
    return { e, port }
  }
  // 1) без trust: петля (адреса реєстратора) — так, LAN-адреса цієї машини — 403
  const { e, port } = await run('engine-src', null)
  const lo = udpEndpoint(5095)
  await lo.ready
  lo.host = '127.0.0.1'
  const inv1 = rawInvite(lo, '127.0.0.1', port, 'lo')
  const inc = await e.wait((x) => x.ev === 'incoming', 3000, 'incoming з адреси реєстратора')
  assert(inc.src === '127.0.0.1:5095', `src=${inc.src}`)
  e.send({ cmd: 'hangup', call: inc.call, code: 486 })
  inv1.ack((await lo.wait((x) => /^SIP\/2\.0 486/.test(x), 3000, '486')).s)
  if (lan) {
    const far = udpEndpoint(0, lan)
    await far.ready
    far.host = lan
    const inv2 = rawInvite(far, lan, port, 'lan')
    const r403 = await far.wait((x) => /^SIP\/2\.0 403/.test(x), 3000, '403 чужій адресі')
    inv2.ack(r403.s)
    const un = await e.wait((x) => x.ev === 'untrusted', 3000, 'подія untrusted')
    assert(un.src.startsWith(`${lan}:`), `untrusted src=${un.src}`)
    await sleep(500)
    assert(!e.seen((x) => x.ev === 'incoming' && x.src?.startsWith(lan)), 'incoming для чужої адреси не очікується')
    assert(!e.seen((x) => x.ev === 'state' && x.call !== inc.call), 'state для відхиленого рушієм виклику не очікується')
    far.close()
    say(`  ${lan} → 403, мозку лише {ev:"untrusted"}; 127.0.0.1 (реєстратор) → incoming`)
  } else say('  немає LAN-адреси IPv4 — перевірку чужої адреси пропущено')
  e.send({ cmd: 'quit' })
  await Promise.race([e.exited, sleep(8000)])
  // 2) trust = LAN-адреса: тепер її INVITE доходить до мозку
  if (lan) {
    const { e: e2, port: p2 } = await run('engine-src-trust', `${lan}, 192.0.2.7`)
    const far = udpEndpoint(0, lan)
    await far.ready
    far.host = lan
    const inv3 = rawInvite(far, lan, p2, 'trust')
    const inc2 = await e2.wait((x) => x.ev === 'incoming', 3000, 'incoming з адреси з trust')
    assert(inc2.src.startsWith(`${lan}:`), `src=${inc2.src}`)
    e2.send({ cmd: 'hangup', call: inc2.call, code: 486 })
    inv3.ack((await far.wait((x) => /^SIP\/2\.0 486/.test(x), 3000, '486')).s)
    e2.send({ cmd: 'quit' })
    await Promise.race([e2.exited, sleep(8000)])
    far.close()
    const log = fs.readFileSync(e2.errLogPath, 'utf8')
    assert(log.includes(`trusted source ${lan} (trust)`) && log.includes('trusted source 192.0.2.7 (trust)'), 'trust не потрапив у список')
  }
  lo.close()
  fake.close()
})

await step('8. кінець stdin і SIGTERM: рушій кладе виклики й виходить з кодом 0', async () => {
  const p1 = await startPeer('s8-p1', 5091, 6000)
  peers.push(p1)
  const e3 = startEngine('engine-eof')
  await e3.wait((e) => e.ev === 'ready', 3000, 'ready')
  e3.send({ cmd: 'local', bind: '127.0.0.1', port: 5092, user: 'gw' })
  await e3.wait((e) => e.ev === 'reg', 3000, 'reg')
  e3.send({ cmd: 'dial', ref: 'eof-1', uri: 'sip:peer@127.0.0.1:5091;transport=udp' })
  const d = await e3.wait((e) => e.ev === 'dialing', 3000, 'dialing')
  await e3.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'CONFIRMED', 5000, 'CONFIRMED')
  e3.child.stdin.end() // мозок «зник»
  await e3.wait((e) => e.ev === 'state' && e.call === d.call && e.state === 'DISCONNECTED', 5000, 'DISCONNECTED після EOF')
  const r = await Promise.race([e3.exited, sleep(8000).then(() => null)])
  assert(r && r.code === 0, `вихід після EOF: ${JSON.stringify(r)}`)
  const e4 = startEngine('engine-sigterm')
  await e4.wait((e) => e.ev === 'ready', 3000, 'ready')
  e4.child.kill('SIGTERM')
  const r4 = await Promise.race([e4.exited, sleep(8000).then(() => null)])
  assert(r4 && r4.code === 0, `вихід після SIGTERM: ${JSON.stringify(r4)}`)
  say(`  EOF → code=${r.code}; SIGTERM → code=${r4.code}`)
})

for (const f of fs.readdirSync(WORK).filter((x) => x.startsWith('engine-') && x.endsWith('.stderr.log'))) {
  const lines = fs.readFileSync(path.join(WORK, f), 'utf8').split('\n').filter((l) => /\) error: .*\(status=\d+\)|leaked|Assertion/i.test(l) && !/EINVALIDREQURI/.test(l))
  if (lines.length) say(`  ${f}: ${lines.length} рядк. з помилками pjsua2, напр.: ${lines[0].trim().slice(0, 140)}`)
}

const failed = results.filter((r) => !r.ok)
console.log('\n================ ПІДСУМОК ================')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.msg}`}`)
console.log(`Журнали: ${WORK}`)
console.log(failed.length ? `ПРОВАЛЕНО: ${failed.length} з ${results.length}` : `УСЕ ПРОЙШЛО: ${results.length} з ${results.length}`)
await quitPeers()
if (eng && eng.child.exitCode === null) eng.child.kill('SIGKILL')
process.exit(failed.length ? 1 : 0)
