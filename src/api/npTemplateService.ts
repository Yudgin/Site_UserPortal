// Хранилище шаблонов посылок Новой Почты (Firestore, коллекция npTemplates). Доступ — владелец
// (см. firestore.rules). Не-секретные данные (параметры посылки).
import { db, auth } from './firebase'
import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import type { NpTemplate } from '@/types/npTemplate'
import { secureId } from '@/utils/id'

const COLLECTION = 'npTemplates'

export const npTemplateService = {
  list: async (): Promise<NpTemplate[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(collection(db, COLLECTION))
      return snap.docs
        .map((d) => d.data() as NpTemplate)
        .sort((a, b) => (a.serviceCenterId || '').localeCompare(b.serviceCenterId || '') || a.name.localeCompare(b.name))
    } catch (e) {
      console.error('npTemplates list:', e)
      return []
    }
  },

  save: async (t: Partial<NpTemplate> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = t.id || secureId(16)
      const now = new Date().toISOString()
      await setDoc(doc(db, COLLECTION, id), { ...t, id, updatedAt: now, ...(t.createdAt ? {} : { createdAt: now }) }, { merge: true })
      return { id }
    } catch (e) {
      console.error('npTemplates save:', e)
      return null
    }
  },

  remove: async (id: string): Promise<boolean> => {
    if (!db) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (e) {
      console.error('npTemplates remove:', e)
      return false
    }
  },
}

export default npTemplateService
