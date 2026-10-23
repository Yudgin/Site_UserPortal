// node --test: приглашения в чат с ИИ (server/chatInvites.js) на фейковом Firestore — без сети, firebase-admin и ИИ.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {
  inviteSmsText, smsSegments, withInviteLead, inviteSystemBlock, inviteOpenedTurn, inviteUrl, SMS_MAX,
} from './chatInvitePrompt.js'
import { createMessengerCore } from './messengerCore.js'
import { registerNotifications } from './notifications.js'

// Минутный лимит в памяти общий для всех тестов процесса — поднимаем до импорта модуля.
process.env.CHAT_INVITE_PER_MIN = '1000'
const { createChatInviteActions, registerChatInvites, validateInviteInput, topicProblem, isInboundCall, maskInviteLink, LIMITS } = await import('./chatInvites.js')

// ---------- фейковый Firestore (хранение по полному пути) ----------
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deepMerge = (dst, src) => {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v)
    else dst[k] = clone(v)
  }
  return dst
}
class FakeDb {
  constructor(seed = {}) { this.docs = {}; for (const [path, v] of Object.entries(seed)) this.docs[path] = clone(v) }
  get(path) { return this.docs[path] }
  collection(path) {
    const db = this
    return {
      doc(id) {
        const did = id || `auto${Math.random().toString(36).slice(2, 8)}`
        const full = `${path}/${did}`
        return {
          id: did, _path: full,
          async get() { const d = db.docs[full]; return { id: did, exists: !!d, data: () => clone(d) } },
          async set(v, opts) { db._set(full, v, opts) },
        }
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(`fake where: ${op}`)
        return {
          async get() {
            const docs = db.list(path).filter((d) => d[field] === value).map(({ id, ...rest }) => ({ id, data: () => clone(rest) }))
            return { docs, empty: !docs.length, size: docs.length }
          },
        }
      },
    }
  }
  _set(full, v, opts) {
    if (opts && opts.merge && this.docs[full]) deepMerge(this.docs[full], v)
    else this.docs[full] = clone(v)
  }
  async runTransaction(fn) {
    const db = this
    let wrote = false
    const tx = {
      async get(ref) { if (wrote) throw new Error('Firestore: reads after writes in a transaction'); return ref.get() },
      set(ref, v, opts) { wrote = true; db._set(ref._path, v, opts) },
      create(ref, v) { wrote = true; if (db.docs[ref._path]) throw new Error('ALREADY_EXISTS'); db._set(ref._path, v) },
    }
    return fn(tx)
  }
  list(prefix) { return Object.entries(this.docs).filter(([k]) => k.startsWith(prefix + '/') && k.slice(prefix.length + 1).indexOf('/') === -1).map(([k, v]) => ({ id: k.slice(prefix.length + 1), ...v })) }
}

// ---------- фейки ИИ и SMS ----------
// Ответ по типу запроса: перевод темы (system про «редактор тем») или приветствие.
const fakeAnthropic = ({ topic = (t) => t, opening = 'Вітаю! Підкажіть, будь ласка, рік покупки кораблика.', fail = false, openingStop = 'end_turn' } = {}) => {
  const calls = []
  return {
    calls,
    messages: {
      async create(params, opts) {
        calls.push({ params, opts })
        if (fail) throw new Error('AI down')
        const isTopic = String(params.system).includes('редактор коротких тем')
        const text = isTopic ? JSON.stringify({ topic: topic(params.messages[0].content) }) : JSON.stringify({ reply: opening })
        const stop = isTopic ? 'end_turn' : openingStop
        return { content: [{ type: 'text', text: stop === 'max_tokens' ? text.slice(0, 20) : text }], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } }
      },
    },
  }
}
const fakeNotify = (status = 'sent') => {
  const calls = []
  const fn = async (p) => { calls.push(p); return { id: `ntf-${calls.length}`, status, error: status === 'failed' ? 'gateway down' : null, channel: 'sms' } }
  fn.calls = calls
  return fn
}
const buildUsage = (u = {}) => ({ inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, costUsd: 0.004 })
const core = { buildKnowledgeContext: async () => '### Кришки Solo V2 (консультація)\nДо 2020 — на защіпках, після — на магнітах.' }
const make = (db, extra = {}) => createChatInviteActions({
  adminDb: db, siteUrl: 'https://my.runferry.com', core, anthropic: fakeAnthropic(), AI_MODEL: 'test-model',
  KNOWLEDGE_SYSTEM: 'KNOWLEDGE', buildUsage, notifyClient: fakeNotify(), ...extra,
})

