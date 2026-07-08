import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, where, limit, orderBy } from 'firebase/firestore'
import type { Feedback, BehaviorCorrection } from '@/types/feedback'

// Обратная связь клиентов и правки поведения ИИ.
const FEEDBACK = 'feedback'
const CORRECTIONS = 'behaviorCorrections'

const generateId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

export const feedbackService = {
  // Клиент/ИИ создаёт отзыв (создание доступно всем — см. firestore.rules)
  create: async (fb: Omit<Feedback, 'id' | 'createdAt' | 'status' | 'reviewedBy' | 'managerReply'>): Promise<{ id: string } | null> => {
    if (!db) return null
    try {
      const id = generateId()
      const payload: Feedback = {
        ...fb,
        id,
        status: 'new',
        managerReply: null,
        reviewedBy: null,
        createdAt: new Date().toISOString(),
      }
      await setDoc(doc(db, FEEDBACK, id), payload)
      return { id }
    } catch (error) {
      console.error('Error creating feedback:', error)
      return null
    }
  },

  // Список отзывов (для админки; только администратор — см. firestore.rules)
  list: async (max = 200): Promise<Feedback[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, FEEDBACK), orderBy('createdAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as Feedback)
    } catch (error) {
      console.error('Error listing feedback:', error)
      return []
    }
  },

  // Обновить отзыв (статус, ответ менеджера) — администратор
  update: async (id: string, patch: Partial<Feedback>): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      const snap = await getDoc(doc(db, FEEDBACK, id))
      if (!snap.exists()) return false
      const current = snap.data() as Feedback
      await setDoc(doc(db, FEEDBACK, id), { ...current, ...patch, reviewedBy: auth.currentUser.email })
      return true
    } catch (error) {
      console.error('Error updating feedback:', error)
      return false
    }
  },
}

export const behaviorCorrectionService = {
  // Создать правку поведения ИИ (администратор)
  create: async (corr: Omit<BehaviorCorrection, 'id' | 'createdAt' | 'createdBy'>): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = generateId()
      const payload: BehaviorCorrection = {
        ...corr,
        id,
        createdAt: new Date().toISOString(),
        createdBy: auth.currentUser.email,
      }
      await setDoc(doc(db, CORRECTIONS, id), payload)
      return { id }
    } catch (error) {
      console.error('Error creating behavior correction:', error)
      return null
    }
  },

  // Активные правила для инжекта в промпт ИИ (публичное чтение)
  listActive: async (): Promise<BehaviorCorrection[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, CORRECTIONS), where('active', '==', true), limit(100)))
      return snap.docs.map((d) => d.data() as BehaviorCorrection)
    } catch (error) {
      console.error('Error listing behavior corrections:', error)
      return []
    }
  },

  // Все правки (для админки)
  listAll: async (max = 200): Promise<BehaviorCorrection[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, CORRECTIONS), limit(max)))
      const items = snap.docs.map((d) => d.data() as BehaviorCorrection)
      return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    } catch (error) {
      console.error('Error listing corrections:', error)
      return []
    }
  },

  update: async (id: string, patch: Partial<BehaviorCorrection>): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      const snap = await getDoc(doc(db, CORRECTIONS, id))
      if (!snap.exists()) return false
      await setDoc(doc(db, CORRECTIONS, id), { ...(snap.data() as BehaviorCorrection), ...patch })
      return true
    } catch (error) {
      console.error('Error updating correction:', error)
      return false
    }
  },
}
