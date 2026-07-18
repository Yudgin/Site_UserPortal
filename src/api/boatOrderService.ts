// Замовлення корабликів (Firestore, колекція boatOrders). Доступ — власник (rules).
// Список сортується за датою створення (нові зверху).
import { db, auth } from './firebase'
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import type { BoatOrder } from '@/types/boats'
import { secureId } from '@/utils/id'

const COLLECTION = 'boatOrders'

export const boatOrderService = {
  list: async (): Promise<BoatOrder[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(collection(db, COLLECTION))
      return snap.docs
        .map((d) => d.data() as BoatOrder)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    } catch (e) {
      console.error('boatOrders list:', e)
      return []
    }
  },

  get: async (id: string): Promise<BoatOrder | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as BoatOrder) : null
    } catch (e) {
      console.error('boatOrders get:', e)
      return null
    }
  },

  save: async (o: Partial<BoatOrder> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = o.id || secureId(16)
      const now = new Date().toISOString()
      await setDoc(
        doc(db, COLLECTION, id),
        { ...o, id, updatedAt: now, ...(o.createdAt ? {} : { createdAt: now, createdBy: auth.currentUser.uid }) },
        { merge: true }
      )
      return { id }
    } catch (e) {
      console.error('boatOrders save:', e)
      return null
    }
  },

  remove: async (id: string): Promise<boolean> => {
    if (!db) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (e) {
      console.error('boatOrders remove:', e)
      return false
    }
  },
}

export default boatOrderService
