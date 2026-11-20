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

// Вид рядка замовлення — за ним підставляється комісія магазину (кораблик або вид опції).
export type ShopLineKind = 'boat' | BoatOptionKind

export const SHOP_LINE_KINDS: ShopLineKind[] = ['boat', 'bag', 'echo', 'depthgauge', 'accessory']

export const SHOP_LINE_KIND_LABELS: Record<ShopLineKind, string> = {
  boat: 'Кораблик',
  ...BOAT_OPTION_KIND_LABELS,
}

// Платник магазину: з якого рахунку і від чийого імені він нам платить (їх може бути кілька) —
// за цим потім упізнається його платіж у виписці ФОП.
export interface ShopPayer {
  name?: string
  taxId?: string // ЄДРПОУ / РНОКПП
  iban?: string
}

// Умови роботи з магазином (§26.1). Комісія рахується від роздрібної ціни і задається
// на кожен вид позиції окремо; порожньо = без комісії.
export interface ShopTerms {
  commissionByKind?: Partial<Record<ShopLineKind, number>> // %, напр. { boat: 15 }
  payTermDays?: number // строк оплати після отримання посилки, днів (типово 14)
  ttnBy?: 'us' | 'shop' // хто зазвичай створює накладну
  collectBy?: 'shop' | 'us' // хто зазвичай отримує гроші клієнта
}

export const SHOP_PAY_TERM_DAYS = 14

