// Модулі з I/O на підробках: синтез (fetch), Secret Manager, журнал, процес рушія (node-скрипт замість sip-engine).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeTts, wavFromPcm16, readWavInfo, isTelephonyWav, sha1, VOICE_SETTINGS, toneWav } from './tts.mjs'
import { makeTokenSource, accessSecret } from './gcp.mjs'
import { makeJournal } from './journal.mjs'
import { startEngine, redact, redactEvent } from './engine.mjs'
import { makeDailyLog, pruneOld, pruneGatewayData, ensurePrivateDir, makeVoicemailPath, ensureBeep, BEEP_NAME, repairWavHeader, repairVoicemailHeaders, findGitRoot } from './storage.mjs'
import { parseLineSecret, clean, makePrompter, summary, parseArgs } from './gateway.mjs'
import { loadConfig, extUri, isOff, defaultDataDir, GATEWAY_DIR, PROMPT_TEXTS, PROMPT_ENV } from './config.mjs'
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
  // номер у URI набору / сліпого переведення — 4 цифри; внутрішні лінії й імена — як є; цифри DTMF (PIN) — ні
  assert.deepEqual(redact({ cmd: 'dial', ref: 'cb-1-1', uri: 'sip:0501234567@sip14.binotel.com;transport=udp' }), { cmd: 'dial', ref: 'cb-1-1', uri: 'sip:…4567@sip14.binotel.com;transport=udp' })
  assert.deepEqual(redact({ cmd: 'xfer', call: 1, uri: 'sip:+380501234567@x' }), { cmd: 'xfer', call: 1, uri: 'sip:…4567@x' })
  assert.deepEqual(redact({ cmd: 'dial', ref: 'mgr-1-1', uri: 'sip:907@sip14.binotel.com;transport=udp' }).uri, 'sip:907@sip14.binotel.com;transport=udp')
  assert.deepEqual(redact({ cmd: 'dial', ref: 'fb-1-1', uri: 'sip:op@127.0.0.1:5094' }).uri, 'sip:op@127.0.0.1:5094')
  assert.deepEqual(redactEvent({ ev: 'dtmf', call: 2, digit: '7', method: 'rfc2833' }), { ev: 'dtmf', call: 2, digit: '<…>', method: 'rfc2833' })
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
  assert.deepEqual(c.retentionDays, { logs: 14, cache: 30, journal: 90, voicemail: 90 })
  const c2 = loadConfig({ VG_MANAGER: '905', VG_ALLOWED_INTERNAL: '907, 906', VG_SIP_TRUST: '45.91.130.64 1.2.3.4' })
  assert.equal(extUri(c2.manager, 'sip15.binotel.com'), 'sip:905@sip15.binotel.com;transport=udp')
  assert.deepEqual(c2.allowedInternal, ['907', '906'])
  assert.equal(c2.sipTrust, '45.91.130.64,1.2.3.4')
})

