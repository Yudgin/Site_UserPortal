// Звірка ДОДАТКОВИХ ВИТРАТ (рядки extra=true, refId 'extra:<id>') між редактором факту і базою.
//
// Витрати поза прайсом вносять одночасно кілька джерел: Telegram-бот співробітників і застосунок
// «RunFerry Сервіс» (через server/estimateEngine.js — пишуть і в кошторис, і в журнал заявки
// serviceRequests.extraExpenses), а також майстер у веб-редакторі факту, який зберігає кошторис цілком.
// Щоб збереження редактора не затирало чужі зміни, редактор пам'ятає, які витрати він БАЧИВ (known):
//  • є в базі, але не відомі редактору      → додано деінде (incoming) — повертаємо в кошторис;
//  • відомі редактору, але зникли з бази     → вилучено деінде (vanished) — прибираємо, не виставляємо;
//  • відомі, але майстер прибрав у редакторі → свідоме видалення — у журналі прибираємо.
// Чисті функції без React/Firestore — їх перевіряє тест на справжньому коді.
import { round2, tName, extraExpenseLine } from '@/utils/pricing'
import type { Estimate, EstimateLine } from '@/types/pricing'
import type { ServiceRequest, ExtraExpense } from '@/types/serviceRequest'

export const extraRef = (id: string): string => `extra:${id}`

// Рядок поза прайсом без знижки (grossLineTotal — повна сума, якщо знижка була): редактор тримає повні
// суми, знижку вшиває заново під час перерахунку.
export const grossExtraLine = (l: EstimateLine): EstimateLine => {
  const full = l.grossLineTotal ?? l.lineTotal
  const line: EstimateLine = { ...l, lineTotal: full, unitPrice: l.qty ? round2(full / l.qty) : full, extra: true }
  delete line.grossLineTotal
  return line
}

// Рядки, яких редактор ще не бачив (для засіву). Відомий, але відсутній у редакторі рядок прибрав
// майстер — його не повертаємо (інакше пізніше завантаження заявки «воскресило» б видалене).
export const unseenLines = (lines: EstimateLine[], known: ReadonlySet<string>): EstimateLine[] =>
  lines.filter((l, i) => !known.has(l.refId) && lines.findIndex((x) => x.refId === l.refId) === i)

// Витрати журналу заявки, що мають бути в кошторисі редактора: ще не застосовані (бот/застосунок записав
// до факту) і застосовані до ЦЬОГО факту (редагування) або до ПОТОЧНОГО факту заявки (створення нового
// факту — вони переходять у новий). Записи старих, витіснених фактів не беремо.
export const requestSeedLines = (r: Pick<ServiceRequest, 'extraExpenses' | 'actualEstimateId'>, editId: string): EstimateLine[] => {
  const target = editId || r.actualEstimateId || ''
  return (r.extraExpenses || [])
    .filter((x) => !x.appliedToEstimateId || (!!target && x.appliedToEstimateId === target))
    .map(extraExpenseLine)
}

// Додано деінде після завантаження редактора і відсутнє в редакторі.
export const incomingExtras = (p: {
  known: ReadonlySet<string>
  editorLines: EstimateLine[]
  freshEst: Estimate | null
  freshReq: Pick<ServiceRequest, 'extraExpenses' | 'actualEstimateId'> | null
  estimateId: string
}): EstimateLine[] => {
  const inEditor = new Set(p.editorLines.map((l) => l.refId))
  const target = p.estimateId || p.freshReq?.actualEstimateId || ''
  const out: EstimateLine[] = []
  const take = (l: EstimateLine) => {
    if (!p.known.has(l.refId) && !inEditor.has(l.refId) && !out.some((o) => o.refId === l.refId)) out.push(l)
  }
  for (const l of p.freshEst?.lines || []) if (l.extra) take(grossExtraLine(l))
  for (const x of p.freshReq?.extraExpenses || []) {
    if (!x.appliedToEstimateId || (!!target && x.appliedToEstimateId === target)) take(extraExpenseLine(x))
  }
  return out
}

// Відомі редактору витрати, яких у базі вже немає ні в кошторисі, ні в журналі (вилучили бот, застосунок
// чи інший співробітник). Якщо свіжих даних немає взагалі — нічого не вважаємо зниклим. exempt — рядки,
// засіяні з ВАРІАНТА-батька (їх у журналі ще немає до першого збереження факту) — зниклими не вважаються.
export const vanishedExtras = (p: {
  known: ReadonlySet<string>
  editorLines: EstimateLine[]
  freshEst: Estimate | null
  freshReq: Pick<ServiceRequest, 'extraExpenses'> | null
  exempt?: ReadonlySet<string>
}): EstimateLine[] => {
  if (!p.freshEst && !p.freshReq) return []
  const present = new Set([
    ...(p.freshEst?.lines || []).filter((l) => l.extra).map((l) => l.refId),
    ...(p.freshReq?.extraExpenses || []).map((x) => extraRef(x.id)),
  ])
  return p.editorLines.filter((l) => p.known.has(l.refId) && !present.has(l.refId) && !(p.exempt && p.exempt.has(l.refId)))
}

// Рядки поза прайсом ВАРІАНТА-батька (факт «за обраним варіантом»): рядки калькуляцій майстрів живуть у
// варіанті, а в журналі заявки з'являються лише із збереженням факту — тож переносимо їх із варіанта.
export const parentExtraLines = (parent: Pick<Estimate, 'lines'> | null | undefined): EstimateLine[] =>
  (parent?.lines || []).filter((l) => l.extra).map(grossExtraLine)

// Журнал витрат заявки після збереження факту: записи, чиї рядки є у факті, — «у кошторисі» (прив'язуємо
// до estimateId); додані майстром тут — нові записи (source='portal'); прибрані майстром (були показані —
// shown — і зникли з редактора) — вилучаються, навіть якщо були прив'язані до попереднього факту.
// Записи ІНШОГО кошторису, яких редактор не показував (старий факт), не чіпаємо. existing — СВІЖИЙ журнал.
export const syncRequestExtras = (p: {
  existing: ExtraExpense[] | undefined
  editorLines: EstimateLine[]
  estimateId: string
  by: string | null
  shown?: ReadonlySet<string>
  now?: string
}): ExtraExpense[] => {
  const byRef = new Map(p.editorLines.map((l) => [l.refId, l] as const))
  const existing = p.existing || []
  const kept = existing.filter((x) => byRef.has(extraRef(x.id))).map((x) => ({ ...x, appliedToEstimateId: p.estimateId }))
  const foreign = existing.filter((x) => !byRef.has(extraRef(x.id)) && !(p.shown && p.shown.has(extraRef(x.id)))
    && x.appliedToEstimateId && x.appliedToEstimateId !== p.estimateId)
  const known = new Set(kept.map((x) => extraRef(x.id)))
  const at = p.now || new Date().toISOString()
  // Рядок з калькуляції майстра → запис source='master' з masterRef (як пише сервер), інші — 'portal'.
  const added: ExtraExpense[] = p.editorLines.filter((l) => !known.has(l.refId)).map((l) => ({
    id: l.refId.replace(/^extra:/, ''), title: tName(l.name, 'uk'), amount: round2(l.lineTotal), at,
    by: p.by, source: l.fromMaster ? 'master' : 'portal', appliedToEstimateId: p.estimateId,
    ...(l.fromMaster ? { masterRef: l.fromMaster } : {}),
  }))
  return [...kept, ...foreign, ...added]
}
