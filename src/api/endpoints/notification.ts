// Отправка оповещения клиенту через backend (/api/notify). Канал выбирается на сервере
// (мессенджер в окне / иначе SMS). Требует админ-токен. Авто-события (offer/actual/ttn)
// идемпотентны по (serviceRequestId, event) на сервере — повторный вызов не задваивает.
import axios from 'axios'
import { auth } from '@/api/firebase'
import type { ClientNotification, NotificationEvent } from '@/types/notification'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface NotifyParams {
  serviceRequestId?: string
  sessionId?: string
  phone?: string
  text?: string // для event='custom'
  event?: NotificationEvent
  link?: string
  ttn?: string
}

export const notificationApi = {
  // Возвращает запись оповещения (в т.ч. status='failed' с причиной) или null при сетевой ошибке.
  notify: async (params: NotifyParams): Promise<ClientNotification | null> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/notify`, params, {
        headers: await adminHeaders(),
        timeout: 30000,
      })
      return data?.success ? (data.data as ClientNotification) : null
    } catch {
      return null
    }
  },
}

export default notificationApi
