import axios from 'axios'
import { ApiResponse } from '@/types/api'
import { auth } from '@/api/firebase'

// Backend URL (ключ Claude живёт на сервере, см. server/index.js /api/ai/improve-text)
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

// Мастер-инструменты ИИ (improve-text, pick-works, build-*) на бэкенде за админ-гейтом —
// шлём Firebase ID-токен. Публичные (estimate-chat/knowledge-chat, чат клиента) — без токена.
const adminHeaders = async (): Promise<Record<string, string>> => {
  const t = await auth?.currentUser?.getIdToken?.()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// Одна запись истории правок текста через ИИ
export interface AiHistoryEntry {
  prompt: string // что просили изменить
  resultPreview?: string // короткий фрагмент результата
  at?: string // ISO-дата
}

// Тип текста — задаёт контекст для ИИ (соглашение, диагностика, статья базы знаний и т.д.)
export type AiTextContext = 'terms' | 'diagnostics' | 'knowledge' | 'generic'

export interface ImproveTextParams {
  currentText: string
  userPrompt: string
  history?: AiHistoryEntry[]
  context?: AiTextContext
  lang?: string
}

// Использование токенов и стоимость одного AI-вызова
export interface AiUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

// Сообщение диалога, передаваемое ИИ-консультанту (внутренние заметки не отправляются)
export interface ChatMsgInput {
  role: 'client' | 'ai' | 'manager'
  text: string
  internal?: boolean
}

export interface EstimateChatParams {
  messages: ChatMsgInput[]
  priceContext?: string // компактный прайс для контекста оценки
  knowledgeContext?: string // выжимка базы знаний (самопомощь — предлагать бесплатное решение первым)
  corrections?: string[] // активные правки поведения ИИ (scope estimate/all)
}

export interface KnowledgeChatParams {
  messages: ChatMsgInput[]
  knowledgeContext?: string // выжимка базы знаний
  corrections?: string[] // активные правки поведения ИИ
}

// ==== AI-конструктор услуг прайса ====
export interface AiBuiltMaterial {
  code: string
  name: string
  unit: string
  price: number
}
export interface AiBuiltWork {
  code: string
  name: string
  categoryId: string
  laborHours: number
  dedupe: 'once' | 'perComplaint'
  materials: { materialCode: string; qty: number }[]
  reused: boolean // true — существующая работа (code из каталога), не создавать заново
}
export interface AiBuiltKit {
  code: string
  name: string
  serviceKind: 'repair' | 'upgrade'
  items: { workCode: string; qty: number }[]
}
export interface BuildPricingResult {
  summary: string
  materials: AiBuiltMaterial[]
  works: AiBuiltWork[]
  kit: AiBuiltKit
  usage?: AiUsage
}
export interface BuildPricingParams {
  instruction: string
  catalogContext?: string
  laborRate?: number
}

// ==== AI-генератор шаблона жалобы из описания ремонта ====
export interface AiBuiltComplaint {
  symptom: string
  keywords: string[]
  diagnosticWorkCodes: string[]
  variants: { label: string; severity: 'best' | 'likely' | 'worst'; workCodes: string[] }[]
  usage?: AiUsage
}
export interface BuildComplaintParams {
  description: string
  catalogContext?: string
}

export const aiApi = {
  // Улучшить/переписать текст по промпту с учётом истории правок
  improveText: async (params: ImproveTextParams): Promise<ApiResponse<{ text: string; usage?: AiUsage }>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/improve-text`, params, { headers: await adminHeaders() })
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося обробити запит ІІ',
        },
      }
    }
  },

  // Диалоговая оценка стоимости. Возвращает ответ, флаг эскалации, признак предложения
  // самостоятельного ремонта (нужны комплектующие), статус гарантии и список
  // рекомендованных комплектующих (когда предложен самостоятельный ремонт).
  estimateChat: async (
    params: EstimateChatParams
  ): Promise<ApiResponse<{ reply: string; needsManager: boolean; offeredSelfRepair: boolean; warranty: 'yes' | 'no' | 'unknown'; parts: { name: string; qty: number }[]; estimate: { lines: { label: string; price: number; workCode?: string }[]; total: number }; usage?: AiUsage }>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/estimate-chat`, params)
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося обробити запит ІІ',
        },
      }
    }
  },

  // Консультация по эксплуатации / самопомощь на основе базы знаний
  knowledgeChat: async (
    params: KnowledgeChatParams
  ): Promise<ApiResponse<{ reply: string; needsManager: boolean; offeredSelfHelp: boolean; usage?: AiUsage }>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/knowledge-chat`, params)
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося обробити запит ІІ',
        },
      }
    }
  },

  // AI-подбор позиций прайса для мастера: описание словами → список workCode+qty из прайса
  pickWorks: async (
    params: { description: string; priceContext?: string; knowledgeContext?: string }
  ): Promise<ApiResponse<{ works: { workCode: string; qty: number; name: string }[]; note: string; usage?: AiUsage }>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/pick-works`, params, { headers: await adminHeaders() })
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося підібрати позиції',
        },
      }
    }
  },

  // AI-конструктор услуги: описание словами → структура работ/материалов/набора
  buildPricing: async (params: BuildPricingParams): Promise<ApiResponse<BuildPricingResult>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/build-pricing`, params, { headers: await adminHeaders() })
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося сформувати послугу',
        },
      }
    }
  },

  // AI-генератор шаблона жалобы: описание выполненного ремонта → симптом + диагностика + варианты
  buildComplaint: async (params: BuildComplaintParams): Promise<ApiResponse<AiBuiltComplaint>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/ai/build-complaint`, params, { headers: await adminHeaders() })
      return { success: true, data: response.data.data }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'AI_ERROR',
          message: error.response?.data?.error?.message || 'Не вдалося сформувати шаблон',
        },
      }
    }
  },
}

export default aiApi
