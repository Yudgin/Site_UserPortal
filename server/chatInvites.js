// Приглашение человека в чат с ИИ по заранее известной теме (инструмент «ссылка + SMS»).
//
// Сотрудник (портал, приложение «RunFerry Сервіс», бот, доска оператора) уже знает, о чём будет разговор
// («Кришка для Solo V2» — у Solo V2 за годы было несколько вариантов крышки, нужны уточнения), и приглашает
// человека в чат на нашем портале. Сервер:
//   1) приводит тему к украинскому (её видит клиент; сотрудники пишут и по-русски) — dryRun показывает итог;
//   2) СРАЗУ готовит первое сообщение ИИ (приветствие + уточняющие вопросы по базе знаний) — человек открывает
//      ссылку и видит готовые вопросы, без публичного вызова ИИ и без гонки с его первым сообщением;
//   3) создаёт сессию chatSessions/{id} (ссылка ${SITE_URL}/c/{id}) и шлёт SMS через notifyClient.
// Дальше чат идёт обычным путём (/api/ai/knowledge-chat | estimate-chat), а сервер по sessionId подмешивает тему.
//
// Данные (всё пишет только сервер, Admin SDK):
//   • chatSessions/{id}.invite — КЛИЕНТСКИЙ блок {topic, mode, createdAt}: виден по ссылке, неизменяем;
//   • chatInvites/{id} — служебная запись (заметка для ИИ, кто/откуда пригласил, телефон, SMS, «відкрито»);
//     ИИ доверяет ТОЛЬКО ей, а не сессии, которую клиент может дописывать;
//   • chatInviteKeys/{uid}_{clientKey} — идемпотентность: повтор запроса возвращает то же приглашение (и досылает
//     SMS, если она не ушла), а не создаёт второе;
//   • chatInviteCounters/{…}_{день} — дневные лимиты (сотрудник, номер, все SMS), общие для инстансов Cloud Run.
// SMS — платный шлюз с альфа-именем RUNFERRY: на произвольный номер — только роли CHAT_INVITE_ANY_PHONE_ROLES
// (по умолчанию владелец), остальным — номер клиента заявки своего центра или номер, звонивший нам недавно.
// Вызов из бота в этом же процессе — actions.createInvite(staff, params); из приложения/портала — POST /api/chat-invites.
import crypto from 'crypto'
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'
import { normalizePhone, genMsgId } from './messengerCore.js'
import { inviteUrl, inviteSmsText, smsSegments, fallbackOpening, inviteSystemBlock, openingRequest } from './chatInvitePrompt.js'

const nowIso = () => new Date().toISOString()
const fail = (status, code, message) => ({ ok: false, status, code, message })
const ok = (data) => ({ ok: true, data })

export const INVITE_ROLES = ['owner', 'director', 'master', 'operator']
export const INVITE_MODES = ['knowledge', 'estimate']
export const INVITE_SOURCES = ['portal', 'app', 'bot', 'phone', 'other']
export const TOPIC_MIN = 3
export const TOPIC_MAX = 80
export const DETAILS_MAX = 2000
export const NAME_MAX = 80
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
export const SESSION_ID_RE = /^[A-Za-z0-9]{16}$/
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/
const UA_PHONE_RE = /^380\d{9}$/
const PREVIEW_ID = 'X'.repeat(16) // ссылка в превью SMS той же длины, что настоящая
const RESEND_AFTER_MS = 60 * 1000 // «pending» дольше минуты — отправка оборвалась, повтор её досылает
const MAX_SMS_ATTEMPTS = 3 // досылка при повторах — не бесконечно (шлюз мог принять SMS и ответить тайм-аутом)
const envInt = (name, def) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : def
}
export const LIMITS = {
  staffPerMin: envInt('CHAT_INVITE_PER_MIN', 5),
  staffPerDay: envInt('CHAT_INVITE_PER_DAY', 40),
  ownerPerDay: envInt('CHAT_INVITE_OWNER_PER_DAY', 200),
  phonePerDay: envInt('CHAT_INVITE_PHONE_PER_DAY', 3), // SMS-приглашений на один номер в сутки
  smsPerDay: envInt('CHAT_INVITE_SMS_PER_DAY', 150), // все SMS-приглашения за сутки (бюджет шлюза)
  recentCallHours: envInt('CHAT_INVITE_RECENT_CALL_HOURS', 48),
}
const ANY_PHONE_ROLES = String(process.env.CHAT_INVITE_ANY_PHONE_ROLES || 'owner').split(',').map((s) => s.trim()).filter(Boolean)