const owner = { uid: 'u-o', email: 'o@x', role: 'owner', centers: [] }
const master = { uid: 'u-m', email: 'm@kat', role: 'master', centers: [{ centerId: 'kat', perms: ['view'] }] }
const operator = { uid: 'u-op', email: 'op@x', role: 'operator', centers: [] }
const accountant = { uid: 'u-a', email: 'a@x', role: 'accountant', centers: [] }
let phoneSeq = 1000000
const nextPhone = () => `+38067${String(phoneSeq++).padStart(7, '0')}` // уникальный номер на тест (минутный лимит номера)
const digits = (p) => p.replace(/\D/g, '')

// ---------- чистые функции ----------

test('validateInviteInput: тема, телефон, ключ, значения по умолчанию', () => {
  assert.equal(validateInviteInput({ topic: 'аб' }).code, 'NO_TOPIC')
  assert.equal(validateInviteInput({ topic: 'х'.repeat(81) }).code, 'TOPIC_TOO_LONG')
  assert.equal(validateInviteInput({ topic: 'Оплатіть тут bit.ly/abc' }).code, 'TOPIC_HAS_LINK')
  assert.equal(validateInviteInput({ topic: 'Деталі на https://x' }).code, 'TOPIC_HAS_LINK')
  assert.equal(validateInviteInput({ topic: 'Подзвоніть 0671234567' }).code, 'TOPIC_HAS_LINK')
  for (const bad of ['Оплата на картку 4149 4993 1234 5678', 'Дзвоніть 067 123 45 67', 'Деталі на runferry.pro/pay', 'Оплата t.co/abc', 'Сайт приват.укр', 'Пишіть на a@b']) {
    assert.equal(validateInviteInput({ topic: bad }).code, 'TOPIC_HAS_LINK', bad)
  }
  for (const good of ['Кришка для Solo V2', 'Акумулятор 2019–2020 року', 'Прошивка V2.1 для R3', 'Кришка/люк бункера']) {
    assert.equal(validateInviteInput({ topic: good }).ok, true, good)
  }
  assert.equal(validateInviteInput({ topic: 'Кришка', phone: '12345' }).code, 'BAD_PHONE')
  assert.equal(validateInviteInput({ topic: 'Кришка', clientKey: 'short' }).code, 'BAD_CLIENT_KEY')
  // русские буквы допустимы на входе (переведёт ИИ), но не в подтверждённой теме
  assert.equal(validateInviteInput({ topic: 'Новая крышка Solo V2' }).ok, true)
  assert.equal(validateInviteInput({ topic: 'Новая крышка Solo V2', topicConfirmed: true }).code, 'TOPIC_NOT_UK')
  const v = validateInviteInput({ topic: '  Кришка   для Solo V2 ', phone: '067 123 45 67', name: ' Іван ' })
  assert.equal(v.ok, true)
  assert.deepEqual(
    { topic: v.data.topic, phone: v.data.phone, phoneDigits: v.data.phoneDigits, mode: v.data.mode, deliver: v.data.deliver, source: v.data.source, name: v.data.name },
    { topic: 'Кришка для Solo V2', phone: '+380671234567', phoneDigits: '380671234567', mode: 'knowledge', deliver: 'sms', source: 'other', name: 'Іван' },
  )
  assert.equal(topicProblem('Кришка для Solo V2', { strictUk: true }), null)
})

test('isInboundCall: входящие Binotel/бота — да; исходящие, звонки из приложения, Киевстар без направления — нет', () => {
  assert.equal(isInboundCall({ source: 'binotel-settings', kind: 'incoming', direction: 'inbound' }), true)
  assert.equal(isInboundCall({ lastType: 'call.incoming' }), true)
  assert.equal(isInboundCall({ lastType: 'call.completed' }), true)
  assert.equal(isInboundCall({ source: 'kyivstar', direction: 'incoming' }), true)
  assert.equal(isInboundCall({ source: 'kyivstar', direction: 'outgoing' }), false)
  assert.equal(isInboundCall({ source: 'kyivstar', direction: null, lastType: 'ks.alerting' }), false)
  assert.equal(isInboundCall({ source: 'binotel-originate', kind: 'originate', direction: 'outbound' }), false)
  assert.equal(isInboundCall({ source: 'fmc-originate', kind: 'originate' }), false)
  assert.equal(isInboundCall({}), false)
  assert.equal(maskInviteLink('чат: https://x/c/AbC123', 'AbC123'), 'чат: https://x/c/…')
})

