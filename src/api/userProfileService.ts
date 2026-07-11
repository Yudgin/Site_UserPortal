// Профили сотрудников (роль-документы). Firestore-коллекция users, ключ = Firebase uid.
// Чтение: свой документ ИЛИ владелец. Запись роли/центров/активности — ТОЛЬКО владелец (правила).
// Саморегистрация identity (email/имя при входе) идёт через backend /api/me/register (Admin SDK),
// чтобы клиент не мог сам выдать себе роль.
import axios from 'axios'
import { db, auth } from './firebase'
import { doc, getDoc, collection, getDocs, setDoc, query, orderBy } from 'firebase/firestore'
import type { UserProfile, Role, CenterAccess } from '@/types/access'

const COLLECTION = 'users'
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export const userProfileService = {
  // Профиль текущего пользователя (для слоя доступа).
  getOwn: async (uid: string): Promise<UserProfile | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, uid))
      return snap.exists() ? (snap.data() as UserProfile) : null
    } catch (error) {
      console.error('Error loading own profile:', error)
      return null
    }
  },

  // Список всех сотрудников (владелец) — для назначения ролей/центров.
  list: async (): Promise<UserProfile[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, COLLECTION), orderBy('email', 'asc')))
      return snap.docs.map((d) => d.data() as UserProfile)
    } catch (error) {
      console.error('Error listing user profiles:', error)
      return []
    }
  },

  // Саморегистрация identity при входе (через backend; роль НЕ трогаем). Best-effort.
  registerSelf: async (): Promise<void> => {
    try {
      await axios.post(`${BACKEND_URL}/api/me/register`, {}, { headers: await adminHeaders(), timeout: 15000 })
    } catch (error) {
      console.error('registerSelf:', error)
    }
  },

  // Назначить роль/центры/активность (ТОЛЬКО владелец; запись гейтится правилами по email).
  setAccess: async (uid: string, patch: { role?: Role; centers?: CenterAccess[]; active?: boolean }): Promise<boolean> => {
    if (!db || !auth?.currentUser) return false
    try {
      await setDoc(doc(db, COLLECTION, uid), { ...patch, updatedAt: new Date().toISOString() }, { merge: true })
      return true
    } catch (error) {
      console.error('Error setting user access:', error)
      return false
    }
  },
}

export default userProfileService