test('config: повтори у вікні 12 с через 2 с, запасна consult (blind — лише за VG_FALLBACK_MODE, none — без неї), пошта, VG_ENGINE_PATH', () => {
  const c = loadConfig({})
  assert.equal(c.dialRetryWindowSec, 12)
  assert.equal(c.dialRetryIntervalMs, 2000)
  assert.equal(c.dialRetries, null) // кількість не обмежена — лише вікно
  assert.equal(c.managerTimeoutSec, 25)
  assert.equal(c.fallbackTimeoutSec, 20)
  assert.equal(c.fallbackMode, 'consult')
  assert.equal(c.fallbackUri, 'sip:906@sip14.binotel.com;transport=udp')
  assert.equal(c.voicemailEnabled, true)
  assert.equal(c.voicemailMaxSec, 60)
  assert.equal(c.voicemailPromptFile, '/Users/yevhenyushchenko/Documents/GitHub/runferry-briefs/telephony/voice-prompts/wav-8k/mila/07-voicemail-no-answer-short.wav')
  assert.equal(c.beepFile, null)
  assert.equal(c.recordSupported, null)
  assert.equal(c.retentionDays.voicemail, 90)
  assert.match(c.enginePath, /voice-gateway\/engine\/sip-engine$/)
  assert.equal(loadConfig({ VG_ENGINE: '/x/old' }).enginePath, '/x/old') // стара назва працює
  assert.equal(loadConfig({ VG_ENGINE: '/x/old', VG_ENGINE_PATH: '/x/sip-engine-next' }).enginePath, '/x/sip-engine-next')
  assert.equal(loadConfig({ VG_DIAL_RETRY_DELAY_MS: '1500' }).dialRetryIntervalMs, 1500) // стара назва інтервалу
  assert.equal(loadConfig({ VG_DIAL_RETRY_DELAY_MS: '1500', VG_DIAL_RETRY_INTERVAL_MS: '2500' }).dialRetryIntervalMs, 2500)
  const c3 = loadConfig({ VG_DIAL_RETRIES: '3', VG_DIAL_RETRY_WINDOW_SEC: '8', VG_FALLBACK_TIMEOUT_SEC: '15', VG_FALLBACK_MODE: ' Blind ', VG_VOICEMAIL: '0', VG_VOICEMAIL_MAX_SEC: '30', VG_VOICEMAIL_WAV: '/w/vm.wav', VG_BEEP_WAV: '/w/beep.wav', VG_VOICEMAIL_DAYS: '0' })
  assert.deepEqual([c3.dialRetries, c3.dialRetryWindowSec, c3.fallbackTimeoutSec, c3.fallbackMode, c3.voicemailEnabled, c3.voicemailMaxSec, c3.voicemailPromptFile, c3.beepFile, c3.retentionDays.voicemail],
    [3, 8, 15, 'blind', false, 30, '/w/vm.wav', '/w/beep.wav', 0])
  assert.equal(loadConfig({ VG_FALLBACK_MODE: 'what' }).fallbackMode, 'consult')
  for (const v of ['none', 'OFF', '-', '0', 'no']) {
    const c4 = loadConfig({ VG_FALLBACK: v })
    assert.equal(c4.fallback, '', v)
    assert.equal(c4.fallbackUri, '', v)
  }
  assert.equal(isOff('906'), false)
  assert.equal(isOff(undefined), false)
})

