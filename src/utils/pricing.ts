// Движок расчёта смет по прайс-листу.
//
// Чистые функции без побочных эффектов (кроме метки времени createdAt) — сюда
// вынесена вся логика ценообразования, чтобы её можно было переиспользовать и
// в UI, и на сервере (AI-оценка), и покрыть проверками.
//
// Правила расчёта:
//  • Стоимость работы = нормо-часы × ставка (laborRatePerHour).
//  • Сезонный коэффициент применяется ТОЛЬКО к стоимости работ (labor).
//  • Материалы и доп. товары/услуги идут по фиксированной цене (без сезона).

import type {
  Addon,
  DeferSuggestion,
  Estimate,
  EstimateComplaintRef,
  EstimateLine,
  EstimateLineType,
  Kit,
  LocalizedText,
  Material,
  PricingSettings,
  RateBreakdown,
  RateComponentBase,
  ReceiptGood,
  SeasonRule,
  ServiceKind,
  Work,
  WorkCategory,
} from '@/types/pricing'
import type { ServiceAuthorization } from '@/types/chat'
import { NO_REAPPROVAL_DEVIATION_PCT } from '@/types/chat'

// ==== Вспомогательные функции ====

// Округление до копеек
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

// Перевод локализованного текста с fallback на украинский
export const tName = (text: LocalizedText | undefined, lang: string): string => {
  if (!text) return ''
  return (text as Record<string, string>)[lang] || text.uk || ''
}

// Форматирование суммы в гривнах (как в остальном проекте, см. service.ts)
export const formatMoney = (amount: number, locale = 'uk-UA'): string =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'UAH' }).format(amount)

// ==== Каталог (индексы по id для быстрого расчёта) ====

export interface CatalogInput {
  categories: WorkCategory[]
  works: Work[]
  kits: Kit[]
  materials: Material[]
  addons: Addon[]
}

export interface PriceCatalog {
  categories: Record<string, WorkCategory>
  works: Record<string, Work>
  kits: Record<string, Kit>
  materials: Record<string, Material>
  addons: Record<string, Addon>
}

const indexById = <T extends { id: string }>(items: T[]): Record<string, T> => {
  const map: Record<string, T> = {}
  for (const item of items) map[item.id] = item
  return map
}

export const buildCatalog = (input: CatalogInput): PriceCatalog => ({
  categories: indexById(input.categories),
  works: indexById(input.works),
  kits: indexById(input.kits),
  materials: indexById(input.materials),
  addons: indexById(input.addons),
})

// ==== Сезонность ====

// Обычный сезон по умолчанию (если ни одно правило не подошло)
const DEFAULT_SEASON: SeasonRule = {
  id: 'normal',
  name: { uk: 'Звичайний сезон', ru: 'Обычный сезон', en: 'Regular season' },
  coefficient: 1,
  months: [],
}

// Определить активный сезон: ручной оверрайд имеет приоритет, иначе — авто по месяцу
export const resolveActiveSeason = (settings: PricingSettings, month: number): SeasonRule => {
  const { seasons, activeSeasonOverride } = settings
  if (activeSeasonOverride) {
    const forced = seasons.find((s) => s.id === activeSeasonOverride)
    if (forced) return forced
  }
  const auto = seasons.find((s) => s.months.includes(month))
  if (auto) return auto
  return seasons.find((s) => s.coefficient === 1) ?? DEFAULT_SEASON
}

// Текущий месяц (1–12) в часовом поясе Украины (Europe/Kyiv). Сезонная наценка привязана к
// украинскому времени, а не к TZ рантайма (Cloud Run — UTC) или браузера клиента (может быть
// за кордоном): иначе у границы месяца коэффициент сезона «плавал» бы в зависимости от места расчёта.
export const currentMonth = (): number => {
  try {
    return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', month: 'numeric' }).format(new Date()), 10)
  } catch {
    return new Date().getMonth() + 1
  }
}

// Эффективный сезонный коэффициент.
// Наценка высокого сезона не применяется (коэффициент не поднимается выше 1), если это
// апгрейд ИЛИ в смете есть позиция с отметкой «без сезонной наценки» (waives).
// Скидка низкого сезона (коэф < 1) в обоих случаях сохраняется.
export const effectiveSeasonCoef = (coef: number, kind: ServiceKind, waives = false): number =>
  kind === 'upgrade' || waives ? Math.min(coef, 1) : coef

// ==== Ставка нормо-часа и её расшифровка ====

// Одна строка расшифровки ставки (для waterfall в UI)
export interface RateLine {
  name: LocalizedText
  amount: number // вклад компонента в ставку, грн
  kind: 'amount' | 'percent'
  base?: RateComponentBase
  percent?: number // процент, если kind='percent'
}

export interface RateComputation {
  rate: number // итоговая ставка нормо-часа, грн
  salary: number // базовая зарплата (сумма amount-компонентов)
  lines: RateLine[]
}

