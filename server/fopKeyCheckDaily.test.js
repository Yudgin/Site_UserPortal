// node --test: последняя проверка ключей ФОП и ежедневная проверка с сообщением владельцу — без сети и Firebase.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { fopIssues, dailyMessage, runDailyKeyCheck, saveKeyCheck, forgetKeyCheck, ownerTelegram } from './fopKeyCheckDaily.js'
import { registerFopsAdmin } from './fopsAdmin.js'

// Firestore в памяти: только то, что трогают проверки.
const fakeDb = (fops = {}, secrets = {}) => {
  const data = { fops: { ...fops }, fopSecrets: { ...secrets }, fopKeyChecks: {}, fopKeyCheckRuns: {} }
  const col = (name) => ({
    get: async () => {
      const docs = Object.entries(data[name] || {}).map(([id, v]) => ({ id, data: () => v }))
      return { docs, forEach: (f) => docs.forEach(f) }
    },
    doc: (id) => ({
      get: async () => ({ exists: !!data[name]?.[id], data: () => data[name]?.[id] }),
      set: async (v, opts) => { data[name] = data[name] || {}; data[name][id] = JSON.parse(JSON.stringify(opts?.merge ? { ...(data[name][id] || {}), ...v } : v)) },
      delete: async () => { if (data[name]) delete data[name][id] },
      create: async (v) => {
        if (data[name]?.[id]) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 })
        data[name] = data[name] || {}
        data[name][id] = JSON.parse(JSON.stringify(v))
      },
    }),
  })
  return { data, collection: col }
}

const OK = { status: 'ok', message: 'Ключі дійсні' }
const NONE = { status: 'none', message: 'Ключі не задані' }
const allOk = () => ({ liqpay: NONE, monoAcquire: OK, monoChast: NONE, checkbox: { ...OK, cashierName: 'Касир' }, novaPoshta: OK })
const BLOCKED = { status: 'bad', message: 'Checkbox: Касу заблоковано', urgent: true, cashierName: 'Касир' }
const NP_BAD = { status: 'bad', message: 'Ключ дійсний, але обраний відправник не з цього кабінету' }
const notifier = (configured = true) => {
  const sent = []
  return { sent, notify: { configured, send: async (text) => { if (!configured) return false; sent.push(text); return true } } }
}

test('fopIssues: червоні рядки і те, що скоро перестане працювати; срочне позначене', () => {
  const issues = fopIssues({ id: 'a', name: 'ФОП А' }, {
    ...allOk(),
    novaPoshta: NP_BAD,
    checkbox: { ...OK, expiring: [{ what: 'subscription', date: '2026-11-15', text: 'Підписка Checkbox закінчується 15.11.2026' }] },
  })
  assert.deepEqual(issues.map((i) => [i.title, i.urgent]), [['Checkbox (чеки)', true], ['Нова Пошта', false]])
  assert.equal(issues[0].fop, 'ФОП А')
  assert.deepEqual(fopIssues({ id: 'a' }, allOk()), [])
  assert.equal(fopIssues({ id: 'a' }, { checkbox: BLOCKED })[0].urgent, true)
})

test('dailyMessage: по ФОП, з посиланням на сторінку; без проблем — «усе в порядку»', () => {
  const text = dailyMessage([
    { fop: 'ФОП А', title: 'Нова Пошта', text: 'відправник не з цього кабінету' },
    { fop: 'ФОП Б', title: 'Checkbox (чеки)', text: 'Касу заблоковано' },
    { fop: 'ФОП А', title: 'LiqPay', text: 'ключ не той' },
  ])
  assert.match(text, /^⚠️ RunFerry: щоденна перевірка ключів ФОП/)
  assert.match(text, /ФОП А:\n• Нова Пошта: відправник не з цього кабінету\n• LiqPay: ключ не той/)
  assert.match(text, /ФОП Б:\n• Checkbox \(чеки\): Касу заблоковано/)
  assert.match(text, /https:\/\/my\.runferry\.com\/fops$/)
  assert.match(dailyMessage([]), /^✅/)
})

