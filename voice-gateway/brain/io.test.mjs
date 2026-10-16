// Модулі з I/O на підробках: синтез (fetch), Secret Manager, журнал, процес рушія (node-скрипт замість sip-engine).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeTts, wavFromPcm16, readWavInfo, isTelephonyWav, sha1, VOICE_SETTINGS } from './tts.mjs'
import { makeTokenSource, accessSecret } from './gcp.mjs'
import { makeJournal } from './journal.mjs'
import { startEngine, redact, redactEvent } from './engine.mjs'
import { makeDailyLog, pruneOld, pruneGatewayData, ensurePrivateDir } from './storage.mjs'
import { parseLineSecret, clean, makePrompter } from './gateway.mjs'
import { loadConfig, extUri } from './config.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const made = []
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-test-')); made.push(d); return d }
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const KEY = 'sk_test_never_printed'

function fakeFetch(responses) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null })
    const r = responses.shift()
    if (r instanceof Error) throw r
    const { status = 200, bytes = null, json = null } = r
    return {
      status,
      ok: status >= 200 && status < 300,
      arrayBuffer: async () => (bytes || Buffer.alloc(0)).buffer.slice((bytes || Buffer.alloc(0)).byteOffset, (bytes || Buffer.alloc(0)).byteOffset + (bytes || Buffer.alloc(0)).length),
      json: async () => { if (json == null) throw new Error('not json'); return json },
    }
  }
  fn.calls = calls
  return fn
}

test('wav: заголовок 8 кГц моно 16 біт; читання fmt серед інших чанків', () => {
  const wav = wavFromPcm16(Buffer.alloc(16001)) // непарна довжина — останній байт відкидаємо
  assert.equal(wav.length, 44 + 16000)
  const info = readWavInfo(wav)
  assert.deepEqual(info, { format: 1, channels: 1, rate: 8000, bits: 16 })
  assert.ok(isTelephonyWav(info))
  assert.equal(readWavInfo(Buffer.from('not a wav file at all')), null)
  // LIST перед fmt
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')])
  const shuffled = Buffer.concat([wav.subarray(0, 12), list, wav.subarray(12)])
  assert.equal(readWavInfo(shuffled).rate, 8000)
})

test('tts: запит ElevenLabs (голос, модель, uk, налаштування), WAV у кеші; вдруге — з кешу без мережі', async () => {
  const dir = tmpDir()
  const pcm = Buffer.alloc(8000 * 2, 1) // 1 с
  const f = fakeFetch([{ status: 200, bytes: pcm }])
  const tts = makeTts({ cacheDir: dir, getApiKey: async () => KEY, voiceId: 'zDLnIEu0UzYpFE8fq9aq', model: 'eleven_multilingual_v2', fetchImpl: f })
  const r = await tts('Дзвонить тест.')
  assert.equal(r.cached, false)
  assert.equal(path.basename(r.file), `card-${sha1('Дзвонить тест.')}.wav`)
  assert.ok(isTelephonyWav(readWavInfo(fs.readFileSync(r.file))))
  assert.equal(fs.statSync(r.file).size, 44 + pcm.length)
  const c = f.calls[0]
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/text-to-speech/zDLnIEu0UzYpFE8fq9aq?output_format=pcm_8000')
  assert.equal(c.init.method, 'POST')
  assert.equal(c.init.headers['xi-api-key'], KEY)
  assert.deepEqual(c.body, { text: 'Дзвонить тест.', model_id: 'eleven_multilingual_v2', voice_settings: VOICE_SETTINGS, language_code: 'uk' })
  assert.deepEqual(VOICE_SETTINGS, { stability: 0.55, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.0 })
  const again = await tts('Дзвонить тест.')
  assert.equal(again.cached, true)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), [])
})