// Вычислить ставку нормо-часа из расшифровки:
//  • amount-компоненты складываются в базовую зарплату;
//  • percent от 'salary'/'cumulative' применяются каскадно;
//  • percent от 'revenue' — налоги с оборота, gross-up в конце.
export const computeLaborRate = (breakdown: RateBreakdown): RateComputation => {
  const comps = breakdown.components
  const salary = comps.filter((c) => c.kind === 'amount').reduce((a, c) => a + c.value, 0)

  const lines: RateLine[] = []
  let cumulative = salary

  for (const c of comps.filter((c) => c.kind === 'amount')) {
    lines.push({ name: c.name, amount: round2(c.value), kind: 'amount' })
  }

  for (const c of comps.filter((c) => c.kind === 'percent' && c.base !== 'revenue')) {
    const from = c.base === 'salary' ? salary : cumulative
    const amount = round2((from * c.value) / 100)
    cumulative = round2(cumulative + amount)
    lines.push({ name: c.name, amount, kind: 'percent', base: c.base ?? 'cumulative', percent: c.value })
  }

  const revenueComps = comps.filter((c) => c.kind === 'percent' && c.base === 'revenue')
  // Клампим суммарный налог с оборота ниже 100%: иначе делитель (1 − revPct) ≤ 0
  // ломает gross-up. revPct ≥ 100% — это ошибка конфигурации (налог не может съедать
  // весь оборот); ограничиваем, чтобы ставка не «схлопнулась» и не пропустила gross-up.
  const revPct = Math.min(revenueComps.reduce((a, c) => a + c.value, 0) / 100, 0.99)
  let rate = cumulative
  if (revPct > 0) rate = round2(cumulative / (1 - revPct))
  for (const c of revenueComps) {
    lines.push({ name: c.name, amount: round2((rate * c.value) / 100), kind: 'percent', base: 'revenue', percent: c.value })
  }

  return { rate, salary, lines }
}

// Фактическая ставка нормо-часа: из расшифровки, если задана, иначе прямое значение
export const resolveLaborRate = (settings: PricingSettings): number =>
  settings.rateBreakdown ? computeLaborRate(settings.rateBreakdown).rate : settings.laborRatePerHour

// ==== Разворачивание набора ====

export interface ExpandedWork {
  work: Work
  qty: number
}

// Развернуть набор в список работ с количеством (пропускает несуществующие/неактивные)
export const expandKit = (kit: Kit, catalog: PriceCatalog): ExpandedWork[] => {
  const result: ExpandedWork[] = []
  for (const item of kit.items) {
    const work = catalog.works[item.workId]
    if (work && work.active) result.push({ work, qty: item.qty })
  }
  return result
}

// ==== Сборка сметы ====

// Позиция-работа на входе сборки сметы
export interface EstimateWorkInput {
  workId: string
  qty: number
  sourceKitId?: string
  // доп. услуги/товары этой работы, включаемые СВЕРХ includedByDefault
  extraAddonIds?: string[]
  // доп. по умолчанию, которые нужно ИСКЛЮЧИТЬ (клиент отказался)
  excludeAddonIds?: string[]
}

export interface BuildEstimateParams {
  works: EstimateWorkInput[]
  catalog: PriceCatalog
  settings: PricingSettings
  month?: number // 1–12; по умолчанию — текущий месяц
  serviceKind?: ServiceKind // тип обращения (влияет на сезонную наценку); по умолчанию 'repair'
  skipCommonWorks?: boolean // не добавлять общие работы (для витрины «цена одной работы»)
  forceWaive?: boolean // принудительно снять наценку высокого сезона (напр. льготный/критический набор)
  meta?: {
    requestId?: string | null
    title?: string
    complaint?: string
    source?: Estimate['source']
    createdBy?: string | null
  }
}

// Какие доп. работы включить: (по умолчанию ∪ дополнительно) − исключённые
const resolveActiveAddonIds = (work: Work, input: EstimateWorkInput): string[] => {
  const ids = new Set<string>()
  for (const ref of work.addons) {
    if (ref.includedByDefault) ids.add(ref.addonId)
  }
  for (const id of input.extraAddonIds ?? []) ids.add(id)
  for (const id of input.excludeAddonIds ?? []) ids.delete(id)
  return [...ids]
}

// Метки для строк одной работы (используются в мульти-жалобах)
interface LineTags {
  complaintIndex?: number
  merged?: boolean
  mergedCount?: number
}

// Построить строки сметы для одной работы: labor + материалы + доп.
const buildWorkLines = (
  work: Work,
  qty: number,
  input: EstimateWorkInput,
  rate: number,
  coef: number,
  catalog: PriceCatalog,
  tags: LineTags = {}
): EstimateLine[] => {
  const lines: EstimateLine[] = []

  // Строка работы (labor) — единственная, к которой применяется сезон.
  // Критическая работа снимает наценку высокого сезона ТОЛЬКО со своей строки
  // (min(coef,1)), не затрагивая остальную смету.
  // unitPrice округляем для отображения; lineTotal считаем из неокруглённого, чтобы
  // не накапливать двойное округление. seasonApplied — реально ли коэффициент ≠ 1.
  const lineCoef = work.criticalNoSurcharge ? Math.min(coef, 1) : coef
  const laborUnit = round2(work.laborHours * rate)
  lines.push({
    type: 'labor', refId: work.id, code: work.code, name: work.name, qty,
    laborHours: work.laborHours, unitPrice: laborUnit, seasonApplied: lineCoef !== 1,
    lineTotal: round2(work.laborHours * rate * qty * lineCoef), sourceKitId: input.sourceKitId, ...tags,
  })

  // Материалы работы (фикс. цена, без сезона)
  for (const ref of work.materials) {
    const material = catalog.materials[ref.materialId]
    if (!material || !material.active) continue
    const totalQty = ref.qty * qty
    lines.push({
      type: 'material', refId: material.id, code: material.code, name: material.name,
      qty: totalQty, unitPrice: material.price, seasonApplied: false,
      lineTotal: round2(material.price * totalQty), fromWorkId: work.id, ...tags,
    })
  }

  // Доп. товары/услуги работы (фикс. цена, без сезона)
  for (const addonId of resolveActiveAddonIds(work, input)) {
    const addon = catalog.addons[addonId]
    if (!addon || !addon.active) continue
    lines.push({
      type: 'addon', refId: addon.id, code: addon.code, name: addon.name, qty,
      unitPrice: addon.price, seasonApplied: false, lineTotal: round2(addon.price * qty),
      fromWorkId: work.id, ...tags,
    })
  }

  return lines
}

