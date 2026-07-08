import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, limit, orderBy } from 'firebase/firestore'
import { secureId } from '@/utils/id'
import type { ServiceTask } from '@/types/serviceTask'

// Задачи сервиса (отправка комплектующих, доп. работа, перезвон…).
// Создание доступно всем (клиент из чата), чтение/изменение — администратору.
const COLLECTION = 'serviceTasks'

export const serviceTaskService = {
  create: async (data: Omit<ServiceTask, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'createdBy'> & { status?: ServiceTask['status'] }): Promise<{ id: string } | null> => {
    if (!db) return null
    try {
      const id = secureId(12)
      const now = new Date().toISOString()
      const payload: ServiceTask = {
        ...data,
        id,
        status: data.status ?? 'new',
        createdAt: now,
        updatedAt: now,
        createdBy: auth?.currentUser?.email ?? null,
      }
      await setDoc(doc(db, COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error creating service task:', error)
      return null
    }
  },

  load: async (id: string): Promise<ServiceTask | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ServiceTask) : null
    } catch (error) {
      console.error('Error loading service task:', error)
      return null
    }
  },

  list: async (max = 500): Promise<ServiceTask[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), orderBy('createdAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as ServiceTask)
    } catch (error) {
      console.error('Error listing service tasks:', error)
      return []
    }
  },

  update: async (id: string, patch: Partial<ServiceTask>): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      if (!snap.exists()) return false
      await setDoc(doc(db, COLLECTION, id), { ...(snap.data() as ServiceTask), ...patch, updatedAt: new Date().toISOString() })
      return true
    } catch (error) {
      console.error('Error updating service task:', error)
      return false
    }
  },

  delete: async (id: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (error) {
      console.error('Error deleting service task:', error)
      return false
    }
  },
}

export default serviceTaskService
