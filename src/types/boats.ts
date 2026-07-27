// Продажі корабликів — внутрішня картотека (без публічної вітрини), див.
// docs/service-requirements.md §26. Рішення власника: ціни живуть у каталозі
// (базова ціна в модельного ряду, свої ціни в опцій; у замовленні можна правити),
// сумісність сумок/аксесуарів — по МОДЕЛІ (не по ряду), набір статусів фіксований,
// чек видає той, хто отримав гроші (при dropship-оплаті «на дропера» — без наших чеків).

// Модельний ряд (рік випуску) конкретної моделі. Базова ціна кораблика — тут:
// та сама модель у різні роки коштує по-різному.
export interface BoatModelRow {
  id: string
  name: string // напр. «2024»
  basePrice: number // ФАКТИЧНА ціна кораблика (вже зі знижкою, якщо вона є), грн
  oldPrice?: number | null // ціна БЕЗ знижки — для красивого показу вигоди (закреслена)
}

// Модель кораблика. Кольори — на рівні моделі (доступні для всіх рядів).
export interface BoatModel {
  id: string
  name: string
  colors: string[]
  rows: BoatModelRow[]
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}

// Опції комплектації. depthgauge — глибиномір (у замовленні це прапорець «потрібен»,
// що додає обрану опцію-глибиномір); bag — сумка (можна без неї); echo — ехолот.
export type BoatOptionKind = 'bag' | 'echo' | 'depthgauge' | 'accessory'

export const BOAT_OPTION_KINDS: BoatOptionKind[] = ['bag', 'echo', 'depthgauge', 'accessory']

export const BOAT_OPTION_KIND_LABELS: Record<BoatOptionKind, string> = {
  bag: 'Сумка',
  echo: 'Ехолот',
  depthgauge: 'Глибиномір',
  accessory: 'Аксесуар',
}

// Опція каталогу. compatibleModelIds: порожньо/undefined = сумісна з УСІМА моделями,
// інакше — тільки з переліченими. Конфігуратор замовлення фільтрує опції за моделлю.
export interface BoatOption {
  id: string
  kind: BoatOptionKind
  name: string
  price: number // фактична ціна (зі знижкою)
  oldPrice?: number | null // ціна без знижки (для показу вигоди)
  compatibleModelIds?: string[]
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}

export const optionFitsModel = (o: BoatOption, modelId: string): boolean =>
  !o.compatibleModelIds || o.compatibleModelIds.length === 0 || o.compatibleModelIds.includes(modelId)

// Дропшипер (посередник). Взаєморозрахунки — окрема фаза; поки довідник + прив'язка в замовленні.
export interface Dropshipper {
  id: string
  name: string
  phone?: string
  note?: string
  active: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}

// ==== Замовлення (фаза 2; типи тут, щоб статуси були єдиним джерелом правди) ====

export type BoatOrderStatus =
  | 'lead' // лід
  | 'confirmed' // підтверджено
  | 'assembly' // збірка
  | 'ready' // готово до відправки
  | 'shipped' // відправлено
  | 'delivered' // доставлено
  | 'done' // завершено
  | 'cancelled' // скасовано

export const BOAT_ORDER_STATUSES: BoatOrderStatus[] = [
  'lead', 'confirmed', 'assembly', 'ready', 'shipped', 'delivered', 'done', 'cancelled',
]

export const BOAT_ORDER_STATUS_LABELS: Record<BoatOrderStatus, string> = {
  lead: 'Лід',
  confirmed: 'Підтверджено',
  assembly: 'Збірка',
  ready: 'Готово до відправки',
  shipped: 'Відправлено',
  delivered: 'Доставлено',
  done: 'Завершено',
  cancelled: 'Скасовано',
}

