// Хранилище заявок на обслуживание (Firestore, коллекция serviceRequests). Доступ — админ
// (см. firestore.rules). Заявка — наша локальная сущность-хаб (обращение → калькуляции → оплата).
import { db, auth } from './firebase'
import { doc, getDoc, setDoc, runTransaction, collection, query, where, getDocs, limit, orderBy, arrayUnion } from 'firebase/firestore'
import type { ServiceRequest, StageHistoryItem } from '@/types/serviceRequest'
import { secureId } from '@/utils/id'
import { canonicalPhone } from '@/utils/phone'

const COLLECTION = 'serviceRequests'

export const serviceRequestService = {
  // Создать/обновить заявку (merge — чтобы не затирать поля, проставленные другими шагами).
  // createdAt/createdBy ставятся ТОЛЬКО при создании; частичные patch (статус, диагностика, ТТН,
  // offerId и т.д.) их не трогают — иначе дата/автор создания терялись бы при каждом обновлении.
  // Здесь же — для правил входящих Binotel (зеркало server/statusTimes.js и поиска по номеру):
  //   statusChangedAt — при настоящей смене статуса, doneAt — при переходе в «Виконано»;
  //   clientPhone — канонический +380XXXXXXXXX, кто бы его ни передал (обращение, перенос из 1С, карточка).
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
        if (typeof req.clientPhone === 'string') payload.clientPhone = canonicalPhone(req.clientPhone)
        const prevStatus = snap.exists() ? (snap.data() as Partial<ServiceRequest>).status : undefined
        if (req.status && req.status !== prevStatus) {
          payload.statusChangedAt = now
          if (req.status === 'done') payload.doneAt = now
        }
        // Денормалізація для вибірки «Мої заявки»: specialistUids завжди = specialists[].uid.
        if (Array.isArray(req.specialists)) payload.specialistUids = req.specialists.map((s) => s.uid)
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

  // Етап ремонту: merge-патч + запис в історію через arrayUnion — той самий шлях, що й у мобільного
  // додатка (без транзакції, щоб працювало з офлайн-черги SDK). waitingParts живе лише на етапі
  // «Чекаємо запчастини», при будь-якому іншому переході очищується.
  setStage: async (id: string, item: StageHistoryItem): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await setDoc(doc(db, COLLECTION, id), {
        stage: item.stage,
        stageSince: item.at,
        stageHistory: arrayUnion(item),
        waitingParts: item.stage === 'waiting_parts' ? { note: item.note || '', since: item.at } : null,
        updatedAt: item.at,
      }, { merge: true })
      return true
    } catch (error) {
      console.error('Error setting repair stage:', error)
      return false
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
