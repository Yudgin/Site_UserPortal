// Чтение коллекции оплат для админки (клиентский Firestore SDK; правило payments — read/list админ).
// Записи создаются backend-ом; здесь только чтение. Действия (чек/реконсиляция) — через backend.
import { db } from './firebase'
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore'
import { paymentsApi } from './endpoints/payments'

export interface PaymentRow {
  orderId: string
  fopId: string
  amount: number
  method?: string
  provider?: string
  status: string
  receiptId?: string | null
  receiptStatus?: string | null
  receiptError?: string | null
  taxUrl?: string | null
  fiscalCode?: string | null
  estimateId?: string | null
  shopOrderId?: string | null
  createdAt: string
  receiptAt?: string | null
}

const list = async (max = 200): Promise<PaymentRow[]> => {
  if (!db) return []
  try {
    const q = query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(max))
    const snap = await getDocs(q)
    return snap.docs.map((d) => d.data() as PaymentRow)
  } catch (error) {
    console.error('Error listing payments:', error)
    return []
  }
}

export const paymentsAdminService = {
  list,
  // Новейшие оплаты плюс все без чека: попытки оплаты в магазине не должны вытеснять такую оплату со страницы и из счётчика.
  // Маршрут не ответил (роль, сеть): остаётся список из Firestore.
  listWithUnfiscalized: async (max = 200): Promise<PaymentRow[]> => {
    const [rows, unfiscalized] = await Promise.all([
      list(max),
      paymentsApi.unfiscalized().catch((error) => {
        console.error('Error listing unfiscalized payments:', error)
        return []
      }),
    ])
    const known = new Set(rows.map((p) => p.orderId))
    const older = unfiscalized.filter((p) => !known.has(p.orderId))
      .map((p) => ({ ...p, provider: p.provider || undefined, method: p.method || undefined }))
    return [...rows, ...older]
  },
}

export default paymentsAdminService
