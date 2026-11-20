// Приглашение в чат с ИИ по теме (server/chatInvites.js): сотрудник создаёт ссылку /c/<id>, сервер переводит тему
// на украинский, готовит первое сообщение ИИ (вопросы по теме) и шлёт SMS. create/get — персонал (Firebase ID-токен);
// open — публично (отметка «відкрито»).
import axios from 'axios'
import { auth } from '@/api/firebase'
import { secureId } from '@/utils/id'
import type { ChatInviteMode, ChatInviteRecord, ChatInviteSource } from '@/types/chat'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const staffHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface CreateChatInviteParams {
  topic: string // видна клиенту (SMS, шапка чата), 3–80 символов; сервер переведёт на українську (см. topicConfirmed)
  topicConfirmed?: boolean // сотрудник видел итоговую тему (dryRun) — сервер её не переписывает, но требует українську
  topicInput?: string // при topicConfirmed — как тему написал сотрудник до перевода (сохраняется для разбора)
  details?: string // что уже известно / какие бывают варианты — для ИИ (клиенту не показываем, но ИИ может пересказать), до 2000
  phone?: string // при deliver='sms' обязателен (или берётся из заявки serviceRequestId)
  name?: string
  mode?: ChatInviteMode // по умолчанию 'knowledge' (база знаний)
  deliver?: 'sms' | 'none' // 'none' — без SMS, ссылку доставляет вызывающий (бот, мессенджер, копирование)
  serviceRequestId?: string // привязка к заявке (SMS попадёт в журнал оповещений заявки)
  source?: ChatInviteSource
  clientKey?: string // идемпотентность: повтор с тем же ключом не создаёт второе приглашение (и дошлёт SMS)
  dryRun?: boolean // только показать итоговую тему и текст SMS, ничего не создавая
}

export type ChatInviteResult = ChatInviteRecord & { created: boolean }

// Ответ dryRun: итоговая тема (после перевода) и текст SMS (ссылка в нём — заглушка той же длины).
export interface ChatInvitePreview {
  dryRun: true
  topic: string
  topicChanged: boolean
  phone: string | null
  deliver: 'sms' | 'none'
  smsText: string | null
  smsSegments: number
}

type Res<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

const failure = (e: unknown, fallback: string): { ok: false; error: string; code?: string } => {
  const err = e as { response?: { data?: { error?: { message?: string; code?: string } } }; message?: string }
  return { ok: false, error: err?.response?.data?.error?.message || err?.message || fallback, code: err?.response?.data?.error?.code }
}

export const newInviteClientKey = (): string => `inv-${secureId(20)}`

export const chatInviteApi = {
  create: async (params: CreateChatInviteParams): Promise<Res<ChatInviteResult>> => {
    try {
      // Сервер готовит первое сообщение ИИ (до ~30 с) и шлёт SMS — ждём с запасом; повтор с тем же clientKey безопасен.
      const { data } = await axios.post(`${BACKEND_URL}/api/chat-invites`, params, { headers: await staffHeaders(), timeout: 90000 })
      return data?.success ? { ok: true, data: data.data as ChatInviteResult } : { ok: false, error: data?.error?.message || 'Помилка', code: data?.error?.code }
    } catch (e) {
      return failure(e, 'Не вдалося створити запрошення')
    }
  },

  preview: async (params: CreateChatInviteParams): Promise<Res<ChatInvitePreview>> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/chat-invites`, { ...params, dryRun: true }, { headers: await staffHeaders(), timeout: 45000 })
      return data?.success ? { ok: true, data: data.data as ChatInvitePreview } : { ok: false, error: data?.error?.message || 'Помилка', code: data?.error?.code }
    } catch (e) {
      return failure(e, 'Не вдалося перевірити запрошення')
    }
  },

  get: async (sessionId: string): Promise<Res<ChatInviteRecord>> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/chat-invites/get`, { sessionId }, { headers: await staffHeaders(), timeout: 20000 })
      return data?.success ? { ok: true, data: data.data as ChatInviteRecord } : { ok: false, error: data?.error?.message || 'Помилка' }
    } catch (e) {
      return failure(e, 'Не вдалося отримати запрошення')
    }
  },

  // Клиент открыл ссылку: отметка «відкрито» для пригласившего (ошибка не мешает чату). Если вошёл сотрудник —
  // шлём его токен: сервер не засчитает его просмотр как открытие клиентом.
  open: async (sessionId: string): Promise<boolean> => {
    try {
      const { data } = await axios.post(`${BACKEND_URL}/api/chat-invites/open`, { sessionId }, { headers: await staffHeaders(), timeout: 15000 })
      return !!data?.success
    } catch {
      return false
    }
  },
}

export default chatInviteApi
