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
  cityRef: string | null
  warehouse: string
  warehouseRef: string | null
  lastName: string
  firstName: string
  middleName: string
}

export interface ServiceCenter {
  ID: string
  Name: string
}

export interface NewRepairRequest {
  phone_number: string
  Service: string  // Service center ID
  Disc: string     // Complaint description
  LastName: string
  FirstName: string
  MiddleName: string
  City: string      // Nova Poshta City Ref
  tWarehouse: string // Nova Poshta Warehouse Ref
}

export interface NewRepairResponse {
  ID: string
  Status: string
  LastName: number
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
      city: info.CityDescription || info.City || info.city || '',
      cityRef: info.CityRef || info.cityRef || null,
      warehouse: info.WarehouseDescription || info.tWarehouse || info.warehouse || '',
      warehouseRef: info.WarehouseRef || info.warehouseRef || null,
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
      await axios.post(`${SERVICE_API_BASE}/${requestId}/accept`, '', {
        headers: { 'Content-Type': 'text/plain' },
      })
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
      await axios.post(`${SERVICE_API_BASE}/${requestId}/select-repair`, JSON.stringify({
        optionId,
        confirmedAt,
      }), {
        headers: { 'Content-Type': 'text/plain' },
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
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/comment`, JSON.stringify({ text }), {
        headers: { 'Content-Type': 'text/plain' },
      })
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
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/question`, JSON.stringify({ text }), {
        headers: { 'Content-Type': 'text/plain' },
      })
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
      const response = await axios.post(`${SERVICE_API_BASE}/${requestId}/call-request`, JSON.stringify({
        userComment,
      }), {
        headers: { 'Content-Type': 'text/plain' },
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
      const response = await axios.post('https://portal.runferry.com/api/hs/facebook/labels', JSON.stringify({
        lang,
        keys,
      }), {
        headers: { 'Content-Type': 'text/plain' },
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

  // Get service requests list by phone number
  getRepairList: async (phone: string): Promise<ApiResponse<Array<{ id: string; Number: string; Date: string }>>> => {
    try {
      // Phone should be in format 380XXXXXXXXX (without +)
      const cleanPhone = phone.replace(/^\+/, '').replace(/\D/g, '')
      const response = await axios.post(`${SERVICE_API_BASE}/${cleanPhone}/List`, '', {
        headers: { 'Content-Type': 'text/plain' },
      })
      return {
        success: true,
        data: response.data.List || [],
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to load repair requests',
        },
      }
    }
  },

  // Update client information (recipient for return delivery)
  updateClientInfo: async (
    requestId: string,
    clientInfo: {
      LastName: string
      FirstName: string
      MiddleName: string
      City: string      // City Ref from Nova Poshta
      tWarehouse: string // Warehouse Ref from Nova Poshta
    }
  ): Promise<ApiResponse<void>> => {
    const url = `${SERVICE_API_BASE}/${requestId}/ClientInformation`
    console.log('Updating client info URL:', url)
    console.log('Updating client info body:', clientInfo)
    try {
      // Use text/plain to avoid CORS preflight (OPTIONS request)
      // Server accepts JSON body with text/plain content-type
      const response = await axios.post(url, JSON.stringify(clientInfo), {
        headers: {
          'Content-Type': 'text/plain',
        },
      })
      console.log('Update response:', response.data)
      return { success: true }
    } catch (error: any) {
      console.error('Update error:', error.response?.status, error.response?.data)
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: error.response?.data?.message || error.response?.data || 'Failed to update client information',
        },
      }
    }
  },

  // Get list of service centers
  getServiceCenters: async (): Promise<ApiResponse<ServiceCenter[]>> => {
    try {
      const response = await axios.get(`${SERVICE_API_BASE}/repair_ServoceList`)
      return {
        success: true,
        data: response.data.List || [],
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to load service centers',
        },
      }
    }
  },

  // Send SMS verification code
  sendSmsCode: async (phone: string): Promise<ApiResponse<{ code: string }>> => {
    try {
      // Phone should be in format 380XXXXXXXXX (without +)
      const cleanPhone = phone.replace(/^\+/, '').replace(/\D/g, '')
      const response = await axios.post(`${SERVICE_API_BASE}/${cleanPhone}/sendSMS`, '', {
        headers: { 'Content-Type': 'text/plain' },
      })
      return {
        success: true,
        data: { code: String(response.data.Code) },
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'SMS_FAILED',
          message: 'Failed to send SMS',
        },
      }
    }
  },

  // Create new repair request
  createRepairRequest: async (request: NewRepairRequest): Promise<ApiResponse<NewRepairResponse>> => {
    try {
      const response = await axios.post(`${SERVICE_API_BASE}/repair_NEW`, JSON.stringify(request), {
        headers: { 'Content-Type': 'text/plain' },
      })
      return {
        success: true,
        data: response.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'CREATE_FAILED',
          message: error.response?.data?.message || 'Failed to create repair request',
        },
      }
    }
  },

  // Get communication history by phone number
  getRepairHistory: async (phone: string): Promise<ApiResponse<Array<{ Desc: string; Date: string }>>> => {
    try {
      // Phone should be in format 380XXXXXXXXX (without +)
      const cleanPhone = phone.replace(/^\+/, '').replace(/\D/g, '')
      const response = await axios.post(`${SERVICE_API_BASE}/${cleanPhone}/repair_History`, '', {
        headers: { 'Content-Type': 'text/plain' },
      })
      return {
        success: true,
        data: response.data.List || [],
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to load communication history',
        },
      }
    }
  },
}
