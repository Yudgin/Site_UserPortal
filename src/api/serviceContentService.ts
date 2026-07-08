import { db, auth } from './firebase'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import type { LocalizedText } from '@/types/pricing'
import { AiHistoryEntry } from '@/api/endpoints/ai'

// Редактируемые тексты сервиса (соглашение и т.п.). Один документ на ключ.
// Клиент читает публично; редактирует администратор (см. firestore.rules).
export interface ServiceContentDoc {
  content: LocalizedText // текст на 6 языках
  aiHistory: AiHistoryEntry[] // история правок через ИИ (для наследственности промптов)
  updatedAt: string
  updatedBy: string | null
}

const COLLECTION = 'serviceContent'

// Ключи известных редактируемых текстов
export const SERVICE_CONTENT_KEYS = {
  terms: 'terms', // соглашение об использовании сервиса
} as const

export const serviceContentService = {
  load: async (key: string): Promise<ServiceContentDoc | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, key))
      return snap.exists() ? (snap.data() as ServiceContentDoc) : null
    } catch (error) {
      console.error('Error loading service content:', error)
      return null
    }
  },

  save: async (
    key: string,
    data: { content: LocalizedText; aiHistory: AiHistoryEntry[] }
  ): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      const payload: ServiceContentDoc = {
        ...data,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser.email,
      }
      await setDoc(doc(db, COLLECTION, key), payload)
      return true
    } catch (error) {
      console.error('Error saving service content:', error)
      return false
    }
  },
}

export default serviceContentService
