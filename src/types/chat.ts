// Сессии общения клиента с ИИ-консультантом и эскалация на менеджера.
//
// Клиент описывает проблему — ИИ оценивает стоимость по прайсу; если не может помочь,
// сессия эскалируется на менеджера (срок 48 рабочих часов). Менеджер может отвечать
// клиенту прямо в диалоге и вести внутренние заметки/напоминания, невидимые клиенту.

export type ChatRole = 'client' | 'ai' | 'manager'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: string
  internal?: boolean // внутренняя заметка менеджера — клиенту не видна и не идёт в промпт ИИ
}

export type ChatStatus = 'active' | 'escalated' | 'resolved'

export interface ChatReminder {
  id: string
  at: string // когда напомнить (ISO)
  note: string
  done: boolean
}

export interface ChatEscalation {
  escalatedAt: string
  reason: string
  dueAt: string // крайний срок ответа менеджера (48 рабочих часов)
  resolvedAt: string | null
  managerEmail: string | null
}

// Накопленная стоимость общения ИИ по сессии (для учёта расходов на клиента)
export interface ChatAiUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

// Согласование объёма работ клиентом (заполняется в опроснике).
// Позволяет заранее договориться, что можно делать без дополнительного согласования.
export interface ServiceAuthorization {
  fixOtherVisibleDefects: boolean // устранять другие видимые дефекты, найденные при диагностике/ремонте
  autoApproveNewDefects: boolean // авто-согласовать работы по новым дефектам…
  newDefectsBoatPctThreshold: number // …если их стоимость не превышает X% стоимости кораблика (по умолч. 20)
  autoApproveEstimateIncrease: boolean // авто-согласовать рост сметы (галочка, по умолч. включена)…
  estimateIncreasePctThreshold: number // …если превышение не больше X% от первоначальной сметы (по умолч. 25)
}

// Если фактическая смета отличается от предварительной не более чем на столько %,
// повторное согласование не требуется (информируем клиента).
export const NO_REAPPROVAL_DEVIATION_PCT = 10

// По умолчанию все разрешения включены (спрашиваем на стадии заявки на ремонт,
// а не на стадии предварительной оценки).
export const defaultAuthorization = (): ServiceAuthorization => ({
  fixOtherVisibleDefects: true,
  autoApproveNewDefects: true,
  newDefectsBoatPctThreshold: 20,
  autoApproveEstimateIncrease: true,
  estimateIncreasePctThreshold: 25,
})

export interface ChatSession {
  id: string
  createdAt: string
  updatedAt: string
  status: ChatStatus
  lang: string
  requestId: string | null // привязка к заявке 1С (если есть)
  contact: { name?: string; phone?: string } | null
  messages: ChatMessage[]
  escalation: ChatEscalation | null
  reminders: ChatReminder[]
  aiUsage?: ChatAiUsage // сумма токенов/стоимости ИИ по сессии
  authorization?: ServiceAuthorization // согласование объёма работ клиентом
  outcome?: ChatOutcome // чем закончилась переписка (для менеджера)
}

// Чем закончилась переписка по сервису
export type ChatOutcome = 'open' | 'self-resolved' | 'repair-request' | 'parts-shipment'

export const OUTCOME_LABELS: Record<ChatOutcome, string> = {
  open: 'В процессе',
  'self-resolved': 'Клиент разобрался сам',
  'repair-request': 'Заявка на ремонт',
  'parts-shipment': 'Отправка комплектующих',
}

// Срок ответа менеджера при эскалации — 48 рабочих часов (пн–пт)
export const ESCALATION_WORKING_HOURS = 48
