// Прайс-лист и сметы по сервису
//
// Модель разбивает сервисную работу на мелкие детализированные операции.
// Каждая операция (Work) измеряется в нормо-часах (как в автосервисе) и может
// тянуть за собой материалы (Material) и опциональные доп. товары/услуги (Addon).
// Быстрые наборы (Kit) — внутренний инструмент: один выбор менеджера
// разворачивается в длинный список недорогих работ, из которых складывается смета.

// Языки локализации (совпадает с src/i18n)
export type Lang = 'uk' | 'en' | 'ru' | 'de' | 'pl' | 'ro'

// Локализованный текст. uk обязателен как основной/fallback язык проекта,
// остальные языки — опционально (см. helper tName в src/utils/pricing.ts).
export type LocalizedText = { uk: string } & Partial<Record<Lang, string>>

// В проекте валюта одна — гривна (UAH). Тип оставлен на будущее расширение.
export type Currency = 'UAH'

// Категория работ — для группировки в прайс-листе и админке
export interface WorkCategory {
  id: string
  name: LocalizedText
  order: number
}

// Материал (расходник), привязывается к работе. Цена фиксированная (без сезона).
export interface Material {
  id: string
  code: string
  name: LocalizedText
  unit: LocalizedText // единица измерения: шт, мл, компл.
  price: number // цена за единицу, грн
  // Отметка «продажа нового оборудования»: если этот материал попал в смету,
  // наценка высокого сезона снимается со ВСЕЙ сметы (достаточно одной такой позиции).
  waivesHighSeasonSurcharge?: boolean
  active: boolean
}

// Доп. товар или услуга, привязывается к работе (например «утилизация салфеток»)
export interface Addon {
  id: string
  code: string
  name: LocalizedText
  kind: 'service' | 'product'
  // product — фиксированная цена; service — тоже фикс. цена (сезон к доп. не применяется,
  // см. решение по сезонности: коэффициент только на основную работу).
  price: number // грн
  active: boolean
}

// Ссылка на материал внутри работы (сколько единиц нужно на одну работу)
export interface WorkMaterialRef {
  materialId: string
  qty: number
}

// Ссылка на доп. услугу/товар внутри работы
export interface WorkAddonRef {
  addonId: string
  // true — включён в смету сразу; false — предлагается опционально (менеджер/клиент решает)
  includedByDefault: boolean
}

// Как работа ведёт себя в смете с несколькими жалобами:
//  • 'once'          — выполняется один раз на всю смету, даже если нужна нескольким
//                       жалобам (приёмка, транспортировка, упаковка) → дубликаты объединяются;
//  • 'perComplaint'  — выполняется отдельно для каждой жалобы (настройка, ремонт) → суммируется.
export type WorkDedupe = 'once' | 'perComplaint'

// Работа (операция) — базовая единица прайс-листа
export interface Work {
  id: string
  code: string // артикул, напр. "W-DRY-01"
  name: LocalizedText
  description?: LocalizedText
  categoryId: string
  laborHours: number // нормо-часы
  dedupe: WorkDedupe // поведение при нескольких жалобах в смете
  // Отметка «без сезонной наценки»: если эта работа попала в смету, наценка высокого
  // сезона снимается со ВСЕЙ сметы (достаточно одной такой позиции). Напр. работы по
  // установке нового оборудования. Обобщает serviceKind='upgrade' на уровень позиции.
  waivesHighSeasonSurcharge?: boolean
  // Критическая работа (не работает мотор, замена сервопривода руля/бункера): наценка
  // высокого сезона НЕ применяется к этой позиции, но ТОЛЬКО к ней (в отличие от
  // waivesHighSeasonSurcharge, который снимает наценку со всей сметы).
  criticalNoSurcharge?: boolean
  materials: WorkMaterialRef[]
  addons: WorkAddonRef[]
  publicVisible: boolean // показывать ли в публичном прайс-листе
  active: boolean
}

// Позиция набора
export interface KitItem {
  workId: string
  qty: number
}

// Тип обращения:
//  • 'repair'  — устранение поломки. Сезонная наценка применяется; в высокий/средний
//                сезон клиенту можно предложить отложить сервис до дешёвого сезона,
//                если кораблик пока эксплуатируется.
//  • 'upgrade' — установка доп. оборудования или обновление (эхолот, ПО автопилота).
//                Выполняется сразу; наценка высокого сезона НЕ применяется.
export type ServiceKind = 'repair' | 'upgrade'

