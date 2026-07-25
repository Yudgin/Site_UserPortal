// Журнал дзвінків (читання, власник): події дзвінків + результати розмов операторів.
// Пише тільки backend (зеркало операторского бота) — див. server/calls.js.
import { db } from './firebase'
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore'

export interface CallEvent {
  callId: string
  sourceCallId?: string | null
  phone: string
  clientName?: string | null
  clientId?: string | null
  line?: string | null
  employee?: string | null
  employeeId?: string | null
  at: string // початок дзвінка
  completedAt?: string | null
  lastType?: string | null
}

export interface CallResult {
  id: string
  callId?: string | null
  phone: string
  clientName?: string | null
  resultText: string
  operatorName?: string | null
  createdAt: string
  sentTo1C?: boolean
  reviewedAt?: string | null
  reviewedByName?: string | null
}

export const callsService = {
  listEvents: async (max = 800): Promise<CallEvent[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, 'callEvents'), orderBy('at', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as CallEvent)
    } catch (e) {
      console.error('callEvents list:', e)
      return []
    }
  },
  listResults: async (max = 1500): Promise<CallResult[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, 'callResults'), orderBy('createdAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as CallResult)
    } catch (e) {
      console.error('callResults list:', e)
      return []
    }
  },
}

export default callsService
