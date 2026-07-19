// Telegram deep-link для заявки: сервер генерує стабільне посилання t.me/<бот>?start=<токен>.
// Клієнт відкриває → бот привʼязує чат до заявки → сповіщення йдуть у Telegram (безкоштовно).
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export const telegramLinkApi = {
  create: async (serviceRequestId: string): Promise<{ ok: boolean; url?: string; connected?: boolean; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/telegram/link`, { serviceRequestId }, { headers: await adminHeaders(), timeout: 20000 })
      if (data?.success) return { ok: true, url: data.data.url, connected: !!data.data.connected }
      return { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: any) {
      return { ok: false, error: e?.response?.data?.error?.message || e?.message || 'Не вдалося створити посилання' }
    }
  },
}

export default telegramLinkApi
