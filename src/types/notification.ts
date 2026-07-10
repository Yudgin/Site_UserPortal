// Оповещение клиента (журнал информирования). Пишется сервером (/api/notify) в коллекцию
// notifications; фронт читает историю и инициирует отправку. Канал выбирается автоматически:
// мессенджер (если окно доставки открыто) или SMS.
export type NotificationEvent = 'offer' | 'actual' | 'ttn' | 'custom'

export interface ClientNotification {
  id: string
  createdAt: string
  serviceRequestId: string | null
  sessionId: string | null
  phone: string | null
  event: NotificationEvent
  channel: 'telegram' | 'viber' | 'sms' | null // фактический канал доставки
  via: 'messenger' | 'sms' | null
  status: 'sent' | 'failed'
  error: string | null
  text: string
  by: string | null
}

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  offer: 'Попередня калькуляція',
  actual: 'Фактична калькуляція',
  ttn: 'Відправлення (ТТН)',
  custom: 'Повідомлення',
}
