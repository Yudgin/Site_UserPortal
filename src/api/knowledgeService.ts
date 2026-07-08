import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, limit } from 'firebase/firestore'
import type { KnowledgeArticle } from '@/types/knowledge'

// Единая база знаний: статьи для консультаций и самопомощи.
const COLLECTION = 'knowledgeArticles'

const generateId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

export const knowledgeService = {
  // Сохранить статью (создать или обновить). Доступно администратору (см. firestore.rules).
  save: async (article: Omit<KnowledgeArticle, 'updatedAt' | 'updatedBy'> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = article.id || generateId()
      const payload: KnowledgeArticle = {
        ...article,
        id,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser.email,
      }
      await setDoc(doc(db, COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error saving knowledge article:', error)
      return null
    }
  },

  load: async (id: string): Promise<KnowledgeArticle | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as KnowledgeArticle) : null
    } catch (error) {
      console.error('Error loading knowledge article:', error)
      return null
    }
  },

  // Все статьи (для админ-редактора и как контекст для ИИ; фильтрация по флагам — на клиенте)
  listAll: async (max = 300): Promise<KnowledgeArticle[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), limit(max)))
      const items = snap.docs.map((d) => d.data() as KnowledgeArticle)
      return items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    } catch (error) {
      console.error('Error listing knowledge articles:', error)
      return []
    }
  },

  delete: async (id: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (error) {
      console.error('Error deleting knowledge article:', error)
      return false
    }
  },
}

export default knowledgeService