test('config: типово «лінія зайнята» + передзвін, підтвердження «1» (10 с, повтор 1), менеджери з VG_MANAGERS + лінія менеджера, номер у картці не кажемо', () => {
  const c = loadConfig({})
  assert.equal(c.noAnswerMode, 'busy')
  assert.deepEqual([c.confirmEnabled, c.confirmTimeoutSec, c.confirmRepeats, c.confirmDigit, c.declineDigit, c.dtmfSupported], [true, 10, 1, '1', '2', null])
  assert.deepEqual(c.managers, [['907']])
  assert.deepEqual([c.callbackTtlHours, c.lastClientTtlDays, c.callbackDialTimeoutSec], [24, 30, 30])
  assert.equal(c.clientUriTemplate, 'sip:{national}@{server};transport=udp')
  assert.equal(c.cardSpeakNumber, false)
  assert.deepEqual(c.promptTexts, PROMPT_TEXTS)
  assert.equal(PROMPT_TEXTS.confirm, "Натисніть один, щоб з'єднатися з клієнтом, або два — якщо не можете говорити.")
  assert.equal(PROMPT_TEXTS.busy, 'На жаль, лінія менеджера зараз зайнята. Менеджер побачить ваш дзвінок і передзвонить вам.')
  assert.deepEqual(Object.values(c.promptFiles), [null, null, null, null, null, null, null])
  assert.equal(PROMPT_TEXTS.pin, 'Введіть пін-код.')
  // зовнішні номери менеджерів — лише з прапорцем і PIN; черга, ліміти, очікування лінії, пропущений, REFER
  assert.deepEqual([c.managersExternal, c.managerPin, c.managerPinInvalid, c.pinTimeoutSec], [false, null, false, 10])
  assert.deepEqual([c.callbackMaxAttempts, c.callbackMaxDialsPerDay, c.callbackLineWaitSec, c.callbackOnHangup, c.callbackReferOn], [3, 5, 15, true, 'manager'])
  const c3 = loadConfig({ VG_MANAGERS_EXTERNAL: '1', VG_MANAGER_PIN: ' 2468 ', VG_PIN_TIMEOUT_SEC: '7', VG_CALLBACK_MAX_ATTEMPTS: '0', VG_CALLBACK_MAX_DIALS_DAY: '2', VG_CALLBACK_LINE_WAIT_SEC: '5', VG_CALLBACK_ON_HANGUP: '0', VG_CALLBACK_REFER_ON: ' Client ', VG_PIN_WAV: '/w/pin.wav' })
  assert.deepEqual([c3.managersExternal, c3.managerPin, c3.pinTimeoutSec, c3.callbackMaxAttempts, c3.callbackMaxDialsPerDay, c3.callbackLineWaitSec, c3.callbackOnHangup, c3.callbackReferOn, c3.promptFiles.pin],
    [true, '2468', 7, 0, 2, 5, false, 'client', '/w/pin.wav'])
  for (const bad of ['12', '12345678901', 'abcd', '24 68']) {
    const cb = loadConfig({ VG_MANAGER_PIN: bad })
    assert.deepEqual([cb.managerPin, cb.managerPinInvalid], [null, true], bad)
  }
  assert.deepEqual(c.prompts, {})
  for (const [m, want] of [['fallback', 'fallback'], [' VoiceMail ', 'voicemail'], ['busy', 'busy'], ['what', 'busy']]) assert.equal(loadConfig({ VG_NO_ANSWER_MODE: m }).noAnswerMode, want, m)
  const c2 = loadConfig({ VG_MANAGERS: '907=0676575085, 905', VG_MANAGER: '0676575085', VG_CONFIRM: '0', VG_CONFIRM_TIMEOUT_SEC: '5', VG_CONFIRM_REPEATS: '0', VG_CALLBACK_TTL_HOURS: '12', VG_LAST_CLIENT_DAYS: '7', VG_CALLBACK_DIAL_TIMEOUT_SEC: '20', VG_CLIENT_URI: 'sip:{e164}@{server}', VG_CARD_SPEAK_NUMBER: '1', [PROMPT_ENV.confirm]: '/w/confirm.wav', VG_CB_NONE_WAV: '/w/none.wav' })
  assert.deepEqual(c2.managers, [['907', '+380676575085'], ['905']])
  assert.deepEqual([c2.confirmEnabled, c2.confirmTimeoutSec, c2.confirmRepeats, c2.callbackTtlHours, c2.lastClientTtlDays, c2.callbackDialTimeoutSec, c2.clientUriTemplate, c2.cardSpeakNumber],
    [false, 5, 0, 12, 7, 20, 'sip:{e164}@{server}', true])
  assert.deepEqual([c2.promptFiles.confirm, c2.promptFiles.cbNone, c2.promptFiles.busy], ['/w/confirm.wav', '/w/none.wav', null])
  assert.deepEqual(loadConfig({ VG_MANAGERS: '905' }).managers, [['905'], ['907']]) // лінія менеджера — завжди
})

test('gateway: прапорці --no-answer, --managers, --client-uri', () => {
  const o = parseArgs(['--local', '--manager', 'sip:0500000002@127.0.0.1:5093', '--no-answer', ' Fallback ', '--managers', '907=0676575085', '--client-uri', 'sip:{national}@127.0.0.1:5091'])
  assert.deepEqual([o.local, o.manager, o.noAnswer, o.managers, o.clientUri], [true, 'sip:0500000002@127.0.0.1:5093', 'fallback', '907=0676575085', 'sip:{national}@127.0.0.1:5091'])
  assert.throws(() => parseArgs(['--no-answer']), /требует значение/)
})