test('щоденна перевірка: нове — одразу, повтор того ж — мовчки, срочне — щодня, усе виправили — одне «✅»', async () => {
  const db = fakeDb({ a: { name: 'ФОП А' }, b: { name: 'ФОП Б' }, off: { name: 'Вимкнений', active: false } })
  const day = { a: allOk(), b: allOk() }
  const checked = []
  const checkKeys = async (fop) => { checked.push(fop.id); return day[fop.id] }
  const loadFop = async (_db, id) => ({ id, name: db.data.fops[id].name })
  const { sent, notify } = notifier()
  const run = () => runDailyKeyCheck({ adminDb: db, loadFop, checkKeys, notify, now: () => new Date('2026-11-11T07:05:00Z') })

  // день 1: у А зламався відправник НП — нове, надсилаємо
  day.a = { ...allOk(), novaPoshta: NP_BAD }
  let r = await run()
  assert.equal(r.checked, 2)
  assert.deepEqual(checked.sort(), ['a', 'b']) // вимкнений ФОП не перевіряємо
  assert.equal(r.sent, true)
  assert.match(sent.at(-1), /ФОП А:\n• Нова Пошта: Ключ дійсний, але обраний відправник не з цього кабінету/)
  // результат кожного ФОП збережено для міток, без даних каси
  assert.equal(db.data.fopKeyChecks.a.source, 'daily')
  assert.equal(db.data.fopKeyChecks.a.results.novaPoshta.status, 'bad')
  assert.equal(db.data.fopKeyChecks.b.results.checkbox.cashierName, undefined)
  // день 2: те саме — мовчимо
  r = await run()
  assert.equal(r.sent, null)
  assert.equal(sent.length, 1)
  // день 3 і 4: у Б Checkbox заблокував касу — срочне, нагадуємо щодня
  day.b = { ...allOk(), checkbox: BLOCKED }
  assert.equal((await run()).sent, true)
  assert.equal((await run()).sent, true)
  assert.equal(sent.length, 3)
  assert.match(sent.at(-1), /ФОП Б:\n• Checkbox \(чеки\): Касу заблоковано/) // без повтору «Checkbox:»
  // день 5: усе виправили — одне «✅», день 6 — тиша
  day.a = allOk()
  day.b = allOk()
  assert.equal((await run()).sent, true)
  assert.match(sent.at(-1), /^✅/)
  assert.equal((await run()).sent, null)
  assert.equal(sent.length, 4)
  assert.equal(db.data.fopKeyCheckRuns.last.issues, 0)
  assert.equal(db.data.fopKeyCheckRuns.lock, undefined) // блокування знято
})

test('щоденна перевірка: чат не підключено — не вважаємо надісланим і спробуємо завтра; збій одного ФОП не зупиняє інших', async () => {
  const db = fakeDb({ a: { name: 'ФОП А' }, b: { name: 'ФОП Б' } })
  const loadFop = async (_db, id) => ({ id, name: db.data.fops[id].name })
  const checkKeys = async (fop) => {
    if (fop.id === 'b') throw new Error('firestore down')
    return { ...allOk(), novaPoshta: NP_BAD }
  }
  const off = notifier(false)
  let r = await runDailyKeyCheck({ adminDb: db, loadFop, checkKeys, notify: off.notify })
  assert.equal(r.sent, false)
  assert.equal(r.telegram, false)
  assert.equal(r.failed, 1)
  assert.equal(r.checked, 1) // упалий ФОП не рахуємо перевіреним
  assert.deepEqual(db.data.fopKeyCheckRuns.last.issueList, [])
  // чат підключили — та сама проблема приходить
  const on = notifier(true)
  r = await runDailyKeyCheck({ adminDb: db, loadFop, checkKeys, notify: on.notify })
  assert.equal(r.sent, true)
  assert.equal(on.sent.length, 1)
})

