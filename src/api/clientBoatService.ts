import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, where, limit, orderBy } from 'firebase/firestore'
import type { ClientBoat } from '@/types/clientBoat'

// База клиентов и их корабликов. Создание доступно всем (опросник), чтение — администратору.
const COLLECTION = 'clientBoats'

const generateId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 12; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return s
}

export const clientBoatService = {
  // Создать запись из опросника (клиент может быть анонимным)
  create: async (data: Omit<ClientBoat, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ id: string } | null> => {
    if (!db) return null
    try {
      const id = generateId()
      const now = new Date().toISOString()
      const payload: ClientBoat = { ...data, id, createdAt: now, updatedAt: now }
      await setDoc(doc(db, COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error creating client boat:', error)
      return null
    }
  },

  load: async (id: string): Promise<ClientBoat | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ClientBoat) : null
    } catch (error) {
      console.error('Error loading client boat:', error)
      return null
    }
  },

  // Список всех корабликов (админка). Сортировка — новые сверху.
  list: async (max = 500): Promise<ClientBoat[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), orderBy('createdAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as ClientBoat)
    } catch (error) {
      console.error('Error listing client boats:', error)
      return []
    }
  },

  // Поиск по телефону (для дедупликации и будущей привязки истории 1С) — администратор
  findByPhone: async (phone: string): Promise<ClientBoat[]> => {
    if (!db || !phone) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), where('contact.phone', '==', phone), limit(20)))
      return snap.docs.map((d) => d.data() as ClientBoat)
    } catch (error) {
      console.error('Error finding client boat by phone:', error)
      return []
    }
  },

  // Обновить запись (админка)
  update: async (id: string, patch: Partial<ClientBoat>): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      if (!snap.exists()) return false
      await setDoc(doc(db, COLLECTION, id), { ...(snap.data() as ClientBoat), ...patch, updatedAt: new Date().toISOString() })
      return true
    } catch (error) {
      console.error('Error updating client boat:', error)
      return false
    }
  },

  delete: async (id: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await deleteDoc(doc(db, COLLECTION, id))
      return true
    } catch (error) {
      console.error('Error deleting client boat:', error)
      return false
    }
  },
}

export default clientBoatService
