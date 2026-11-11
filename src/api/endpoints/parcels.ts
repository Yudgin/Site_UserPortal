// Журнал відправлень «Посилки» (§36): Нова Пошта по всіх ФОП і особистих акаунтах, ручні записи
// (самовивіз, автобус, інше), реєстр передач водієві. Усе через сервер (server/parcels.js) — колекції
// Firestore закриті для браузера. Ключі НП write-only: сервер віддає лише «задано / не задано».
import axios from 'axios'
import { auth } from '@/api/firebase'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'
const headers = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}
const errText = (e: unknown, fallback: string): string => {
  const m = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
  return m || fallback
}

export type ParcelMethod = 'np' | 'pickup' | 'bus' | 'other'
export type ParcelGroup = 'draft' | 'transit' | 'arrived' | 'received' | 'problem' | 'deleted' | 'other'
export type ParcelDirection = 'in' | 'out'
export type ParcelAttention = 'problem' | 'waiting' | 'storage' | 'autoReturn' | 'driver'
export type Currency = 'EUR' | 'UAH' | 'PLN' | 'USD'

export interface ParcelParty { name?: string; company?: string; phone?: string; city?: string; address?: string }
export interface ParcelLink { kind: 'return' | 'incoming' | 'order' | 'manual'; serviceRequestId: string | null; boatOrderId: string | null; serviceCenterId: string | null; title?: string }
export type PaidMethod = 'cash' | 'card' | 'transfer' | 'other'
export interface ParcelTransferRef { id: string; date: string; driver: string; share: number; currency: Currency; paid?: boolean }

export interface Parcel {
  id: string
  number: string
  method: ParcelMethod
  manual?: boolean
  directions: ParcelDirection[]
  accountIds: string[]
  fopId: string | null
  private: boolean
  selfSender?: boolean // відправник у накладній — теж ми (клієнт здає кораблик за нашою накладною)
  group: ParcelGroup
  statusCode: string
  statusName: string
  final: boolean
  createdAt?: string | null
  sortAt?: string | null
  scheduledAt?: string | null
  arrivedAt?: string | null
  receivedAt?: string | null
  statusAt?: string | null
  autoReturnAt?: string | null
  storageFrom?: string | null // перший день платного зберігання (РРРР-ММ-ДД)
  sender?: ParcelParty
  recipient?: ParcelParty
  description?: string
  declaredCost?: number
  deliveryCost?: number // вартість доставки НП, грн
  cod?: number // накладений платіж, грн
  payer?: string
  paymentMethod?: string
  payStatus?: string
  weight?: number
  seats?: number
  serviceType?: string
  can?: { redirect?: boolean; changeEW?: boolean; return?: boolean; extend?: boolean; refuse?: boolean; trustee?: boolean }
  sources?: string[]
  link: ParcelLink | null
  transfer: ParcelTransferRef | null
  extraCost?: { amount: number; currency: Currency } | null // ручний запис: вартість передачі
  note?: string
  history?: { at: string; code: string; name: string }[]
  attention: ParcelAttention[]
  firstSeenAt?: string
  updatedAt?: string
}

export interface ParcelAccountBrief { id: string; name: string; kind: 'fop' | 'personal'; private: boolean }
export interface ParcelsList { items: Parcel[]; days: number; accounts: ParcelAccountBrief[]; owner: boolean }

export interface ManualParcelPayload {
  method: Exclude<ParcelMethod, 'np'>
  direction: ParcelDirection
  date: string
  group: 'draft' | 'transit' | 'received' | 'problem'
  number?: string
  description?: string
  counterparty: ParcelParty
  declaredCost?: number | string
  cod?: number | string
  cost?: { amount: number | string; currency: Currency }
  note?: string
  serviceRequestId?: string
  private?: boolean
}

export interface ParcelTransfer {
  id: string
  date: string
  driver: string
  driverPhone?: string
  route?: string
  cost: number
  currency: Currency
  parcelIds: string[]
  shares: Record<string, number>
  note?: string
  done: boolean
  paid?: boolean // водієві заплачено (лише позначка: гроші портал не надсилає)
  paidAt?: string | null // день оплати, РРРР-ММ-ДД
  paidMethod?: PaidMethod | null
}
export type ParcelTransferPayload = Omit<ParcelTransfer, 'id' | 'shares'>

export interface NpAccount {
  id: string
  kind: 'fop' | 'personal'
  name: string
  private: boolean
  active: boolean
  keySet: boolean
  lastSyncAt: string | null
  lastOkAt: string | null
  lastError: string | null
  counts: { listed: number; out: number; inc: number; tracked: number; written: number; created: number } | null
  phones: string[]
  backfilledAt: string | null
}
export interface NpProbe { ok: boolean; count: number; error?: string }
export interface NpKeyCheck { list: NpProbe; outgoing: NpProbe; incoming: NpProbe; phone: string }
export interface SyncSummary { accounts: { accounts: string[]; listed: number; out: number; inc: number; tracked: number; written: number; created: number; ok: boolean; error: string | null }[] }