test('ownerTelegram: без токена або чату не шле; помилка — false, токен у журнал не потрапляє', async (t) => {
  assert.equal(ownerTelegram({}).configured, false)
  assert.equal(await ownerTelegram({ TELEGRAM_BOT_TOKEN: 't' }).send('x'), false)
  const posts = []
  const tg = ownerTelegram({ TELEGRAM_BOT_TOKEN: 'BOT-SECRET', OWNER_TELEGRAM_CHAT_ID: '42' }, { post: async (url, body) => { posts.push({ url, body }) } })
  assert.equal(tg.configured, true)
  assert.equal(await tg.send('привіт'), true)
  assert.equal(posts[0].url, 'https://api.telegram.org/botBOT-SECRET/sendMessage')
  assert.equal(posts[0].body.chat_id, '42')
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a.join(' '))
  t.after(() => { console.error = orig })
  const failing = ownerTelegram({ TELEGRAM_BOT_TOKEN: 'BOT-SECRET', OWNER_TELEGRAM_CHAT_ID: '42' }, {
    post: async () => { throw Object.assign(new Error('Request to https://api.telegram.org/botBOT-SECRET failed'), { response: { status: 403 } }) },
  })
  assert.equal(await failing.send('x'), false)
  assert.ok(logged.length > 0)
  assert.ok(!logged.join('\n').includes('BOT-SECRET'))
})

test('saveKeyCheck: зберігає лише вердикт, текст і строки', async () => {
  const db = fakeDb()
  await saveKeyCheck(db, 'a', { checkbox: { ...BLOCKED, subscriptionExp: '2026-11-01', merchantName: 'ФОП', edrpou: '1' }, liqpay: null }, 'manual', '2026-11-10T10:00:00Z')
  assert.deepEqual(db.data.fopKeyChecks.a, {
    checkedAt: '2026-11-10T10:00:00Z', source: 'manual',
    results: { checkbox: { status: 'bad', message: 'Checkbox: Касу заблоковано', subscriptionExp: '2026-11-01' } },
  })
  await saveKeyCheck(db, 'b', { checkbox: { ...OK, note: 'скоро', expiring: [{ what: 'subscription', date: '2026-11-15', text: 'скоро' }] } }, 'daily')
  assert.equal(db.data.fopKeyChecks.b.results.checkbox.soon, true)
  assert.equal(db.data.fopKeyChecks.b.results.checkbox.expiring, undefined)
})

test('щоденна перевірка: ФОП або сервіс сьогодні не відповів — минулі проблеми не «зникли», а переносяться з позначкою', async () => {
  const db = fakeDb({ a: { name: 'ФОП А' } })
  let day = { ...allOk(), novaPoshta: NP_BAD }
  let loadFails = false
  const loadFop = async (_db, id) => { if (loadFails) throw new Error('firestore down'); return { id, name: 'ФОП А' } }
  const { sent, notify } = notifier()
  const run = () => runDailyKeyCheck({ adminDb: db, loadFop, checkKeys: async () => day, notify })
  assert.equal((await run()).sent, true) // день 1: нова проблема
  day = { ...allOk(), novaPoshta: { status: 'unknown', message: 'Нова Пошта не відповіла' } }
  let r = await run() // день 2: НП не відповіла — не «✅» і не повтор
  assert.equal(r.sent, null)
  assert.equal(r.issues, 1)
  loadFails = true
  r = await run() // день 3: ФОП не прочитали зовсім — те саме
  assert.equal(r.sent, null)
  assert.equal(r.failed, 1)
  assert.equal(r.issues, 1)
  loadFails = false
  day = allOk()
  assert.equal((await run()).sent, true) // день 4: справді виправили — «✅»
  assert.match(sent.at(-1), /^✅/)
  assert.equal(sent.length, 2)

  // срочне, яке сьогодні не перевірили, нагадуємо з позначкою
  const db2 = fakeDb({ b: { name: 'ФОП Б' } })
  const n2 = notifier()
  let res = { ...allOk(), checkbox: BLOCKED }
  const run2 = () => runDailyKeyCheck({ adminDb: db2, loadFop: async (_db, id) => ({ id, name: 'ФОП Б' }), checkKeys: async () => res, notify: n2.notify })
  await run2()
  res = { ...allOk(), checkbox: { status: 'unknown', message: 'Checkbox не відповів' } }
  assert.equal((await run2()).sent, true)
  assert.match(n2.sent.at(-1), /Касу заблоковано \(сьогодні перевірити не вдалося, це результат минулої перевірки\)/)
})

