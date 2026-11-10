// Замовлення кораблика через магазин-партнера (дропшипінг / викуп) — чисті розрахунки без бази.
// Вимоги: docs/service-requirements.md §26.1. Та сама математика, що в src/types/boats.ts
// (UI показує, сервер вирішує): зміни робити в обох місцях.
//
// Одна формула на всі випадки:
//   магазин винен нам = (роздрібна сума рядків − комісія магазину по кожному рядку) − те, що клієнт платить нам.
//   Менше нуля — винні ми магазину.
//
// Поля замовлення (boatOrders):
//   kind          'retail' | 'dropship' | 'buyout'   (немає поля: є dropshipperId → dropship, інакше retail)
//   ttnBy         'us' | 'shop'                      (накладну створюємо ми / номер дав магазин)
//   collectByUs   скільки клієнт платить НАМ, грн    (0 — усе отримує магазин; total — усе ми; між — аванс магазину)
//   lines[].shopPct  комісія магазину на рядок, %
//   payTo         застаріле ('us' | 'dropshipper'), читається лише коли collectByUs не задано

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// Сума рядка з додатковою знижкою — та сама формула, що в /api/boat-orders/pay і в UI.
export const lineEffTotal = (l) => {
  const qty = num(l?.qty) || 1
  const gross = r2(num(l?.price) * qty)
  const raw = num(l?.extraOff)
  const off = raw > 0 ? Math.min(l.extraOffKind === 'pct' ? r2((gross * raw) / 100) : r2(raw), gross) : 0
  return r2(r2((gross - off) / qty) * qty)
}

export const orderKind = (o) => {
  if (o?.kind === 'retail' || o?.kind === 'dropship' || o?.kind === 'buyout') return o.kind
  return o?.dropshipperId ? 'dropship' : 'retail'
}
export const isShopOrder = (o) => orderKind(o) !== 'retail'

const orderTotal = (o) => {
  const t = num(o?.total)
  if (t > 0) return r2(t)
  return r2((Array.isArray(o?.lines) ? o.lines : []).reduce((s, l) => s + lineEffTotal(l), 0))
}

// Скільки клієнт платить НАМ (наложка в нашій ТТН або оплата за посиланням).
export function clientDueToUs(o) {
  const total = orderTotal(o)
  const kind = orderKind(o)
  if (kind === 'retail') return total
  if (kind === 'buyout') return 0 // викуп: магазин платить нам на рахунок, кінцевого покупця ми не бачимо
  if (o?.ttnBy === 'shop') return 0 // накладна магазину — наложку отримує магазин
  if (o?.collectByUs !== null && o?.collectByUs !== undefined && Number.isFinite(Number(o.collectByUs))) {
    return r2(Math.min(Math.max(Number(o.collectByUs), 0), total))
  }
  return o?.payTo === 'dropshipper' ? 0 : total // старі замовлення без collectByUs
}

// 'full' — усе нам; 'none' — усе магазину; 'split' — аванс магазину, решта нам.
export function payMode(o) {
  const total = orderTotal(o)
  const due = clientDueToUs(o)
  if (due <= 0) return 'none'
  return due >= total ? 'full' : 'split'
}

const pctOf = (l) => Math.min(Math.max(num(l?.shopPct), 0), 100)
export const lineShopNet = (l) => r2(lineEffTotal(l) * (1 - pctOf(l) / 100))
export const lineShopFee = (l) => r2(lineEffTotal(l) - lineShopNet(l))

// Скільки замовлення коштує магазину (роздріб мінус комісія по кожному рядку).
export const orderShopNet = (o) => r2((Array.isArray(o?.lines) ? o.lines : []).reduce((s, l) => s + lineShopNet(l), 0))

// Більше нуля — магазин винен нам; менше — винні ми; для роздробу завжди 0.
export const shopDue = (o) => (isShopOrder(o) ? r2(orderShopNet(o) - clientDueToUs(o)) : 0)

// Чи можна створити НАШЕ посилання на оплату (і наш чек). null — можна.
export function boatPayGate(o) {
  const kind = orderKind(o)
  if (kind === 'buyout') return { status: 409, code: 'BUYOUT_PAY', message: 'Викуп: магазин платить на рахунок ФОП — посилання на оплату не створюємо' }
  const mode = payMode(o)
  if (mode === 'none') return { status: 409, code: 'DROPSHIP_PAY', message: 'Гроші отримує дропшипер — посилання на оплату і чек на його стороні' }
  if (mode === 'split') return { status: 409, code: 'SPLIT_PAY', message: 'Часткова оплата: клієнт платить нам наложкою в нашій накладній — посилання на частину суми не створюємо' }
  return null
}

// Наложений платіж у НАШІЙ накладній для замовлення кораблика (цілі гривні). 0 — без наложки.
export function boatCodAmount(o) {
  if (!o || o.paidAt) return 0
  return Math.round(clientDueToUs(o))
}
