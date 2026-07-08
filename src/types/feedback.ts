// Обратная связь клиентов о работе автоматизированной системы (ИИ) и правки поведения ИИ.

export type FeedbackKind = 'helpful' | 'not-helpful' | 'inaccuracy' | 'suggestion' | 'error'
export type FeedbackStatus = 'new' | 'reviewed' | 'resolved'

export interface Feedback {
  id: string
  sessionId: string | null // из какой сессии диалога
  kind: FeedbackKind
  helpful: boolean | null // помогло ли общение (для helpful/not-helpful)
  text: string // отзыв / описание неточности / предложение
  contact: { name?: string; phone?: string } | null
  status: FeedbackStatus
  managerReply: string | null // ответ менеджера клиенту
  createdAt: string
  reviewedBy: string | null
}

// Область действия правки поведения ИИ
export type BehaviorScope = 'all' | 'estimate' | 'consultation' | 'selfservice'

// Правка поведения ИИ: инжектится в системный промпт как дополнительное правило.
// Позволяет корректировать поведение по отзывам без переобучения модели.
export interface BehaviorCorrection {
  id: string
  instruction: string // что скорректировать (правило для ИИ, украинский)
  scope: BehaviorScope
  active: boolean
  createdAt: string
  createdBy: string | null
  sourceFeedbackId: string | null // из какого отзыва возникла правка
}
