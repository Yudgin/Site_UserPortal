import axios from 'axios'
import { ApiResponse } from '@/types/api'

// Service repair API - uses the real API at portal.runferry.com
const SERVICE_API_BASE = 'https://portal.runferry.com/api/hs/facebook/repair'

export interface StatusHistoryItem {
  date: string
  status: string
  comment?: string
}

export interface RepairOption {
  id: string
  description: string
  price: number
}

export interface CommentItem {
  date: string
  text: string
  author?: string
}

export interface QuestionItem {
  question: string
  questionDate: string
  answer: string | null
  answerDate: string | null
}

export interface CallRequestItem {
  date: string
  userComment: string
  managerComment?: string
}

export interface InvoiceItem {
  description: string
  price: number
}

export interface ClientInfo {
  city: string
  warehouse: string
  lastName: string
  firstName: string
  middleName: string
}

export interface ServiceRequestData {
  requestId: string
  clientInfo: ClientInfo | null
  clientAcceptedTerms: {
    accepted: boolean
    acceptedAt: string | null
  }
  shipment: {
    ttn: string | null
    statusHistory: StatusHistoryItem[]
  }
  complaint: string
  repairOptions: RepairOption[]
  selectedRepairOptionId: string | null
  selectedRepairConfirmedAt: string | null
  comments: CommentItem[]
  questions: QuestionItem[]
  callRequests: CallRequestItem[]
  finalInvoice: InvoiceItem[]
  finalPrice: number | null
  paymentStatus: boolean | string
  monopayUrl: string | null
  returnTtn: string | null
  returnTtnHistory: StatusHistoryItem[]
}

// Helper to normalize API response
const normalizeResponse = (raw: any): ServiceRequestData => {
  console.log('Raw API response:', JSON.stringify(raw, null, 2))

  // Normalize status history items (timestamp -> date)
  const normalizeStatusHistory = (history: any[]): StatusHistoryItem[] => {
    if (!Array.isArray(history)) return []
    return history.map(item => ({
      date: item.date || item.timestamp || '',
      status: item.status || '',
      comment: item.comment,
    }))
  }

  // Normalize client info
  const normalizeClientInfo = (info: any): ClientInfo | null => {
    if (!info) return null
    return {
      city: info.City || info.city || '',
      warehouse: info.tWarehouse || info.warehouse || '',
      lastName: info.LastName || info.lastName || '',
      firstName: info.FirstName || info.firstName || '',
      middleName: info.MiddleName || info.middleName || '',
    }
  }

  return {
    requestId: raw.requestId || raw.FixNumber || raw.request_id || '',
    clientInfo: normalizeClientInfo(raw.ClientInfo || raw.clientInfo),
    clientAcceptedTerms: {
      accepted: raw.clientAcceptedTerms?.accepted ?? raw.agreement_at != null,
      acceptedAt: raw.clientAcceptedTerms?.acceptedAt || raw.agreement_at || null,
    },
    shipment: {
      ttn: raw.shipment?.ttn?.toString() || raw.TrackToFix?.toString() || null,
      statusHistory: normalizeStatusHistory(raw.shipment?.statusHistory || raw.status_history || []),
    },
    complaint: raw.complaint || raw.preinspection || '',
    repairOptions: raw.repairOptions || raw.repair_options || [],
    selectedRepairOptionId: raw.selectedRepairOptionId || raw.selected_option?.id || null,
    selectedRepairConfirmedAt: raw.selectedRepairConfirmedAt || raw.selected_option?.selected_at || null,
    comments: raw.comments || raw.Comunacation || [],
    questions: raw.questions || [],
    callRequests: raw.callRequests || raw.call_requests || [],
    finalInvoice: Array.isArray(raw.finalInvoice) ? raw.finalInvoice : [],
    finalPrice: raw.finalPrice ?? raw.final_price ?? null,
    paymentStatus: raw.paymentStatus ?? raw.payment_status ?? false,
    monopayUrl: raw.monopayUrl || raw.monopay_url || null,
    returnTtn: raw.returnTtn?.toString() || raw.TrackToClient?.toString() || null,
    returnTtnHistory: normalizeStatusHistory(raw.returnTtnHistory || raw.return_ttn_history || []),
  }
}

export const serviceApi = {
  // Get service request data by ID
  getRequest: async (requestId: string): Promise<ApiResponse<ServiceRequestData>> => {
    try {
      const response = await axios.get(`${SERVICE_API_BASE}/${requestId}`)
      return {
        success: true,
        data: normalizeResponse(response.data),
      }
    } catch (error: any) {
      const status = error.response?.status
      let message = 'Failed to load service request'

      if (status === 404) {
        message = 'Service request not found'
      } else if (status === 403) {
        message = 'Access denied'
      } else if (status === 500) {
        message = 'Server error. Please try again later'
      }

      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message,
        },
      }
    }
  },

  // Accept terms
  acceptTerms: async (requestId: string): Promise<ApiResponse<void>> => {
    try {
      await axios.post(`${SERVICE_API_BASE}/${requestId}/accept`)
      return { success: true }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'ACCEPT_FAILED',
          message: error.response?.data?.message || 'Failed to accept terms',
        },
      }
    }
  },

  // Select repair option
  selectRepairOption: async (
    requestId: string,
    optionId: string,
    confirmedAt: string
  ): Promise<ApiResponse<void>> => {
    try {
      await axios.post(`${SERVICE_API_BASE}/${requestId}/select-repair`, {
        optionId,
        confirmedAt,
      })
      return { success: true }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'SELECT_FAILED',
          message: error.response?.data?.message || 'Failed to select repair option',
        },
      }
    }
  },

  // Add comment
  addComment: async (requestId: string, text: string): Promise<ApiResponse<{ comments: CommentItem[] }>> => {
    try {
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/comment`, { text })
      return {
        success: true,
        data: response.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'COMMENT_FAILED',
          message: error.response?.data?.message || 'Failed to add comment',
        },
      }
    }
  },

  // Add question
  addQuestion: async (requestId: string, text: string): Promise<ApiResponse<{ questions: QuestionItem[] }>> => {
    try {
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/question`, { text })
      return {
        success: true,
        data: response.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'QUESTION_FAILED',
          message: error.response?.data?.message || 'Failed to send question',
        },
      }
    }
  },

  // Request callback
  requestCall: async (
    requestId: string,
    userComment: string
  ): Promise<ApiResponse<{ callRequests: CallRequestItem[] }>> => {
    try {
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/call-request`, {
        userComment,
      })
      return {
        success: true,
        data: response.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'CALL_REQUEST_FAILED',
          message: error.response?.data?.message || 'Failed to request callback',
        },
      }
    }
  },

  // Get labels for localization
  getLabels: async (lang: string, keys: string[]): Promise<ApiResponse<Record<string, string>>> => {
    try {
      const response = await axios.post('https://portal.runferry.com/api/hs/facebook/labels', {
        lang,
        keys,
      })

      const labels: Record<string, string> = {}
      for (const item of response.data) {
        labels[item.key] = item.text
      }

      return {
        success: true,
        data: labels,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'LABELS_FAILED',
          message: 'Failed to load labels',
        },
      }
    }
  },

  // Get service requests by phone number
  getRequestsByPhone: async (phone: string): Promise<ApiResponse<{ requests: Array<{ id: string; status: string; date: string }> }>> => {
    try {
      const response = await axios.get(`https://portal.runferry.com/api/hs/facebook/repair/by-phone`, {
        params: { phone },
      })
      return {
        success: true,
        data: response.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to load service requests',
        },
      }
    }
  },
}
