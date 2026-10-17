// Голосова картка для менеджера (укр.): хто дзвонить і що з його заявкою. Будується тими самими чистими
// функціями, що й customerData приймача Binotel (server/binotelWebhook.js) — не копіюємо, імпортуємо.
//   «Дзвонить <ім'я>. <опис: « · » → «. », «№» → «номер »>.»
//   нічого не знаємо → «Дзвонить новий клієнт, у базі порталу немає.»
// Номер телефону клієнта картка вголос НЕ каже (частина менеджерів не має його знати): ні замість імені, ні зі
// скарги, куди клієнт міг його вписати. Лише з speakNumber (VG_CARD_SPEAK_NUMBER=1) — як раніше, номером групами.
import { buildCustomerData, clientCategory, clip, isOpen, lastActivityMs } from '../../server/binotelWebhook.js'
import { normPhone } from '../../server/phone.js'

export const CARD_MAX = 200
const NOT_IN_BASE = 'Немає в базі порталу' // опис buildCustomerData, коли про номер нічого немає

// +380500000001 → «050 000 00 01» (так читається групами)
export const groupPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '').slice(-9)
  return d.length === 9 ? `0${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}` : String(p ?? '').trim()
}

// Текст картки для синтезу: розділювачі — у речення, «№» — словом; обрізане clip() слово наприкінці («гвин…») —
// геть разом із «…», бо вголос обрубок звучить гірше, ніж його відсутність.
export const spoken = (s) => String(s ?? '')
  .replace(/\s*[^\s·]*…$/, '')
  .replace(/…/g, '')
  .replace(/\s*·\s*/g, '. ')
  .replace(/№\s*/g, 'номер ')
  .replace(/\(\+(\d+)\)/g, '(ще $1)')
  .replace(/(^|[.!?]\s+)[-–—]+\s*/g, '$1') // «-Ремонт ББВ» із поля boat — тире на початку речення не читаємо
  .replace(/\s+/g, ' ')
  .trim()
