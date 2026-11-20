// Telegram-бот СПІВРОБІТНИКІВ по заявках: сервер видає одноразове посилання t.me/<бот>?start=<токен>
// (діє 30 хв), бот привʼязує Telegram до профілю users/{uid}. Далі співробітник пише боту
// «знайди заявку 067…», «включи туди доставку 560 грн» — зміни підтверджуються кнопкою.
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export const staffBotApi = {
  link: async (): Promise<{ ok: boolean; url?: string; connected?: boolean; error?: string }> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/staff-bot/link`, {}, { headers: await adminHeaders(), timeout: 20000 })
      if (data?.success) return { ok: true, url: data.data.url, connected: !!data.data.connected }
      return { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e: any) {
      return { ok: false, error: e?.response?.data?.error?.message || e?.message || 'Не вдалося створити посилання' }
    }
  },
}

export default staffBotApi