test('tts: сталі фрази — prompt-<sha1>.wav, прибирання кешу їх не чіпає (картки з іменем — прибираються)', async () => {
  const dir = tmpDir()
  const f = fakeFetch([{ status: 200, bytes: Buffer.alloc(8000 * 2, 1) }, { status: 200, bytes: Buffer.alloc(8000 * 2, 1) }])
  const tts = makeTts({ cacheDir: dir, getApiKey: async () => KEY, voiceId: 'v', model: 'm', fetchImpl: f })
  const p = await tts(PROMPT_TEXTS.busy, { prefix: 'prompt' })
  assert.equal(path.basename(p.file), `prompt-${sha1(PROMPT_TEXTS.busy)}.wav`)
  assert.equal(f.calls[0].body.text, PROMPT_TEXTS.busy)
  assert.equal(f.calls[0].body.language_code, 'uk')
  const c = await tts('Дзвонить клієнт.')
  assert.match(path.basename(c.file), /^card-[0-9a-f]{40}\.wav$/)
  assert.deepEqual(await tts(PROMPT_TEXTS.busy, { prefix: 'prompt' }), { file: p.file, cached: true }) // з кешу, без мережі
  assert.equal(f.calls.length, 2)
  const old = (Date.now() - 400 * 86400000) / 1000
  fs.utimesSync(p.file, old, old)
  fs.utimesSync(c.file, old, old)
  const data = path.join(dir, 'data')
  fs.mkdirSync(data)
  assert.equal(pruneGatewayData({ dataDir: data, cacheDir: dir, retentionDays: { logs: 14, cache: 30, journal: 90, voicemail: 90 } }), 1)
  assert.ok(fs.existsSync(p.file) && !fs.existsSync(c.file))
})

test('gateway: підсумок — «лінія зайнята» з передзвоном, відповідь «1 / 2», передзвін менеджера', () => {
  assert.equal(summary({ number: '+380500000001', outcome: 'busy_callback', reason: 'manager_declined', confirm: { manager: { plays: 1, digit: '2' } }, callback: { managerKey: '907', stored: true, id: 'x' }, t: {} }),
    'итог +380500000001: busy_callback (manager_declined), менеджер нажал «2», клиенту «линия занята», перезвон сохранён')
  assert.equal(summary({ number: '+380500000001', outcome: 'busy_callback', reason: 'manager_no_confirm', confirm: { manager: { plays: 2, digit: null } }, callback: { stored: false, why: 'no_number' }, t: {} }),
    'итог +380500000001: busy_callback (manager_no_confirm), менеджер не нажал «1» (вопрос 2 раз), клиенту «линия занята», перезвон не сохранён (no_number)')
  assert.equal(summary({ kind: 'callback', number: '907', outcome: 'connected_callback', cardSource: 'prompt', callback: { source: 'pending', client: '…4567', removed: true }, t: { xfer: 9000 } }),
    'итог 907: connected_callback, перевод на 9.0 с, перезвон: ждал перезвона …4567, ожидание перезвона снято')
  assert.equal(summary({ kind: 'callback', number: '907', outcome: 'callback_none', reason: 'no_target', callback: { source: null }, t: {} }),
    'итог 907: callback_none (no_target), перезвон: некому')
})

