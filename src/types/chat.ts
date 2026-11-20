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

// Структурированная предварительная оценка (последняя, что назвал ИИ в диалоге).
// Хранится на сессии — менеджер видит смету не только текстом переписки.
export interface PreliminaryEstimate {
  // workCode — код работы прайса, если ИИ распознал позицию (для засева редактора предложения)
  lines: { label: string; price: number; workCode?: string }[]
  total: number
  at: string // когда ИИ её сформировал
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

// Канал, из которого пришёл диалог. 'web' — онлайн-чат на сайте (по умолчанию),
// остальные — мессенджеры-агрегатор.
export type ChatChannel = 'web' | 'telegram' | 'viber' | 'whatsapp'

export const CHANNEL_LABELS: Record<ChatChannel, string> = {
  web: 'Сайт',
  telegram: 'Telegram',
  viber: 'Viber',
  whatsapp: 'WhatsApp',
}

// Тема обращения (определяется ботом-консьержем: сервис/ремонт, покупка/продажа, другое)
export type ChatTopic = 'service' | 'sales' | 'other'

export const TOPIC_LABELS: Record<ChatTopic, string> = {
  service: 'Сервіс',
  sales: 'Продаж',
  other: 'Інше',
}

// Беседа-приглашение: сотрудник заранее знает тему («Кришка для Solo V2») и приглашает человека в чат
// по SMS-ссылке /c/<id> (server/chatInvites.js); первое сообщение ИИ (приветствие с уточняющими вопросами)
// уже лежит в сессии. Клиентский блок на сессии виден по ссылке и неизменяем (firestore.rules); служебная
// запись с заметкой для ИИ, статусом SMS и отметкой «відкрито» — chatInvites/{id} (ChatInviteRecord).
export type ChatInviteMode = 'knowledge' | 'estimate'

export interface ChatInvite {
  topic: string // тема — видна клиенту (SMS, шапка чата), українською
  mode: ChatInviteMode // режим помощника по умолчанию
  createdAt: string
}

export type ChatInviteSource = 'portal' | 'app' | 'bot' | 'phone' | 'other'

// Служебная запись приглашения (chatInvites/{sessionId}); пишет только сервер, читает персонал
// (владелец/директор — все, остальные — свои).
export interface ChatInviteRecord {
  id: string
  sessionId: string
  topic: string
  topicInput: string | null // как написал сотрудник, если ИИ перевёл тему на украинский
  details: string | null // заметка для ИИ (клиенту не показывается, но может просочиться в ответы)
  mode: ChatInviteMode
  phone: string | null // +380XXXXXXXXX
  name: string | null
  serviceRequestId: string | null
  serviceCenterId: string | null
  source: ChatInviteSource
  deliver: 'sms' | 'none'
  by: { uid: string; email: string | null; role: string }
  url: string
  createdAt: string
  openedAt: string | null // когда человек впервые открыл ссылку
  opening: { messageId: string; source: 'ai' | 'fallback' } | null
  sms: {
    status: 'pending' | 'sent' | 'failed' | 'skipped'
    text: string | null
    error: string | null
    notificationId: string | null
    attempts: number
    lastAttemptAt: string | null
  }
}

export interface ChatSession {
  id: string
  createdAt: string
  updatedAt: string
  status: ChatStatus
  lang: string
  requestId: string | null // привязка к заявке 1С (если есть)
  channel?: ChatChannel // канал обращения (по умолчанию 'web')
  channelUserId?: string // идентификатор пользователя в мессенджере (chat_id/sender.id/wa_id)
  botPaused?: boolean // менеджер перехватил диалог → ИИ не отвечает (снимается упоминанием бота)
  businessConnectionId?: string // Telegram Business connection id (для отправки от имени владельца)
  topic?: ChatTopic // тема обращения (сервис/продажа/другое) — определяет бот-консьерж
  contact: { name?: string; phone?: string } | null
  messages: ChatMessage[]
  escalation: ChatEscalation | null
  reminders: ChatReminder[]
  aiUsage?: ChatAiUsage // сумма токенов/стоимости ИИ по сессии
  authorization?: ServiceAuthorization // согласование объёма работ клиентом
  outcome?: ChatOutcome // чем закончилась переписка (для менеджера)
  estimate?: PreliminaryEstimate // последняя структурированная предварительная оценка от ИИ
  invite?: ChatInvite // беседа создана приглашением сотрудника (тема известна заранее)
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
