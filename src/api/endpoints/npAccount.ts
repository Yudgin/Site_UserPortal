// Справочники Новой Почты в разрезе ФОП (владелец): тянем отправителей/контакты по ключу этого
// ФОП, чтобы выбирать из списка вместо ручного ввода Ref, и создаём нового отправителя/контакт.
// Ключ НП по умолчанию берётся сохранённый; можно передать только что введённый (ещё не сохранён).
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// Сырые записи НП (берём только нужные поля).
export interface NpSender {
  Ref: string
  Description: string
  EDRPOU?: string
  CityDescription?: string
  CounterpartyType?: string
  FirstName?: string
  LastName?: string
}
export interface NpContact {
  Ref: string
  Description: string
  Phones?: string
  FirstName?: string
  LastName?: string
}

export interface NpAccountResult<T> {
  ok: boolean
  data?: T
  error?: string
  npErrors?: string[]
}

const post = async <T>(id: string, path: string, body: Record<string, unknown>): Promise<NpAccountResult<T>> => {
  try {
    const { data } = await axios.post(`${BACKEND_URL}/api/fops/admin/${encodeURIComponent(id)}/np/${path}`, body, {
      headers: await adminHeaders(), timeout: 25000,
    })
    if (data?.success) return { ok: true, data: data.data as T }
    return { ok: false, error: data?.error?.message || 'Помилка', npErrors: data?.error?.npErrors }
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: { message?: string; npErrors?: string[] } } } }
    const d = err.response?.data?.error
    return { ok: false, error: d?.message || 'Помилка запиту до НП', npErrors: d?.npErrors }
  }
}

export const npAccountApi = {
  // apiKey — необязательный «свежий» ключ из формы (если ФОП ещё не сохранён с ключом).
  senders: (id: string, apiKey?: string) => post<NpSender[]>(id, 'senders', { apiKey }),
  contacts: (id: string, ref: string, apiKey?: string) => post<NpContact[]>(id, 'contacts', { ref, apiKey }),
  addSender: (id: string, body: { type: 'org' | 'person'; edrpou?: string; firstName?: string; lastName?: string; middleName?: string; phone?: string; cityRef?: string }, apiKey?: string) =>
    post<NpSender[]>(id, 'add-sender', { ...body, apiKey }),
  addContact: (id: string, body: { ref: string; firstName: string; lastName: string; middleName?: string; phone?: string }, apiKey?: string) =>
    post<NpContact[]>(id, 'add-contact', { ...body, apiKey }),
}

export default npAccountApi