test('SMS: 2 сегмента, тема укорачивается по слову, ссылка целиком', () => {
  const url = inviteUrl('https://my.runferry.com/', 'A'.repeat(16))
  assert.equal(url, 'https://my.runferry.com/c/AAAAAAAAAAAAAAAA')
  const short = inviteSmsText('Кришка для Solo V2', url)
  assert.equal(short, `RunFerry: продовжимо розмову про «Кришка для Solo V2» у чаті: ${url}`)
  assert.equal(smsSegments(short), 2)
  const long = inviteSmsText('Заміна кришки бункера для кораблика Solo V2 після удару об корч на риболовлі', url)
  assert.ok(long.length <= SMS_MAX, `${long.length}`)
  assert.ok(long.endsWith(url))
  assert.match(long, /…» у чаті:/)
  assert.doesNotMatch(long, / …/) // режем по границе слова, без висящего пробела
  assert.equal(smsSegments('а'.repeat(70)), 1)
  assert.equal(smsSegments('а'.repeat(71)), 2)
  assert.equal(smsSegments('а'.repeat(135)), 3)
})

test('история бесед-приглашений начинается со служебной реплики, тема и заметка — в системном блоке', () => {
  const inv = { topic: 'Кришка для Solo V2', details: 'Купив у 2019' }
  const h = withInviteLead([{ role: 'assistant', content: 'Вітаю!' }, { role: 'user', content: '2019' }], inv)
  assert.deepEqual(h[0], { role: 'user', content: inviteOpenedTurn('Кришка для Solo V2') })
  assert.equal(h.length, 3)
  const same = [{ role: 'user', content: 'привіт' }]
  assert.equal(withInviteLead(same, inv), same)
  const block = inviteSystemBlock(inv)
  assert.match(block, /Тема розмови: «Кришка для Solo V2»/)
  assert.match(block, /Купив у 2019/)
  assert.match(block, /не можна надсилати фото/)
  assert.doesNotMatch(inviteSystemBlock({ topic: 'X' }), /Нотатка співробітника/)
})

// ---------- создание ----------

