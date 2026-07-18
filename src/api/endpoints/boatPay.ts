// Оплата замовлення кораблика (адмін): список ФОП з методами + створення посилання на оплату.
// Сума/позиції — server-authoritative (беруться з boatOrders на сервері, не з браузера).
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface FopPublic {
  id: string
  name: string
  methods: Record<string, boolean> // liqpayCard/liqpayPaypart/monoChast/monoAcquire/privatPaypart/cod
  novaPoshta: boolean
  receipts: boolean
}

// Онлайн-методи, для яких можна створити посилання (COD — не посилання, а наложка в ТТН).
export const BOAT_PAY_METHODS: { value: string; fopKey: string; label: string }[] = [
  { value: 'mono-acquire', fopKey: 'monoAcquire', label: 'Картою (monobank)' },
  { value: 'mono-chast', fopKey: 'monoChast', label: 'Покупка частинами (monobank)' },
  { value: 'liqpay-card', fopKey: 'liqpayCard', label: 'Картою (LiqPay)' },
  { value: 'liqpay-paypart', fopKey: 'liqpayPaypart', label: 'Оплата частинами (LiqPay/Приват)' },
]

export interface BoatPayResult {
  orderId: string
  provider: string
  pageUrl?: string
  checkoutUrl?: string
  bank?: unknown // mono-chast: банк шле клієнту push, посилання нема
}

export const boatPayApi = {
  listFops: async (): Promise<FopPublic[]> => {
    try {
      const { data } = await axios.get(`${BACKEND_URL}/api/fops`, { timeout: 15000 })
      return data?.success ? (data.data as FopPublic[]) : []
    } catch {
      return []
    }
  },

  create: async (params: { boatOrderId: string; fopId: string; method: string; deliveryEmail?: string }):
    Promise<{ ok: boolean; data?: BoatPayResult; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/boat-orders/pay`, params, { headers: await adminHeaders(), timeout: 30000 })
      if (data?.success) return { ok: true, data: data.data }
      return { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: any) {
      return { ok: false, error: e?.response?.data?.error?.message || e?.message || 'Не вдалося створити оплату' }
    }
  },
}

export default boatPayApi
