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
  senderName?: string // человекочитаемое имя отправителя (для отображения без ре-синхронизации)
  contactRef?: string
  contactName?: string
  senderPhone?: string
  cityRef?: string
  cityName?: string
  settlementRef?: string // Ref населённого пункта (для адресной доставки)
  warehouseRef?: string
  warehouseName?: string
}
// Реквизиты продавца для магазина на сайте: кроме actualAddress, они публичны.
export interface FopSeller {
  displayName?: string
  ipn?: string
  address?: string
  actualAddress?: string
  email?: string
  phone?: string
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
  seller?: FopSeller
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
  seller?: FopSeller
  secrets?: FopSecretsPayload
}

// Проверка ключей без денег: только вердикты, значения ключей сервер не отдаёт.
export type KeyCheckStatus = 'ok' | 'bad' | 'unknown' | 'none'
export interface KeyCheckItem {
  status: KeyCheckStatus
  message: string
  note?: string // ключ годен, но способ оплаты выключен
  merchantName?: string // monobank: чей кабинет
  edrpou?: string
  paymentControl?: boolean | null // Нова Пошта: доступен ли «контроль оплаты»; null — неизвестно
}
export interface FopKeyCheck {
  liqpay: KeyCheckItem
  monoAcquire: KeyCheckItem
  novaPoshta: KeyCheckItem
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
  checkKeys: async (id: string): Promise<{ ok: boolean; data?: FopKeyCheck; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}/check-keys`, {}, { headers: await adminHeaders() })
      return data?.success ? { ok: true, data: data.data } : { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: { message?: string } } } }
      return { ok: false, error: err.response?.data?.error?.message || 'Не вдалося виконати запит' }
    }
  },
  // РЕАЛЬНЫЙ тестовый чек на 10 грн кредами этого ФОП (Checkbox) — проверка данных кассы.
  testReceipt: async (id: string): Promise<{ ok: boolean; data?: { receiptId?: string; fiscalCode?: string | null; taxUrl?: string | null; status?: string | null }; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}/test-receipt`, {}, { headers: await adminHeaders() })
      return data?.success ? { ok: true, data: data.data } : { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: { message?: string } } } }
      return { ok: false, error: err.response?.data?.error?.message || 'Не вдалося виконати запит' }
    }
  },
}

export default fopsAdminApi