test('владелец: тема переводится, приветствие ИИ уже в сессии, профиль, счётчики, SMS', async () => {
  const db = new FakeDb()
  const anthropic = fakeAnthropic({ topic: () => 'Нова кришка для Solo V2' })
  const notifyClient = fakeNotify()
  const a = make(db, { anthropic, notifyClient })
  const phone = nextPhone()
  const r = await a.createInvite(owner, { topic: 'Новая крышка на Solo V2', details: 'Купил в 2019', phone, name: 'Іван', source: 'phone', clientKey: 'key-00000001' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const inv = r.data
  assert.equal(inv.created, true)
  assert.match(inv.sessionId, /^[A-Za-z0-9]{16}$/)
  assert.equal(inv.url, `https://my.runferry.com/c/${inv.sessionId}`)
  assert.equal(inv.topic, 'Нова кришка для Solo V2')
  assert.equal(inv.topicInput, 'Новая крышка на Solo V2')
  assert.equal(inv.sms.status, 'sent')
  assert.equal(inv.clientKey, undefined) // технические поля не отдаём
  const session = db.get(`chatSessions/${inv.sessionId}`)
  assert.deepEqual(session.invite, { topic: 'Нова кришка для Solo V2', mode: 'knowledge', createdAt: session.createdAt })
  assert.equal(session.channel, 'web')
  assert.deepEqual(session.contact, { name: 'Іван', phone })
  assert.equal(session.messages.length, 1)
  assert.equal(session.messages[0].role, 'ai')
  assert.match(session.messages[0].text, /рік покупки/)
  assert.equal(session.aiUsage.calls, 1)
  const rec = db.get(`chatInvites/${inv.sessionId}`)
  assert.equal(rec.details, 'Купил в 2019')
  assert.equal(rec.opening.source, 'ai')
  assert.equal(rec.by.uid, 'u-o')
  assert.equal(rec.sms.status, 'sent')
  assert.equal(rec.sms.attempts, 1)
  // приветствие: база знаний и тема — в системном промпте, таймаут задан
  const openingCall = anthropic.calls.find((c) => !String(c.params.system).includes('редактор коротких тем'))
  assert.match(openingCall.params.system, /KNOWLEDGE/)
  assert.match(openingCall.params.system, /на магнітах/)
  assert.match(openingCall.params.system, /Нова кришка для Solo V2/)
  assert.equal(openingCall.params.messages[0].role, 'user')
  assert.ok(openingCall.opts.timeout > 0)
  // SMS через журнал: событие chat-invite, ключ = id приглашения, веб-сессия (не Telegram заявки)
  assert.equal(notifyClient.calls.length, 1)
  const n = notifyClient.calls[0]
  assert.equal(n.event, 'chat-invite')
  assert.equal(n.phone, phone)
  assert.equal(n.sessionId, inv.sessionId)
  assert.ok(n.clientKey && !n.clientKey.includes(inv.sessionId)) // ключ журнала — хэш, не сама ссылка
  assert.deepEqual(n.journal, { text: `RunFerry: продовжимо розмову про «Нова кришка для Solo V2» у чаті: https://my.runferry.com/c/…`, sessionId: null })
  assert.equal(n.text, `RunFerry: продовжимо розмову про «Нова кришка для Solo V2» у чаті: ${inv.url}`)
  // профиль клиента и счётчики
  const prof = db.get(`clientProfiles/${digits(phone)}`)
  assert.deepEqual(prof.sessionIds, [inv.sessionId])
  assert.equal(prof.name, 'Іван')
  const day = session.createdAt.slice(0, 10)
  assert.equal(db.get(`chatInviteCounters/staff_u-o_${day}`).count, 1)
  assert.equal(db.get(`chatInviteCounters/phone_${digits(phone)}_${day}`).count, 1)
  assert.equal(db.get(`chatInviteCounters/sms_${day}`).count, 1)
})

test('повтор с тем же ключом — то же приглашение без второго SMS; другое содержимое — 409; упавшая SMS досылается', async () => {
  const db = new FakeDb()
  const notifyClient = fakeNotify('failed')
  const a = make(db, { notifyClient })
  const phone = nextPhone()
  const params = { topic: 'Кришка для Solo V2', phone, clientKey: 'key-00000002', topicConfirmed: true }
  const first = await a.createInvite(owner, params)
  assert.equal(first.ok, true)
  assert.equal(first.data.sms.status, 'failed')
  assert.equal(first.data.sms.error, 'gateway down')
  // повтор: SMS не ушла → досылаем (журнал идемпотентен по id приглашения)
  const again = await a.createInvite(owner, params)
  assert.equal(again.ok, true)
  assert.equal(again.data.created, false)
  assert.equal(again.data.sessionId, first.data.sessionId)
  assert.equal(notifyClient.calls.length, 2)
  assert.equal(db.get(`chatInvites/${first.data.sessionId}`).sms.attempts, 2)
  assert.equal(db.list('chatSessions').length, 1)
  // успешная SMS — повтор больше не шлёт
  const okDb = new FakeDb()
  const okNotify = fakeNotify('sent')
  const b = make(okDb, { notifyClient: okNotify })
  const p2 = { ...params, phone: nextPhone() }
  const r1 = await b.createInvite(owner, p2)
  const r2 = await b.createInvite(owner, p2)
  assert.equal(r2.data.created, false)
  assert.equal(r2.data.sessionId, r1.data.sessionId)
  assert.equal(okNotify.calls.length, 1)
  assert.equal((await b.createInvite(owner, { ...p2, topic: 'Інша тема' })).code, 'KEY_REUSED')
})

test('SMS на любой номер — все роли приглашения (решение владельца 2026-10-23), дневной лимит сотрудника действует', async () => {
  const db = new FakeDb()
  const a = make(db)
  const base = { topic: 'Кришка для Solo V2', topicConfirmed: true }
  for (const who of [owner, master, operator, { uid: 'u-d', email: 'd@x', role: 'director', centers: [] }]) {
    const r = await a.createInvite(who, { ...base, phone: nextPhone() })
    assert.equal(r.ok, true, `${who.role}: ${JSON.stringify(r)}`)
    assert.equal(r.data.sms.status, 'sent')
  }
  const day = new Date().toISOString().slice(0, 10)
  db.docs[`chatInviteCounters/staff_u-m_${day}`] = { count: LIMITS.staffPerDay }
  assert.equal((await a.createInvite(master, { ...base, phone: nextPhone() })).code, 'DAILY_LIMIT')
  assert.equal((await a.createInvite(accountant, { ...base, phone: nextPhone() })).code, 'FORBIDDEN')
})

test('суженное правило (CHAT_INVITE_ANY_PHONE_ROLES=owner): мастер — номер своей заявки или недавнего входящего; оператор — входящего', async () => {
  const callPhone = nextPhone()
  const oldCallPhone = nextPhone()
  const outPhone = nextPhone() // наш исходящий звонок не открывает SMS на номер
  const srPhone = nextPhone()
  const recent = new Date(Date.now() - 3600 * 1000).toISOString()
  const old = new Date(Date.now() - (LIMITS.recentCallHours + 5) * 3600 * 1000).toISOString()
  const db = new FakeDb({
    'callEvents/c1': { phone: callPhone, at: recent, source: 'binotel-settings', kind: 'incoming', direction: 'inbound' },
    'callEvents/c2': { phone: oldCallPhone, at: old, source: 'binotel-settings', kind: 'incoming', direction: 'inbound' },
    'callEvents/c4': { phone: outPhone, at: recent, source: 'binotel-originate', kind: 'originate', direction: 'outbound' },
    'serviceRequests/sr-1': { serviceCenterId: 'kat', clientPhone: srPhone.replace('+380', '0') },
    'serviceRequests/sr-k': { serviceCenterId: 'kyiv', clientPhone: nextPhone() },
  })
  const a = make(db, { anyPhoneRoles: ['owner'] })
  const base = { topic: 'Кришка для Solo V2', topicConfirmed: true }
  assert.equal((await a.createInvite(master, { ...base, phone: nextPhone() })).code, 'PHONE_NOT_ALLOWED')
  assert.equal((await a.createInvite(master, { ...base, phone: oldCallPhone })).code, 'PHONE_NOT_ALLOWED')
  assert.equal((await a.createInvite(master, { ...base, phone: outPhone })).code, 'PHONE_NOT_ALLOWED')
  assert.equal((await a.createInvite(master, { ...base, phone: callPhone })).ok, true)
  // заявка своего центра: номер по умолчанию — клиента заявки
  const bySr = await a.createInvite(master, { ...base, serviceRequestId: 'sr-1' })
  assert.equal(bySr.ok, true, JSON.stringify(bySr))
  assert.equal(bySr.data.phone, srPhone)
  assert.equal(bySr.data.serviceCenterId, 'kat')
  assert.equal((await a.createInvite(master, { ...base, serviceRequestId: 'sr-k' })).code, 'OTHER_CENTER')
  assert.equal((await a.createInvite(master, { ...base, serviceRequestId: 'nope' })).code, 'NO_SR')
  assert.equal((await a.createInvite(operator, { ...base, phone: nextPhone() })).code, 'PHONE_NOT_ALLOWED')
  const opCall = nextPhone()
  db.docs['callEvents/c3'] = { phone: opCall, at: recent, lastType: 'call.incoming' }
  assert.equal((await a.createInvite(operator, { ...base, phone: opCall })).ok, true)
  // ссылка без SMS — любой сотрудник из ролей приглашения, номер не обязателен
  const link = await a.createInvite(master, { ...base, deliver: 'none' })
  assert.equal(link.ok, true)
  assert.equal(link.data.sms.status, 'skipped')
  assert.equal(link.data.phone, null)
  assert.equal((await a.createInvite(accountant, { ...base, deliver: 'none' })).code, 'FORBIDDEN')
})

test('лимиты: номер за сутки, бюджет SMS, сотрудник за сутки', async () => {
  const day = new Date().toISOString().slice(0, 10)
  const phone = nextPhone()
  const db = new FakeDb({ [`chatInviteCounters/phone_${digits(phone)}_${day}`]: { count: LIMITS.phonePerDay } })
  const ai = fakeAnthropic()
  const a = make(db, { anthropic: ai })
  assert.equal((await a.createInvite(owner, { topic: 'Новая крышка', phone })).code, 'PHONE_LIMIT')
  assert.equal(ai.calls.length, 0) // лимит исчерпан — ни перевода темы, ни приветствия (платные вызовы ИИ)
  assert.equal((await a.createInvite(owner, { topic: 'Новая крышка', phone, dryRun: true })).code, 'PHONE_LIMIT')
  assert.equal(ai.calls.length, 0)
  assert.equal(db.list('chatSessions').length, 0)
  const db2 = new FakeDb({ [`chatInviteCounters/sms_${day}`]: { count: LIMITS.smsPerDay } })
  assert.equal((await make(db2).createInvite(owner, { topic: 'Кришка', phone: nextPhone(), topicConfirmed: true })).code, 'SMS_BUDGET')
  // ссылка без SMS бюджет SMS не тратит
  assert.equal((await make(db2).createInvite(owner, { topic: 'Кришка', deliver: 'none', topicConfirmed: true })).ok, true)
  const db3 = new FakeDb({ [`chatInviteCounters/staff_u-o_${day}`]: { count: LIMITS.ownerPerDay } })
  assert.equal((await make(db3).createInvite(owner, { topic: 'Кришка', deliver: 'none', topicConfirmed: true })).code, 'DAILY_LIMIT')
})

test('dryRun: итоговая тема и текст SMS без записи; ИИ недоступен — русская тема не проходит', async () => {
  const db = new FakeDb()
  const a = make(db, { anthropic: fakeAnthropic({ topic: () => 'Нова кришка для Solo V2' }) })
  const phone = nextPhone()
  const r = await a.createInvite(owner, { topic: 'Новая крышка Solo V2', phone, dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.data.dryRun, true)
  assert.equal(r.data.topic, 'Нова кришка для Solo V2')
  assert.equal(r.data.topicChanged, true)
  assert.equal(r.data.smsText, `RunFerry: продовжимо розмову про «Нова кришка для Solo V2» у чаті: https://my.runferry.com/c/${'X'.repeat(16)}`)
  assert.equal(r.data.smsSegments, 2)
  assert.deepEqual(Object.keys(db.docs), [])
  const noAi = make(new FakeDb(), { anthropic: null })
  assert.equal((await noAi.createInvite(owner, { topic: 'Новая крышка Solo V2', phone: nextPhone() })).code, 'TOPIC_NOT_UK')
  // ИИ вернул тему со ссылкой — не берём, остаётся исходная (украинская)
  const sneaky = make(new FakeDb(), { anthropic: fakeAnthropic({ topic: () => 'Кришка www.evil.com' }) })
  const s = await sneaky.createInvite(owner, { topic: 'Кришка для Solo V2', phone: nextPhone(), dryRun: true })
  assert.equal(s.data.topic, 'Кришка для Solo V2')
})

test('ИИ упал — запасное приветствие, приглашение всё равно создано', async () => {
  const db = new FakeDb()
  const a = make(db, { anthropic: fakeAnthropic({ fail: true }) })
  const r = await a.createInvite(owner, { topic: 'Кришка для Solo V2', deliver: 'none', topicConfirmed: true })
  assert.equal(r.ok, true)
  const s = db.get(`chatSessions/${r.data.sessionId}`)
  assert.match(s.messages[0].text, /^Вітаємо! Це чат RunFerry щодо «Кришка для Solo V2»/)
  assert.equal(s.aiUsage, undefined)
  assert.equal(db.get(`chatInvites/${r.data.sessionId}`).opening.source, 'fallback')
})

test('обрезанный ответ ИИ (max_tokens) — запасное приветствие, а не сырой JSON', async () => {
  const db = new FakeDb()
  const r = await make(db, { anthropic: fakeAnthropic({ openingStop: 'max_tokens' }) }).createInvite(owner, { topic: 'Кришка для Solo V2', deliver: 'none', topicConfirmed: true })
  assert.equal(r.ok, true)
  const s = db.get(`chatSessions/${r.data.sessionId}`)
  assert.doesNotMatch(s.messages[0].text, /\{"reply"/)
  assert.equal(db.get(`chatInvites/${r.data.sessionId}`).opening.source, 'fallback')
})

test('подтверждённая тема: исходная формулировка сотрудника сохраняется (topicInput)', async () => {
  const db = new FakeDb()
  const r = await make(db).createInvite(owner, { topic: 'Нова кришка для Solo V2', topicInput: 'Новая крышка на Solo V2', topicConfirmed: true, deliver: 'none' })
  assert.equal(r.ok, true)
  assert.equal(r.data.topicInput, 'Новая крышка на Solo V2')
  assert.equal(db.get(`chatInvites/${r.data.sessionId}`).topic, 'Нова кришка для Solo V2')
})

test('досылка SMS при повторах — не больше 3 попыток', async () => {
  const notifyClient = fakeNotify('failed')
  const a = make(new FakeDb(), { notifyClient })
  const params = { topic: 'Кришка', phone: nextPhone(), clientKey: 'key-00000009', topicConfirmed: true }
  for (let i = 0; i < 6; i++) await a.createInvite(owner, params)
  assert.equal(notifyClient.calls.length, 3)
})

test('профиль: имя настоящего владельца номера не затирается, беседы копятся', async () => {
  const phone = nextPhone()
  const db = new FakeDb({ [`clientProfiles/${digits(phone)}`]: { id: digits(phone), phone: digits(phone), name: 'Петро Іваненко', sessionIds: ['old-1'] } })
  const r = await make(db).createInvite(owner, { topic: 'Кришка', phone, name: 'Хтось інший', deliver: 'none', topicConfirmed: true })
  assert.equal(r.ok, true)
  const prof = db.get(`clientProfiles/${digits(phone)}`)
  assert.equal(prof.name, 'Петро Іваненко')
  assert.deepEqual(prof.sessionIds, ['old-1', r.data.sessionId])
})

// ---------- открытие, чтение ----------

test('open: отметка «відкрито» один раз; неверный id — 400, чужой — 404; inviteFor / getInvite', async () => {
  const db = new FakeDb()
  const a = make(db)
  const r = await a.createInvite(master, { topic: 'Кришка', deliver: 'none', topicConfirmed: true, details: 'нотатка' })
  const id = r.data.sessionId
  assert.equal((await a.openInvite('bad')).code, 'BAD_ID')
  assert.equal((await a.openInvite('A'.repeat(16))).code, 'NOT_FOUND')
  assert.equal((await a.openInvite(id)).ok, true)
  const first = db.get(`chatInvites/${id}`).openedAt
  assert.ok(first)
  await new Promise((res) => setTimeout(res, 5))
  await a.openInvite(id)
  assert.equal(db.get(`chatInvites/${id}`).openedAt, first)
  assert.equal((await a.inviteFor(id)).details, 'нотатка')
  assert.equal(await a.inviteFor('../x'), null)
  assert.equal(await a.inviteFor('A'.repeat(16)), null)
  assert.equal((await a.getInvite(owner, id)).ok, true)
  assert.equal((await a.getInvite(master, id)).ok, true)
  assert.equal((await a.getInvite(operator, id)).code, 'FORBIDDEN')
})

// ---------- HTTP ----------

test('HTTP: создание — сотрудник (201), без токена — 403; открытие — публично', async () => {
  const db = new FakeDb()
  const app = express()
  app.use(express.json())
  registerChatInvites(app, {
    adminDb: db, siteUrl: 'https://my.runferry.com', core, anthropic: fakeAnthropic(), AI_MODEL: 'm', KNOWLEDGE_SYSTEM: 'K', buildUsage,
    notifyClient: fakeNotify(), verifyStaff: async (req) => (req.get('authorization') === 'Bearer owner' ? owner : null),
  })
  const server = app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const post = (path, body, auth) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) })
    const denied = await post('/api/chat-invites', { topic: 'Кришка' })
    assert.equal(denied.status, 403)
    const created = await post('/api/chat-invites', { topic: 'Кришка для Solo V2', phone: nextPhone() }, 'Bearer owner')
    assert.equal(created.status, 201)
    const body = await created.json()
    assert.equal(body.success, true)
    assert.equal(body.data.sms.status, 'sent')
    const bad = await post('/api/chat-invites', { topic: 'x' }, 'Bearer owner')
    assert.equal(bad.status, 400)
    const staffView = await post('/api/chat-invites/open', { sessionId: body.data.sessionId }, 'Bearer owner')
    assert.equal((await staffView.json()).data.staffView, true) // сотрудник открыл для проверки — не «клієнт відкрив»
    assert.equal(db.get(`chatInvites/${body.data.sessionId}`).openedAt, null)
    const opened = await post('/api/chat-invites/open', { sessionId: body.data.sessionId })
    assert.equal(opened.status, 200)
    assert.equal((await opened.json()).data.opened, true)
    const got = await post('/api/chat-invites/get', { sessionId: body.data.sessionId }, 'Bearer owner')
    assert.ok((await got.json()).data.openedAt)
  } finally {
    server.close()
  }
})

