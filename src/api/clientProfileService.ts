import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, getDocs, query, limit, orderBy, arrayUnion } from 'firebase/firestore'
import { normalizePhone } from '@/utils/phone'
import type { ClientProfile } from '@/types/clientProfile'

// Профили клиентов. Ключ = нормализованный телефон → слияние по телефону автоматическое.
const COLLECTION = 'clientProfiles'

interface UpsertExtra {
  name?: string
  email?: string
  authUid?: string | null
  boatId?: string | null
  sessionId?: string | null
  taskId?: string | null
}

export const clientProfileService = {
  // Create-or-update профиля по телефону. Массивы наполняются arrayUnion (не перезаписываются),
  // имя/email пишутся только если непустые (чтобы не затирать существующие).
  upsertByPhone: async (phone: string, extra: UpsertExtra = {}): Promise<{ id: string } | null> => {
    if (!db) return null
    const id = normalizePhone(phone)
    if (!id) return null
    try {
      const uid = extra.authUid || auth?.currentUser?.uid || null
      // arrayUnion требует минимум 1 аргумент — включаем поле только когда есть что добавить.
      const payload: Record<string, unknown> = {
        id,
        phone: id,
        updatedAt: new Date().toISOString(),
        ...(extra.name && extra.name.trim() ? { name: extra.name.trim() } : {}),
        ...(extra.email && extra.email.trim() ? { email: extra.email.trim() } : {}),
        ...(uid ? { authUids: arrayUnion(uid) } : {}),
        ...(extra.boatId ? { boatIds: arrayUnion(extra.boatId) } : {}),
        ...(extra.sessionId ? { sessionIds: arrayUnion(extra.sessionId) } : {}),
        ...(extra.taskId ? { taskIds: arrayUnion(extra.taskId) } : {}),
      }
      await setDoc(doc(db, COLLECTION, id), payload, { merge: true })
      return { id }
    } catch (error) {
      console.error('Error upserting client profile:', error)
      return null
    }
  },

  load: async (phone: string): Promise<ClientProfile | null> => {
    if (!db) return null
    const id = normalizePhone(phone)
    if (!id) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ClientProfile) : null
    } catch (error) {
      console.error('Error loading client profile:', error)
      return null
    }
  },

  // Список профилей (админка)
  list: async (max = 500): Promise<ClientProfile[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), orderBy('updatedAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as ClientProfile)
    } catch (error) {
      console.error('Error listing client profiles:', error)
      return []
    }
  },
}

export default clientProfileService
