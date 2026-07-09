// Хранилище заявок на обслуживание (Firestore, коллекция serviceRequests). Доступ — админ
// (см. firestore.rules). Заявка — наша локальная сущность-хаб (обращение → калькуляции → оплата).
import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, limit, orderBy } from 'firebase/firestore'
import type { ServiceRequest } from '@/types/serviceRequest'
import { secureId } from '@/utils/id'

const COLLECTION = 'serviceRequests'

export const serviceRequestService = {
  // Создать/обновить заявку (merge — чтобы не затирать поля, проставленные другими шагами)
  save: async (req: Partial<ServiceRequest> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = req.id || secureId(16)
      const now = new Date().toISOString()
      const payload = {
        ...req,
        id,
        updatedAt: now,
        ...(req.createdAt ? {} : { createdAt: now }),
        ...(req.createdBy ? {} : { createdBy: auth.currentUser.email }),
      }
      await setDoc(doc(db, COLLECTION, id), payload, { merge: true })
      return { id }
    } catch (error) {
      console.error('Error saving service request:', error)
      return null
    }
  },

  get: async (id: string): Promise<ServiceRequest | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ServiceRequest) : null
    } catch (error) {
      console.error('Error loading service request:', error)
      return null
    }
  },

  list: async (max = 200): Promise<ServiceRequest[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, COLLECTION), orderBy('createdAt', 'desc'), limit(max))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as ServiceRequest)
    } catch (error) {
      console.error('Error listing service requests:', error)
      return []
    }
  },

  // Заявки, привязанные к обращению (для дедупликации/перехода)
  listBySession: async (sessionId: string): Promise<ServiceRequest[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, COLLECTION), where('sessionId', '==', sessionId), limit(20))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as ServiceRequest)
    } catch (error) {
      console.error('Error listing service requests by session:', error)
      return []
    }
  },
}

export default serviceRequestService
