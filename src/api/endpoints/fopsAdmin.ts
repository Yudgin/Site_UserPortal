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
  // Банки ФОП (остатки и выписки). Нет в ответе прежней версии сервера.
  monoPersonal?: boolean
  privatAutoclient?: boolean
  novaPay?: boolean
}
export interface FopAdmin {
  id: string
  name: string
  active: boolean
  methods: FopMethods
  novaPoshta: FopNovaPoshtaRefs
  seller?: FopSeller
  secretsSet: FopSecretsSet
  lastCheck?: FopLastCheck | null // последняя проверка ключей (вручную или ежедневная); нет — метки серые
}

// Урезанный результат проверки по провайдеру — для меток в списке (подробности — в окне проверки).
export interface KeyCheckSummary { status: KeyCheckStatus; message: string; note?: string; subscriptionExp?: string; dateToBlock?: string; soon?: boolean }
export interface FopLastCheck {
  checkedAt: string
  source: 'manual' | 'daily'
  results: Partial<Record<keyof FopKeyCheck, KeyCheckSummary>>
}
// Подключены ли сообщения владельцу в Telegram и чем закончилась последняя ежедневная проверка.
export interface FopChecksStatus {
  telegram: boolean
  lastRun: { at: string; checked: number; failed: number; issues: number; sent: boolean | null } | null
}
export interface FopChecksRun { at: string; checked: number; failed: number; issues: number; sent: boolean | null; telegram: boolean }

// Секреты для сохранения (все опциональны; пустые/undefined НЕ перезаписывают существующие).
export interface FopSecretsPayload {
  liqpay?: { publicKey?: string; privateKey?: string }
  monoChast?: { storeId?: string; storeSecret?: string }
  monoAcquire?: { token?: string }
  privatPaypart?: { storeId?: string; password?: string }
  checkbox?: { licenseKey?: string; pinCode?: string; cashierName?: string }
  novaPoshta?: { apiKey?: string }
  // Банки ФОП: только чтение остатков и выписок
  monoPersonal?: { token?: string }
  privatAutoclient?: { token?: string; id?: string }
  novaPay?: { login?: string; refreshToken?: string; certificate?: string }
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
// Счёт ФОП в банке, как его показал банк при проверке подключения.
export interface BankAccountInfo { iban?: string; currency?: string; balance?: number | null; owner?: string }
export interface KeyCheckItem {
  status: KeyCheckStatus
  message: string
  holderName?: string // monobank, личный токен: на кого выдан
  accounts?: BankAccountInfo[] // банки ФОП: счета и остатки
  personalCards?: number // monobank: сколько личных карт человека портал не читает
  moreAccounts?: boolean // ПриватБанк: показаны не все счета
  note?: string // ключ годен, но способ оплаты выключен
  merchantName?: string // monobank: чей кабинет
  edrpou?: string
  paymentControl?: boolean | null // Нова Пошта: доступен ли «контроль оплаты»; null — неизвестно
  cashRegister?: { title?: string; fiscalNumber?: string; address?: string } // Checkbox: какая касса
  cashierName?: string // Checkbox: кассир
  certificateEnd?: string // Checkbox: до какого числа действует ключ подписи (КЕП) кассира
  shift?: string | null // Checkbox: OPENED / CLOSED / NONE…; null — не прочитали
  subscriptionExp?: string // Checkbox: подписка организации действует до (YYYY-MM-DD)
  billingStatus?: string // Checkbox: статус оплаты услуг как его отдал Checkbox
  dateToBlock?: string // Checkbox: с какого момента касса будет заблокирована за неоплату
  balanceUah?: number // Checkbox: остаток на счёте, грн
}
export interface FopKeyCheck {
  liqpay: KeyCheckItem
  monoAcquire: KeyCheckItem
  monoChast?: KeyCheckItem // нет в ответе прежней версии сервера
  checkbox?: KeyCheckItem
  novaPoshta: KeyCheckItem
  bankMono?: KeyCheckItem // счёт ФОП в monobank (остатки и выписки)
  bankPrivat?: KeyCheckItem // счёт ФОП в ПриватБанке
  bankNovaPay?: KeyCheckItem // счёт ФОП в NovaPay
}
export interface TestReceiptInfo { receiptId?: string; fiscalCode?: string | null; taxUrl?: string | null; status?: string | null }
// Чек возврата к тестовому чеку: создан (поля чека), не удался (error) или не создан (skipped: 'not_registered' — продажа
// не прошла, возвращать нечего; 'sale_pending' — ДПС ещё не приняла продажу, возврат делает владелец в кабинете).
export interface TestRefund extends TestReceiptInfo { error?: string; skipped?: string }

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
  checksStatus: async (): Promise<FopChecksStatus | null> => {
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/fops/admin/checks-status`, { headers: await adminHeaders() })
      return data?.success ? (data.data as FopChecksStatus) : null
    } catch (e) {
      console.error('fops checks-status:', e)
      return null
    }
  },
  // Та же проверка, что ежедневная: все активные ФОП, результат в метки, при проблемах — сообщение в Telegram.
  runAllChecks: async (): Promise<{ ok: boolean; data?: FopChecksRun; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/fops/checks/daily`, {}, { headers: await adminHeaders() })
      return data?.success ? { ok: true, data: data.data } : { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: { message?: string } } } }
      return { ok: false, error: err.response?.data?.error?.message || 'Не вдалося виконати запит' }
    }
  },
  // РЕАЛЬНЫЙ тестовый чек на 10 грн кассой этого ФОП (Checkbox) и сразу чек возврата — проверка кассы до конца.
  testReceipt: async (id: string): Promise<{ ok: boolean; data?: TestReceiptInfo & { refund?: TestRefund }; error?: string }> => {
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
