// Запуск синхронизации картотеки ремонтов из 1С (админ). Сервер тянет список ремонтов
// из 1С и upsert-ит их в serviceRequests под id sr-ext-<guid> (портальные поля не трогает).
import axios from 'axios'
import { auth } from './firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

export interface OnecSyncResult {
  success: boolean
  total: number
  created: number
  updated: number
  unchanged: number
  deferred: number // не успели в бюджет прогона — доберёт следующий запуск
  errors: { guid: string; error: string }[]
}

export const syncRepairsFrom1C = async (guids?: string[]): Promise<OnecSyncResult> => {
  const t = await auth?.currentUser?.getIdToken?.()
  const res = await axios.post(
    `${BACKEND_URL}/api/onec/sync-repairs`,
    guids?.length ? { guids } : {},
    // Сервер сам укладывается в 240s (бюджет прогона) — 290s здесь только запас на сеть.
    { timeout: 290000, headers: t ? { Authorization: `Bearer ${t}` } : {} },
  )
  return res.data as OnecSyncResult
}
