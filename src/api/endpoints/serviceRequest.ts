// Публичное создание НАШЕЙ локальной заявки на обслуживание (backend пишет через admin SDK,
// поля контролирует сервер). Вызывается из клиентской формы /repair/new в дополнение к 1С.
import axios from 'axios'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

export interface CreateLocalRequestInput {
  sessionId?: string | null
  externalRequestId?: string | null
  clientName?: string
  clientPhone?: string
  clientCityRef?: string
  clientCityName?: string
  clientWarehouseRef?: string
  clientWarehouseName?: string
  boat?: string
  complaint?: string
}

export const serviceRequestApi = {
  createLocal: async (data: CreateLocalRequestInput): Promise<{ id: string } | null> => {
    try {
      const { data: res } = await axios.post(`${BACKEND_URL}/api/service-requests`, data, { timeout: 20000 })
      return res.success ? res.data : null
    } catch (error) {
      console.error('createLocal service request:', error)
      return null
    }
  },
}

export default serviceRequestApi
