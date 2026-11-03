// Заказ магазина runferry.ua глазами страниц владельца. Браузер документов не читает: всё приходит из /api/shop/admin/* (server/shopAdmin.js).
// Подписи только для владельца и директора. Тексты покупателя лежат на сайте и в server/shopPayments.js.

export type ShopOrderState =
  | 'phone_pending' | 'cod_confirmed' | 'awaiting_payment' | 'paid' | 'shipped' | 'delivered'
  | 'refused' | 'returned' | 'payment_review' | 'reversed' | 'cancelled' | 'expired'

export const SHOP_STATE_LABELS: Record<ShopOrderState, string> = {
  phone_pending: 'Чекає код із SMS',
  cod_confirmed: 'Номер підтверджено',
  awaiting_payment: 'Чекає оплату',
  paid: 'Оплачено',
  shipped: 'Накладна створена',
  delivered: 'Отримано',
  refused: 'Посилку не отримано',
  returned: 'Посилка повернулась',
  payment_review: 'Перевірка оплати',
  reversed: 'Кошти повернуто',
  cancelled: 'Скасовано',
  expired: 'Час на оплату минув',
}

export const shopStateColor = (s: ShopOrderState): 'default' | 'info' | 'warning' | 'success' | 'error' =>
  s === 'paid' || s === 'cod_confirmed' || s === 'phone_pending' ? 'warning'
  : s === 'payment_review' || s === 'refused' ? 'error'
  : s === 'shipped' ? 'info'
  : s === 'delivered' ? 'success'
  : 'default'

export type ShopFlag = 'payment-review' | 'receipt-failed' | 'ttn-unknown' | 'ttn-on-closed' | 'refund-due' | 'sms-failed' | 'not-handed'

export const SHOP_FLAG_LABELS: Record<ShopFlag, string> = {
  'payment-review': 'Рішення щодо оплати',
  'receipt-failed': 'Чек не вийшов',
  'ttn-unknown': 'Невідомо, чи є накладна',
  'ttn-on-closed': 'Накладна на закритому замовленні',
  'refund-due': 'Повернення коштів',
  'sms-failed': 'Повідомлення не дійшло',
  'not-handed': 'Посилку не здано',
}

export type ShopSalesMode = 'off' | 'prices' | 'hidden' | 'live'

export const SHOP_MODES: { mode: ShopSalesMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Вимкнено', hint: 'На сайті «Ціна за запитом» і менеджер, замовлення не приймаються' },
  { mode: 'prices', label: 'Лише ціни', hint: 'На картці ціна і менеджер, замовлення не приймаються' },
  { mode: 'hidden', label: 'Прихований', hint: 'Кнопки немає, пряме посилання /uk/buy/… працює: для першої перевірочної покупки' },
  { mode: 'live', label: 'Увімкнено', hint: 'На картці кнопка «Купити»' },
]
export const shopModeLabel = (mode: ShopSalesMode): string => SHOP_MODES.find((m) => m.mode === mode)?.label || mode

// Памятка лежит в приватном репозитории документов.
export const SHOP_GUIDE_URL = 'https://github.com/Runferry/runferry-briefs/blob/main/catalog/ua-shop-owner-guide-2026-11.md'

// Фото есть только в коде сайта (apps/web/public/images/products/spare-parts), в прайсе портала пути нет: новый артикул покажется без фото, пока его не впишут сюда.
// У V2-LID-RM то же изображение, что у V2-LID-R (решение владельца): различать их надо по артикулу и названию.
const SITE_PARTS_PHOTOS = 'https://runferry.ua/images/products/spare-parts'
export const SHOP_SKU_PHOTOS: Record<string, string> = {
  'V2-LID-R': `${SITE_PARTS_PHOTOS}/solo-v2-lid-rect/1.jpg`,
  'V2-LID-RM': `${SITE_PARTS_PHOTOS}/solo-v2-lid-rect/1.jpg`,
  'V2-LID-H': `${SITE_PARTS_PHOTOS}/solo-v2-lid-hex/1.jpg`,
}

export const fmtShopDate = (iso?: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('uk-UA')
}

export interface ShopOrderRow {
  id: string
  orderNo: string
  state: ShopOrderState
  method: 'card' | 'cod'
  sku: string
  titleUk: string
  total: number
  clientName?: string | null
  clientPhone?: string | null
  clientCityName?: string | null
  clientWarehouseName?: string | null
  ttn?: string | null
  receiptStatus?: string
  createdAt: string
  paidAt?: string | null
  shippedAt?: string | null
  flags: ShopFlag[]
  needsAction: boolean
}