test('tts: 422 → повтор без language_code; 401 — помилка без ключа в тексті; замало аудіо — помилка', async () => {
  const dir = tmpDir()
  const f = fakeFetch([{ status: 422, json: { detail: { status: 'invalid_language' } } }, { status: 200, bytes: Buffer.alloc(8000) }])
  const tts = makeTts({ cacheDir: dir, getApiKey: async () => KEY, voiceId: 'v', model: 'm', fetchImpl: f })
  await tts('Раз.')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].body.language_code, 'uk')
  assert.equal('language_code' in f.calls[1].body, false)

  const f2 = fakeFetch([{ status: 401, json: { detail: { status: 'invalid_api_key' } } }])
  const tts2 = makeTts({ cacheDir: dir, getApiKey: async () => KEY, voiceId: 'v', model: 'm', fetchImpl: f2 })
  await assert.rejects(tts2('Два.'), (e) => e.message === 'tts HTTP 401 invalid_api_key' && !e.message.includes(KEY))

  const f3 = fakeFetch([{ status: 200, bytes: Buffer.alloc(100) }])
  const tts3 = makeTts({ cacheDir: dir, getApiKey: async () => KEY, voiceId: 'v', model: 'm', fetchImpl: f3 })
  await assert.rejects(tts3('Три.'), /замало аудіо/)
  assert.equal(fs.existsSync(path.join(dir, `card-${sha1('Три.')}.wav`)), false)
})

test('gcp: токен із метаданих GCE, інакше gcloud; секрет base64 → рядок', async () => {
  const meta = fakeFetch([{ status: 200, json: { access_token: 'ya29.meta', expires_in: 3599 } }])
  const ts = makeTokenSource({ fetchImpl: meta, exec: async () => { throw new Error('must not call gcloud') } })
  assert.equal(await ts(), 'ya29.meta')
  assert.equal(await ts(), 'ya29.meta') // з кешу
  assert.equal(meta.calls.length, 1)
  assert.equal(meta.calls[0].init.headers['Metadata-Flavor'], 'Google')

  let execArgs = null
  const ts2 = makeTokenSource({ fetchImpl: fakeFetch([new Error('ENOTFOUND')]), exec: async (cmd, args) => { execArgs = [cmd, ...args]; return 'ya29.adc' } })
  assert.equal(await ts2(), 'ya29.adc')
  assert.deepEqual(execArgs, ['gcloud', 'auth', 'application-default', 'print-access-token'])

  const sm = fakeFetch([{ status: 200, json: { payload: { data: Buffer.from(JSON.stringify({ user: 'u', password: 'p' })).toString('base64') } } }])
  const v = await accessSecret({ project: 'droidmaps-runferry', name: 'elevenlabs-api-key', getAccessToken: async () => 'tok', fetchImpl: sm })
  assert.deepEqual(JSON.parse(v), { user: 'u', password: 'p' })
  assert.equal(sm.calls[0].url, 'https://secretmanager.googleapis.com/v1/projects/droidmaps-runferry/secrets/elevenlabs-api-key/versions/latest:access')
  assert.equal(sm.calls[0].init.headers.Authorization, 'Bearer tok')
  await assert.rejects(accessSecret({ project: 'p', name: 's', getAccessToken: async () => 't', fetchImpl: fakeFetch([{ status: 403 }]) }), /HTTP 403/)
})

