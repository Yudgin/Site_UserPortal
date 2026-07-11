// Реестр сервисных центров (зон). Firestore-коллекция serviceCenters. Чтение — авторизованные
// (мастерам нужны названия центров), запись — только владелец (см. firestore.rules).
import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, orderBy } from 'firebase/firestore'
import type { ServiceCenter } from '@/types/access'
import { secureId } from '@/utils/id'

const COLLECTION = 'serviceCenters'

export const serviceCenterService = {
  list: async (): Promise<ServiceCenter[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), orderBy('name', 'asc')))
      return snap.docs.map((d) => d.data() as ServiceCenter)
    } catch (error) {
      console.error('Error listing service centers:', error)
      return []
    }
  },

  get: async (id: string): Promise<ServiceCenter | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ServiceCenter) : null
    } catch (error) {
      console.error('Error loading service center:', error)
      return null
    }
  },

  // Создать/обновить центр (владелец). createdAt/createdBy ставятся только при создании.
  save: async (c: Partial<ServiceCenter> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = c.id || secureId(12)
      const now = new Date().toISOString()
      const existing = await getDoc(doc(db, COLLECTION, id))
      const payload: Record<string, unknown> = { ...c, id, updatedAt: now }
      if (!existing.exists()) {
        payload.createdAt = c.createdAt || now
        payload.createdBy = c.createdBy || auth.currentUser.email
        if (payload.active === undefined) payload.active = true
      } else {
        delete payload.createdAt
        delete payload.createdBy
      }
      await setDoc(doc(db, COLLECTION, id), payload, { merge: true })
      return { id }
    } catch (error) {
      console.error('Error saving service center:', error)
      return null
    }
  },
}

export default serviceCenterService
