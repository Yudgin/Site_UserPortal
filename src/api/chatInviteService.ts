// Чтение служебных записей приглашений в чат с ИИ (chatInvites/{sessionId}; пишет только сервер — server/chatInvites.js).
// Правила Firestore: владелец и директор читают все записи, остальные сотрудники — только свои (запрос обязан
// фильтровать по by.uid, иначе отклоняется целиком).
import { db, auth } from './firebase'
import { collection, getDocs, limit, query, where } from 'firebase/firestore'
import type { ChatInviteRecord } from '@/types/chat'

const COLLECTION = 'chatInvites'
const IN_MAX = 30 // лимит Firestore на число значений в where('in')

const toRecord = (d: { id: string; data: () => unknown }) => ({ ...(d.data() as ChatInviteRecord), id: d.id })

export const chatInviteService = {
  // Приглашения на эти номера (+380XXXXXXXXX — так их пишет сервер). seesAll — владелец/директор: запрос по номерам;
  // иначе (или если правила не пустили) — свои приглашения одним запросом, номера фильтруются на клиенте.
  listByPhones: async (phones: string[], seesAll: boolean): Promise<ChatInviteRecord[]> => {
    const uid = auth?.currentUser?.uid
    const wanted = [...new Set(phones.filter(Boolean))]
    if (!db || !uid || !wanted.length) return []
    const coll = collection(db, COLLECTION)
    if (seesAll) {
      try {
        const chunks: string[][] = []
        for (let i = 0; i < wanted.length; i += IN_MAX) chunks.push(wanted.slice(i, i + IN_MAX))
        const snaps = await Promise.all(chunks.map((c) => getDocs(query(coll, where('phone', 'in', c)))))
        return snaps.flatMap((s) => s.docs.map(toRecord))
      } catch (e) {
        console.error('chatInvites by phone (fallback to own):', e)
      }
    }
    try {
      const set = new Set(wanted)
      const snap = await getDocs(query(coll, where('by.uid', '==', uid), limit(500)))
      return snap.docs.map(toRecord).filter((r) => !!r.phone && set.has(r.phone))
    } catch (e) {
      console.error('chatInvites own:', e)
      return []
    }
  },
}