// Собрать итоговый объект сметы из готовых строк
const finalizeEstimate = (
  lines: EstimateLine[],
  seasonId: string,
  coef: number,
  surchargeApplied: boolean,
  rate: number,
  settings: PricingSettings,
  meta: BuildEstimateParams['meta'],
  sections?: EstimateComplaintRef[]
): Estimate => {
  const sumBy = (type: EstimateLine['type']) =>
    round2(lines.filter((l) => l.type === type).reduce((acc, l) => acc + l.lineTotal, 0))
  const laborTotal = sumBy('labor')
  const materialsTotal = sumBy('material')
  const addonsTotal = sumBy('addon')
  return {
    id: '',
    requestId: meta?.requestId ?? null,
    title: meta?.title ?? '',
    complaint: meta?.complaint ?? (sections ? sections.map((s) => s.complaint).filter(Boolean).join('; ') : ''),
    sections,
    lines,
    laborTotal,
    materialsTotal,
    addonsTotal,
    seasonId,
    seasonCoefficient: coef,
    seasonSurchargeApplied: surchargeApplied,
    laborRatePerHour: rate,
    total: round2(laborTotal + materialsTotal + addonsTotal),
    currency: settings.currency,
    source: meta?.source ?? 'manual',
    createdAt: new Date().toISOString(),
    createdBy: meta?.createdBy ?? null,
  }
}

// Есть ли среди работ (или их активных материалов) позиция с отметкой «без сезонной наценки».
// Материал учитывается только активный — синхронно с buildWorkLines (неактивные не идут в смету).
const worksWaiveSurcharge = (workIds: string[], catalog: PriceCatalog): boolean => {
  for (const id of workIds) {
    const work = catalog.works[id]
    if (!work) continue
    if (work.waivesHighSeasonSurcharge) return true
    for (const ref of work.materials) {
      const m = catalog.materials[ref.materialId]
      if (m?.active && m.waivesHighSeasonSurcharge) return true
    }
  }
  return false
}

// Общие работы (сопутствующие любому ремонту), которых ещё нет в смете — по кодам из настроек.
export const commonWorkInputs = (
  settings: PricingSettings,
  catalog: PriceCatalog,
  existingWorkIds: Set<string>,
  excludeCodes?: Set<string> // виключені майстром у фактичному кошторисі
): EstimateWorkInput[] => {
  const codes = settings.commonWorkCodes ?? []
  if (!codes.length) return []
  const byCode = new Map(Object.values(catalog.works).map((w) => [w.code, w]))
  const result: EstimateWorkInput[] = []
  for (const code of codes) {
    if (excludeCodes?.has(code)) continue
    const w = byCode.get(code)
    if (!w || !w.active || existingWorkIds.has(w.id)) continue
    result.push({ workId: w.id, qty: 1 })
  }
  return result
}

// Собрать детальную смету из списка работ (одна жалоба).
// Общие работы (приёмка, тест, упаковка…) добавляются автоматически, если их ещё нет.
// Возвращает готовый Estimate с id='' — реальный id проставит слой хранения.
export const buildEstimate = (params: BuildEstimateParams): Estimate => {
  const { catalog, settings, meta } = params
  const month = params.month ?? currentMonth()
  const rate = resolveLaborRate(settings)
  const season = resolveActiveSeason(settings, month)

  const existing = new Set(params.works.map((w) => w.workId))
  const works = params.skipCommonWorks
    ? params.works
    : [...params.works, ...commonWorkInputs(settings, catalog, existing)]

  const waives = params.forceWaive || worksWaiveSurcharge(works.map((w) => w.workId), catalog)
  const coef = effectiveSeasonCoef(season.coefficient, params.serviceKind ?? 'repair', waives)

  const lines: EstimateLine[] = []
  for (const input of works) {
    const work = catalog.works[input.workId]
    if (!work) continue
    lines.push(...buildWorkLines(work, input.qty, input, rate, coef, catalog))
  }
  return finalizeEstimate(lines, season.id, season.coefficient, coef > 1, rate, settings, meta)
}

// ==== Смета с несколькими жалобами (мульти-жалобы) ====

// Метка авто-секции общих (сопутствующих) работ, которую buildMultiEstimate добавляет сама.
// Экспортируется, чтобы редактор мог отличать её (не редактируется вручную).
export const COMMON_SECTION_LABEL = 'Загальні роботи (супровід ремонту)'

// Секция сметы — одна жалоба клиента и относящиеся к ней работы
export interface ComplaintSection {
  complaint: string
  kitId?: string
  serviceKind: ServiceKind // поломка или апгрейд (определяет применение сезонной наценки)
  works: EstimateWorkInput[]
}

export interface BuildMultiEstimateParams {
  sections: ComplaintSection[]
  catalog: PriceCatalog
  settings: PricingSettings
  month?: number
  meta?: BuildEstimateParams['meta']
  // Коди загальних робіт, які майстер ВИКЛЮЧИВ у фактичному кошторисі (не додавати авто-секцією)
  excludeCommonCodes?: string[]
}