test('config: дані шлюзу типово поза репозиторієм (worktree видаляють), шляхи абсолютні; поріг порожнього повідомлення', () => {
  assert.equal(defaultDataDir({ HOME: '/Users/x' }, 'darwin'), '/Users/x/Library/Application Support/runferry-voice-gateway/data')
  assert.equal(defaultDataDir({ HOME: '/home/x' }, 'linux'), '/home/x/.local/share/runferry-voice-gateway/data')
  assert.equal(defaultDataDir({ HOME: '/home/x', XDG_DATA_HOME: '/srv/d' }, 'linux'), '/srv/d/runferry-voice-gateway/data')
  const c = loadConfig({ HOME: '/Users/x' })
  assert.equal(c.dataDir, defaultDataDir({ HOME: '/Users/x' }))
  assert.ok(!c.dataDir.startsWith(GATEWAY_DIR), c.dataDir)
  assert.equal(c.cacheDir, path.join(GATEWAY_DIR, 'cache'))
  // VG_DATA_DIR=data (відносний) — від поточної теки, абсолютним: інакше рушій відкине шлях запису пошти
  const rel = loadConfig({ VG_DATA_DIR: 'data', VG_CACHE_DIR: 'c' })
  assert.equal(rel.dataDir, path.resolve('data'))
  assert.equal(rel.cacheDir, path.resolve('c'))
  assert.equal(loadConfig({ VG_DATA_DIR: '/abs/d' }).dataDir, '/abs/d')
  assert.equal(c.voicemailMinSec, 1)
  assert.equal(loadConfig({ VG_VOICEMAIL_MIN_SEC: '0' }).voicemailMinSec, 0)
})

test('storage: шлях голосової пошти (київська дата, gcid або час, 4 цифри, вільне ім\'я, теки 0700), сигнал 1 кГц 0,4 с, старі повідомлення прибираються', () => {
  const dir = tmpDir()
  const data = path.join(dir, 'data')
  const now = new Date('2026-10-16T21:53:01Z') // у Києві 17.10, 00:53:01
  const day = path.join(data, 'voicemail', '2026-10-17')
  const f1 = makeVoicemailPath({ dataDir: data, gcid: '6929308233', number: '+380671230255', now })
  assert.equal(f1, path.join(day, '6929308233-0255.wav'))
  assert.equal(fs.statSync(path.join(data, 'voicemail')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(day).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(f1), false) // файл створює рушій
  fs.writeFileSync(f1, 'x')
  assert.equal(makeVoicemailPath({ dataDir: data, gcid: '6929308233', number: '+380671230255', now }), path.join(day, '6929308233-0255-2.wav'))
  assert.equal(makeVoicemailPath({ dataDir: data, gcid: null, number: '907', now }), path.join(day, '005301-907.wav'))
  assert.equal(makeVoicemailPath({ dataDir: data, gcid: '../../etc/x', number: null, now }), path.join(day, 'etcx-anon.wav')) // GCID із SIP — без «..» і «/»
  // відносна тека даних → усе одно абсолютний шлях (рушій приймає лише такий)
  const relData = path.relative(process.cwd(), data)
  const f3 = makeVoicemailPath({ dataDir: relData, gcid: 'g1', number: '+380671230255', now })
  assert.ok(path.isAbsolute(f3), f3)
  assert.equal(f3, path.join(day, 'g1-0255.wav'))

  const cache = path.join(dir, 'cache')
  const beep = ensureBeep({ cacheDir: cache })
  assert.equal(beep, path.join(cache, BEEP_NAME))
  const b = fs.readFileSync(beep)
  assert.ok(isTelephonyWav(readWavInfo(b)))
  assert.equal(b.length, 44 + 8000 * 2 * 0.4)
  assert.equal(fs.statSync(beep).mode & 0o777, 0o600)
  let peak = 0
  for (let i = 44; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)))
  assert.ok(peak > 10000 && peak < 12000, `пік ${peak}`)
  assert.equal(b.readInt16LE(44), 0) // плавний початок — без клацання
  assert.deepEqual(toneWav({ ms: 400 }), b)
  const mtime = fs.statSync(beep).mtimeMs
  assert.equal(ensureBeep({ cacheDir: cache }), beep) // уже є — не переписуємо
  assert.equal(fs.statSync(beep).mtimeMs, mtime)
  assert.equal(pruneGatewayData({ dataDir: data, cacheDir: cache, retentionDays: { logs: 14, cache: 30, journal: 90, voicemail: 90 } }), 0) // сигнал і свіжі записи не чіпаємо

  const old = (f, days) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); const ts = (Date.now() - days * 86400000) / 1000; fs.utimesSync(f, ts, ts) }
  old(path.join(data, 'voicemail', '2026-06-01', 'a-0001.wav'), 100)
  old(path.join(data, 'voicemail', '2026-07-20', 'b-0002.wav'), 89)
  assert.equal(pruneGatewayData({ dataDir: data, cacheDir: cache, retentionDays: { logs: 14, cache: 30, journal: 90, voicemail: 90 } }), 1)
  assert.deepEqual(fs.readdirSync(path.join(data, 'voicemail')).sort(), ['2026-07-20', '2026-10-17']) // порожню теку дня прибрали
  assert.equal(pruneGatewayData({ dataDir: data, cacheDir: cache, retentionDays: { logs: 14, cache: 30, journal: 90, voicemail: 0 } }), 0) // 0 — не прибирати
})