test('щоденна перевірка: один запуск за раз; завислу блокування забираємо', async () => {
  const db = fakeDb({ a: { name: 'ФОП А' } })
  let checks = 0
  const deps = { adminDb: db, loadFop: async (_db, id) => ({ id, name: 'ФОП А' }), checkKeys: async () => { checks += 1; return allOk() }, notify: notifier().notify }
  db.data.fopKeyCheckRuns.lock = { until: '2999-01-01T00:00:00.000Z' }
  assert.deepEqual(await runDailyKeyCheck(deps), { busy: true })
  assert.equal(checks, 0)
  assert.ok(db.data.fopKeyCheckRuns.lock) // чужу блокування не чіпаємо
  db.data.fopKeyCheckRuns.lock = { until: '2000-01-01T00:00:00.000Z' } // упалий запуск
  assert.equal((await runDailyKeyCheck(deps)).checked, 1)
  assert.equal(db.data.fopKeyCheckRuns.lock, undefined)
})

test('saveKeyCheck: перевірка, що почалась до збереження нових ключів, старий результат не запише', async () => {
  const db = fakeDb()
  await forgetKeyCheck(db, 'a', '2026-11-10T10:00:01.000Z')
  assert.equal(await saveKeyCheck(db, 'a', { checkbox: BLOCKED }, 'daily', '2026-11-10T10:00:05.000Z', '2026-11-10T10:00:00.000Z'), false)
  assert.equal(db.data.fopKeyChecks.a.results, undefined)
  assert.equal(await saveKeyCheck(db, 'a', { checkbox: OK }, 'manual', '2026-11-10T10:00:09.000Z', '2026-11-10T10:00:02.000Z'), true)
  assert.equal(db.data.fopKeyChecks.a.results.checkbox.status, 'ok')
})

test('dailyMessage: задовге — ріже цілими ФОП і посилання лишає', () => {
  const many = Array.from({ length: 40 }, (_, n) => ({ fop: `ФОП ${n}`, title: 'Checkbox (чеки)', text: 'Касу заблоковано. '.repeat(8) }))
  const text = dailyMessage(many)
  assert.ok(text.length <= 3900, String(text.length))
  assert.match(text, /…і ще \d+ — дивіться сторінку\.\n\nДеталі: https:\/\/my\.runferry\.com\/fops$/)
  assert.ok(!/Касу заблоковано\. Касу забл$/m.test(text))
})