// Быстрый набор — разворачивается в список работ. Внутренний инструмент менеджера.
// Сезонный режим набора:
//  • normal — обычная работа: действуют сезонные коэффициенты (наценка/скидка) на позиции;
//  • critical — критическая поломка: позиции набора БЕЗ наценки высокого сезона (скидка низкого — остаётся);
//  • benefit — льготный: без наценки высокого сезона, И при добавлении в смету снимает наценку со ВСЕЙ сметы.
export type KitSeasonMode = 'normal' | 'critical' | 'benefit'

export const KIT_SEASON_LABELS: Record<KitSeasonMode, string> = {
  normal: 'Обычная (сезон действует)',
  critical: 'Критическая (без наценки сезона)',
  benefit: 'Льготная (снимает наценку со всей сметы)',
}

export interface Kit {
  id: string
  code: string
  name: LocalizedText
  description?: LocalizedText
  categoryId: string
  serviceKind: ServiceKind
  seasonMode?: KitSeasonMode // сезонное поведение набора (по умолчанию 'normal')
  items: KitItem[]
  active: boolean
}

// Сезонное правило (зима −25% → 0.75, высокий сезон +50% → 1.5, обычный → 1.0)
export interface SeasonRule {
  id: string
  name: LocalizedText
  coefficient: number
  months: number[] // месяцы (1–12) для авто-применения по календарю
}

// ==== Расшифровка ставки нормо-часа ====
//
// Ставка клиенту складывается из компонентов: зарплата мастеру + налоги на ФОТ +
// администрирование + норма прибыли + налог с оборота (ФОП). Клиент может раскрыть
// расшифровку по клику на ставку. Итоговая ставка вычисляется из компонентов.

// От какой базы считается процентный компонент:
//  • 'salary'     — от базовой зарплаты (налоги на ФОТ: НДФЛ, военный сбор, ЕСВ);
//  • 'cumulative' — от накопленной суммы (наценка: администрирование, прибыль);
//  • 'revenue'    — от итоговой выручки, gross-up (налог с оборота ФОП).
export type RateComponentBase = 'salary' | 'cumulative' | 'revenue'

export interface RateComponent {
  id: string
  name: LocalizedText
  kind: 'amount' | 'percent' // amount — абсолютная сумма (зарплата), percent — процент
  value: number // грн (amount) или % (percent)
  base?: RateComponentBase // для percent: от чего считать (по умолчанию 'cumulative')
}

export interface RateBreakdown {
  components: RateComponent[]
}

// Глобальные настройки ценообразования (редактирует администратор)
export interface PricingSettings {
  currency: Currency
  // Ставка нормо-часа, грн. Если задан rateBreakdown — вычисляется из него,
  // иначе используется это значение напрямую (см. resolveLaborRate).
  laborRatePerHour: number
  rateBreakdown?: RateBreakdown
  seasons: SeasonRule[]
  // Ручной оверрайд активного сезона по id; null → авто по текущему месяцу
  activeSeasonOverride: string | null
  // Общие работы, сопутствующие любому ремонту (приёмка, подготовка к тесту, упаковка…).
  // Коды работ прайса; при сборке любой сметы они добавляются автоматически, если ещё
  // не включены (в т.ч. через набор). Дедупликация — по dedupe='once'.
  commonWorkCodes?: string[]
  updatedAt: string
  updatedBy: string | null
}

// ==== Смета (результат расчёта) ====

export type EstimateLineType = 'labor' | 'material' | 'addon'

// Одна строка детальной сметы
export interface EstimateLine {
  type: EstimateLineType
  refId: string // workId | materialId | addonId
  code: string
  name: LocalizedText
  qty: number
  laborHours?: number // для строк type='labor'
  unitPrice: number // цена за единицу ДО сезонного коэффициента, грн
  seasonApplied: boolean // применён ли сезонный коэффициент к этой строке (только labor)
  lineTotal: number // итог строки, грн (с учётом сезона для labor)
  sourceKitId?: string // из какого набора пришла работа (для группировки)
  fromWorkId?: string // к какой работе относится материал/доп.
  // Мульти-жалобы:
  complaintIndex?: number // к какой жалобе относится (индекс секции)
  merged?: boolean // объединено из нескольких жалоб (dedupe='once')
  mergedCount?: number // сколько жалоб требовало эту позицию (>1 при merged)
}

// Ссылка на жалобу внутри сметы (для истории и базы знаний AI)
export interface EstimateComplaintRef {
  complaint: string
  kitId?: string
  serviceKind?: ServiceKind // поломка или апгрейд (влияет на сезонную наценку)
}

