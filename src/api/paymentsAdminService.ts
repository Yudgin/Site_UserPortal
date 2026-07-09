// Чтение коллекции оплат для админки (клиентский Firestore SDK; правило payments — read/list админ).
// Записи создаются backend-ом; здесь только чтение. Действия (чек/реконсиляция) — через backend.
import { db } from './firebase'
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore'

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
  createdAt: string
  receiptAt?: string | null
}

export const paymentsAdminService = {
  list: async (max = 200): Promise<PaymentRow[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, 'payments'), orderBy('createdAt', 'desc'), limit(max))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as PaymentRow)
    } catch (error) {
      console.error('Error listing payments:', error)
      return []
    }
  },
}

export default paymentsAdminService
