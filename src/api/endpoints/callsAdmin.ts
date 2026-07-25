// Дії власника над журналом дзвінків через backend: коментар зберігається в журналі
// І автоматично відправляється в 1С як результат розмови (рішення власника).
import axios from 'axios'
import { auth } from '@/api/firebase'
import type { CallNote } from '@/api/callsService'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export const callsAdminApi = {
  addNote: async (params: { kind: 'event' | 'result'; docId: string; text: string; by?: string }):
    Promise<{ ok: boolean; note?: CallNote; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/calls/note`, params, { headers: await adminHeaders(), timeout: 25000 })
      if (data?.success) return { ok: true, note: data.data.note as CallNote }
      return { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: any) {
      return { ok: false, error: e?.response?.data?.error?.message || e?.message || 'Не вдалося зберегти коментар' }
    }
  },
}

export default callsAdminApi
