// Голосова картка для менеджера (укр.): хто дзвонить і що з його заявкою. Будується тими самими чистими
// функціями, що й customerData приймача Binotel (server/binotelWebhook.js) — не копіюємо, імпортуємо.
//   «Дзвонить <ім'я>. <опис: « · » → «. », «№» → «номер »>.»
//   нічого не знаємо → «Дзвонить номер 050 000 00 01. У базі порталу немає.»
import { buildCustomerData, clientCategory, pickRequests, clip } from '../../server/binotelWebhook.js'
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

// lookup — {requests, profile, orders} | null (пошук не встиг або вимкнений). Повертає {text, category, serviceRequestId}.
export function buildCard(lookup, { number, phone, nowMs = Date.now() } = {}) {
  const raw = String(number ?? '').trim()
  if (/^\d{3}$/.test(raw)) return { text: `Дзвонить внутрішній номер ${raw}.`, category: null, serviceRequestId: null }
  const e164 = phone || normPhone(raw)
  const pretty = groupPhone(e164 || raw)
  const who = pretty ? `номер ${pretty}` : 'невідомий номер'
  if (!lookup) return { text: `Дзвонить ${who}.`, category: null, serviceRequestId: null } // без бази — лише номер
  const cd = buildCustomerData({ phone: e164, requests: lookup.requests, orders: lookup.orders, profile: lookup.profile, nowMs })
  const category = clientCategory(lookup, nowMs)
  const serviceRequestId = pickRequests(lookup.requests, nowMs).main?.id || null
  if (cd.description === NOT_IN_BASE) return { text: `Дзвонить ${who}. У базі порталу немає.`, category, serviceRequestId }
  const name = spoken(cd.name)
  const nameIsNumber = !name || name === pretty || name === 'Невідомий номер'
  const text = `Дзвонить ${sentence(nameIsNumber ? who : name)} ${sentence(spoken(cd.description))}`.trim()
  return { text: clip(text, CARD_MAX), category, serviceRequestId }
}

export default buildCard