// Рядок вартості замовлення. Автозбирається з каталогу (базова ціна ряду + опції),
// але зберігається явно і його можна правити вручну (рішення власника: ціни з каталогу
// як дефолт + ручні корективи в замовленні).
export interface BoatOrderLine {
  id: string
  label: string
  price: number // фактична ціна (зі знижкою каталогу)
  oldPrice?: number | null // ціна без знижки з каталогу — щоб показати знижку в замовленні
  qty: number
  // Додаткова знижка НА РЯДОК (поверх каталожної): відсотком або фіксованою сумою (грн).
  extraOff?: number | null
  extraOffKind?: 'pct' | 'uah'
}

// Відсоток знижки для показу («-12%»); null — знижки немає.
export const discountPct = (price: number, oldPrice?: number | null): number | null =>
  oldPrice && oldPrice > price && price >= 0 ? Math.round((1 - price / oldPrice) * 100) : null

// ==== Грошова математика рядка (ЄДИНЕ джерело правди — сервер повторює цю ж формулу) ====
// Дод. знижка застосовується до рядка цілком; ефективна ціна за одиницю округлюється до копійки,
// а сума рядка = ефективна ціна × кількість — тоді оплата (mono/LiqPay) і чек (Checkbox)
// сходяться з замовленням копійка в копійку.
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export const lineDiscountAmount = (l: BoatOrderLine): number => {
  const qty = l.qty || 1
  const gross = r2(l.price * qty)
  if (!l.extraOff || l.extraOff <= 0) return 0
  const off = l.extraOffKind === 'pct' ? r2((gross * l.extraOff) / 100) : r2(l.extraOff)
  return Math.min(off, gross)
}

export const lineEffUnit = (l: BoatOrderLine): number => {
  const qty = l.qty || 1
  const gross = r2(l.price * qty)
  return r2((gross - lineDiscountAmount(l)) / qty)
}

export const lineEffTotal = (l: BoatOrderLine): number => r2(lineEffUnit(l) * (l.qty || 1))

export interface BoatOrderStatusChange {
  status: BoatOrderStatus
  at: string
  by?: string | null
}

// Замовлення кораблика (картотека продажів).
export interface BoatOrder {
  id: string
  // Клієнт. clientName — зведене «Прізвище Імʼя По батькові» (для списків/пошуку/ТТН);
  // роздільні поля — джерело правди при редагуванні в картці (потрібні для НП).
  clientName: string
  clientLastName?: string | null
  clientFirstName?: string | null
  clientMiddleName?: string | null
  clientPhone: string
  clientCityRef?: string | null
  clientCityName?: string | null
  clientWarehouseRef?: string | null
  clientWarehouseName?: string | null
  // Конфігурація кораблика
  modelId?: string | null
  rowId?: string | null // модельний ряд (рік)
  color?: string | null
  serialNumber?: string | null // серійний номер кораблика (гарантія, зв'язок із ремонтами)
  needDepthGauge?: boolean // ознака «потрібен глибиномір»
  depthGaugeOptionId?: string | null
  bagOptionId?: string | null // null/порожньо = без сумки
  echoOptionId?: string | null
  accessories?: { optionId: string; qty: number }[]
  // Вартість
  lines: BoatOrderLine[]
  total: number
  // Хід виконання
  status: BoatOrderStatus
  statusHistory: BoatOrderStatusChange[]
  // Дропшипінг: хто посередник і куди йде оплата. Чек видає отримувач грошей:
  // payTo='dropshipper' ⇒ без наших посилань на оплату і чеків (лише фіксація суми).
  dropshipperId?: string | null
  payTo?: 'us' | 'dropshipper'
  // Доставка (пишет сервер при создании ТТН)
  ttn?: string | null
  npDocRef?: string | null
  npCostOnSite?: string | null
  npEstimatedDelivery?: string | null
  // Оплата (пишет сервер: створення посилання і вебхук «оплачено»)
  paymentId?: string | null
  payMethod?: string | null
  payUrl?: string | null
  payCreatedAt?: string | null
  paidAt?: string | null
  taxUrl?: string | null // фискальный чек Checkbox
  fiscalCode?: string | null
  // Дата продажу (для внесення раніше проданих і для гарантії/допродажів)
  soldAt?: string | null
  note?: string
  createdAt: string
  updatedAt: string
  createdBy?: string | null
}
