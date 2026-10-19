// Роботи по заявці та калькуляції майстрів (етап 1 проекту
// runferry-briefs/service-app/master-estimates-brief-2026-10-19.md).
//
// Ремонт кораблика роблять кілька людей (доставка, прийом, ремонт, тест на воді) — у кожної роботи свій виконавець:
// serviceRequests/{id}/works/{workId}. Виконавець (свій майстер або партнерський центр) виставляє КАЛЬКУЛЯЦІЮ МАЙСТРА —
// опис своїх робіт і вартість: masterEstimates/{id}. Пише ТІЛЬКИ сервер (server/masterEstimates.js, /api/master-estimates);
// портал на етапі 1 лише показує. Ключі видів робіт і підписи — ті самі, що WORK_KINDS на сервері.

export type WorkKind =
  | 'delivery_in'
  | 'intake'
  | 'diagnostics'
  | 'repair'
  | 'water_test'
  | 'packing'
  | 'delivery_out'
  | 'other'

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
  delivery_in: 'Доставка до сервісу',
  intake: 'Прийом і внесення в базу',
  diagnostics: 'Діагностика',
  repair: 'Ремонт',
  water_test: 'Тест на воді',
  packing: 'Пакування',
  delivery_out: 'Відправка клієнту',
  other: 'Інше',
}

export type WorkStatus = 'planned' | 'in_progress' | 'done' | 'cancelled'

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  planned: 'заплановано',
  in_progress: 'в роботі',
  done: 'виконано',
  cancelled: 'скасовано',
}

// Робота по заявці (підзадача): хто що робить.
export interface ServiceWork {
  id: string
  kind: WorkKind
  title: string
  assigneeUid: string | null
  assigneeName: string | null
  centerId: string | null
  status: WorkStatus
  createdAt: string
  createdBy?: string | null
  createdByUid?: string
  updatedAt?: string
  updatedBy?: string | null
}

export type MasterEstimateKind = 'preliminary' | 'actual'
export type MasterEstimateDirection = 'from_master' | 'to_master' // майстер виставив нам | ми виставили майстру
export type MasterEstimateStatus = 'draft' | 'submitted' | 'accepted' | 'returned' | 'cancelled'

export const MASTER_ESTIMATE_KIND_LABELS: Record<MasterEstimateKind, string> = {
  preliminary: 'попередня',
  actual: 'фактична',
}

export const MASTER_ESTIMATE_DIRECTION_LABELS: Record<MasterEstimateDirection, string> = {
  from_master: 'від майстра',
  to_master: 'майстру',
}

export const MASTER_ESTIMATE_STATUS_LABELS: Record<MasterEstimateStatus, string> = {
  draft: 'чернетка',
  submitted: 'надіслано',
  accepted: 'прийнято',
  returned: 'повернуто',
  cancelled: 'скасовано',
}

// Рядок калькуляції майстра: amount — сума рядка (не ціна за одиницю), unitPrice = amount / qty.
// sourceLineRef — рядок калькуляції клієнту, з якого складено (напрям «майстру»).
export interface MasterEstimateLine {
  title: string
  qty: number
  amount: number
  unitPrice: number
  note?: string
  sourceLineRef?: { estimateId: string; index: number }
}

// Похідний документ, складений «на основі» цієї калькуляції: варіант пропозиції або факт клієнту.
export type MasterEstimateDerivedType = 'variant' | 'actual'

export const MASTER_ESTIMATE_DERIVED_LABELS: Record<MasterEstimateDerivedType, string> = {
  variant: 'варіант',
  actual: 'факт',
}

export interface MasterEstimateDerived {
  type: MasterEstimateDerivedType
  id: string // id калькуляції клієнту (priceEstimates)
  at: string
  by: string | null
}

export interface MasterEstimateHistoryEntry {
  at: string
  total: number
  lines: MasterEstimateLine[]
  comment: string
  editedBy: string | null
}

export interface MasterEstimate {
  id: string
  serviceRequestId: string
  requestNo?: string
  serviceCenterId: string | null
  workId?: string | null
  kind: MasterEstimateKind
  direction: MasterEstimateDirection
  performerUid: string
  performerName: string
  lines: MasterEstimateLine[]
  total: number
  status: MasterEstimateStatus
  comment?: string
  reviewComment?: string
  basedOn?: { type: 'clientEstimate' | 'masterEstimate'; id: string } | null
  derived?: MasterEstimateDerived[]
  history?: MasterEstimateHistoryEntry[]
  createdAt: string
  createdBy?: string | null
  createdByUid?: string
  updatedAt?: string
  updatedBy?: string | null
  submittedAt?: string
  reviewedAt?: string
  reviewedBy?: string | null
  via?: 'app' | 'portal'
}
