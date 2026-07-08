import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, where, limit } from 'firebase/firestore'
import type { ComplaintTemplate } from '@/types/complaint'

// Шаблоны жалоб (симптом → диагностика + варианты ремонта).
// Публичное чтение (нужно ИИ-оценке как контекст), запись — администратору.
const COLLECTION = 'complaintTemplates'

const generateId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

export const complaintTemplateService = {
  save: async (tpl: Omit<ComplaintTemplate, 'updatedAt' | 'updatedBy'> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = tpl.id || generateId()
      const payload: ComplaintTemplate = {
        ...tpl,
        id,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser.email,
      }
      await setDoc(doc(db, COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error saving complaint template:', error)
      return null
    }
  },

  load: async (id: string): Promise<ComplaintTemplate | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ComplaintTemplate) : null
    } catch (error) {
      console.error('Error loading complaint template:', error)
      return null
    }
  },

  listAll: async (max = 300): Promise<ComplaintTemplate[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), limit(max)))
      const items = snap.docs.map((d) => d.data() as ComplaintTemplate)
      return items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    } catch (error) {
      console.error('Error listing complaint templates:', error)
      return []
    }
  },

  // Активные шаблоны для контекста ИИ (публичное чтение)
  listActive: async (max = 300): Promise<ComplaintTemplate[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), where('active', '==', true), limit(max)))
      return snap.docs.map((d) => d.data() as ComplaintTemplate)
    } catch (error) {
      console.error('Error listing active complaint templates:', error)
      return []
    }
  },

  delete: async (id: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (error) {
      console.error('Error deleting complaint template:', error)
      return false
    }
  },
}

export default complaintTemplateService
