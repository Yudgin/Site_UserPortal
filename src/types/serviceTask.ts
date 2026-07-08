// Задачи сервиса. Возникают из консультаций (по ремонту или обычных): отправка
// комплектующих клиенту, дополнительная работа по просьбе клиента, перезвон и т.д.
// Менеджер видит их в отдельной админке и ведёт по статусам.

export type ServiceTaskType = 'parts-shipment' | 'repair-request' | 'callback' | 'extra-work' | 'other'
export type ServiceTaskStatus = 'new' | 'in-progress' | 'done' | 'cancelled'

export const TASK_TYPE_LABELS: Record<ServiceTaskType, string> = {
  'parts-shipment': 'Отправка комплектующих',
  'repair-request': 'Заявка на ремонт',
  callback: 'Перезвонить',
  'extra-work': 'Доп. работа по просьбе',
  other: 'Другое',
}

export const TASK_STATUS_LABELS: Record<ServiceTaskStatus, string> = {
  new: 'Новая',
  'in-progress': 'В работе',
  done: 'Выполнена',
  cancelled: 'Отменена',
}

// Позиция комплектующих в заявке на отправку
export interface PartItem {
  name: string
  qty: number
}

// Адрес доставки Новой Почтой (для отправки комплектующих)
export interface ShippingAddress {
  recipient?: string // ФИО получателя
  phone?: string
  city?: string // название населённого пункта (как отображается)
  cityRef?: string // ref НП для повторного запроса отделений
  warehouse?: string // описание отделения
  warehouseRef?: string
}

export interface ServiceTask {
  id: string
  type: ServiceTaskType
  status: ServiceTaskStatus
  title: string // краткая суть
  details: string // подробности (какие комплектующие, что сделать)
  contact: { name?: string; phone?: string; email?: string } | null
  sessionId: string | null // из какой чат-сессии
  origin: 'client' | 'admin' | 'ai' // кто создал
  assignee: string | null // ответственный
  parts?: PartItem[] // авто-сформированный список комплектующих (заявка parts-shipment)
  shipping?: ShippingAddress // куда отправлять (Новая Почта)
  createdAt: string
  updatedAt: string
  createdBy: string | null
}