// Собрать смету из нескольких жалоб с дедупликацией повторяющихся позиций.
// Работы с dedupe='once' (приёмка, транспортировка) объединяются в один экземпляр
// с пометкой merged/mergedCount; работы 'perComplaint' суммируются по жалобам.
export const buildMultiEstimate = (params: BuildMultiEstimateParams): Estimate => {
  const { sections: inputSections, catalog, settings, meta } = params
  const month = params.month ?? currentMonth()
  const rate = resolveLaborRate(settings)
  const season = resolveActiveSeason(settings, month)

  // Общие работы (сопутствующие любому ремонту), которых нет ни в одной секции —
  // добавляем отдельной секцией. dedupe='once' обеспечит единичное вхождение.
  const existingIds = new Set(inputSections.flatMap((s) => s.works.map((w) => w.workId)))
  const commonInputs = commonWorkInputs(settings, catalog, existingIds,
    params.excludeCommonCodes?.length ? new Set(params.excludeCommonCodes) : undefined)
  const sections: ComplaintSection[] = commonInputs.length
    ? [...inputSections, { complaint: COMMON_SECTION_LABEL, serviceKind: 'repair', works: commonInputs }]
    : inputSections

  // Плоский список работ с индексом жалобы
  const flat: { input: EstimateWorkInput; ci: number }[] = []
  sections.forEach((sec, ci) => sec.works.forEach((input) => flat.push({ input, ci })))

  // Дедупликация работ с dedupe='once'. При объединении:
  //  • берём max(qty) по вхождениям (не теряем большее количество);
  //  • объединяем доп.услуги (union extra/exclude), чтобы не терять платные позиции;
  //  • тип обращения общей работы — наименее льготный: если работа нужна хоть одной
  //    repair-секции, коэффициент считается по repair (не зависит от порядка секций).
  interface Resolved {
    input: EstimateWorkInput
    ci: number
    qty: number
    extraAddonIds: string[]
    excludeAddonIds: string[]
    hardestKind: ServiceKind
    mergedCount: number
  }
  const onceIndex = new Map<string, number>()
  const resolved: Resolved[] = []
  for (const { input, ci } of flat) {
    const work = catalog.works[input.workId]
    if (!work) continue
    const kind = sections[ci]?.serviceKind ?? 'repair'
    if (work.dedupe === 'once' && onceIndex.has(input.workId)) {
      const r = resolved[onceIndex.get(input.workId)!]
      r.mergedCount += 1
      r.qty = Math.max(r.qty, input.qty)
      r.extraAddonIds = [...new Set([...r.extraAddonIds, ...(input.extraAddonIds ?? [])])]
      r.excludeAddonIds = [...new Set([...r.excludeAddonIds, ...(input.excludeAddonIds ?? [])])]
      if (kind === 'repair') r.hardestKind = 'repair' // наименее льготный побеждает
      continue
    }
    if (work.dedupe === 'once') onceIndex.set(input.workId, resolved.length)
    resolved.push({
      input, ci, qty: input.qty,
      extraAddonIds: input.extraAddonIds ?? [],
      excludeAddonIds: input.excludeAddonIds ?? [],
      hardestKind: kind, mergedCount: 1,
    })
  }

  // Отметка «без сезонной наценки» действует на ВСЮ смету: если хоть одна позиция
  // (любой секции) помечена — наценка высокого сезона снимается со всех секций.
  // Наценка снимается со ВСЕЙ сметы, если есть льготная позиция (флаг работы/материала)
  // ИЛИ льготный набор (seasonMode='benefit') в любой секции.
  const estimateWaives =
    worksWaiveSurcharge(sections.flatMap((s) => s.works.map((w) => w.workId)), catalog) ||
    sections.some((s) => s.kitId && catalog.kits[s.kitId]?.seasonMode === 'benefit')

  // Строки — коэффициент по наименее льготному типу общей работы + общая отметка waives
  const lines: EstimateLine[] = []
  for (const r of resolved) {
    const work = catalog.works[r.input.workId]!
    const merged = r.mergedCount > 1
    const coef = effectiveSeasonCoef(season.coefficient, r.hardestKind, estimateWaives)
    const mergedInput: EstimateWorkInput = {
      ...r.input,
      qty: r.qty,
      extraAddonIds: r.extraAddonIds,
      excludeAddonIds: r.excludeAddonIds,
    }
    lines.push(
      ...buildWorkLines(work, r.qty, mergedInput, rate, coef, catalog, {
        complaintIndex: r.ci,
        merged: merged || undefined,
        mergedCount: merged ? r.mergedCount : undefined,
      })
    )
  }

  // Наценка фактически применена, если хоть одна секция считается с эффективным коэф > 1
  const surchargeApplied = resolved.some(
    (r) => effectiveSeasonCoef(season.coefficient, r.hardestKind, estimateWaives) > 1
  )
  const refs: EstimateComplaintRef[] = sections.map((s) => ({ complaint: s.complaint, kitId: s.kitId, serviceKind: s.serviceKind }))
  return finalizeEstimate(lines, season.id, season.coefficient, surchargeApplied, rate, settings, meta, refs)
}

