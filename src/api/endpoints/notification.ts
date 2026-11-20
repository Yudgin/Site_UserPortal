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
  clientKey?: string // ідемпотентність custom: повторний тап з тим самим ключем не шле другий SMS
}

export const notificationApi = {
  // Возвращает запись оповещения (в т.ч. status='failed' с причиной). Отказ сервера (400 текст
  // задовгий / 429 ліміт / 403 чужий центр) — тоже как status='failed' с его сообщением, чтобы
  // хаб показал причину; null — только при сетевой ошибке без ответа.
  notify: async (params: NotifyParams): Promise<ClientNotification | null> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/notify`, params, {
        headers: await adminHeaders(),
        timeout: 30000,
      })
      return data?.success ? (data.data as ClientNotification) : null
    } catch (e: any) {
      const msg = e?.response?.data?.error?.message
      return msg ? ({ status: 'failed', error: msg } as ClientNotification) : null
    }
  },
}

export default notificationApi
