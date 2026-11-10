// Підписи й форматування для журналу «Посилки» (§36).
import type { Parcel, ParcelAttention, ParcelGroup, ParcelMethod, Currency } from '@/api/endpoints/parcels'

export const GROUP_LABELS: Record<ParcelGroup, string> = {
  draft: 'Створена', transit: 'В дорозі', arrived: 'У відділенні', received: 'Отримана', problem: 'Проблема', deleted: 'Видалена', other: 'Інше',
}
export const GROUP_COLOR: Record<ParcelGroup, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  draft: 'default', transit: 'info', arrived: 'warning', received: 'success', problem: 'error', deleted: 'default', other: 'default',
}
export const METHOD_LABELS: Record<ParcelMethod, string> = { np: 'Нова Пошта', pickup: 'Самовивіз', bus: 'Автобус', other: 'Інше' }
export const ATTENTION_LABELS: Record<ParcelAttention, string> = {
  problem: 'Відмова або проблема', waiting: 'Лежить 3+ дні', storage: 'Платне зберігання', autoReturn: 'Скоро повернення', driver: 'У водія 5+ днів',
}
export const CURRENCIES: Currency[] = ['EUR', 'UAH', 'PLN', 'USD']
const CUR_SIGN: Record<Currency, string> = { EUR: '€', UAH: 'грн', PLN: 'zł', USD: '$' }

export const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
export const fmtDate = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
export const fmtMoney = (v?: number | null, cur: Currency = 'UAH'): string =>
  v ? `${v.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} ${CUR_SIGN[cur]}` : '—'

// Статус для рядка: чернетка, віддана водієві, показується як «У водія».
export const statusLabel = (p: Parcel): string =>
  p.group === 'draft' && p.transfer ? `У водія (${p.transfer.driver})` : p.manual ? p.statusName : p.statusName || GROUP_LABELS[p.group]

export const directionLabel = (p: Parcel): string =>
  p.directions.length > 1 ? 'Внутрішня' : p.directions[0] === 'in' ? 'Вхідна' : 'Вихідна'

// З ким посилка: для вихідної — одержувач, для вхідної — відправник, для внутрішньої — обидва.
export const counterpartyLabel = (p: Parcel): string => {
  const who = (x?: { name?: string; company?: string; phone?: string }) => x?.name || x?.company || x?.phone || ''
  if (p.directions.length > 1) return `${who(p.sender)} → ${who(p.recipient)}`
  // Клієнт здає кораблик за нашою накладною: у накладній відправник — ми, тож показуємо клієнта із заявки.
  if (p.directions[0] === 'in' && p.selfSender) return p.link?.title || 'клієнт (наша накладна)'
  return who(p.directions[0] === 'in' ? p.sender : p.recipient) || '—'
}
export const placeLabel = (p: Parcel): string => {
  const x = p.directions[0] === 'in' && p.directions.length === 1 ? p.sender : p.recipient
  return [x?.city, x?.address].filter(Boolean).join(', ') || '—'
}
// Вартість передачі: частка з реєстру водія або сума ручного запису.
export const extraCostLabel = (p: Parcel): string =>
  p.transfer ? fmtMoney(p.transfer.share, p.transfer.currency) : p.extraCost ? fmtMoney(p.extraCost.amount, p.extraCost.currency) : ''

export const todayIso = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
