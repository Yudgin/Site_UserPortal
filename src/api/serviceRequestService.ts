// Хранилище заявок на обслуживание (Firestore, коллекция serviceRequests). Доступ — админ
// (см. firestore.rules). Заявка — наша локальная сущность-хаб (обращение → калькуляции → оплата).
import { db, auth } from './firebase'
import { doc, getDoc, runTransaction, collection, query, where, getDocs, limit, orderBy } from 'firebase/firestore'
import type { ServiceRequest } from '@/types/serviceRequest'
import { secureId } from '@/utils/id'

const COLLECTION = 'serviceRequests'

export const serviceRequestService = {
  // Создать/обновить заявку (merge — чтобы не затирать поля, проставленные другими шагами).
  // createdAt/createdBy ставятся ТОЛЬКО при создании; частичные patch (статус, диагностика, ТТН,
  // offerId и т.д.) их не трогают — иначе дата/автор создания терялись бы при каждом обновлении.
  save: async (req: Partial<ServiceRequest> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    const database = db
    const email = auth.currentUser.email
    try {
      const id = req.id || secureId(16)
      const ref = doc(database, COLLECTION, id)
      const now = new Date().toISOString()
      await runTransaction(database, async (tx) => {
        const snap = await tx.get(ref)
        const payload: Record<string, unknown> = { ...req, id, updatedAt: now }
        if (snap.exists()) {
          // существующая заявка — не переписываем дату/автора создания
          delete payload.createdAt
          delete payload.createdBy
        } else {
          payload.createdAt = req.createdAt || now
          payload.createdBy = req.createdBy || email
        }
        tx.set(ref, payload, { merge: true })
      })
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
