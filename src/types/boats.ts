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
  basePrice: number // базова ціна кораблика цього ряду, грн
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
  price: number
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