// ---------- маршрути ----------
const startApp = async (deps) => {
  const app = express()
  app.use(express.json())
  registerFopsAdmin(app, deps)
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

test('маршрут щоденної перевірки: токен планувальника або власник; інакше 403 і перевірок нема', async (t) => {
  const db = fakeDb({ a: { name: 'ФОП А' } })
  let checks = 0
  const { notify } = notifier()
  const a = await startApp({
    adminDb: db, cronToken: 'CRON', notify,
    verifyAdmin: async (req) => req.get('authorization') === 'Bearer owner',
    loadFop: async (_db, id) => ({ id, name: 'ФОП А' }),
    checkKeys: async () => { checks += 1; return { ...allOk(), novaPoshta: NP_BAD } },
  })
  t.after(a.close)
  const post = (headers = {}) => fetch(`${a.url}/api/fops/checks/daily`, { method: 'POST', headers })
  assert.equal((await post()).status, 403)
  assert.equal((await post({ 'x-admin-token': 'wrong' })).status, 403)
  assert.equal(checks, 0)
  const byCron = await post({ 'x-admin-token': 'CRON' })
  assert.equal(byCron.status, 200)
  assert.deepEqual((await byCron.json()).data, { at: db.data.fopKeyCheckRuns.last.at, checked: 1, failed: 0, issues: 1, sent: true, telegram: true })
  assert.equal((await post({ authorization: 'Bearer owner' })).status, 200)
  assert.equal(checks, 2)
  // уже йде інший запуск — 409, а не друге повідомлення
  db.data.fopKeyCheckRuns.lock = { until: '2999-01-01T00:00:00.000Z' }
  const busy = await post({ 'x-admin-token': 'CRON' })
  assert.equal(busy.status, 409)
  assert.equal((await busy.json()).error.code, 'BUSY')
  delete db.data.fopKeyCheckRuns.lock

  // порожній токен у налаштуваннях не відкриває маршрут порожнім заголовком
  const noToken = await startApp({ adminDb: db, cronToken: '', notify, verifyAdmin: async () => false, loadFop: async () => null, checkKeys: async () => ({}) })
  t.after(noToken.close)
  assert.equal((await fetch(`${noToken.url}/api/fops/checks/daily`, { method: 'POST', headers: { 'x-admin-token': '' } })).status, 403)
})

test('список ФОП несе останню перевірку, ручна перевірка її записує, статус показує Telegram і останній запуск', async (t) => {
  const db = fakeDb({ a: { name: 'ФОП А' }, b: { name: 'ФОП Б' } })
  const { notify } = notifier(false)
  const a = await startApp({
    adminDb: db, notify, verifyAdmin: async () => true,
    loadFop: async (_db, id) => ({ id, name: db.data.fops[id]?.name }),
    checkKeys: async () => ({ ...allOk(), checkbox: BLOCKED }),
  })
  t.after(a.close)
  let list = (await (await fetch(`${a.url}/api/fops/admin`)).json()).data
  assert.deepEqual(list.map((f) => [f.id, f.lastCheck]), [['a', null], ['b', null]])
  assert.equal((await fetch(`${a.url}/api/fops/admin/a/check-keys`, { method: 'POST' })).status, 200)
  list = (await (await fetch(`${a.url}/api/fops/admin`)).json()).data
  assert.equal(list[0].lastCheck.source, 'manual')
  assert.equal(list[0].lastCheck.results.checkbox.status, 'bad')
  assert.equal(list[0].lastCheck.results.checkbox.cashierName, undefined)
  assert.equal(list[1].lastCheck, null)

  // нові ключі — старий результат уже не про них: мітки сірі до нової перевірки
  const put = await fetch(`${a.url}/api/fops/admin/a`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ФОП А', secrets: { checkbox: { licenseKey: 'new' } } }) })
  assert.equal(put.status, 200)
  assert.equal(db.data.fopKeyChecks.a.results, undefined)
  assert.equal((await (await fetch(`${a.url}/api/fops/admin`)).json()).data[0].lastCheck, null)
  assert.equal((await fetch(`${a.url}/api/fops/admin/a/check-keys`, { method: 'POST' })).status, 200)
  assert.ok(db.data.fopKeyChecks.a)
  let status = (await (await fetch(`${a.url}/api/fops/admin/checks-status`)).json()).data
  assert.deepEqual(status, { telegram: false, lastRun: null })
  await fetch(`${a.url}/api/fops/checks/daily`, { method: 'POST' })
  status = (await (await fetch(`${a.url}/api/fops/admin/checks-status`)).json()).data
  assert.equal(status.lastRun.checked, 2)
  assert.equal(status.lastRun.issues, 2)
  assert.equal(status.lastRun.sent, false)
})
