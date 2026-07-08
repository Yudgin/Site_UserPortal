import { db } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, limit, orderBy } from 'firebase/firestore'
import { secureId } from '@/utils/id'
import type { ChatSession } from '@/types/chat'

// Сессии диалога клиента с ИИ/менеджером. Открываются по непубличной ссылке (id).
const COLLECTION = 'chatSessions'

// Криптостойкий непредсказуемый id — ссылка на сессию защищена самим id (как share-ссылка)
const generateId = (): string => secureId(16)

export const chatSessionService = {
  // Создать новую сессию (клиент может быть анонимным)
  create: async (init?: Partial<ChatSession>): Promise<ChatSession | null> => {
    if (!db) return null
    try {
      const now = new Date().toISOString()
      const session: ChatSession = {
        id: generateId(),
        createdAt: now,
        updatedAt: now,
        status: 'active',
        lang: init?.lang || 'uk',
        requestId: init?.requestId ?? null,
        contact: init?.contact ?? null,
        messages: init?.messages ?? [],
        escalation: init?.escalation ?? null,
        reminders: init?.reminders ?? [],
        // authorization опционально — не пишем undefined (Firestore его не принимает)
        ...(init?.authorization ? { authorization: init.authorization } : {}),
      }
      await setDoc(doc(db, COLLECTION, session.id), session)
      return session
    } catch (error) {
      console.error('Error creating chat session:', error)
      return null
    }
  },

  load: async (id: string): Promise<ChatSession | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, COLLECTION, id))
      return snap.exists() ? (snap.data() as ChatSession) : null
    } catch (error) {
      console.error('Error loading chat session:', error)
      return null
    }
  },

  // Сохранить сессию целиком (после добавления сообщения, эскалации и т.д.)
  save: async (session: ChatSession): Promise<boolean> => {
    if (!db) return false
    try {
      await setDoc(doc(db, COLLECTION, session.id), { ...session, updatedAt: new Date().toISOString() })
      return true
    } catch (error) {
      console.error('Error saving chat session:', error)
      return false
    }
  },

  // Все недавние сессии (для просмотра менеджером)
  listRecent: async (max = 100): Promise<ChatSession[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, COLLECTION), orderBy('updatedAt', 'desc'), limit(max))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as ChatSession)
    } catch (error) {
      console.error('Error listing chat sessions:', error)
      return []
    }
  },

  // Только эскалированные обращения (для менеджера обращений)
  listEscalated: async (max = 100): Promise<ChatSession[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, COLLECTION), where('status', '==', 'escalated'), limit(max))
      const snap = await getDocs(q)
      const items = snap.docs.map((d) => d.data() as ChatSession)
      return items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    } catch (error) {
      console.error('Error listing escalated sessions:', error)
      return []
    }
  },
}

export default chatSessionService