// Магазин-партнер (дропшипер). Колекція історично зветься dropshippers — на неї посилаються замовлення.
// Взаєморозрахунки (журнал, сальдо) — наступний крок; тут довідник, умови і прив'язка в замовленні.
export interface Dropshipper {
  id: string
  name: string
  phone?: string
  note?: string
  legalName?: string // юридична назва для рахунку
  taxId?: string // ЄДРПОУ / РНОКПП
  payers?: ShopPayer[]
  terms?: ShopTerms
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
  // Замовлення магазину: вид рядка (для підстановки комісії) і комісія магазину на цей рядок, %.
  kind?: ShopLineKind | null
  shopPct?: number | null
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

// ==== Замовлення магазину (дропшипінг / викуп), §26.1 ====
// Та сама математика, що в server/boatShop.js (сервер вирішує, UI показує) — міняти в обох місцях.
// Формула: магазин винен нам = (роздрібна сума − комісія магазину по кожному рядку) − те, що клієнт платить нам.

export type BoatOrderKind = 'retail' | 'dropship' | 'buyout'

export const BOAT_ORDER_KINDS: BoatOrderKind[] = ['retail', 'dropship', 'buyout']

export const BOAT_ORDER_KIND_LABELS: Record<BoatOrderKind, string> = {
  retail: 'Роздріб',
  dropship: 'Дропшипінг',
  buyout: 'Викуп',
}

type ShopOrderLike = Pick<BoatOrder, 'kind' | 'dropshipperId' | 'ttnBy' | 'collectByUs' | 'payTo' | 'total' | 'lines'>

export const orderKind = (o: Partial<ShopOrderLike>): BoatOrderKind =>
  o.kind === 'retail' || o.kind === 'dropship' || o.kind === 'buyout' ? o.kind : o.dropshipperId ? 'dropship' : 'retail'

export const isShopOrder = (o: Partial<ShopOrderLike>): boolean => orderKind(o) !== 'retail'

// Скільки клієнт платить НАМ (наложка в нашій ТТН або оплата за посиланням).
export const clientDueToUs = (o: Partial<ShopOrderLike>): number => {
  const total = r2(o.total || 0)
  const kind = orderKind(o)
  if (kind === 'retail') return total
  if (kind === 'buyout') return 0
  if (o.ttnBy === 'shop') return 0
  if (o.collectByUs !== null && o.collectByUs !== undefined && Number.isFinite(Number(o.collectByUs))) {
    return r2(Math.min(Math.max(Number(o.collectByUs), 0), total))
  }
  return o.payTo === 'dropshipper' ? 0 : total
}

// 'full' — усе нам; 'none' — усе магазину; 'split' — аванс магазину, решта нам.
export const payMode = (o: Partial<ShopOrderLike>): 'full' | 'none' | 'split' => {
  const due = clientDueToUs(o)
  if (due <= 0) return 'none'
  return due >= r2(o.total || 0) ? 'full' : 'split'
}

const shopPctOf = (l: BoatOrderLine): number => Math.min(Math.max(Number(l.shopPct) || 0, 0), 100)
export const lineShopNet = (l: BoatOrderLine): number => r2(lineEffTotal(l) * (1 - shopPctOf(l) / 100))
export const orderShopNet = (lines: BoatOrderLine[]): number => r2((lines || []).reduce((s, l) => s + lineShopNet(l), 0))
export const orderShopFee = (lines: BoatOrderLine[]): number =>
  r2((lines || []).reduce((s, l) => s + lineEffTotal(l), 0) - orderShopNet(lines))

// Більше нуля — магазин винен нам; менше — винні ми; для роздробу 0.
export const shopDue = (o: Partial<ShopOrderLike>): number =>
  isShopOrder(o) ? r2(orderShopNet(o.lines || []) - clientDueToUs(o)) : 0

// Вид рядка за підписом — для старих рядків без kind (автозбір пише «Кораблик …», «Сумка: …»).
export const inferLineKind = (label: string): ShopLineKind | null => {
  const s = (label || '').trim().toLowerCase()
  if (s.startsWith('кораблик')) return 'boat'
  for (const k of BOAT_OPTION_KINDS) if (s.startsWith(`${BOAT_OPTION_KIND_LABELS[k].toLowerCase()}:`)) return k
  return null
}

// Комісія магазину для виду рядка; виду немає або відсоток не задано — без комісії.
export const shopPctFor = (terms: ShopTerms | undefined, kind: ShopLineKind | null | undefined): number => {
  const v = kind ? Number(terms?.commissionByKind?.[kind]) : 0
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0
}

// Підставити комісію магазину в рядки (при виборі магазину і при перерахунку з каталогу).
export const applyShopPct = (lines: BoatOrderLine[], terms: ShopTerms | undefined): BoatOrderLine[] =>
  (lines || []).map((l) => {
    const kind = l.kind || inferLineKind(l.label)
    return { ...l, kind: kind || null, shopPct: shopPctFor(terms, kind) }
  })

// Похідні поля перед збереженням: вид, сума «клієнт платить нам», скільки замовлення коштує магазину,
// застаріле payTo (його ще читають старі місця). Роздрібне замовлення не чіпаємо.
export const withShopDerived = <T extends Partial<BoatOrder>>(o: T): T => {
  if (!isShopOrder(o)) {
    return o.kind === 'retail' ? { ...o, dropshipperId: null, ttnBy: null, collectByUs: null, shopNet: null, payTo: 'us' } : o
  }
  const mode = payMode(o)
  return {
    ...o,
    kind: orderKind(o),
    ttnBy: o.ttnBy === 'shop' ? 'shop' : 'us',
    collectByUs: clientDueToUs(o),
    shopNet: orderShopNet(o.lines || []),
    payTo: mode === 'none' ? 'dropshipper' : 'us', // аванс магазину + решта нам — теж «гроші отримуємо ми»
  }
}

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
  // Дозволені способи оплати цього замовлення (обирає адмін): онлайн-методи + 'cod'
  // (наложений платіж — сума встановлюється в ТТН автоматично з суми замовлення).
  payMethods?: string[]
  // ФОП для кожного обраного способу (метод → fopId): онлайн — хто приймає гроші і видає чек;
  // 'cod' — ФОП-відправник ТТН (на нього приходить наложений платіж).
  payFops?: Record<string, string>
  // Продаж через магазин-партнера (§26.1). Чек видає отримувач грошей: наш чек і наше посилання
  // на оплату — лише на ту суму, яку клієнт платить нам.
  kind?: BoatOrderKind // немає поля: є dropshipperId → дропшипінг, інакше роздріб
  dropshipperId?: string | null // магазин
  ttnBy?: 'us' | 'shop' | null // накладну створюємо ми / номер дав магазин (тоді наложку отримує він)
  collectByUs?: number | null // скільки клієнт платить НАМ: 0 — усе магазину, total — усе нам, між — аванс магазину
  shopNet?: number | null // скільки замовлення коштує магазину (роздріб мінус комісія по рядках); пишеться при збереженні
  payTo?: 'us' | 'dropshipper' // застаріле, виводиться з collectByUs (нових значень не додаємо — поле читають старі місця)
  // Доставка (пишет сервер при создании ТТН)
  ttn?: string | null
  npDocRef?: string | null
  npCodAmount?: number | null // наложка в нашій накладній, грн (0 — без наложки)
  npFopId?: string | null // ФОП-відправник нашої накладної
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

// Способи оплати замовлення для UI (онлайн-методи збігаються з BOAT_PAY_METHODS у boatPay.ts).
export const BOAT_ORDER_PAY_METHOD_LABELS: Record<string, string> = {
  cod: 'Наложений платіж (НП)',
  'mono-acquire': 'Картою (monobank)',
  'mono-chast': 'Покупка частинами (monobank)',
  'liqpay-card': 'Картою (LiqPay)',
  'liqpay-paypart': 'Оплата частинами (LiqPay)',
}