// ==== Предварительная / фактическая калькуляция ====
//
//  • 'preliminary' — ПРЕДВАРИТЕЛЬНАЯ калькуляция (оценка до работ; из AI-оценки или ручной
//                    сборки). Показывается клиенту как ориентир.
//  • 'actual'      — ФАКТИЧЕСКАЯ калькуляция (реально выполненные работы+материалы после
//                    диагностики/ремонта). Из неё выбивается фискальный чек и берётся сумма
//                    к оплате. Ссылается на предварительную через parentEstimateId.
// Отсутствие поля kind у старых смет трактуется как 'preliminary' (обратная совместимость).
export type EstimateKind = 'preliminary' | 'actual'

// ==== Три стадии калькуляции ====
//
//  • 'ai'       — предварительная оценка ИИ (черновик, внутренняя; source='ai'). Заготовка мастеру.
//  • 'proposed' — утверждённый мастером ВАРИАНТ для клиента. Вариантов может быть несколько
//                 (offerId группирует их в одно предложение); клиент выбирает ОДИН путь.
//  • 'actual'   — фактическая калькуляция по выбранному варианту. По ней оплата и фискальный чек.
// Соотношение с kind: 'ai'/'proposed' → kind='preliminary'; 'actual' → kind='actual'.
export type EstimateStage = 'ai' | 'proposed' | 'actual'

// Статус жизненного цикла (в основном для фактической сметы):
//  • 'draft'            — черновик мастера (ещё правится);
//  • 'pending_approval' — рост сметы > порога, ждёт согласия клиента;
//  • 'approved'         — согласована (в т.ч. авто ≤ порога) → можно выставлять оплату;
//  • 'paid'             — оплачена, чек выбит (paymentId/fopId/paidAt проставлены);
//  • 'rejected'         — клиент отклонил рост сметы.
export type EstimateStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'rejected'

// Позиция для фискального чека (снимок, из estimate2goods). Сумма позиций == total.
export interface ReceiptGood {
  name: string // готовая строка для чека (уже локализованная)
  price: number // цена за единицу, грн
  qty: number // количество
  code?: string // артикул (если нужен по требованиям чека)
}

// Способы оплаты (ключи совпадают с fop.methods на бэкенде). cod — накладений платіж (при отриманні).
export type PayMethodKey = 'liqpayCard' | 'liqpayPaypart' | 'monoChast' | 'monoAcquire' | 'privatPaypart' | 'cod'
export const PAY_METHOD_KEYS: PayMethodKey[] = ['liqpayCard', 'liqpayPaypart', 'monoChast', 'monoAcquire', 'privatPaypart', 'cod']
export const PAY_METHOD_LABELS: Record<PayMethodKey, string> = {
  liqpayCard: 'Картою (LiqPay)',
  liqpayPaypart: 'Частинами (LiqPay)',
  monoChast: 'Частинами (monobank)',
  monoAcquire: 'Картою (monobank еквайринг)',
  privatPaypart: 'Оплата частинами (ПриватБанк)',
  cod: 'Накладений платіж (Нова Пошта)',
}
// Онлайн-оплата идёт через /api/estimates/pay (LiqPay/monobank Частини). cod — оплата при получении
// (не онлайн). Прочие (monoAcquire/privatPaypart) — потоки ещё не реализованы (только настройка ФОП).
export const ONLINE_PAY_METHODS: PayMethodKey[] = ['liqpayCard', 'liqpayPaypart', 'monoChast']

// Разрешённый способ оплаты фактической сметы + ФОП, которым он принимается (дефолт из центра,
// переопределяемо мастером). Клиенту отдаётся только список method (без fopId) через safeEstimate.
export interface EstimatePayOption {
  method: PayMethodKey
  fopId: string
}

// Распределение фактической сметы по специалистам (ВНУТРЕННЯЯ экономика — клиенту НЕ отдаётся:
// serverный safeEstimate это поле не включает; priceEstimates читает только админ). Специалист —
// портальный пользователь центра (role master/director). specialistAmount — сумма специалисту;
// centerAdminAmount — центру за администрирование. Суммы задаются мастером вручную.
export interface SpecialistPayout {
  uid: string
  name: string // ФИО (снимок, чтобы отображать без загрузки users)
  specialistAmount: number // грн специалисту
  centerAdminAmount: number // грн центру за администрирование
}