// ---------- интеграция с ядром мессенджеров и журналом ----------

test('ответ бота по упоминанию менеджера в беседе-приглашении: тема в промпте, история с user', async () => {
  const calls = []
  const anthropic = { messages: { async create(p) { calls.push(p); return { content: [{ type: 'text', text: JSON.stringify({ reply: 'Ок', needsManager: false, intent: 'service', wantsServiceRequest: false }) }], usage: {} } } } }
  const coreM = createMessengerCore({
    adminDb: new FakeDb(), anthropic, AI_MODEL: 'm', CHAT_SYSTEM: 'SYS', buildUsage,
    mergeConsecutiveMessages: (msgs) => msgs.reduce((acc, m) => { const l = acc[acc.length - 1]; if (l && l.role === m.role) l.content += '\n\n' + m.content; else acc.push({ ...m }); return acc }, []),
    inviteFor: async (id) => (id === 'AAAAAAAAAAAAAAAA' ? { topic: 'Кришка для Solo V2', details: null } : null),
  })
  const session = {
    id: 'AAAAAAAAAAAAAAAA', invite: { topic: 'Кришка для Solo V2', mode: 'knowledge', createdAt: 'x' },
    messages: [{ role: 'ai', text: 'Вітаю! Який рік?' }, { role: 'client', text: '2019' }, { role: 'manager', text: 'бот, допоможи' }],
  }
  const r = await coreM.aiReply(session, { managerDirective: 'бот, допоможи' })
  assert.equal(r.reply, 'Ок')
  assert.equal(calls.length, 1)
  assert.match(calls[0].system, /Тема розмови: «Кришка для Solo V2»/)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.match(calls[0].messages[0].content, /перейшла за запрошенням/)
  assert.equal(calls[0].messages[calls[0].messages.length - 1].content, '2019')
})