// Удобная обёртка: собрать смету из набора
export const buildEstimateFromKit = (
  kit: Kit,
  catalog: PriceCatalog,
  settings: PricingSettings,
  extra?: Partial<BuildEstimateParams>
): Estimate => {
  const works: EstimateWorkInput[] = expandKit(kit, catalog).map(({ work, qty }) => ({
    workId: work.id,
    qty,
    sourceKitId: kit.id,
  }))
  return buildEstimate({
    works,
    catalog,
    settings,
    month: extra?.month,
    serviceKind: extra?.serviceKind ?? kit.serviceKind,
    // Критический/льготный набор — без наценки высокого сезона на его работы
    forceWaive: kit.seasonMode === 'critical' || kit.seasonMode === 'benefit',
    meta: {
      title: tName(kit.name, 'uk'),
      source: 'kit',
      ...extra?.meta,
    },
  })
}

// Стоимость одной работы «под ключ» для витрины прайс-листа:
// работа + материалы по умолчанию + доп. по умолчанию, с учётом сезона на работу.
export const workTurnkeyPrice = (
  work: Work,
  catalog: PriceCatalog,
  settings: PricingSettings,
  month?: number
): number => {
  const est = buildEstimate({
    works: [{ workId: work.id, qty: 1 }],
    catalog,
    settings,
    month,
    skipCommonWorks: true, // витрина «цена одной работы» — без общих работ
  })
  return est.total
}

// Три сезонных коэффициента для витрины прайса: низкий (мин), обычный (1), высокий (макс).
export const seasonPriceCoefs = (settings: PricingSettings): { low: number; normal: number; high: number } => {
  const coefs = settings.seasons.map((s) => s.coefficient)
  return {
    low: coefs.length ? Math.min(1, ...coefs) : 1,
    normal: 1,
    high: coefs.length ? Math.max(1, ...coefs) : 1,
  }
}

// Стоимость одной работы «под ключ» при заданном сезонном коэффициенте (для 3 цен в прайсе).
// Учитывает льготу (waives) и критическую работу — для них наценка снимается.
export const workPriceAtSeasonCoef = (
  work: Work,
  catalog: PriceCatalog,
  settings: PricingSettings,
  seasonCoef: number,
  forceExempt = false // напр. критический/льготный набор снимает наценку со своих работ
): number => {
  const rate = resolveLaborRate(settings)
  const exempt = forceExempt || !!work.waivesHighSeasonSurcharge // критическая работа учитывается внутри buildWorkLines
  const coef = exempt ? Math.min(seasonCoef, 1) : seasonCoef
  const lines = buildWorkLines(work, 1, { workId: work.id, qty: 1 }, rate, coef, catalog)
  return round2(lines.reduce((acc, l) => acc + l.lineTotal, 0))
}

// Проанализировать выгоду отсрочки сервиса до дешёвого сезона.
// Применимо только к поломкам (repair) в сезон с наценкой, когда кораблик ещё можно
// эксплуатировать. Апгрейды выполняются сразу и в анализ отсрочки не входят.
export const analyzeDefer = (
  sections: ComplaintSection[],
  catalog: PriceCatalog,
  settings: PricingSettings,
  boatUsable: boolean,
  month?: number
): DeferSuggestion => {
  const m = month ?? currentMonth()
  const currentSeason = resolveActiveSeason(settings, m)
  const seasons = settings.seasons.length ? settings.seasons : [currentSeason]
  const bestSeason = seasons.reduce((a, b) => (b.coefficient < a.coefficient ? b : a), seasons[0])

  const base: DeferSuggestion = {
    applicable: false,
    currentSeasonId: currentSeason.id,
    currentCoefficient: currentSeason.coefficient,
    bestSeasonId: bestSeason.id,
    bestCoefficient: bestSeason.coefficient,
    currentTotal: 0,
    bestTotal: 0,
    savings: 0,
    reason: 'not-applicable',
  }

  // Только поломки можно откладывать
  const repairSections = sections.filter((s) => s.serviceKind !== 'upgrade')
  if (repairSections.length === 0) return { ...base, reason: 'upgrade-only' }

  const curEst = buildMultiEstimate({ sections: repairSections, catalog, settings, month: m })
  const bestEst = buildMultiEstimate({
    sections: repairSections,
    catalog,
    settings: { ...settings, activeSeasonOverride: bestSeason.id },
    month: m,
  })
  const savings = round2(curEst.total - bestEst.total)

  let reason: DeferSuggestion['reason'] = 'not-applicable'
  if (currentSeason.coefficient <= 1) reason = 'not-applicable'
  else if (!boatUsable) reason = 'boat-not-usable'
  else reason = 'high-season'

  return {
    ...base,
    currentTotal: curEst.total,
    bestTotal: bestEst.total,
    savings,
    applicable: currentSeason.coefficient > 1 && boatUsable && savings > 0,
    reason,
  }
}

// ==== Объяснение статуса сезонной наценки (для показа клиенту) ====

export interface SeasonalWaiverInfo {
  waived: boolean // наценка снята льготной позицией
  hasSurcharge: boolean // наценка применена (высокий сезон и нет льготных позиций)
  seasonCoefficient: number
  surchargePercent: number // (coef−1)×100, если наценка
  discountPercent: number // (1−coef)×100, если скидка
  messageUk: string // готовое сообщение клиенту (украинский)
  avoidLabelUk: string // текст мягкой ссылки «Як можна уникнути…» (пусто, если наценки нет)
}

// Одна позиция состава льготного набора (для разворачивания)
export interface WaiverKitBreakdownItem {
  name: LocalizedText
  type: EstimateLineType
  qty: number
  total: number
}

