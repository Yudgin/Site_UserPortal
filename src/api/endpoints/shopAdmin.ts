// Страницы «Замовлення з сайту»: только маршруты /api/shop/admin/*, коллекции магазина закрыты правилом Firestore по умолчанию.
// Отказ сервера возвращается целиком: код и список действий решают, какие кнопки показать (например, «Створити без чека»).
import axios from 'axios'
import { auth } from '@/api/firebase'
import type { ShopCounters, ShopOrderCard, ShopOrderRow, ShopReadiness, ShopSalesSettings } from '@/types/shopOrder'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

const REQUEST_TIMEOUT_MS = 60 * 1000
// Накладная идёт через банк и несколько запросов к НП. Дольше ждать незачем: через 3 минуты сервер сам считает исход неизвестным.
const TTN_TIMEOUT_MS = 3 * 60 * 1000

export interface ShopFail {
  ok: false
  code: string // NETWORK: ответа нет, исход действия неизвестен
  error: string
  actions: string[]
  fields: string[]
  ttn?: string
  sms?: string
}
export type ShopResult<T> = { ok: true; data: T } | ShopFail

interface ServerError {
  code?: string
  message?: string
  actions?: string[]
  fields?: string[]
  ttn?: string
  sms?: string
}

const failOf = (err: ServerError | undefined, answered: boolean): ShopFail => ({
  ok: false,
  code: err?.code || (answered ? 'UNEXPECTED' : 'NETWORK'),
  error: err?.message || (answered ? 'Сервер відповів незрозуміло, спробуйте ще раз' : 'Сервер не відповів. Оновіть сторінку і перевірте, чи дія виконалась'),
  actions: err?.actions || [],
  fields: err?.fields || [],
  ttn: err?.ttn,
  sms: err?.sms,
})

const call = async <T>(method: 'get' | 'post' | 'put', path: string, { body, params, timeout = REQUEST_TIMEOUT_MS }: { body?: unknown; params?: Record<string, string>; timeout?: number } = {}): Promise<ShopResult<T>> => {
  try {
    const { data } = await axios.request({ method, url: `${BACKEND_URL}/api/shop/admin${path}`, data: body, params, headers: await adminHeaders(), timeout })
    return data?.success ? { ok: true, data: data.data as T } : failOf(data?.error, true)
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: ServerError } } }
    return failOf(err.response?.data?.error, !!err.response)
  }
}

const orderPath = (id: string, tail = '') => `/orders/${encodeURIComponent(id)}${tail}`

export const shopAdminApi = {
  actionList: () => call<{ items: ShopOrderRow[]; counters: ShopCounters }>('get', '/orders', { params: { view: 'action' } }),
  allOrders: () => call<{ items: ShopOrderRow[] }>('get', '/orders'),
  findByPhone: (phone: string) => call<{ items: ShopOrderRow[] }>('get', '/orders', { params: { phone } }),
  findByOrderNo: (orderNo: string) => call<{ items: ShopOrderRow[] }>('get', '/orders', { params: { orderNo } }),
  order: (id: string) => call<ShopOrderCard>('get', orderPath(id)),

  // force: коды отказов, которые владелец проверил и принял (TTN_UNKNOWN, NO_RECEIPT, TTN_NOT_FOUND).
  createTtn: (id: string, force: string[] = []) => call<{ ttn: string; state: string }>('post', orderPath(id, '/ttn'), { body: { force }, timeout: TTN_TIMEOUT_MS }),
  attachTtn: (id: string, number: string, force: string[] = []) => call<{ ttn: string; state: string }>('post', orderPath(id, '/ttn/attach'), { body: { number, force } }),
  refreshTtn: (id: string) => call<{ outcome?: string | null; state: string; ttn: string | null }>('post', orderPath(id, '/ttn/refresh')),
  cancel: (id: string) => call<{ state: string }>('post', orderPath(id, '/cancel')),
  updateRecipient: (id: string, body: Record<string, string>) => call<ShopOrderCard>('post', orderPath(id, '/recipient'), { body }),
  mark: (id: string, action: 'returned' | 'refund-requested' | 'confirm-payment' | 'check-reversed') => call<{ state?: string }>('post', orderPath(id, '/mark'), { body: { action } }),
  receiptRetry: (id: string) => call<{ receiptStatus: string | null; taxUrl: string | null; receiptAttempt: number }>('post', orderPath(id, '/receipt-retry')),
  resend: (id: string, kind: 'paid' | 'rcpt' | 'ttn') => call<{ kind: string; status: string }>('post', orderPath(id, '/resend'), { body: { kind } }),

  readiness: () => call<ShopReadiness>('get', '/readiness'),
  settings: () => call<{ settings: ShopSalesSettings | null }>('get', '/settings'),
  saveSettings: (patch: Partial<ShopSalesSettings>) => call<{ settings: ShopSalesSettings }>('put', '/settings', { body: patch }),
  testAlert: () => call<{ ownerTestOkAt: string; sms: string }>('post', '/test-alert'),
  dailyReset: () => call<{ day: string; unpaid: number }>('post', '/daily-reset'),
  disableAndRemoveInvoices: () => call<{ mode: string; total: number; failed: number }>('post', '/disable-and-remove-invoices'),
}

export default shopAdminApi
