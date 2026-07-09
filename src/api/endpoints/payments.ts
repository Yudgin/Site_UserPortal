// Клиент API оплат/чеков (backend server/payments.js). Оплата фактической сметы идёт через
// backend: он берёт позиции и сумму из persisted-сметы (priceEstimates) и создаёт оплату у
// нужного ФОП, а после подтверждения выбивает чек Checkbox тем же ФОП.
import axios from 'axios'
import type { LocalizedText, EstimateLineType } from '@/types/pricing'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const client = axios.create({ baseURL: BACKEND_URL, timeout: 30000 })

// Публичный ФОП (без секретов) — какие методы оплаты доступны и может ли выдавать чек
export interface FopPublic {
  id: string
  name: string
  methods: {
    liqpayCard: boolean
    liqpayPaypart: boolean
    monoChast: boolean
    monoAcquire: boolean
  }
  receipts: boolean // выбивает ли фискальные чеки (есть Checkbox)
}

export type PayMethod = 'liqpay-card' | 'liqpay-paypart' | 'liqpay-moment' | 'mono-chast'

export interface PayEstimateInput {
  estimateId: string
  fopId?: string // если не задан — берётся fopId со сметы
  method?: PayMethod
  clientPhone?: string // обязателен для mono-chast
  deliveryEmail?: string // e-mail для отправки чека
  resultUrl?: string // куда вернуть клиента после оплаты (LiqPay result_url)
  description?: string
}

export interface PayCreateResult {
  orderId: string
  provider: 'liqpay' | 'mono-chast'
  // LiqPay: данные для авто-сабмита формы Checkout
  checkoutUrl?: string
  data?: string
  signature?: string
  // monobank Частини: ответ банка
  bank?: unknown
}

export interface PayStatus {
  status: string
  receiptStatus: string | null
  taxUrl: string | null
}

// Безопасный вид сметы для клиента (без внутренней экономики/PII — приходит с backend)
export interface SafeEstimateLine {
  type: EstimateLineType
  refId: string
  name: LocalizedText
  qty: number
  unitPrice: number
  lineTotal: number
}
export interface SafeEstimate {
  id: string
  title: string
  complaint: string
  kind: 'preliminary' | 'actual'
  status: string
  total: number
  currency: string
  lines: SafeEstimateLine[]
  fopId: string | null
  parentEstimateId: string | null
  paid: boolean
  paidAt: string | null
  taxUrl: string | null
}
export interface EstimatePublic {
  estimate: SafeEstimate
  parent: SafeEstimate | null
}

interface ApiEnvelope<T> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
}

const unwrap = <T,>(env: ApiEnvelope<T>): T => {
  if (!env.success || env.data === undefined) {
    throw new Error(env.error?.message || 'Помилка запиту')
  }
  return env.data
}

export const paymentsApi = {
  // Список ФОП с доступными методами (для выбора в UI)
  listFops: async (): Promise<FopPublic[]> => {
    const { data } = await client.get<ApiEnvelope<FopPublic[]>>('/api/fops')
    return unwrap(data)
  },

  // Безопасный вид сметы для клиента (+ родительская для diff), минуя прямой доступ к Firestore
  getEstimatePublic: async (id: string): Promise<EstimatePublic> => {
    const { data } = await client.get<ApiEnvelope<EstimatePublic>>(`/api/estimates/${id}/public`)
    return unwrap(data)
  },

  // Создать оплату из фактической сметы (деньги/позиции — из persisted-сметы на сервере)
  payEstimate: async (input: PayEstimateInput): Promise<PayCreateResult> => {
    const { data } = await client.post<ApiEnvelope<PayCreateResult>>('/api/estimates/pay', input)
    return unwrap(data)
  },

  // Статус оплаты (поллинг после редиректа/оплаты)
  payStatus: async (orderId: string): Promise<PayStatus> => {
    const { data } = await client.get<ApiEnvelope<PayStatus>>('/api/pay/status', { params: { orderId } })
    return unwrap(data)
  },

  // Клиент соглашается с ростом сметы (по знанию id сметы)
  approveEstimate: async (estimateId: string): Promise<void> => {
    const { data } = await client.post<ApiEnvelope<void>>(`/api/estimates/${estimateId}/approve`)
    if (!data.success) throw new Error(data.error?.message || 'Не вдалося погодити')
  },

  // Клиент отклоняет рост сметы
  rejectEstimate: async (estimateId: string): Promise<void> => {
    const { data } = await client.post<ApiEnvelope<void>>(`/api/estimates/${estimateId}/reject`)
    if (!data.success) throw new Error(data.error?.message || 'Не вдалося відхилити')
  },
}

// Авто-сабмит формы LiqPay Checkout (POST data+signature на checkoutUrl в новой вкладке/этой же)
export const submitLiqpayCheckout = (res: PayCreateResult, target: '_self' | '_blank' = '_self'): void => {
  if (!res.checkoutUrl || !res.data || !res.signature) return
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = res.checkoutUrl
  form.target = target
  form.style.display = 'none'
  const add = (name: string, value: string) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  add('data', res.data)
  add('signature', res.signature)
  document.body.appendChild(form)
  form.submit()
  form.remove()
}

export default paymentsApi
