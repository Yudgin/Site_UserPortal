// Журнал дзвінків (читання, власник): події дзвінків + результати розмов операторів.
// Пише тільки backend (зеркало операторского бота) — див. server/calls.js.
import { db } from './firebase'
import { collection, doc, getDocs, limit, orderBy, query, updateDoc } from 'firebase/firestore'

// Рабочий процесс канбана «Дзвінки»: нові (без резюме) → оброблені (оператор лишив
// коментар/резюме — черга власника) → архів (власник додав дію і закрив).
export type CallWorkflowStatus = 'new' | 'processed' | 'archived'

export interface CallNote {
  text: string
  at: string
  by?: string | null
}

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
  answeredAt?: string | null // Kyivstar: абонент відповів (established)
  completedAt?: string | null
  lastType?: string | null
  source?: string | null // 'kyivstar' — прямий вебхук Віртуальної АТС; інакше — зеркало бота (1С)
  direction?: 'incoming' | 'outgoing' | null
  owners?: string[] // Kyivstar: номери співробітників, яким дзвонило (груповий дзвінок)
  workflowStatus?: CallWorkflowStatus | null // явний стан канбану (без нього — виводиться з результатів)
  notes?: CallNote[] // дії/коментарі власника
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
  // Для результатов без связанного события (orphan) канбан-статус живёт на самом результате.
  workflowStatus?: CallWorkflowStatus | null
  notes?: CallNote[]
}

// Задача/напоминание операторского бота (зеркало botTasks). status: open → done;
// после done владелец просматривает результат и архивирует (workflowStatus='archived').
export interface BotTask {
  id: string
  kind: 'task' | 'reminder'
  title: string
  assigneeUserId?: string | null
  assigneeName?: string | null
  creatorName?: string | null
  dueAt?: string | null
  status: 'open' | 'done'
  result?: string | null
  doneAt?: string | null
  doneByName?: string | null
  createdAt: string
  updatedAt?: string
  workflowStatus?: CallWorkflowStatus | null
  notes?: CallNote[]
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

  listTasks: async (max = 500): Promise<BotTask[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(query(collection(db, 'botTasks'), orderBy('createdAt', 'desc'), limit(max)))
      return snap.docs.map((d) => d.data() as BotTask)
    } catch (e) {
      console.error('botTasks list:', e)
      return []
    }
  },

  // Канбан: обновление воркфлоу-полей (создание/удаление карточек — только backend).
  updateEvent: async (callId: string, patch: { workflowStatus?: CallWorkflowStatus; notes?: CallNote[] }): Promise<boolean> => {
    if (!db) return false
    try {
      await updateDoc(doc(db, 'callEvents', callId), patch)
      return true
    } catch (e) {
      console.error('callEvents update:', e)
      return false
    }
  },
  updateResult: async (id: string, patch: { workflowStatus?: CallWorkflowStatus; notes?: CallNote[] }): Promise<boolean> => {
    if (!db) return false
    try {
      await updateDoc(doc(db, 'callResults', id), patch)
      return true
    } catch (e) {
      console.error('callResults update:', e)
      return false
    }
  },
  updateTask: async (id: string, patch: { workflowStatus?: CallWorkflowStatus; notes?: CallNote[] }): Promise<boolean> => {
    if (!db) return false
    try {
      await updateDoc(doc(db, 'botTasks', id), patch)
      return true
    } catch (e) {
      console.error('botTasks update:', e)
      return false
    }
  },
}

export default callsService