// Льготный набор (содержит позицию «без сезонной наценки») — для предложения «добавить и убрать
// наценку». Показывается одной строкой с общей суммой, разворачивается в состав.
export interface WaiverKitOption {
  kitId: string
  code: string
  name: LocalizedText
  serviceKind: ServiceKind
  total: number // общая стоимость набора «под ключ»
  breakdown: WaiverKitBreakdownItem[] // состав (работы, материалы, доп.)
}

// Разобрать сезонный статус готовой сметы: снята ли наценка льготной позицией,
// применена ли наценка, и какие позиции можно добавить, чтобы посчитать по льготному.
export const analyzeSeasonalWaiver = (estimate: Estimate, catalog: PriceCatalog): SeasonalWaiverInfo => {
  const coef = estimate.seasonCoefficient

  // Есть ли в смете активная позиция с отметкой «без сезонной наценки»
  let waived = false
  for (const l of estimate.lines) {
    if (l.type === 'labor' && catalog.works[l.refId]?.waivesHighSeasonSurcharge) { waived = true; break }
    if (l.type === 'material') {
      const m = catalog.materials[l.refId]
      if (m?.active && m.waivesHighSeasonSurcharge) { waived = true; break }
    }
  }

  const surchargePercent = coef > 1 ? Math.round((coef - 1) * 100) : 0
  const discountPercent = coef < 1 ? Math.round((1 - coef) * 100) : 0
  // Наценка фактически применена — по флагу из расчёта, а не по сырому коэффициенту
  const hasSurcharge = estimate.seasonSurchargeApplied

  let messageUk: string
  let avoidLabelUk = ''
  if (hasSurcharge) {
    // Честно объясняем причину; про избежание — мягко, отдельной ссылкой
    messageUk = `Через високе навантаження та дефіцит ресурсів у високий сезон ми змушені застосовувати сезонну націнку +${surchargePercent}% до робіт.`
    avoidLabelUk = 'Як можна уникнути сезонної націнки?'
  } else if (coef > 1 && waived) {
    messageUk = 'У кошторисі є пільгова позиція (без сезонної націнки), тому сезонну націнку знято з усього кошторису.'
  } else if (coef > 1) {
    // Высокий сезон, но наценка не применена и нет waives-позиции → это апгрейд
    messageUk = 'Це апгрейд/встановлення обладнання — сезонна націнка високого сезону не застосовується.'
  } else if (coef < 1) {
    messageUk = `Діє знижка низького сезону −${discountPercent}% на роботи.`
  } else {
    messageUk = 'Звичайний сезон — базові розцінки, без націнки.'
  }

  return { waived, hasSurcharge, seasonCoefficient: coef, surchargePercent, discountPercent, messageUk, avoidLabelUk }
}

// ==== AI-оценка → работы прайса (для засева редактора предложения) ====
//
// AI-оценка возвращает строки {label, price, workCode?}. workCode проставляется best-effort,
// когда ИИ узнал работу прайса. Здесь маппим распознанные строки на реальные работы каталога
// (по code), а нераспознанные возвращаем списком, чтобы мастер добавил их вручную.
export const aiEstimateToWorkInputs = (
  lines: { label: string; price: number; workCode?: string }[],
  catalog: PriceCatalog
): { works: EstimateWorkInput[]; unmatched: string[] } => {
  const byCode = new Map(Object.values(catalog.works).map((w) => [w.code, w]))
  const works: EstimateWorkInput[] = []
  const unmatched: string[] = []
  for (const l of lines || []) {
    const w = l.workCode ? byCode.get(l.workCode) : undefined
    if (w && w.active) works.push({ workId: w.id, qty: 1 })
    else unmatched.push(l.label)
  }
  return { works, unmatched }
}

// ==== Предварительная → фактическая калькуляция ====
//
// Сравнение план/факт и логика необходимости повторного согласования с клиентом.

// Итоговая разница по одной агрегированной позиции (по ключу type:refId)
export interface EstimateLineDiff {
  type: EstimateLineType
  refId: string
  name: LocalizedText
  before?: { qty: number; lineTotal: number } // в предварительной смете
  after?: { qty: number; lineTotal: number } // в фактической смете
  delta: number // изменение суммы, грн (actual − prelim; для added = +, для removed = −)
}

export interface EstimateComparison {
  added: EstimateLineDiff[] // позиции появились в фактической
  removed: EstimateLineDiff[] // позиции убраны из предварительной
  changed: EstimateLineDiff[] // изменились количество/сумма
  unchangedCount: number // сколько позиций без изменений
  prelimTotal: number
  actualTotal: number
  diffTotal: number // actual − prelim, грн
  diffPercent: number // diffTotal / prelim × 100 (0, если предварительная = 0)
}

// Агрегировать строки сметы по ключу type:refId (объединяет мульти-жалобы/дубликаты)
interface AggLine { type: EstimateLineType; refId: string; name: LocalizedText; qty: number; lineTotal: number }
const aggregateEstimateLines = (lines: EstimateLine[]): Map<string, AggLine> => {
  const map = new Map<string, AggLine>()
  for (const l of lines) {
    const key = `${l.type}:${l.refId}`
    const cur = map.get(key)
    if (cur) {
      cur.qty = round2(cur.qty + l.qty)
      cur.lineTotal = round2(cur.lineTotal + l.lineTotal)
    } else {
      map.set(key, { type: l.type, refId: l.refId, name: l.name, qty: l.qty, lineTotal: l.lineTotal })
    }
  }
  return map
}

