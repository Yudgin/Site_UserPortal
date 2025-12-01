import axios from 'axios'
import { BoatSettingGroup } from '@/types/models'
import { ApiResponse } from '@/types/api'

// Backend API URL
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

// Клиент для работы с нашим backend
const backendClient = axios.create({
  baseURL: BACKEND_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

export interface GetSettingsParams {
  localization?: string
  email?: string
  chipId: string
  chipType?: string
}

export const settingsApi = {
  // Get all settings schema (parameter definitions)
  getSettingsSchema: async (params: GetSettingsParams): Promise<ApiResponse<BoatSettingGroup[]>> => {
    try {
      const response = await backendClient.get('/api/settings/schema', {
        params: {
          localization: params.localization || 'en_US',
          email: params.email || '',
          chipId: params.chipId,
          chipType: params.chipType || 'chip_type',
        },
      })

      if (response.data.success && Array.isArray(response.data.data)) {
        return {
          success: true,
          data: response.data.data,
        }
      }

      return {
        success: false,
        error: response.data.error || {
          code: 'INVALID_RESPONSE',
          message: 'Invalid response format from settings API',
        },
      }
    } catch (error) {
      console.error('Settings API error:', error)
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch settings schema',
        },
      }
    }
  },

  // Get current settings values for a boat
  getSettingsValues: async (boatId: string): Promise<ApiResponse<Record<number, number>>> => {
    try {
      const response = await backendClient.get(`/api/settings/values/${boatId}`)

      if (response.data.success) {
        return {
          success: true,
          data: response.data.data || {},
        }
      }

      return {
        success: false,
        error: response.data.error,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch settings values',
        },
      }
    }
  },

  // Update a setting value
  updateSetting: async (
    boatId: string,
    settingId: number,
    value: number
  ): Promise<ApiResponse<void>> => {
    try {
      const response = await backendClient.put(`/api/settings/${boatId}/${settingId}`, { value })

      if (response.data.success) {
        return { success: true }
      }

      return {
        success: false,
        error: response.data.error,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: 'Failed to update setting',
        },
      }
    }
  },
}