test('storage: заголовок WAV після падіння рушія (довжини 0) лагодимо за розміром файла; цілі й чужі файли не чіпаємо; git-корінь', () => {
  const dir = tmpDir()
  const data = path.join(dir, 'data')
  const day = path.join(data, 'voicemail', '2026-10-17')
  fs.mkdirSync(day, { recursive: true })
  const pcm = Buffer.alloc(8000 * 2 * 3) // 3 с тиші
  const good = wavFromPcm16(pcm)
  const broken = Buffer.from(good)
  broken.writeUInt32LE(0, 4) // так pjmedia лишає заголовок до закриття файла
  broken.writeUInt32LE(0, 40)
  const fBroken = path.join(day, 'g1-0255.wav')
  const fGood = path.join(day, 'g2-0255.wav')
  const fOdd = path.join(day, 'g3-0255.wav')
  const fEmpty = path.join(day, 'g4-0255.wav')
  fs.writeFileSync(fBroken, broken)
  fs.writeFileSync(fGood, good)
  fs.writeFileSync(fOdd, Buffer.concat([broken, Buffer.from([1])])) // обірваний посеред відліку
  fs.writeFileSync(fEmpty, broken.subarray(0, 44)) // лише заголовок — звуку немає
  fs.writeFileSync(path.join(day, 'notes.wav'), 'not a wav at all, definitely more than forty-four bytes long....')
  assert.equal(repairVoicemailHeaders({ dataDir: data }), 2)
  assert.deepEqual(fs.readFileSync(fBroken), good)
  assert.deepEqual(fs.readFileSync(fGood), good)
  const odd = fs.readFileSync(fOdd)
  assert.equal(odd.readUInt32LE(40), pcm.length)
  assert.equal(odd.readUInt32LE(4), 36 + pcm.length)
  assert.equal(fs.readFileSync(fEmpty).readUInt32LE(40), 0)
  assert.equal(repairVoicemailHeaders({ dataDir: data }), 0) // вдруге — нічого
  assert.equal(repairWavHeader(path.join(dir, 'nope.wav')), false)
  // свіжий файл (ще може писатися) з minAgeMs не чіпаємо
  fs.writeFileSync(fBroken, broken)
  assert.equal(repairVoicemailHeaders({ dataDir: data, minAgeMs: 120000 }), 0)
  assert.equal(repairVoicemailHeaders({ dataDir: data, minAgeMs: 120000, now: () => Date.now() + 121000 }), 1)
  assert.equal(repairVoicemailHeaders({ dataDir: path.join(dir, 'nope') }), 0)

  assert.equal(findGitRoot(dir), null)
  fs.mkdirSync(path.join(dir, 'repo', 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'repo', '.git'), 'gitdir: /x') // worktree: .git — файл
  assert.equal(findGitRoot(path.join(dir, 'repo', 'a', 'b')), path.join(dir, 'repo'))
  assert.ok(findGitRoot(GATEWAY_DIR)) // типовий старий шлях voice-gateway/data — у робочій копії
})