// Зеркало src/utils/id.ts secureId: 16 символов base62 (crypto) — ссылка защищена самим id.
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const secureId = (len = 16) => Array.from({ length: len }, () => CHARS[crypto.randomInt(CHARS.length)]).join('')
export const reqHash = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('base64url').slice(0, 22)

const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
// Буквы, которых нет в украинском: тема уходит клиенту (SMS, шапка чата) — только государственным языком.
const NOT_UKRAINIAN_RE = /[ыэъёЫЭЪЁ]/
// Тема идёт в SMS под нашим именем: никаких ссылок, адресов и номеров (телефон, карта) — защита от фишинга.
// Адрес — любое «слово.слово» с буквенным окончанием (bit.ly, t.co, приват.укр, runferry.pro/pay), ://, www., @.
const LINKY_RE = /(https?:|:\/\/|www\.|@|[\p{L}\d-]\.\p{L}{2,})/iu
// Номер — 9+ цифр подряд, в том числе с пробелами/точками/дефисами/скобками между ними («4149 4993 1234 5678»,
// «067 123 45 67»); годы и модели («2019–2020», «Solo V2») проходят.
const longDigitRun = (t) => (String(t).match(/\d[\d\s().-]*\d/g) || []).some((run) => run.replace(/\D/g, '').length >= 9)

// Проблема темы (fail) или null. strictUk — ещё и только украинские буквы (после перевода / подтверждённая тема).
export const topicProblem = (topic, { strictUk = false } = {}) => {
  if (topic.length < TOPIC_MIN) return fail(400, 'NO_TOPIC', 'Вкажіть тему розмови (наприклад «Кришка для Solo V2»).')
  if (topic.length > TOPIC_MAX) return fail(400, 'TOPIC_TOO_LONG', `Тема задовга (до ${TOPIC_MAX} символів) — подробиці напишіть у нотатці для помічника.`)
  if (LINKY_RE.test(topic) || longDigitRun(topic)) return fail(400, 'TOPIC_HAS_LINK', 'У темі не можна вказувати посилання, адреси чи довгі номери — вона йде клієнту в SMS.')
  if (strictUk && NOT_UKRAINIAN_RE.test(topic)) return fail(400, 'TOPIC_NOT_UK', 'Тему пишіть українською — її бачить клієнт у SMS і в чаті.')
  return null
}

// ---------- чистые функции ----------

// Входящий звонок клиента (а не наш исходящий/звонок из приложения): только он открывает SMS на «номер недавнего
// звонка». Зеркало Binotel — direction 'inbound' / kind 'incoming'; зеркало операторского бота (/api/calls/event)
// — без направления и источника, lastType call.incoming|call.completed; Киевстар без направления — не считаем.
const OUT_DIR_RE = /^(out|outbound|outgoing)$/i
const IN_DIR_RE = /^(in|inbound|incoming)$/i
export const isInboundCall = (ev) => {
  if (!ev) return false
  const dir = String(ev.direction || '')
  if (ev.kind === 'originate' || /originate/i.test(String(ev.source || '')) || OUT_DIR_RE.test(dir)) return false
  if (ev.kind === 'incoming' || IN_DIR_RE.test(dir)) return true
  return !ev.source && !dir && /^call\.(incoming|completed)$/.test(String(ev.lastType || ''))
}

