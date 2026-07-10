// Чтение журнала оповещений клиента (Firestore, коллекция notifications). Доступ — админ
// (см. firestore.rules). Запись выполняет только backend (/api/notify, Admin SDK).
import { db } from './firebase'
import { collection, query, where, getDocs } from 'firebase/firestore'
import type { ClientNotification } from '@/types/notification'

const COLLECTION = 'notifications'

export const notificationService = {
  // История оповещений по заявке (новые сверху).
  listByRequest: async (serviceRequestId: string): Promise<ClientNotification[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, COLLECTION), where('serviceRequestId', '==', serviceRequestId))
      const snap = await getDocs(q)
      return snap.docs
        .map((d) => d.data() as ClientNotification)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    } catch (e) {
      console.error('listByRequest notifications:', e)
      return []
    }
  },
}

export default notificationService
