// База клиентов и их корабликов.
//
// Наполняется из опросника приёмки; позже — выгрузкой из 1С (история продаж) и
// endpoint'ом пополнения при продаже (upsert по externalId). Содержит контактные
// данные — доступ на чтение только администратору (см. firestore.rules).

// Модельный ряд корабликов RunFerry (для выпадающего списка в опроснике).
export const BOAT_MODELS = [
  'Камарад', 'Solo V2', 'Solo V3', 'Mini', 'Optima', 'R3', 'R2', 'R1', 'RM', 'RS',
] as const

// Тип установленного эхолота/глубиномера.
// 'installed-unknown' — эхолот стоит, но клиент не знает модель.
export type EchoType = 'none' | 'toslon' | 'depth-gauge' | 'runferry' | 'installed-unknown' | 'unknown'

export const ECHO_LABELS: Record<EchoType, string> = {
  none: 'Немає',
  toslon: 'Toslon',
  'depth-gauge': 'Глибиномір',
  runferry: 'Ехолот RunFerry',
  'installed-unknown': 'Встановлено, модель не знаю',
  unknown: 'Не знаю',
}

// Наличие автопилота: нет / есть / не знаю. Модель — отдельным полем (может быть пустой:
// «стоит, но не знаю модели»).
export type AutopilotPresence = 'none' | 'yes' | 'unknown'

export const AUTOPILOT_PRESENCE_LABELS: Record<AutopilotPresence, string> = {
  none: 'Немає',
  yes: 'Встановлено',
  unknown: 'Не знаю',
}

// Общая удовлетворённость корабликом
export type Satisfaction = 'yes' | 'partly' | 'no' | 'unknown'

export const SATISFACTION_LABELS: Record<Satisfaction, string> = {
  yes: 'Так, задоволений',
  partly: 'Частково',
  no: 'Ні',
  unknown: 'Не вказано',
}

// Гарантия: 1 год с даты продажи. Пока спрашиваем в опроснике; позже подтянем из базы
// корабликов (по purchaseDate) автоматически.
export type WarrantyStatus = 'yes' | 'no' | 'unknown'

export const WARRANTY_LABELS: Record<WarrantyStatus, string> = {
  yes: 'Так, на гарантії',
  no: 'Ні, гарантія закінчилась',
  unknown: 'Не знаю',
}

// Срок гарантии в месяцах от даты продажи
export const WARRANTY_MONTHS = 12

// Автовычисление гарантии по дате продажи (когда она известна из базы/1С)
export const warrantyFromPurchaseDate = (purchaseDate: string | null | undefined, now: Date): WarrantyStatus => {
  if (!purchaseDate) return 'unknown'
  const sold = new Date(purchaseDate)
  if (Number.isNaN(sold.getTime())) return 'unknown'
  const expires = new Date(sold)
  expires.setMonth(expires.getMonth() + WARRANTY_MONTHS)
  return now <= expires ? 'yes' : 'no'
}

export type ClientBoatSource = 'questionnaire' | '1c'

export interface ClientBoat {
  id: string
  contact: { name?: string; phone?: string; email?: string } | null
  model: string // из BOAT_MODELS или произвольная строка
  year: string // год кораблика
  echo: EchoType
  autopilotPresence: AutopilotPresence // есть ли автопилот
  autopilotModel: string // модель, если знает (пусто = «стоит, но не знаю модели»)
  autopilotUpdated: boolean // производилось ли обновление ПО автопилота
  autopilotUpdateYear: string // в каком году (если обновляли)
  satisfaction: Satisfaction
  wishes: string // общие пожелания клиента
  warranty: WarrantyStatus // на гарантии ли (со слов клиента; позже — авто из purchaseDate)
  purchaseDate: string | null // дата продажи (из базы/1С) — для авто-расчёта гарантии
  source: ClientBoatSource
  externalId: string | null // id из 1С — для будущей выгрузки/синхронизации
  sessionId: string | null // связанная чат-сессия (если из опросника)
  createdAt: string
  updatedAt: string
}