test('журнал: chat-invite без заявки идемпотентен по ключу — второй вызов не шлёт второй SMS', async () => {
  const db = new FakeDb({ 'chatSessions/AAAAAAAAAAAAAAAA': { id: 'AAAAAAAAAAAAAAAA', channel: 'web', messages: [] } })
  const sent = []
  const { notifyClient } = registerNotifications({ post() {} }, { adminDb: db, sendSms: async (to, text) => { sent.push({ to, text }); return { ok: true } } })
  const args = { event: 'chat-invite', text: 'RunFerry: тест https://x/c/AAAAAAAAAAAAAAAA', phone: '+380671234567', sessionId: 'AAAAAAAAAAAAAAAA', clientKey: 'ciHASHHASH01', by: 'o@x', journal: { text: 'RunFerry: тест https://x/c/…', sessionId: null } }
  const a = await notifyClient(args)
  assert.equal(a.status, 'sent')
  assert.equal(a.channel, 'sms')
  assert.equal(a.event, 'chat-invite')
  assert.equal(a.id, 'ntf-na-chat-invite-ciHASHHASH01')
  // в журнале (его читает весь персонал) — без ссылки-доступа и id сессии; клиенту — полный текст
  assert.equal(db.get(`notifications/${a.id}`).text, 'RunFerry: тест https://x/c/…')
  assert.equal(db.get(`notifications/${a.id}`).sessionId, null)
  const b = await notifyClient(args)
  assert.equal(b.skipped, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'RunFerry: тест https://x/c/AAAAAAAAAAAAAAAA')
})