// Сравнить предварительную и фактическую сметы: что добавлено/убрано/изменено и на сколько.
export const compareEstimates = (prelim: Estimate, actual: Estimate): EstimateComparison => {
  const a = aggregateEstimateLines(prelim.lines)
  const b = aggregateEstimateLines(actual.lines)
  const added: EstimateLineDiff[] = []
  const removed: EstimateLineDiff[] = []
  const changed: EstimateLineDiff[] = []
  let unchangedCount = 0

  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(key)
    const after = b.get(key)
    if (before && !after) {
      removed.push({ type: before.type, refId: before.refId, name: before.name, before: { qty: before.qty, lineTotal: before.lineTotal }, delta: round2(-before.lineTotal) })
    } else if (!before && after) {
      added.push({ type: after.type, refId: after.refId, name: after.name, after: { qty: after.qty, lineTotal: after.lineTotal }, delta: round2(after.lineTotal) })
    } else if (before && after) {
      const delta = round2(after.lineTotal - before.lineTotal)
      if (Math.abs(delta) >= 0.01 || before.qty !== after.qty) {
        changed.push({ type: after.type, refId: after.refId, name: after.name, before: { qty: before.qty, lineTotal: before.lineTotal }, after: { qty: after.qty, lineTotal: after.lineTotal }, delta })
      } else {
        unchangedCount++
      }
    }
  }

  const prelimTotal = round2(prelim.total)
  const actualTotal = round2(actual.total)
  const diffTotal = round2(actualTotal - prelimTotal)
  const diffPercent = prelimTotal > 0 ? round2((diffTotal / prelimTotal) * 100) : 0
  return { added, removed, changed, unchangedCount, prelimTotal, actualTotal, diffTotal, diffPercent }
}

// Решение о повторном согласовании роста фактической сметы относительно предварительной.
export interface ReapprovalDecision {
  required: boolean
  reason: 'decrease' | 'within-tolerance' | 'pre-authorized' | 'exceeds-threshold'
  diffPercent: number
  thresholdPct: number // порог, по которому принято решение
}

// Нужно ли повторно согласовывать смету с клиентом:
//  • снижение/без роста → нет;
//  • рост ≤ NO_REAPPROVAL_DEVIATION_PCT (10%) → нет (только информируем);
//  • рост ≤ estimateIncreasePctThreshold и клиент заранее разрешил → нет (предсогласовано);
//  • иначе → да.
export const needsReapproval = (
  prelim: Estimate,
  actual: Estimate,
  auth?: ServiceAuthorization | null
): ReapprovalDecision => {
  // Сравниваем на НЕокруглённом проценте (иначе рост 10.004% округлился бы до 10.0 и прошёл
  // как «в пределах»); в решение возвращаем округлённое значение для отображения.
  const prelimTotal = round2(prelim.total)
  const actualTotal = round2(actual.total)
  // Предварительная = 0 (напр. бесплатная диагностика): процент не определён. Любой рост с нуля
  // до положительной суммы — существенный, требует согласования клиента (не авто-«decrease»).
  if (prelimTotal <= 0) {
    return actualTotal > 0
      ? { required: true, reason: 'exceeds-threshold', diffPercent: 100, thresholdPct: 0 }
      : { required: false, reason: 'decrease', diffPercent: 0, thresholdPct: 0 }
  }
  const rawPercent = ((actualTotal - prelimTotal) / prelimTotal) * 100
  const diffPercent = round2(rawPercent)
  if (rawPercent <= 0) return { required: false, reason: 'decrease', diffPercent, thresholdPct: 0 }
  if (rawPercent <= NO_REAPPROVAL_DEVIATION_PCT) {
    return { required: false, reason: 'within-tolerance', diffPercent, thresholdPct: NO_REAPPROVAL_DEVIATION_PCT }
  }
  if (auth?.autoApproveEstimateIncrease && rawPercent <= auth.estimateIncreasePctThreshold) {
    return { required: false, reason: 'pre-authorized', diffPercent, thresholdPct: auth.estimateIncreasePctThreshold }
  }
  const thresholdPct = auth?.autoApproveEstimateIncrease ? auth.estimateIncreasePctThreshold : NO_REAPPROVAL_DEVIATION_PCT
  return { required: true, reason: 'exceeds-threshold', diffPercent, thresholdPct }
}

