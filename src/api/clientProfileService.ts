import axios from 'axios'
import { db, auth } from './firebase'
import { doc, getDoc, collection, getDocs, query, limit, orderBy } from 'firebase/firestore'
import { normalizePhone } from '@/utils/phone'
import type { ClientProfile } from '@/types/clientProfile'

// Профили клиентов. Ключ = нормализованный телефон → слияние по телефону автоматическое.
const COLLECTION = 'clientProfiles'
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

interface UpsertExtra {
  name?: string
  email?: string
  authUid?: string | null
  boatId?: string | null
  sessionId?: string | null
  taskId?: string | null
}

export const clientProfileService = {
  // Create-or-update профиля по телефону — через BACKEND (Admin SDK). Прямую клиентскую запись
  // закрыли правилами: иначе аноним по угадываемому телефону-ключу мог перезаписать чужой PII.
  // Сервер сливает безопасно: имя/email — только если пусто; массивы — arrayUnion.
  upsertByPhone: async (phone: string, extra: UpsertExtra = {}): Promise<{ id: string } | null> => {
    const id = normalizePhone(phone)
    if (!id) return null
    try {
      const uid = extra.authUid || auth?.currentUser?.uid || null
      const { data } = await axios.post(`${BACKEND_URL}/api/client-profiles/upsert`, {
        id,
        name: extra.name,
        email: extra.email,
        authUid: uid,
        boatId: extra.boatId,
        sessionId: extra.sessionId,
        taskId: extra.taskId,
      })
      return data?.success ? { id } : null
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