// Проверка и нормализация параметров приглашения. Возвращает ok(params) или fail(…).
export const validateInviteInput = (p = {}) => {
  const topic = oneLine(p.topic)
  const tp = topicProblem(topic, { strictUk: p.topicConfirmed === true })
  if (tp) return tp
  const details = String(p.details ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim()
  if (details.length > DETAILS_MAX) return fail(400, 'DETAILS_TOO_LONG', `Нотатка задовга (до ${DETAILS_MAX} символів).`)
  const rawPhone = oneLine(p.phone)
  const digits = rawPhone ? normalizePhone(rawPhone) : ''
  if (rawPhone && !UA_PHONE_RE.test(digits)) return fail(400, 'BAD_PHONE', 'Некоректний номер — потрібен український номер (+380…).')
  const serviceRequestId = p.serviceRequestId ? String(p.serviceRequestId) : null
  if (serviceRequestId && !ID_RE.test(serviceRequestId)) return fail(400, 'BAD_REQUEST_ID', 'Некоректний id заявки.')
  const clientKey = p.clientKey ? String(p.clientKey) : null
  if (clientKey && !CLIENT_KEY_RE.test(clientKey)) return fail(400, 'BAD_CLIENT_KEY', 'Некоректний clientKey (8–64 символи A-Z a-z 0-9 _ -).')
  return ok({
    topic,
    topicConfirmed: p.topicConfirmed === true,
    // Как тему написал сотрудник до перевода (dryRun → подтверждение): для разбора неудачных переводов.
    topicInput: oneLine(p.topicInput).slice(0, TOPIC_MAX * 2) || null,
    details,
    name: oneLine(p.name).slice(0, NAME_MAX),
    phoneDigits: digits || null, // ключ clientProfiles (380…)
    phone: digits ? `+${digits}` : null, // канонический вид заявок, журнала и callEvents (+380…)
    mode: INVITE_MODES.includes(p.mode) ? p.mode : 'knowledge',
    source: INVITE_SOURCES.includes(p.source) ? p.source : 'other',
    deliver: p.deliver === 'none' ? 'none' : 'sms',
    serviceRequestId,
    clientKey,
    dryRun: p.dryRun === true,
  })
}

// Отпечаток запроса для идемпотентности: тот же clientKey с другим содержимым — ошибка, а не старый результат.
const hashOf = (p) => reqHash({ t: p.topic, ti: p.topicInput, d: p.details, ph: p.phone, n: p.name, m: p.mode, dl: p.deliver, sr: p.serviceRequestId })

// Ссылка на чат — это доступ к нему: в общих журналах вместо id — «…».
export const maskInviteLink = (text, sessionId) => String(text || '').split(String(sessionId)).join('…')

// Что видит сотрудник (служебная запись без технических полей).
const inviteView = (rec) => {
  if (!rec) return null
  const { clientKey, reqHash: _h, ...rest } = rec
  void clientKey
  void _h
  return rest
}

const TOPIC_SYSTEM = [
  'Ти — редактор коротких тем звернень для клієнтів сервісного центру RunFerry (прикормочні рибальські кораблики).',
  'Отримаєш тему розмови, яку записав співробітник (може бути російською, з помилками чи скороченнями).',
  'Поверни ту саму тему УКРАЇНСЬКОЮ: коротко (до 60 символів), з великої літери, без лапок і крапки в кінці.',
  'Назви моделей і брендів (Solo V2, Камарад, RunFerry тощо) залиш як є. Якщо тема вже українською й коректна — поверни її без змін.',
  'Нічого не додавай від себе і не змінюй змісту; посилань, номерів і контактів не додавай.',
].join('\n')

const correctionsText = (list) => (list.length
  ? `\n\nДОДАТКОВІ ПРАВИЛА (корекції поведінки, дотримуйся їх):\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
  : '')

// Простой минутный лимит в памяти (первый рубеж; дневные — в Firestore). Внутри действий, а не middleware:
// повтор с тем же ключом и ошибка валидации его не тратят, а вызовы из бота тоже под ним.
const minuteHits = new Map()
const minuteAllow = (key, max) => {
  const now = Date.now()
  const arr = (minuteHits.get(key) || []).filter((t) => now - t < 60 * 1000)
  if (arr.length >= max) { minuteHits.set(key, arr); return false }
  arr.push(now)
  minuteHits.set(key, arr)
  if (minuteHits.size > 5000) for (const [k, v] of minuteHits) if (!v.some((t) => now - t < 60 * 1000)) minuteHits.delete(k)
  return true
}

// ---------- действия ----------

// deps: { adminDb, notifyClient?, siteUrl, core?: { buildKnowledgeContext }, anthropic?, AI_MODEL, KNOWLEDGE_SYSTEM, buildUsage }
export function createChatInviteActions(deps) {
  const { adminDb, notifyClient, siteUrl = 'https://my.runferry.com', core, anthropic, AI_MODEL, KNOWLEDGE_SYSTEM = '', buildUsage = () => null } = deps
  const invites = () => adminDb.collection('chatInvites')
  const sessions = () => adminDb.collection('chatSessions')
  const counters = () => adminDb.collection('chatInviteCounters')

  // Можно ли этому сотруднику слать SMS на этот номер (см. шапку файла).
  async function smsPhoneAllowed(staff, phone, phoneDigits, sr) {
    if (ANY_PHONE_ROLES.includes(staff.role)) return true
    if (sr && normalizePhone(sr.clientPhone) === phoneDigits) return true
    try {
      const snap = await adminDb.collection('callEvents').where('phone', '==', phone).get()
      const since = Date.now() - LIMITS.recentCallHours * 3600 * 1000
      return snap.docs.some((d) => {
        const ev = d.data() || {}
        const at = Date.parse(ev.at || '')
        return Number.isFinite(at) && at >= since && isInboundCall(ev)
      })
    } catch (e) {
      console.error('chat-invite recent call check:', e?.message || e)
      return false
    }
  }

  // Тема по-украински (ИИ). Не вышло / результат не прошёл проверки — исходная тема (её проверит strictUk).
  async function normalizeTopic(topic) {
    if (!anthropic) return topic
    try {
      const msg = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 200,
        system: TOPIC_SYSTEM,
        messages: [{ role: 'user', content: topic }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: { type: 'object', additionalProperties: false, properties: { topic: { type: 'string' } }, required: ['topic'] },
          },
        },
      }, { timeout: 15000, maxRetries: 1 })
      const raw = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      const t = oneLine(JSON.parse(raw).topic).replace(/^[«"']+|[»"'.]+$/g, '').trim()
      return t && !topicProblem(t, { strictUk: true }) ? t : topic
    } catch (e) {
      console.error('chat-invite topic AI:', e?.message || e)
      return topic
    }
  }

  const loadCorrections = async (scope) => {
    try {
      const snap = await adminDb.collection('behaviorCorrections').where('active', '==', true).get()
      return snap.docs.map((d) => d.data()).filter((c) => c && c.instruction && (c.scope === 'all' || c.scope === scope)).map((c) => String(c.instruction))
    } catch (e) {
      console.error('chat-invite corrections:', e?.message || e)
      return []
    }
  }

  // Первое сообщение ИИ (приветствие и уточняющие вопросы). Контекст — НА СЕРВЕРЕ: база знаний без статей
  // «для мастеров» (messengerCore.buildKnowledgeContext), правки поведения, тема и заметка приглашения.
  async function generateOpening(inv) {
    const [knowledge, corr] = await Promise.all([
      core && core.buildKnowledgeContext ? core.buildKnowledgeContext() : '',
      loadCorrections(inv.mode === 'estimate' ? 'estimate' : 'consultation'),
    ])
    const system = KNOWLEDGE_SYSTEM
      + (knowledge ? `\n\nБАЗА ЗНАНЬ (використовуй лише ці матеріали):\n${knowledge}` : '')
      + correctionsText(corr) + inviteSystemBlock(inv)
    const msg = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: openingRequest(inv.topic) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { reply: { type: 'string', description: 'Перше повідомлення клієнту українською' } },
            required: ['reply'],
          },
        },
      },
    }, { timeout: 30000, maxRetries: 0 }) // не дождались — запасное приветствие, сотрудник не ждёт минутами
    // Обрезанный/битый ответ — не сырой JSON клиенту, а исключение → запасное приветствие.
    if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'refusal') throw new Error(`opening stop_reason=${msg.stop_reason}`)
    const raw = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    const reply = String(JSON.parse(raw).reply || '')
    return { reply: reply.trim(), usage: buildUsage(msg.usage) }
  }
  const openingOrFallback = async (inv) => {
    if (anthropic) {
      try {
        const r = await generateOpening(inv)
        if (r.reply) return { text: r.reply, usage: r.usage, source: 'ai' }
      } catch (e) {
        console.error('chat-invite opening AI:', e?.message || e)
      }
    }
    return { text: fallbackOpening(inv.topic), usage: null, source: 'fallback' }
  }

  // SMS по служебной записи. Журнал notifications идемпотентен по id приглашения (clientKey = sessionId):
  // повторная попытка не задвоит SMS, если первая уже ушла или ещё идёт.
  async function sendInviteSms(rec, byLabel) {
    let sms = { ...rec.sms, attempts: (Number(rec.sms && rec.sms.attempts) || 0) + 1, lastAttemptAt: nowIso() }
    if (typeof notifyClient !== 'function') {
      sms = { ...sms, status: 'failed', error: 'SMS не налаштовано' }
    } else {
      try {
        const n = await notifyClient({
          event: 'chat-invite',
          text: rec.sms.text,
          phone: rec.phone,
          sessionId: rec.sessionId, // веб-сессия: мессенджера нет → гарантированно SMS (не Telegram заявки)
          serviceRequestId: rec.serviceRequestId,
          by: byLabel,
          // Журнал оповещений читает весь персонал, а ссылка на чат — это доступ к нему: в журнал — ключ-хэш id,
          // текст с замаскированной ссылкой и без id сессии (связь — chatInvites.sms.notificationId).
          clientKey: `ci${reqHash({ s: rec.sessionId })}`,
          journal: { text: maskInviteLink(rec.sms.text, rec.sessionId), sessionId: null },
        })
        const status = n?.status === 'sent' ? 'sent' : n?.status === 'pending' ? 'pending' : 'failed'
        sms = { ...sms, status, error: status === 'failed' ? (n?.error || 'не вдалося надіслати') : null, notificationId: n?.id || null }
      } catch (e) {
        sms = { ...sms, status: 'failed', error: e?.message || String(e) }
      }
    }
    await invites().doc(rec.sessionId).set({ sms }, { merge: true })
    return sms
  }
  const needsResend = (rec) => rec.deliver === 'sms' && rec.sms && (Number(rec.sms.attempts) || 0) < MAX_SMS_ATTEMPTS && (rec.sms.status === 'failed'
    || (rec.sms.status === 'pending' && Date.now() - (Date.parse(rec.sms.lastAttemptAt || rec.createdAt || '') || 0) > RESEND_AFTER_MS))

  // Повтор запроса с тем же clientKey: то же приглашение; SMS досылается, если не ушла.
  async function replay(staff, key, p) {
    if (key.reqHash !== hashOf(p)) return fail(409, 'KEY_REUSED', 'Цей clientKey уже використано для іншого запрошення.')
    const s = await invites().doc(String(key.sessionId)).get()
    if (!s.exists) return fail(404, 'NOT_FOUND', 'Запрошення не знайдено.')
    let rec = s.data()
    if (needsResend(rec)) rec = { ...rec, sms: await sendInviteSms(rec, staff.email || staff.uid) }
    return ok({ ...inviteView(rec), created: false })
  }

  // Создать приглашение (или dryRun — показать итоговую тему и текст SMS). staff = { uid, email, role, centers }.
  async function createInvite(staff, params = {}) {
    if (!staff || !INVITE_ROLES.includes(staff.role)) return fail(403, 'FORBIDDEN', 'Немає права запрошувати в чат.')
    const v = validateInviteInput(params)
    if (!v.ok) return v
    const p = v.data
    const byLabel = staff.email || staff.uid

    // 1) Повтор с тем же ключом — до любых лимитов и вызовов ИИ.
    const keyRef = p.clientKey ? adminDb.collection('chatInviteKeys').doc(`${staff.uid}_${p.clientKey}`) : null
    if (keyRef && !p.dryRun) {
      const ks = await keyRef.get()
      if (ks.exists) return replay(staff, ks.data(), p)
    }

    // 2) Заявка (необязательно): существует и — для не-владельца — своего центра. Номер по умолчанию — из неё.
    let sr = null
    if (p.serviceRequestId) {
      const s = await adminDb.collection('serviceRequests').doc(p.serviceRequestId).get()
      if (!s.exists) return fail(404, 'NO_SR', 'Заявку не знайдено.')
      sr = s.data()
      const own = staff.role === 'owner' || (!!sr.serviceCenterId && (staff.centers || []).some((c) => c && c.centerId === sr.serviceCenterId))
      if (!own) return fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.')
    }
    let { phone, phoneDigits } = p
    if (!phoneDigits && sr) {
      const d = normalizePhone(sr.clientPhone)
      if (UA_PHONE_RE.test(d)) { phoneDigits = d; phone = `+${d}` }
    }
    if (p.deliver === 'sms') {
      if (!phoneDigits) return fail(400, 'NO_PHONE', 'Вкажіть номер телефону, на який надіслати SMS.')
      if (!(await smsPhoneAllowed(staff, phone, phoneDigits, sr))) {
        return fail(403, 'PHONE_NOT_ALLOWED', `SMS на довільний номер надсилає лише власник. Вкажіть заявку свого центру або номер, який дзвонив нам за останні ${LIMITS.recentCallHours} год, — або створіть посилання без SMS.`)
      }
    }

    // 3) Лимиты ДО вызовов ИИ (перевод темы, приветствие): минутный в памяти и дневные — дешёвым чтением
    // счётчиков (окончательно они проверяются и увеличиваются в транзакции ниже).
    if (p.dryRun
      ? !minuteAllow(`dry:${staff.uid}`, Math.max(LIMITS.staffPerMin * 4, 20))
      : !minuteAllow(`staff:${staff.uid}`, LIMITS.staffPerMin)) return fail(429, 'RATE_LIMITED', 'Забагато запрошень поспіль — зачекайте хвилину.')
    const day0 = nowIso().slice(0, 10)
    const countOf = async (id) => {
      const s = await counters().doc(id).get()
      return s.exists ? Number(s.data().count) || 0 : 0
    }
    const [staffUsed, phoneUsed, smsUsed] = await Promise.all([
      countOf(`staff_${staff.uid}_${day0}`),
      p.deliver === 'sms' ? countOf(`phone_${phoneDigits}_${day0}`) : 0,
      p.deliver === 'sms' ? countOf(`sms_${day0}`) : 0,
    ])
    const limitFail = (which) => (which === 'staff'
      ? fail(429, 'DAILY_LIMIT', 'Денний ліміт запрошень вичерпано — спробуйте завтра або зверніться до власника.')
      : which === 'phone'
        ? fail(429, 'PHONE_LIMIT', 'На цей номер сьогодні вже надіслано кілька запрошень — передайте посилання іншим способом.')
        : fail(429, 'SMS_BUDGET', 'Денний ліміт SMS-запрошень вичерпано — створіть посилання без SMS.'))
    const staffMax = staff.role === 'owner' ? LIMITS.ownerPerDay : LIMITS.staffPerDay
    if (staffUsed >= staffMax) return limitFail('staff')
    if (p.deliver === 'sms' && phoneUsed >= LIMITS.phonePerDay) return limitFail('phone')
    if (p.deliver === 'sms' && smsUsed >= LIMITS.smsPerDay) return limitFail('sms')

    // 4) Тема по-украински (её видит клиент). Подтверждённую сотрудником тему не трогаем.
    const topic = p.topicConfirmed ? p.topic : await normalizeTopic(p.topic)
    const tp = topicProblem(topic, { strictUk: true })
    if (tp) return tp
    if (p.dryRun) {
      const preview = p.deliver === 'sms' ? inviteSmsText(topic, inviteUrl(siteUrl, PREVIEW_ID)) : null
      return ok({ dryRun: true, topic, topicChanged: topic !== p.topic, phone, deliver: p.deliver, smsText: preview, smsSegments: preview ? smsSegments(preview) : 0 })
    }
    if (p.deliver === 'sms' && !minuteAllow(`phone:${phoneDigits}`, 1)) return fail(429, 'RATE_LIMITED', 'На цей номер щойно надіслано запрошення — зачекайте хвилину.')

    // 5) Первое сообщение ИИ — до транзакции (вызов долгий). Не вышло — запасное приветствие.
    const opening = await openingOrFallback({ topic, details: p.details || null, mode: p.mode })

    // 6) Сессия + служебная запись + ключ + счётчики + профиль клиента — одной транзакцией.
    const sessionId = secureId(16)
    const now = nowIso()
    const day = now.slice(0, 10)
    const url = inviteUrl(siteUrl, sessionId)
    const msg = { id: genMsgId(), role: 'ai', text: opening.text, at: now }
    const session = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      lang: 'uk',
      requestId: null,
      channel: 'web',
      contact: phone || p.name ? { ...(p.name ? { name: p.name } : {}), ...(phone ? { phone } : {}) } : null,
      messages: [msg],
      escalation: null,
      reminders: [],
      ...(opening.usage ? { aiUsage: { calls: 1, inputTokens: opening.usage.inputTokens || 0, outputTokens: opening.usage.outputTokens || 0, costUsd: opening.usage.costUsd || 0 } } : {}),
      invite: { topic, mode: p.mode, createdAt: now },
    }
    const record = {
      id: sessionId,
      sessionId,
      topic,
      topicInput: [p.topicInput, p.topic].find((t) => t && t !== topic) || null, // как написал сотрудник (если тему перевели)
      details: p.details || null,
      mode: p.mode,
      phone: phone || null,
      name: p.name || null,
      serviceRequestId: p.serviceRequestId,
      serviceCenterId: sr?.serviceCenterId || null,
      source: p.source,
      deliver: p.deliver,
      by: { uid: staff.uid, email: staff.email || null, role: staff.role },
      url,
      createdAt: now,
      openedAt: null,
      opening: { messageId: msg.id, source: opening.source },
      sms: {
        status: p.deliver === 'sms' ? 'pending' : 'skipped',
        text: p.deliver === 'sms' ? inviteSmsText(topic, url) : null,
        error: null,
        notificationId: null,
        attempts: 0,
        lastAttemptAt: null,
      },
      clientKey: p.clientKey,
      reqHash: hashOf(p),
    }
    const staffCounterRef = counters().doc(`staff_${staff.uid}_${day}`)
    const phoneCounterRef = p.deliver === 'sms' ? counters().doc(`phone_${phoneDigits}_${day}`) : null
    const smsCounterRef = p.deliver === 'sms' ? counters().doc(`sms_${day}`) : null
    const profileRef = phoneDigits ? adminDb.collection('clientProfiles').doc(phoneDigits) : null

    const tx = await adminDb.runTransaction(async (t) => {
      // Все чтения — до записей (требование транзакций Firestore).
      const keySnap = keyRef ? await t.get(keyRef) : null
      if (keySnap && keySnap.exists) return { existing: keySnap.data() }
      const count = async (ref) => {
        if (!ref) return 0
        const s = await t.get(ref)
        return s.exists ? Number(s.data().count) || 0 : 0
      }
      const staffCount = await count(staffCounterRef)
      const phoneCount = await count(phoneCounterRef)
      const smsCount = await count(smsCounterRef)
      const prof = profileRef ? await t.get(profileRef) : null
      if (staffCount >= staffMax) return { limit: 'staff' }
      if (phoneCounterRef && phoneCount >= LIMITS.phonePerDay) return { limit: 'phone' }
      if (smsCounterRef && smsCount >= LIMITS.smsPerDay) return { limit: 'sms' }
      t.set(staffCounterRef, { count: staffCount + 1, uid: staff.uid, day, updatedAt: now }, { merge: true })
      if (phoneCounterRef) t.set(phoneCounterRef, { count: phoneCount + 1, day, updatedAt: now }, { merge: true })
      if (smsCounterRef) t.set(smsCounterRef, { count: smsCount + 1, day, updatedAt: now }, { merge: true })
      t.create(sessions().doc(sessionId), session)
      t.create(invites().doc(sessionId), record)
      if (keyRef) t.set(keyRef, { sessionId, reqHash: record.reqHash, uid: staff.uid, createdAt: now })
      // Профиль клиента: беседа — в его историю; имя — ТОЛЬКО если пусто (как server/clientProfiles.js:
      // не затираем имя настоящего владельца номера тем, что ввёл сотрудник).
      if (profileRef) {
        const cur = prof && prof.exists ? prof.data() : null
        const sessionIds = Array.from(new Set([...((cur && Array.isArray(cur.sessionIds)) ? cur.sessionIds : []), sessionId]))
        t.set(profileRef, {
          id: phoneDigits,
          phone: phoneDigits,
          updatedAt: now,
          sessionIds,
          ...(p.name && !(cur && cur.name) ? { name: p.name } : {}),
        }, { merge: true })
      }
      return { created: true }
    })
    if (tx.existing) return replay(staff, tx.existing, p)
    if (tx.limit) return limitFail(tx.limit)

    // 7) SMS — после записи: при сбое шлюза ссылка уже есть (её можно скопировать), повтор с ключом дошлёт.
    const sms = p.deliver === 'sms' ? await sendInviteSms(record, byLabel) : record.sms
    return ok({ ...inviteView({ ...record, sms }), created: true })
  }

  // Служебная запись для сотрудника: владелец/директор — любая, остальные — только свои (как правила Firestore).
  async function getInvite(staff, sessionId) {
    if (!SESSION_ID_RE.test(String(sessionId || ''))) return fail(400, 'BAD_ID', 'Некоректний id.')
    const s = await invites().doc(String(sessionId)).get()
    if (!s.exists) return fail(404, 'NOT_FOUND', 'Запрошення не знайдено.')
    const rec = s.data()
    if (!['owner', 'director'].includes(staff.role) && rec.by?.uid !== staff.uid) return fail(403, 'FORBIDDEN', 'Це запрошення створив інший співробітник.')
    return ok(inviteView(rec))
  }

  // Тема/заметка для промпта ИИ — только если сессия действительно создана как приглашение (запись сервера).
  async function inviteFor(sessionId) {
    if (!SESSION_ID_RE.test(String(sessionId || ''))) return null
    try {
      const s = await invites().doc(String(sessionId)).get()
      return s.exists ? s.data() : null
    } catch (e) {
      console.error('chat-invite inviteFor:', e?.message || e)
      return null
    }
  }

  // Человек открыл ссылку: отметка «відкрито» (первая). Публично — id и есть доступ; ничего не возвращает.
  // Сотрудник, открывший чат для проверки (страница шлёт его токен), отметку не ставит — см. registerChatInvites.
  async function openInvite(sessionId) {
    if (!SESSION_ID_RE.test(String(sessionId || ''))) return fail(400, 'BAD_ID', 'Некоректне посилання.')
    const ref = invites().doc(String(sessionId))
    const s = await ref.get()
    if (!s.exists) return fail(404, 'NOT_FOUND', 'Запрошення не знайдено.')
    if (!s.data().openedAt) await ref.set({ openedAt: nowIso() }, { merge: true })
    return ok({ opened: true })
  }

  return { createInvite, getInvite, inviteFor, openInvite, generateOpening, normalizeTopic }
}

// ---------- HTTP ----------

const err = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } })
const send = (res, r, okStatus = 200) => (r.ok
  ? res.status(okStatus).json({ success: true, data: r.data })
  : err(res, r.status || 500, r.code || 'FAILED', r.message || 'Не вдалося виконати дію'))

// deps: как у createChatInviteActions + verifyStaff? / actions? (тесты)
export function registerChatInvites(app, deps) {
  const verifyStaff = deps.verifyStaff || ((req) => verifyFirebaseStaff(req, INVITE_ROLES))
  // Любой сотрудник (и бухгалтер) — чтобы его просмотр чата не считался «клієнт відкрив».
  const verifyAnyStaff = deps.verifyAnyStaff || deps.verifyStaff || ((req) => verifyFirebaseStaff(req, ['owner', 'director', 'accountant', 'master', 'operator']))
  const actions = deps.actions || (deps.adminDb ? createChatInviteActions(deps) : null)
  const ready = (req, res, next) => (actions ? next() : err(res, 503, 'NO_DB', 'Firestore не налаштовано'))
  const staffOnly = async (req, res, next) => {
    const staff = await verifyStaff(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для співробітників сервісу')
    req.staff = staff
    next()
  }
  // Открытие — публичное, только отметка в записи (без ИИ).
  const openLimiter = rateLimit({ name: 'chat-invite-open', windowMs: 60 * 1000, max: 30 })
  const guard = (fn, okStatus) => async (req, res) => {
    try {
      const r = await fn(req)
      return send(res, r, okStatus && r.ok && r.data && r.data.created ? okStatus : 200)
    } catch (e) {
      console.error('chat-invites error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося виконати дію')
    }
  }

  // Лимиты — внутри createInvite (минутные в памяти + дневные в Firestore), чтобы повтор/ошибка их не тратили.
  app.post('/api/chat-invites', ready, staffOnly, guard((req) => actions.createInvite(req.staff, req.body || {}), 201))
  // id — в теле, а не в URL: ссылка на чат — это доступ, в журналы запросов её не пишем.
  app.post('/api/chat-invites/get', ready, staffOnly, guard((req) => actions.getInvite(req.staff, String(req.body?.sessionId || ''))))
  app.post('/api/chat-invites/open', ready, openLimiter, guard(async (req) => {
    if (/^Bearer /.test(req.get('authorization') || '')) {
      const staff = await verifyAnyStaff(req).catch(() => null)
      if (staff) return ok({ opened: false, staffView: true })
    }
    return actions.openInvite(String(req.body?.sessionId || ''))
  }))

  return { actions }
}

export default registerChatInvites
