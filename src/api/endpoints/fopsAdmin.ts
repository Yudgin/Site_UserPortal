// Управление ФОПами (владелец). Секреты — WRITE-ONLY: список отдаёт только флаги «задано»,
// сохранение шлёт лишь непустые ключи (пустые оставляют прежние). Требует админ-токен.
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface FopMethods {
  liqpayCard?: boolean
  liqpayPaypart?: boolean
  monoChast?: boolean
  monoAcquire?: boolean
  privatPaypart?: boolean
  cod?: boolean // накладений платіж (Нова Пошта)
}
export interface FopNovaPoshtaRefs {
  senderRef?: string
  contactRef?: string
  senderPhone?: string
  cityRef?: string
  cityName?: string
  warehouseRef?: string
  warehouseName?: string
}
export interface FopSecretsSet {
  liqpay: boolean
  monoChast: boolean
  monoAcquire: boolean
  privatPaypart: boolean
  checkbox: boolean
  novaPoshtaApiKey: boolean
}
export interface FopAdmin {
  id: string
  name: string
  active: boolean
  methods: FopMethods
  novaPoshta: FopNovaPoshtaRefs
  secretsSet: FopSecretsSet
}

// Секреты для сохранения (все опциональны; пустые/undefined НЕ перезаписывают существующие).
export interface FopSecretsPayload {
  liqpay?: { publicKey?: string; privateKey?: string }
  monoChast?: { storeId?: string; storeSecret?: string }
  monoAcquire?: { token?: string }
  privatPaypart?: { storeId?: string; password?: string }
  checkbox?: { licenseKey?: string; pinCode?: string; cashierName?: string }
  novaPoshta?: { apiKey?: string }
}
export interface FopSavePayload {
  name: string
  active: boolean
  methods: FopMethods
  novaPoshta: FopNovaPoshtaRefs
  secrets?: FopSecretsPayload
}

export const fopsAdminApi = {
  list: async (): Promise<FopAdmin[]> => {
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/fops/admin`, { headers: await adminHeaders() })
      return data?.success ? (data.data as FopAdmin[]) : []
    } catch (e) {
      console.error('fops list:', e)
      return []
    }
  },
  save: async (id: string, payload: FopSavePayload): Promise<boolean> => {
    try {
      const { data } = await axios.put(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}`, payload, { headers: await adminHeaders() })
      return !!data?.success
    } catch (e) {
      console.error('fops save:', e)
      return false
    }
  },
  clearSecret: async (id: string, group: keyof FopSecretsPayload): Promise<boolean> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}/clear-secret`, { group }, { headers: await adminHeaders() })
      return !!data?.success
    } catch {
      return false
    }
  },
  remove: async (id: string): Promise<boolean> => {
    try {
      const { data } = await axios.delete(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}`, { headers: await adminHeaders() })
      return !!data?.success
    } catch {
      return false
    }
  },
}

export default fopsAdminApi
