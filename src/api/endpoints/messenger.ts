// Ответ менеджера из инбокса — через backend: доставка клиенту в его канал (Telegram/Viber-пуш;
// web — по поллингу сессии) + возврат бота, если менеджер упомянул его в сообщении.
import axios from 'axios'
import { auth } from '@/api/firebase'
import type { ChatSession } from '@/types/chat'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export const messengerApi = {
  managerReply: async (sessionId: string, text: string): Promise<{ session: ChatSession; botReply: string | null }> => {
    const { data } = await axios.post(
      `${BACKEND_URL}/api/messenger/manager-reply`,
      { sessionId, text },
      { headers: await adminHeaders(), timeout: 30000 }
    )
    if (!data.success) throw new Error(data.error?.message || 'Не вдалося надіслати відповідь')
    return data.data
  },
}

export default messengerApi