test('journal: один JSON-рядок на дзвінок у calls-YYYY-MM-DD.jsonl (київська дата), секретні поля відкидаються', () => {
  const dir = tmpDir()
  const write = makeJournal({ dataDir: path.join(dir, 'data'), now: () => new Date('2026-10-16T22:30:00Z') }) // у Києві вже 17-те
  const file = write({ outcome: 'connected', number: '+380500000001', password: 'x', nested: { apiKey: 'k', ok: 1 } })
  write({ outcome: 'fallback' })
  assert.equal(path.basename(file), 'calls-2026-10-17.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { outcome: 'connected', number: '+380500000001', nested: { ok: 1 } })
})

test('engine: JSON-рядки в обидва боки, stderr лише у файл, пароль у трасі прихований, quit → вихід', async () => {
  const dir = tmpDir()
  const script = path.join(dir, 'fake-engine.mjs')
  fs.writeFileSync(script, `
    import { createInterface } from 'node:readline'
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    process.stderr.write('pjsua log line\\n')
    out({ ev: 'ready' })
    process.stdout.write('not json\\n')
    createInterface({ input: process.stdin }).on('line', (l) => {
      const c = JSON.parse(l)
      if (c.cmd === 'register') {
        out({ ev: 'reg', code: 200, reason: 'OK', active: true, user: c.user })
        out({ ev: 'incoming', call: 1, from: 'sip:0631234567@45.91.130.64', number: '0631234567', name: 'Петренко Іван', gcid: '6929148313', to: 'sip:901@x', set_caller_id: '0443338049', src: '45.91.130.64:5060' })
      }
      if (c.cmd === 'quit') process.exit(0)
    })
  `)
  const logFile = path.join(dir, 'logs', 'engine.log')
  const traceFile = path.join(dir, 'logs', 'brain.log')
  const eng = startEngine({ enginePath: process.execPath, args: [script], logFile, traceFile })
  const events = []
  const garbage = []
  eng.on('event', (e) => events.push(e))
  eng.on('garbage', (g) => garbage.push(g))
  await new Promise((r) => eng.once('event', r)) // ready
  eng.send({ cmd: 'register', server: 'sip14.binotel.com', user: '901', password: 'S3cret!', expires: 120 })
  await new Promise((r) => { const on = (e) => { if (e.ev === 'incoming') { eng.off('event', on); r() } }; eng.on('event', on) })
  eng.send({ cmd: 'quit' })
  const ex = await eng.waitExit(5000)
  assert.deepEqual(ex, { code: 0, signal: null })
  assert.equal(eng.send({ cmd: 'stop', call: 1 }), false) // після виходу — не пишемо
  eng.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(events.map((e) => e.ev), ['ready', 'reg', 'incoming'])
  assert.equal(events[2].name, 'Петренко Іван') // мозку — повністю
  assert.deepEqual(garbage, ['not json'])
  assert.match(fs.readFileSync(logFile, 'utf8'), /pjsua log line/)
  const trace = fs.readFileSync(traceFile, 'utf8')
  assert.match(trace, />> \{"cmd":"register".*"password":"<…>"/)
  assert.ok(!trace.includes('S3cret!'))
  // у трасі вхідний — без імені й URI, номер маскою
  assert.ok(!trace.includes('631234567') && !trace.includes('Петренко'))
  assert.match(trace, /<< \{"ev":"incoming","call":1,"gcid":"6929148313","to":"sip:901@x","set_caller_id":"0443338049","src":"45\.91\.130\.64:5060","number":"…4567"\}/)
  assert.deepEqual(redactEvent({ ev: 'state', call: 1 }), { ev: 'state', call: 1 })
  assert.equal((fs.statSync(traceFile).mode & 0o777), 0o600)
  assert.equal((fs.statSync(path.dirname(traceFile)).mode & 0o777), 0o700)
  assert.deepEqual(redact({ cmd: 'answer', call: 1 }), { cmd: 'answer', call: 1 })
})

test('lookup: запити спільного clientLookup, бюджет — null, помилка — null; firebase-admin знаходиться в server/', async () => {
  const { makeLookup } = await import('./lookup.mjs')
  const reads = []
  const db = (delayMs = 0, fail = false) => ({
    collection: (name) => ({
      doc: (id) => ({ get: async () => { reads.push(`${name}/${id}`); if (fail) throw new Error('PERMISSION_DENIED'); await new Promise((r) => setTimeout(r, delayMs)); return { exists: name === 'clientProfiles', data: () => ({ name: 'Тест' }) } } }),
      where: (f, op, v) => ({ limit: (n) => ({ get: async () => { reads.push(`${name}?${f} ${op} ${v.join('|')} limit ${n}`); await new Promise((r) => setTimeout(r, delayMs)); return { docs: [] } } }) }),
    }),
  })
  const logs = []
  const ok = makeLookup({ db: db(), budgetMs: 200, log: (m) => logs.push(m) })
  assert.deepEqual(await ok.lookup('+380500000001'), { requests: [], profile: { name: 'Тест' }, orders: [] })
  assert.ok(reads.includes('serviceRequests?clientPhone in +380500000001|380500000001|0500000001 limit 100'))
  assert.ok(reads.includes('clientProfiles/380500000001'))
  assert.ok(reads.includes('boatOrders?clientPhone in +380500000001|380500000001|0500000001 limit 10'))
  assert.equal(await ok.lookup(null), null)
  assert.equal(await makeLookup({ db: db(500), budgetMs: 50, log: (m) => logs.push(m) }).lookup('+380500000001'), null)
  assert.equal(await makeLookup({ db: db(0, true), budgetMs: 200, log: (m) => logs.push(m) }).lookup('+380500000001'), null)
  assert.ok(logs.some((m) => /50 мс/.test(m)) && logs.some((m) => /PERMISSION_DENIED/.test(m)))
  await ok.warm()
  assert.ok(reads.includes('system/binotelRouting'))
  const { createRequire } = await import('node:module')
  const req = createRequire(new URL('../../server/package.json', import.meta.url))
  assert.match(req.resolve('firebase-admin/app'), /server\/node_modules\/firebase-admin\//)
})

test('секрет лінії: JSON.parse не друкує вміст — повідомлення фіксовані, без пароля; типи перевіряються', () => {
  const PW = 'Pa55word-Xyz'
  for (const raw of [PW, `{"server":"sip14.binotel.com","user":"901","password":${PW}}`, '[1,2]', 'null', '{"user":"901"}', `{"user":"","password":"${PW}"}`, `{"user":"901","password":"${PW}","server":"evil host;x"}`]) {
    assert.throws(() => parseLineSecret(raw, 'sip14.binotel.com'), (e) => !e.message.includes(PW) && !e.message.includes('Pa55'), raw)
  }
  assert.deepEqual(parseLineSecret(`{"user":901,"password":"${PW}"}`, 'sip14.binotel.com'), { server: 'sip14.binotel.com', user: '901', password: PW })
  assert.deepEqual(parseLineSecret(`{"server":"sip15.binotel.com","user":"901","password":"${PW}"}`, 'sip14.binotel.com').server, 'sip15.binotel.com')
})

test('консоль: керівні символи з даних абонента не доходять до термінала, довжина обмежена', () => {
  const name = '\x1b]0;PWNED\x07\x1b[2J RUN \x1b[31m red\u202e\u0085'
  const c = clean(name)
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u202e]/.test(c))
  assert.equal(c, '?]0;PWNED??[2J RUN ?[31m red??')
  assert.equal(clean('x'.repeat(100), 10), `${'x'.repeat(10)}…`)
  assert.equal(clean('Петренко Іван'), 'Петренко Іван')
})

test('config: траса типово вимкнена; менеджер/запасна — як задано, URI будує gateway зі справжнім сервером', () => {
  const c = loadConfig({})
  assert.equal(c.trace, false)
  assert.equal(loadConfig({ VG_TRACE: '1' }).trace, true)
  assert.equal(c.manager, '907')
  assert.equal(c.fallback, '906')
  assert.deepEqual(c.allowedInternal, [])
  assert.equal(c.fallbackRingMs, 90000)
  assert.equal(c.bridgeMaxMin, 60)
  assert.deepEqual(c.retentionDays, { logs: 14, cache: 30, journal: 90 })
  const c2 = loadConfig({ VG_MANAGER: '905', VG_ALLOWED_INTERNAL: '907, 906', VG_SIP_TRUST: '45.91.130.64 1.2.3.4' })
  assert.equal(extUri(c2.manager, 'sip15.binotel.com'), 'sip:905@sip15.binotel.com;transport=udp')
  assert.deepEqual(c2.allowedInternal, ['907', '906'])
  assert.equal(c2.sipTrust, '45.91.130.64,1.2.3.4')
})

test('storage: денний лог переходить на новий файл з новою добою; файли 0600, теки 0700; старе прибирається', async () => {
  const dir = tmpDir()
  let t = new Date('2026-10-16T20:59:30Z') // у Києві 23:59:30
  const log = makeDailyLog({ dir: path.join(dir, 'logs'), prefix: 'engine', now: () => t })
  log.write('a\n')
  t = new Date('2026-10-16T21:00:10Z') // у Києві вже 17-те, але перевірка ще не настала (раз на хвилину)
  log.write('b\n')
  t = new Date('2026-10-16T21:00:40Z')
  log.write('c\n')
  await log.end()
  const logs = path.join(dir, 'logs')
  assert.equal(fs.readFileSync(path.join(logs, 'engine-2026-10-16.log'), 'utf8'), 'a\nb\n')
  assert.equal(fs.readFileSync(path.join(logs, 'engine-2026-10-17.log'), 'utf8'), 'c\n')
  assert.equal(fs.statSync(path.join(logs, 'engine-2026-10-17.log')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700)
  fs.chmodSync(logs, 0o755)
  ensurePrivateDir(logs)
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700)

  // прибирання: лише свої шаблони і лише старші за N діб
  const data = path.join(dir, 'data')
  const cache = path.join(dir, 'cache')
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  const old = (f, days) => { fs.writeFileSync(f, 'x'); const ts = (Date.now() - days * 86400000) / 1000; fs.utimesSync(f, ts, ts) }
  old(path.join(data, 'logs', 'engine-2026-09-01.log'), 20)
  old(path.join(data, 'logs', 'brain-2026-10-10.log'), 6)
  old(path.join(data, 'logs', 'notes.txt'), 400)
  old(path.join(cache, `card-${'a'.repeat(40)}.wav`), 31)
  old(path.join(cache, `card-${'b'.repeat(40)}.wav`), 2)
  old(path.join(data, 'calls-2026-06-01.jsonl'), 100)
  old(path.join(data, 'calls-2026-10-01.jsonl'), 15)
  const n = pruneGatewayData({ dataDir: data, cacheDir: cache, retentionDays: { logs: 14, cache: 30, journal: 90 } })
  assert.equal(n, 3)
  assert.deepEqual(fs.readdirSync(path.join(data, 'logs')).sort(), ['brain-2026-10-10.log', 'notes.txt'])
  assert.deepEqual(fs.readdirSync(cache), [`card-${'b'.repeat(40)}.wav`])
  assert.deepEqual(fs.readdirSync(data).filter((x) => x.endsWith('.jsonl')), ['calls-2026-10-01.jsonl'])
  assert.equal(pruneOld({ dir: path.join(dir, 'nope'), re: /x/, days: 1 }), 0)
  assert.equal(pruneOld({ dir: data, re: /./, days: 0 }), 0) // 0 — не прибирати
})

// Справжній термінал (pty через python3): вставлені разом «логін⏎пароль⏎» — пароль не з'являється на екрані.
const PY_PTY = `
import os, pty, sys, time, select
node, script, mode = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, script])
out = b''
def until(pred, timeout):
    global out
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return pred(out)
            if not chunk:
                return pred(out)
            out += chunk
            if pred(out):
                return True
    return pred(out)
until(lambda o: b'SERVER? ' in o, 10)
if mode == 'all':
    os.write(fd, b'sip14\\r901\\rTopSecretPW\\r')
else:
    os.write(fd, b'sip14\\r')
    until(lambda o: b'LOGIN? ' in o, 5)
    os.write(fd, b'901\\rTopSecretPW\\r')
until(lambda o: b'RESULT ' in o and o.rstrip().endswith(b'}'), 10)
until(lambda o: False, 0.3)
sys.stdout.write(out.decode('utf-8', 'replace'))
os.waitpid(pid, 0)
`
const hasPython = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0
test('пароль у терміналі: ні вставлений разом із логіном, ні набраний — не відлунює', { skip: !hasPython && 'немає python3' }, () => {
  const dir = tmpDir()
  const child = path.join(dir, 'prompt-child.mjs')
  const gw = new URL('./gateway.mjs', import.meta.url).href
  fs.writeFileSync(child, `
    import { makePrompter } from ${JSON.stringify(gw)}
    const pr = makePrompter()
    const server = await pr.ask('SERVER? ')
    const user = await pr.ask('LOGIN? ')
    const pw = await pr.ask('PASSWORD? ', { hidden: true })
    pr.close()
    process.stdout.write('RESULT ' + JSON.stringify({ server, user, pwOk: pw === 'TopSecretPW' }) + '\\n')
    process.exit(0)
  `)
  const py = path.join(dir, 'pty.py')
  fs.writeFileSync(py, PY_PTY)
  for (const mode of ['all', 'login']) {
    const r = spawnSync('python3', ['-I', py, process.execPath, child, mode], { encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /RESULT \{"server":"sip14","user":"901","pwOk":true\}/, `${mode}: ${r.stdout}`)
    assert.ok(!r.stdout.includes('TopSecretPW'), `${mode}: пароль на екрані: ${JSON.stringify(r.stdout)}`)
    assert.match(r.stdout, /PASSWORD\? /)
  }
})

// Шлюз цілком на підробленому рушії: логін з консолі (не TTY), сервер лінії інший за типовий, VG_MANAGER=905;
// рушій падає після першої реєстрації — шлюз сам перезапускає його і реєструється знову; SIGTERM — вихід 0.
test('gateway: менеджер з VG_MANAGER на сервері лінії; рушій упав — перезапуск і нова реєстрація; дані 0700', async () => {
  const dir = tmpDir()
  const cmdsLog = path.join(dir, 'cmds.jsonl')
  const runs = path.join(dir, 'runs')
  const fakeJs = path.join(dir, 'fake-engine.mjs')
  fs.writeFileSync(fakeJs, `
    import fs from 'node:fs'
    import { createInterface } from 'node:readline'
    const n = (fs.existsSync(${JSON.stringify(runs)}) ? Number(fs.readFileSync(${JSON.stringify(runs)}, 'utf8')) : 0) + 1
    fs.writeFileSync(${JSON.stringify(runs)}, String(n))
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    out({ ev: 'ready' })
    createInterface({ input: process.stdin }).on('line', (l) => {
      const c = JSON.parse(l)
      fs.appendFileSync(${JSON.stringify(cmdsLog)}, JSON.stringify({ run: n, cmd: c.cmd, server: c.server, user: c.user, pw: typeof c.password === 'string' && c.password.length > 0 }) + '\\n')
      if (c.cmd === 'register') {
        out({ ev: 'reg', code: 200, reason: 'OK', active: true, expires: 120 })
        if (n === 1) setTimeout(() => process.exit(1), 50) // «segfault»
      }
      if (c.cmd === 'quit') { out({ ev: 'reg', code: 200, reason: 'OK', active: false }); setTimeout(() => process.exit(0), 20) }
    })
  `)
  const fakeSh = path.join(dir, 'fake-engine.sh')
  fs.writeFileSync(fakeSh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeJs)}\n`)
  fs.chmodSync(fakeSh, 0o755)
  const wav = path.join(dir, 'p.wav')
  fs.writeFileSync(wav, wavFromPcm16(Buffer.alloc(1600)))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VG_|^BINOTEL_/.test(k))),
    VG_MANAGER: '905', VG_GREETING_WAV: wav, VG_HOLD_WAV: wav, VG_DATA_DIR: path.join(dir, 'data'), VG_CACHE_DIR: path.join(dir, 'cache'), VG_ENGINE_RESTART_MS: '200' }
  const gwPath = fileURLToPath(new URL('./gateway.mjs', import.meta.url))
  const gw = spawn(process.execPath, [gwPath, '--engine', fakeSh, '--no-tts', '--no-lookup'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  gw.stdout.on('data', (b) => { out += b })
  gw.stderr.on('data', (b) => { out += b })
  gw.stdin.write('sip15.binotel.com\n901\nS3cret-PW\n')
  const regs = () => (fs.existsSync(cmdsLog) ? fs.readFileSync(cmdsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.cmd === 'register') : [])
  const t0 = Date.now()
  while (regs().length < 2 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 200))
  gw.kill('SIGTERM')
  const code = await new Promise((r) => gw.on('exit', (c) => r(c)))
  assert.equal(code, 0, out)
  const rs = regs()
  assert.equal(rs.length, 2, out)
  assert.deepEqual(rs.map((r) => [r.run, r.server, r.user, r.pw]), [[1, 'sip15.binotel.com', '901', true], [2, 'sip15.binotel.com', '901', true]])
  assert.match(out, /менеджер sip:905@sip15\.binotel\.com;transport=udp; запасная sip:906@sip15\.binotel\.com;transport=udp/)
  assert.match(out, /движок завершился \(code 1\)/)
  assert.match(out, /перезапускаю движок/)
  assert.match(out, /шлюз остановлен/)
  assert.ok(!out.includes('S3cret-PW'), 'пароль у виводі шлюзу')
  assert.equal(fs.statSync(path.join(dir, 'data')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, 'data', 'logs')).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(path.join(dir, 'data', 'logs')) && fs.readdirSync(path.join(dir, 'data', 'logs')).some((f) => f.startsWith('brain-')), false) // траса типово вимкнена
  const engLog = fs.readdirSync(path.join(dir, 'data', 'logs')).find((f) => /^engine-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  assert.ok(engLog)
  assert.equal(fs.statSync(path.join(dir, 'data', 'logs', engLog)).mode & 0o777, 0o600)
  assert.equal((fs.readFileSync(path.join(dir, 'data', 'logs', engLog), 'utf8').match(/==== .* старт /g) || []).length, 2)
})