test('gateway: підсумок дзвінка в консолі — запасна, повтори, голосове повідомлення', () => {
  assert.equal(summary({ number: '+380500000001', outcome: 'connected_fallback', reason: 'manager_timeout', fallbackRetries: 2, t: { fbAnswered: 30500, fbXfer: 42000 } }),
    'итог +380500000001: connected_fallback (manager_timeout), запасная ответила через 30.5 с, перевод на 42.0 с, повторов набора запасной 2')
  assert.equal(summary({ number: '+380500000001', outcome: 'voicemail', reason: 'manager_486', fallbackReason: 'fallback_timeout', retries: 5, voicemail: { file: '/d/v.wav', sec: 12.34 }, t: {} }),
    'итог +380500000001: voicemail (manager_486, fallback_timeout), повторов набора 5, сообщение 12.3 с: /d/v.wav')
  assert.equal(summary({ number: '+380500000001', outcome: 'voicemail_empty', reason: 'manager_486', voicemail: { file: null, sec: 0.2, stop: 'client_hangup', empty: true, removed: true }, t: {} }),
    'итог +380500000001: voicemail_empty (manager_486), сообщения нет (запись 0.2 с, пустой файл удалён)')
  assert.equal(summary({ number: '+380500000001', outcome: 'voicemail', reason: 'manager_timeout', abortReason: 'shutdown', voicemail: { file: '/d/v.wav', sec: null, stop: 'aborted' }, t: {} }),
    'итог +380500000001: voicemail (manager_timeout), прерван: остановка шлюза, сообщение (длина неизвестна): /d/v.wav')
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
    out(process.env.FAKE_NO_DTMF ? { ev: 'ready' } : { ev: 'ready', dtmf: true })
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
    VG_MANAGER: '905', VG_NO_ANSWER_MODE: 'fallback', VG_GREETING_WAV: wav, VG_HOLD_WAV: wav, VG_DATA_DIR: path.join(dir, 'data'), VG_CACHE_DIR: path.join(dir, 'cache'), VG_ENGINE_RESTART_MS: '200' }
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
  assert.match(out, /менеджер sip:905@sip15\.binotel\.com;transport=udp; подтверждение «1»/)
  assert.match(out, /→ запасная sip:906@sip15\.binotel\.com;transport=udp \(набор, карточка, REFER\/Replaces\), потом голосовая почта/)
  assert.match(out, /перезвон: менеджеры 905 \(внешние номера — нет, 486\);/) // лінія менеджера — завжди серед менеджерів (захист від петлі)
  assert.ok(!/не сообщает DTMF/.test(out), out)
  assert.match(out, /синтез выключен — нет фраз: вопрос менеджеру «1 \/ 2»/)
  assert.match(out, /движок завершился \(code 1\)/)
  assert.match(out, /перезапускаю движок/)
  assert.match(out, /шлюз остановлен/)
  assert.match(out, /не умеет запись — голосовой почты не будет/) // підроблений рушій не оголосив record у ready
  assert.equal((out.match(/не умеет запись/g) || []).length, 1) // після перезапуску рушія — не повторюємо
  assert.ok(fs.existsSync(path.join(dir, 'cache', 'beep-1000hz-400ms.wav')), 'сигнал перед записом не згенеровано')
  assert.ok(!out.includes('S3cret-PW'), 'пароль у виводі шлюзу')
  assert.equal(fs.statSync(path.join(dir, 'data')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(dir, 'data', 'logs')).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(path.join(dir, 'data', 'logs')) && fs.readdirSync(path.join(dir, 'data', 'logs')).some((f) => f.startsWith('brain-')), false) // траса типово вимкнена
  const engLog = fs.readdirSync(path.join(dir, 'data', 'logs')).find((f) => /^engine-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  assert.ok(engLog)
  assert.equal(fs.statSync(path.join(dir, 'data', 'logs', engLog)).mode & 0o777, 0o600)
  assert.equal((fs.readFileSync(path.join(dir, 'data', 'logs', engLog), 'utf8').match(/==== .* старт /g) || []).length, 2)
})