type Res<T> = { ok: true; data: T } | { ok: false; error: string }
const run = async <T,>(fn: () => Promise<{ data: { success?: boolean; data?: T; error?: { message?: string } } }>, fallback: string): Promise<Res<T>> => {
  try {
    const { data } = await fn()
    return data?.success ? { ok: true, data: data.data as T } : { ok: false, error: data?.error?.message || fallback }
  } catch (e) {
    return { ok: false, error: errText(e, fallback) }
  }
}

export const parcelsApi = {
  list: async (days: number) => run<ParcelsList>(async () => axios.get(`${BACKEND_URL}/api/parcels`, { params: { days }, headers: await headers() }), 'Не вдалося завантажити журнал'),
  sync: async (accountId?: string) => run<SyncSummary>(async () => axios.post(`${BACKEND_URL}/api/parcels/sync`, accountId ? { accountId } : {}, { headers: await headers(), timeout: 180000 }), 'Не вдалося синхронізувати'),

  createManual: async (p: ManualParcelPayload) => run<Parcel>(async () => axios.post(`${BACKEND_URL}/api/parcels/manual`, p, { headers: await headers() }), 'Не вдалося зберегти запис'),
  updateManual: async (id: string, p: ManualParcelPayload) => run<Parcel>(async () => axios.put(`${BACKEND_URL}/api/parcels/manual/${encodeURIComponent(id)}`, p, { headers: await headers() }), 'Не вдалося зберегти запис'),
  removeManual: async (id: string) => run<void>(async () => axios.delete(`${BACKEND_URL}/api/parcels/manual/${encodeURIComponent(id)}`, { headers: await headers() }), 'Не вдалося видалити запис'),
  setMeta: async (id: string, p: { note?: string; serviceRequestId?: string }) => run<Parcel>(async () => axios.put(`${BACKEND_URL}/api/parcels/${encodeURIComponent(id)}/meta`, p, { headers: await headers() }), 'Не вдалося зберегти'),

  transfers: async () => run<ParcelTransfer[]>(async () => axios.get(`${BACKEND_URL}/api/parcels/transfers`, { headers: await headers() }), 'Не вдалося завантажити передачі'),
  saveTransfer: async (id: string | null, p: ParcelTransferPayload) => run<ParcelTransfer>(async () => axios.put(`${BACKEND_URL}/api/parcels/transfers/${encodeURIComponent(id || 'new')}`, p, { headers: await headers() }), 'Не вдалося зберегти передачу'),
  removeTransfer: async (id: string) => run<void>(async () => axios.delete(`${BACKEND_URL}/api/parcels/transfers/${encodeURIComponent(id)}`, { headers: await headers() }), 'Не вдалося видалити передачу'),

  settings: async () => run<{ ownPhones: string[]; fromTemplates: string[] }>(async () => axios.get(`${BACKEND_URL}/api/parcels/settings`, { headers: await headers() }), 'Не вдалося завантажити налаштування'),
  saveSettings: async (ownPhones: string[]) => run<{ ownPhones: string[]; recalculated: { checked: number; changed: number } }>(async () => axios.put(`${BACKEND_URL}/api/parcels/settings`, { ownPhones }, { headers: await headers() }), 'Не вдалося зберегти'),
  accounts: async () => run<NpAccount[]>(async () => axios.get(`${BACKEND_URL}/api/parcels/accounts`, { headers: await headers() }), 'Не вдалося завантажити акаунти'),
  saveAccount: async (id: string, p: { name: string; active: boolean; private: boolean; apiKey?: string }) => run<{ id: string }>(async () => axios.put(`${BACKEND_URL}/api/parcels/accounts/${encodeURIComponent(id)}`, p, { headers: await headers() }), 'Не вдалося зберегти акаунт'),
  removeAccount: async (id: string) => run<void>(async () => axios.delete(`${BACKEND_URL}/api/parcels/accounts/${encodeURIComponent(id)}`, { headers: await headers() }), 'Не вдалося видалити акаунт'),
  checkAccount: async (id: string, apiKey?: string) => run<NpKeyCheck>(async () => axios.post(`${BACKEND_URL}/api/parcels/accounts/${encodeURIComponent(id)}/check`, apiKey ? { apiKey } : {}, { headers: await headers(), timeout: 60000 }), 'Не вдалося перевірити ключ'),
}

export default parcelsApi