// Смета целиком. Сохраняется в Firestore и служит обучающим примером для AI-оценки.
export interface Estimate {
  id: string
  requestId: string | null // привязка к заявке 1С (если смета из заявки)
  title: string
  complaint: string // сводная жалоба (для совместимости; детали — в sections)
  sections?: EstimateComplaintRef[] // разбивка по жалобам (мульти-жалобы)
  lines: EstimateLine[]
  laborTotal: number // сумма работ (с сезоном), грн
  materialsTotal: number
  addonsTotal: number
  seasonId: string
  seasonCoefficient: number // сырой коэффициент активного сезона (какой сезон)
  seasonSurchargeApplied: boolean // фактически ли применена наценка (>1) к работам сметы
  laborRatePerHour: number // ставка на момент составления сметы (фиксируем для истории)
  total: number
  currency: Currency
  source: 'manual' | 'kit' | 'ai' // как собрана смета
  createdAt: string
  createdBy: string | null
  // — Предварительная/фактическая калькуляция и связь с оплатой —
  kind?: EstimateKind // роль сметы (по умолчанию 'preliminary')
  stage?: EstimateStage // стадия: 'ai' | 'proposed' | 'actual' (уточняет kind)
  status?: EstimateStatus // статус жизненного цикла (для фактической)
  serviceRequestId?: string | null // привязка к НАШЕЙ заявке на обслуживание (serviceRequests)
  parentEstimateId?: string | null // из чего выросла: proposed←ai, actual←выбранный proposed-вариант
  // Для stage='proposed' — принадлежность к предложению (набору вариантов) и подпись варианта:
  offerId?: string | null
  variantLabel?: string // «Повний ремонт» / «Бюджетний» и т.п.
  variantOrder?: number
  receiptGoods?: ReceiptGood[] // снимок позиций для чека (для фактической, на момент согласования)
  specialistPayouts?: SpecialistPayout[] // распределение по специалистам (внутреннее; клиенту не видно)
  payOptions?: EstimatePayOption[] // разрешённые способы оплаты + ФОП по каждому (дефолт из центра)
  // Проставляются backend-ом после оплаты и фискализации (минуя клиентские правила):
  payInitiatedAt?: string | null // клиент начал оплату (claim на ~3 хв) — редактировать нельзя
  paymentId?: string | null // orderId в коллекции payments
  fopId?: string | null // ФОП, принявший оплату и выбивший чек
  paidAt?: string | null
  taxUrl?: string | null // ссылка на фискальный чек Checkbox
  fiscalCode?: string | null // фискальный код чека
}

// Предложение клиенту — набор вариантов (stage='proposed'), из которых клиент выбирает ОДИН путь.
// Хранится в Firestore estimateOffers/{id}; клиент открывает по ссылке /offer/:id и выбирает вариант.
export interface EstimateOffer {
  id: string
  requestId: string | null // привязка к заявке 1С (если из заявки)
  serviceRequestId?: string | null // привязка к НАШЕЙ заявке на обслуживание (serviceRequests)
  title: string // заголовок предложения (кораблик/скарга)
  variantIds: string[] // id вариантов (Estimate stage='proposed')
  selectedVariantId: string | null // выбранный клиентом вариант (путь ремонта)
  // 'pending_choice' — ждём выбора; 'chosen' — выбран; 'locked' — по выбранному варианту уже
  // собрана фактическая калькуляция → переизбор клиентом заблокирован (иначе факт/чек разойдутся).
  status: 'pending_choice' | 'chosen' | 'locked'
  createdAt: string
  createdBy: string | null
  chosenAt?: string | null
}

// ==== База знаний для AI-оценки ====
//
// Перегенерируется после накопления новых смет (порог KB_REBUILD_THRESHOLD).
// AI опирается на неё и на прайс-лист, не выдумывая позиции.

export interface KnowledgeEntry {
  problemType: string // нормализованный тип проблемы
  aliases: string[] // варианты формулировок жалоб клиентов
  suggestedKitIds: string[] // подходящие наборы из прайса
  suggestedWorkIds: string[] // подходящие работы из прайса
  priceRange: { min: number; max: number; avg: number }
  sampleCount: number // на скольких сметах основано
}

export interface KnowledgeBase {
  entries: KnowledgeEntry[]
  generatedAt: string
  basedOnEstimates: number // всего смет учтено
  estimatesSinceRebuild: number // накоплено новых с последней генерации
  version: number
}

// Порог перегенерации базы знаний (по числу новых смет)
export const KB_REBUILD_THRESHOLD = 5

// ==== Предложение отложить сервис (сезонная экономия) ====
//
// Для поломок в сезон с наценкой (коэф > 1): если кораблик ещё можно эксплуатировать,
// клиенту выгоднее сделать сервис в дешёвый сезон. Апгрейды сюда не попадают —
// они выполняются сразу и без сезонной наценки.
export interface DeferSuggestion {
  applicable: boolean
  currentSeasonId: string
  currentCoefficient: number
  bestSeasonId: string // сезон с минимальным коэффициентом
  bestCoefficient: number
  currentTotal: number // итог сметы сейчас
  bestTotal: number // итог, если отложить до дешёвого сезона
  savings: number // экономия, грн
  reason: 'high-season' | 'not-applicable' | 'boat-not-usable' | 'upgrade-only'
}