// Рушій без DTMF (старий engine/sip-engine): з підтвердженням «1» шлюз не стартує — без «1» не переводимо, а з таким
// рушієм не з'єднався б жоден дзвінок; переводити без «1» — лише явне VG_CONFIRM=0.
test('gateway: рушій без DTMF і підтвердження «1» — не стартує (код 2, без local/register); VG_CONFIRM=0 — працює', async () => {
  const dir = tmpDir()
  const cmdsLog = path.join(dir, 'cmds.jsonl')
  const fakeJs = path.join(dir, 'fake-engine.mjs')
  fs.writeFileSync(fakeJs, `
    import fs from 'node:fs'
    import { createInterface } from 'node:readline'
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    out({ ev: 'ready', record: true })
    createInterface({ input: process.stdin }).on('line', (l) => {
      const c = JSON.parse(l)
      fs.appendFileSync(${JSON.stringify(cmdsLog)}, JSON.stringify({ run: process.env.RUN, cmd: c.cmd }) + '\\n')
      if (c.cmd === 'local') out({ ev: 'reg', code: 200, reason: 'local', active: true, local: true })
      if (c.cmd === 'quit') setTimeout(() => process.exit(0), 20)
    })
  `)
  const fakeSh = path.join(dir, 'fake-engine.sh')
  fs.writeFileSync(fakeSh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeJs)}\n`)
  fs.chmodSync(fakeSh, 0o755)
  const wav = path.join(dir, 'p.wav')
  fs.writeFileSync(wav, wavFromPcm16(Buffer.alloc(1600)))
  const gwPath = fileURLToPath(new URL('./gateway.mjs', import.meta.url))
  const run = (extra, killAfterMs) => new Promise((resolve) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VG_|^BINOTEL_/.test(k))),
      VG_GREETING_WAV: wav, VG_HOLD_WAV: wav, VG_DATA_DIR: path.join(dir, 'data'), VG_CACHE_DIR: path.join(dir, 'cache'), ...extra }
    const gw = spawn(process.execPath, [gwPath, '--local', '--manager', 'sip:907@127.0.0.1:5094', '--engine', fakeSh, '--no-tts', '--no-lookup'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    gw.stdout.on('data', (b) => { out += b })
    gw.stderr.on('data', (b) => { out += b })
    const t = setTimeout(() => gw.kill('SIGTERM'), killAfterMs)
    gw.on('exit', (code) => { clearTimeout(t); resolve({ code, out }) })
  })
  const cmds = (r) => (fs.existsSync(cmdsLog) ? fs.readFileSync(cmdsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.run === r).map((c) => c.cmd) : [])
  const a = await run({ RUN: 'a' }, 8000)
  assert.equal(a.code, 2, a.out)
  assert.match(a.out, /не сообщает DTMF: подтверждение «1» невозможно, а переводить без «1» нельзя — шлюз не запускается/)
  assert.match(a.out, /VG_CONFIRM=0/)
  assert.deepEqual(cmds('a'), ['quit']) // ні local, ні register
  const b = await run({ RUN: 'b', VG_CONFIRM: '0' }, 1500)
  assert.equal(b.code, 0, b.out)
  assert.match(b.out, /без подтверждения «1»/)
  assert.ok(!/шлюз не запускается/.test(b.out), b.out)
  assert.deepEqual(cmds('b'), ['local', 'quit'])
})