// ==== Смета → позиции фискального чека ====
//
// Украинский фіскальний чек ПРРО: по каждой позиции обязательны НАЗВА и ВАРТІСТЬ; кількість
// и ціна за одиницю — только когда количество ≠ 1 (Наказ Мінфіну №13, розд. II, ряд.6, 11).
// Позиции ряд.6–11 повторяются по каждому отдельному найменуванню — поэтому смету разворачиваем
// ПОСТРОЧНО (самый прозрачный и безопасный вариант; для ФОП-єдинника без ПДВ допускается и
// групповая «спрощена назва», но построчно совпадает с согласованной клиентом сметой).
// ПДВ/УКТ ЗЕД на позициях НЕ указываем — продавец ФОП-спрощенець без ПДВ, услуги ремонта
// не подакцизные (ставка налога настраивается на кассе Checkbox, не в позиции).
//
// Инвариант (ТОЧНЫЙ ПО ПОСТРОЕНИЮ): построчная сумма в копейках каждой позиции == копейкам
// line total этой строки, поэтому Σ(goods, построчно) == Σ toKop(lineTotal) == toKop(est.total).
// Это зеркалит серверную checkbox.goodsTotalKop (round(priceKop*qtyThousandths/1000)), поэтому
// сверка amount==Σ(goods) всегда проходит — без пост-коррекции (которая ломалась на qty≠1).
export const estimate2goods = (est: Estimate, lang = 'uk'): ReceiptGood[] => {
  const goods: ReceiptGood[] = []
  // построчная копейка так же, как считает сервер/Checkbox
  const serverKop = (price: number, qty: number) => Math.round((Math.round(price * 100) * Math.round((qty || 1) * 1000)) / 1000)
  for (const l of est.lines) {
    if (l.lineTotal <= 0) continue // нулевые/скидочные строки в чек не идут
    const lineKop = Math.round(l.lineTotal * 100)
    const name = tName(l.name, lang)
    // Материал/доп. с количеством ≠ 1: показываем кількість + ціну за одиницю, НО только если
    // построчная копейка (ціна×кількість) ТОЧНО совпадает с line total (цена — целые копейки).
    // Иначе (напр. дробная цена за единицу) — одной позицией qty=1, чтобы не разошлась сумма.
    if (l.type !== 'labor' && l.qty !== 1) {
      const unit = round2(l.unitPrice)
      if (serverKop(unit, l.qty) === lineKop) {
        goods.push({ name, price: unit, qty: l.qty })
        continue
      }
    }
    // Одна позиция: цена = сумма строки, qty=1 (сезон/дробность «зашиты»); количество — в названии.
    // serverKop(lineTotal, 1) == toKop(lineTotal) → точное совпадение.
    const suffix = l.qty && l.qty !== 1 ? (l.type === 'labor' ? ` ×${l.qty}` : ` (${l.qty} шт)`) : ''
    goods.push({ name: name + suffix, price: round2(l.lineTotal), qty: 1 })
  }
  return goods
}

// ==== Знижка на кошторис ====
//
// Знижка (відсотком або сумою) ВШИВАЄТЬСЯ в lineTotal рядків пропорційно, в копійках
// (останній ненульовий рядок забирає залишок) — тому Σ(рядків) == total == чек == списання
// банку без жодних від'ємних рядків (їх не можна у фіскальний чек). unitPrice після знижки —
// довідковий (estimate2goods сам згорне рядок у qty=1, якщо ціна за одиницю не ділиться).
export interface EstimateDiscountInput { value: number; kind: 'pct' | 'uah' }

export const applyEstimateDiscount = (est: Estimate, d?: EstimateDiscountInput | null): Estimate => {
  const value = Number(d?.value) || 0
  if (!d || value <= 0) return est
  const grossKop = Math.round(est.total * 100)
  if (grossKop <= 0) return est
  const offKop = Math.min(d.kind === 'pct' ? Math.round((grossKop * value) / 100) : Math.round(value * 100), grossKop)
  if (offKop <= 0) return est
  const targetKop = grossKop - offKop

  const idxs = est.lines
    .map((l, i) => ({ i, kop: Math.round(l.lineTotal * 100) }))
    .filter((x) => x.kop > 0)
  const sumKop = idxs.reduce((acc, x) => acc + x.kop, 0)
  if (!idxs.length || sumKop <= 0) return est

  const lines = est.lines.map((l) => ({ ...l }))
  let acc = 0
  idxs.forEach((x, n) => {
    const nk = n === idxs.length - 1 ? targetKop - acc : Math.floor((x.kop * targetKop) / sumKop)
    acc += nk
    // Для ПОКАЗУ рядки лишаються з повною сумою (grossLineTotal), а знижка — окремим рядком
    // внизу; lineTotal (зі знижкою) — грошова правда для чека/оплати.
    lines[x.i].grossLineTotal = lines[x.i].lineTotal
    lines[x.i].lineTotal = nk / 100
  })

  const sumBy = (type: EstimateLine['type']) =>
    round2(lines.filter((l) => l.type === type).reduce((a, l) => a + l.lineTotal, 0))
  return {
    ...est,
    lines,
    laborTotal: sumBy('labor'),
    materialsTotal: sumBy('material'),
    addonsTotal: sumBy('addon'),
    total: round2(targetKop / 100),
    discount: { value, kind: d.kind, amount: round2(offKop / 100), grossTotal: round2(grossKop / 100) },
  }
}

// Итог по позициям чека (грн) — для сверки/отображения
export const receiptGoodsTotal = (goods: ReceiptGood[]): number =>
  round2(goods.reduce((s, g) => s + Math.round((Math.round(g.price * 100) * Math.round((g.qty || 1) * 1000)) / 1000) / 100, 0))

// Льготные наборы (содержат позицию «без сезонной наценки») — для раскрывающегося блока
// «Як можна уникнути сезонної націнки?», пункт 2. Каждый набор — с общей стоимостью и составом;
// добавление любого из них снимает наценку со всей сметы.
export const waiverKitOptions = (
  catalog: PriceCatalog,
  settings: PricingSettings,
  month?: number
): WaiverKitOption[] => {
  const result: WaiverKitOption[] = []
  for (const kit of Object.values(catalog.kits)) {
    if (!kit.active) continue
    if (!worksWaiveSurcharge(kit.items.map((i) => i.workId), catalog)) continue
    const est = buildEstimateFromKit(kit, catalog, settings, { month })
    const breakdown: WaiverKitBreakdownItem[] = est.lines.map((l) => ({
      name: l.name,
      type: l.type,
      qty: l.qty,
      total: l.lineTotal,
    }))
    result.push({
      kitId: kit.id,
      code: kit.code,
      name: kit.name,
      serviceKind: kit.serviceKind,
      total: est.total,
      breakdown,
    })
  }
  return result
}
