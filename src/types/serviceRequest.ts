// Заявка на обслуживание — НАША локальная сущность-хаб (система-источник на сайте).
// Формируется из обращения (ChatSession) и связывает предварительные калькуляции (предложение
// с вариантами), фактическую калькуляцию и оплату. Ссылка на 1С — через externalRequestId
// (выгрузка позже). Хранится в Firestore-коллекции `serviceRequests` (доступ — админ).

export type ServiceRequestStatus =
  | 'new' // создана из обращения
  | 'diagnostics' // на диагностике
  | 'offered' // выставлено предложение (варианты) клиенту
  | 'approved' // клиент выбрал вариант / согласовал
  | 'in_work' // в работе
  | 'done' // выполнено/оплачено
  | 'cancelled'

export const SERVICE_REQUEST_STATUS_LABELS: Record<ServiceRequestStatus, string> = {
  new: 'Нова',
  diagnostics: 'Діагностика',
  offered: 'Запропоновано',
  approved: 'Погоджено',
  in_work: 'В роботі',
  done: 'Виконано',
  cancelled: 'Скасовано',
}

export interface ServiceRequest {
  id: string
  createdAt: string
  updatedAt: string
  createdBy: string | null
  sessionId: string | null // обращение (ChatSession), из которого создана заявка
  externalRequestId: string | null // ссылка на заявку 1С (выгрузка/связь позже)
  clientName?: string
  clientPhone?: string // связь с clientProfiles (нормализованный телефон)
  // Адрес отправки клиента (Нова Пошта) — из формы /repair/new; подставляется при создании ТТН.
  clientCityRef?: string
  clientCityName?: string
  clientWarehouseRef?: string
  clientWarehouseName?: string
  boat?: string // модель/название кораблика (если известно)
  complaint: string // сводная жалоба/описание
  status: ServiceRequestStatus
  // Диагностика после получения кораблика: выявленные неисправности (текстом). Помогает уточнить
  // предварительную калькуляцию (мастер точнее определил неисправность).
  diagnostics?: { text: string; at: string; by: string | null } | null
  waybillNumber?: string | null // номер транспортной накладной (ТТН) — для оповещения об отправке
  // Привязанные калькуляции и оплата:
  aiEstimateId?: string | null // материализованная предварительная оценка ИИ (stage='ai')
  offerId?: string | null // предложение с вариантами (предварительные калькуляции)
  actualEstimateId?: string | null // фактическая калькуляция
  paymentId?: string | null // оплата
}