const sentence = (s) => {
  const t = String(s ?? '').trim().replace(/[,;:\s]+$/, '')
  return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`
}

// Схоже на телефон: 9+ цифр поспіль, можна з пробілами, дужками, дефісами, «/» і «+», а крапка — лише між цифрами
// («050.000.00.06»). Крапка з пробілом — кінець речення, і на ній кандидат обривається: «Купив 12.06.2025. 0500000006»
// — дата (8 цифр, лишається) і окремо телефон (прибираємо). Номер ремонту «1234», дата «12.06.2025» — коротші, лишаються.
// Дата впритул до телефону без крапки («12.06.2025 0500000006») зливається з ним і зникає разом — краще втратити дату,
// ніж назвати номер.
const PHONE_LIKE = /\+?\(?\d(?:[\d\s()/-]|\.(?=\d))*\d\)?/g
const digitCount = (s) => (String(s).match(/\d/g) || []).length
export const hidePhones = (s) => String(s ?? '')
  .replace(PHONE_LIKE, (m) => (digitCount(m) >= 9 ? ' ' : m))
  .replace(/\s+([.,!?;:])/g, '$1')
  .replace(/([.,!?;:])(?:\s*[.,;:])+/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()

const scrub = (o, keys) => {
  if (!o || typeof o !== 'object') return o
  const c = { ...o }
  for (const k of keys) if (typeof c[k] === 'string') c[k] = hidePhones(c[k])
  return c
}
const withoutPhones = (lookup) => ({
  ...lookup,
  requests: (lookup.requests || []).map((r) => scrub(r, ['clientName', 'boat', 'complaint'])),
  orders: (lookup.orders || []).map((o) => scrub(o, ['clientName'])),
  profile: scrub(lookup.profile, ['name']),
})

const dateMs = (value) => {
  const n = typeof value?.toMillis === 'function' ? value.toMillis()
    : typeof value === 'number' ? value
      : value?.seconds != null ? Number(value.seconds) * 1000 : Date.parse(value || '')
  return Number.isFinite(n) ? n : null
}
// Рішення власника, розділ 12: після отримання кораблика заявка відкрита ще 14 днів. Поки receivedAt немає — doneAt,
// інакше statusChangedAt. Старі імпортовані заявки без цих дат зберігають чинне правило приймача, а не живуть безстроково.
export function isOpenForAi(sr, nowMs = Date.now()) {
  if (!sr || sr.status === 'cancelled') return false
  const received = dateMs(sr.receivedAt)
  if (received != null || sr.status === 'done') {
    const at = received ?? dateMs(sr.doneAt) ?? dateMs(sr.statusChangedAt)
    if (at != null) return nowMs < at + 14 * 86400000
  }
  return isOpen(sr, nowMs)
}
export function aiCategory(lookup, nowMs = Date.now()) {
  if (!lookup) return null
  if ((lookup.requests || []).some((x) => isOpenForAi(x, nowMs))) return 'openRequest'
  const c = clientCategory(lookup, nowMs)
  return c === 'openRequest' ? 'knownClient' : c
}
// Як pickRequests приймача, але «відкрита» — isOpenForAi
export function pickRequestsForAi(list, nowMs = Date.now()) {
  const arr = (list || []).filter(Boolean)
  const byActivity = (a, b) => lastActivityMs(b) - lastActivityMs(a)
  const open = arr.filter((x) => isOpenForAi(x, nowMs)).sort(byActivity)
  const rest = arr.filter((x) => !isOpenForAi(x, nowMs)).sort(byActivity)
  return { main: open[0] || rest[0] || null, mainOpen: open.length > 0, openCount: open.length, total: arr.length }
}

// Картка ведучому в режимі обговорення — MGR-DS-CARD (источник: runferry-briefs segments-texts-draft 5а (fe08058)):
// префікс за причиною, далі «Заявка {номер}, {ім'я клієнта}.» (внутрішня фраза: номер заявки й ім'я ведучому можна), далі
// brief.voice з поля обговорення (≤ 150 знаків), якщо є. Номерів телефонів немає (hidePhones).
export const DS_CARD_HEAD = {
  talked: 'Передзвонює клієнт, з яким ви нещодавно говорили.', // MGR-DS-CARD: источник: runferry-briefs segments-texts-draft 5а (fe08058)
  called: 'Передзвонює клієнт, якому ви телефонували.', // MGR-DS-CARD: источник: runferry-briefs segments-texts-draft 5а (fe08058)
  general: 'Телефонує клієнт, заявкою якого ви займаєтеся.', // MGR-DS-CARD: источник: runferry-briefs segments-texts-draft 5а (fe08058)
}
export function dsCardText({ kind = 'general', lookup = null, srId = null, voice = null } = {}) {
  const sr = (lookup?.requests || []).find((x) => x && x.id === srId) || null
  const no = sr ? hidePhones(String(sr.onec?.number || '').replace(/^0+/, '')) : ''
  const rawName = sr?.clientName ? hidePhones(String(sr.clientName)) : ''
  const name = rawName && digitCount(rawName) < 7 ? spoken(rawName) : ''
  const tail = no ? `Заявка ${no}${name ? `, ${name}` : ''}.` : name ? `${sentence(name)}` : ''
  const v = voice ? sentence(spoken(clip(hidePhones(String(voice)), 149))) : ''
  return clip([DS_CARD_HEAD[kind] || DS_CARD_HEAD.general, tail, v].filter(Boolean).join(' '), CARD_MAX + 150)
}

// lookup — {requests, profile, orders} | null (пошук не встиг або вимкнений). Повертає {text, category, serviceRequestId}.
// category — для ШІ (aiCategory), serviceRequestId — головна заявка за тим самим правилом відкритості.
export function buildCard(lookup, { number, phone, nowMs = Date.now(), speakNumber = false } = {}) {
  const raw = String(number ?? '').trim()
  if (/^\d{3}$/.test(raw)) return { text: `Дзвонить внутрішній номер ${raw}.`, category: null, serviceRequestId: null }
  const e164 = phone || normPhone(raw)
  const pretty = groupPhone(e164 || raw)
  const known = !!(e164 || raw)
  const who = speakNumber ? (pretty ? `номер ${pretty}` : 'невідомий номер') : known ? 'клієнт' : 'невідомий номер'
  // без бази (пошук не встиг або вимкнений) — лише «клієнт» (з speakNumber — номер)
  if (!lookup) return { text: `Дзвонить ${who}.`, category: null, serviceRequestId: null }
  // Телефон із полів (ім'я, кораблик, скарга) прибираємо ДО того, як buildCustomerData обріже опис: обрізаний
  // «+38 (050)…» уже не впізнати як номер
  const src = speakNumber ? lookup : withoutPhones(lookup)
  const cd = buildCustomerData({ phone: e164, requests: src.requests, orders: src.orders, profile: src.profile, nowMs })
  const category = aiCategory(lookup, nowMs)
  const serviceRequestId = pickRequestsForAi(lookup.requests, nowMs).main?.id || null
  if (cd.description === NOT_IN_BASE) {
    const text = speakNumber ? `Дзвонить ${who}. У базі порталу немає.` : known ? 'Дзвонить новий клієнт, у базі порталу немає.' : 'Дзвонить невідомий номер. У базі порталу немає.'
    return { text, category, serviceRequestId }
  }
  const name = spoken(cd.name)
  // Імені немає — buildCustomerData підставляє номер групами: це не ім'я
  const nameIsNumber = !name || name === pretty || name === 'Невідомий номер' || digitCount(name) >= 7
  let text = `Дзвонить ${sentence(nameIsNumber ? who : name)} ${sentence(spoken(cd.description))}`.trim()
  if (!speakNumber) text = hidePhones(text)
  return { text: clip(text, CARD_MAX), category, serviceRequestId }
}

export default buildCard