export interface ShopCounters {
  action: number
  noTtn: number
  liveInvoices: number
  unpaidToday: number
}

export interface ShopInvoice {
  id: string
  status: string
  amount: number
  createdAt: string
  paying: boolean
  receiptStatus?: string | null
  receiptError?: string | null
  taxUrl?: string | null
  receiptEmailDropped: boolean
  partialRefund?: { amount: number; at: string } | null
}

export interface ShopMessageRec {
  status?: string | null
  at?: string | null
  tries?: number
  resends?: number
}

export interface ShopAlertRec {
  at: string
  sentAt?: string | null
  smsAt?: string | null
  text: string
}

export interface ShopHistoryRec {
  at: string
  from?: string | null
  to?: string | null
  by?: string | null
  note?: string | null
}

// Карточка: заказ целиком, кроме токена и отпечатков, плюс счета из payments, ссылка на статус и плашки.
export interface ShopOrderCard extends ShopOrderRow {
  qty?: number
  lastName?: string | null
  firstName?: string | null
  middleName?: string | null
  email?: string | null
  clientCityRef?: string | null
  clientWarehouseRef?: string | null
  addressVerified?: boolean
  offerVersion?: string
  cancelReason?: string | null
  payAttempts?: number
  paidPaymentId?: string | null
  paidSource?: string | null
  amountConfirmed?: { by?: string | null; at: string; amount: number } | null
  partialRefund?: { amount: number; at: string } | null
  refundRequestedAt?: string | null
  refusedAt?: string | null
  receipt?: { status?: string; taxUrl?: string | null; checkedAt?: string | null } | null
  sms?: Record<string, ShopMessageRec | null>
  alerts?: Record<string, ShopAlertRec | null>
  history?: ShopHistoryRec[]
  ttnHistory?: { ttn: string; at: string; reason?: string }[]
  recipientEdits?: { at: string; by?: string | null; fields: string[] }[]
  ttnCreatingAt?: string | null
  ttnError?: string | null
  ttnOnClosed?: boolean
  npCostOnSite?: string | number | null
  npEstimatedDelivery?: string | null
  npDelivery?: { code?: string; text?: string; changedAt?: string; deliveredAt?: string; final?: boolean } | null
  npCheckedAt?: string | null
  piiPurgedAt?: string | null
  statusUrl?: string | null
  invoices: ShopInvoice[]
}

export interface ShopSkuRule {
  enabled: boolean
  inStock: boolean
  stock?: number | null
  minUah: number
  maxUah: number
}

export interface ShopSalesSettings {
  mode: ShopSalesMode
  methods?: { card?: boolean; cod?: boolean }
  fopId?: string
  npTemplateId?: string
  siteBaseUrl?: string
  offerVersion?: string
  cardReceiptLabel?: string
  ownerPhone?: string // директору сервер его не отдаёт
  ownerTestOkAt?: string | null
  skus?: Record<string, ShopSkuRule>
  limits?: Record<string, number | null>
}

export type ShopCheckStatus = 'ok' | 'bad' | 'unknown' | 'none'

export interface ShopReadiness {
  mode: ShopSalesMode
  methods: { card?: boolean; cod?: boolean }
  ready: boolean
  problems: string[]
  fop: { id: string; name: string; active: boolean } | null
  seller: { name: string; ipn: string; address: string; email: string; phone: string } | null
  sellable: { card: { ok: boolean; code?: string; missing?: string[] } }
  monoAcquire: { status: ShopCheckStatus; message?: string; note?: string; merchantName?: string; edrpou?: string }
  npTemplate: { id: string | null; name: string | null; problems: string[]; problemTexts: string[]; description: string | null; weight: number | null; payerType: string | null }
  checkbox: {
    status: ShopCheckStatus
    message?: string
    cashier?: { name?: string | null; blocked?: boolean | null; organization?: string | null; edrpou?: string | null }
    autoCloseShiftAt?: string | null
    shift?: { status?: string | null; openedAt?: string | null }
    cashRegister?: { title?: string | null; address?: string | null; fiscalNumber?: string | null; ettnAcquiring?: boolean; status?: ShopCheckStatus }
  }
  ownerTestOkAt: string | null
  ownerPhoneSet: boolean
  siteBaseUrl: string | null
  callbackBaseUrlSet: boolean
  offerVersion: string | null
  items: { sku: string; enabled: boolean; inStock: boolean; stock: number | null; priceUah: number | null; problem: string | null }[]
  today: { unpaid: number; limit: number }
  acceptsOrders: boolean
}
