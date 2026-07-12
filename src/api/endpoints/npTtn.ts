// Создание ТТН Новой Почты по шаблону (сценарий «приём кораблика»). Требует админ-токен.
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface CreateTtnParams {
  serviceRequestId: string
  templateId: string
  clientCityRef?: string // нужен, только когда сторона ТТН = «клієнт заявки»
  clientWarehouseRef?: string
  cost: number
  codAmount?: number
  clientName?: string // для сценариев «сервис → клиент» (получатель)
  clientPhone?: string
}
export interface CreateTtnResult {
  ttn: string
  ref?: string | null
  cost?: string | null
  estimatedDelivery?: string | null
}

export const npTtnApi = {
  // Возвращает { ok, data?, error? }. error.message — текст ошибки НП (для доводки маппинга).
  create: async (params: CreateTtnParams): Promise<{ ok: boolean; data?: CreateTtnResult; error?: string; npErrors?: string[] }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/np/ttn/create`, params, { headers: await adminHeaders(), timeout: 30000 })
      if (data?.success) return { ok: true, data: data.data }
      return { ok: false, error: data?.error?.message || 'Помилка', npErrors: data?.error?.npErrors }
    } catch (e: any) {
      const err = e?.response?.data?.error
      return { ok: false, error: err?.message || e?.message || 'Не вдалося створити ТТН', npErrors: err?.npErrors }
    }
  },
}

export default npTtnApi
