import axios from 'axios'
import { ApiResponse } from '@/types/api'

// Backend URL for SMS API
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

// Format phone number to international format (380XXXXXXXXX)
const formatPhoneNumber = (phone: string): string => {
  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '')

  // Handle different formats
  if (cleaned.startsWith('0')) {
    // Ukrainian local format: 0XX XXX XX XX
    cleaned = '38' + cleaned
  } else if (cleaned.startsWith('8') && cleaned.length === 10) {
    // Old format without country code
    cleaned = '38' + cleaned
  } else if (!cleaned.startsWith('380')) {
    // If doesn't start with 380, assume it needs it
    if (cleaned.length === 9) {
      cleaned = '380' + cleaned
    }
  }

  return cleaned
}

// Validate Ukrainian phone number
const isValidUkrainianPhone = (phone: string): boolean => {
  const formatted = formatPhoneNumber(phone)
  // Ukrainian mobile numbers: 380 + 9 digits (operator code + number)
  return /^380\d{9}$/.test(formatted)
}

export interface SendSmsResponse {
  success: boolean
  messageId?: string
}

export interface VerifyCodeResponse {
  success: boolean
  verified: boolean
}

export const smsApi = {
  // Send verification code via SMS
  sendVerificationCode: async (phone: string): Promise<ApiResponse<SendSmsResponse>> => {
    // Validate phone number
    if (!isValidUkrainianPhone(phone)) {
      return {
        success: false,
        error: {
          code: 'INVALID_PHONE',
          message: 'Invalid Ukrainian phone number format',
        },
      }
    }

    try {
      const response = await axios.post(`${BACKEND_URL}/api/sms/send-code`, {
        phone: formatPhoneNumber(phone),
      })

      return {
        success: true,
        data: response.data.data,
      }
    } catch (error: any) {
      console.error('SMS send error:', error.response?.data || error.message)
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'SMS_ERROR',
          message: error.response?.data?.error?.message || 'Failed to send SMS',
        },
      }
    }
  },

  // Verify the code entered by user
  verifyCode: async (phone: string, code: string): Promise<ApiResponse<VerifyCodeResponse>> => {
    try {
      const response = await axios.post(`${BACKEND_URL}/api/sms/verify-code`, {
        phone: formatPhoneNumber(phone),
        code,
      })

      return {
        success: true,
        data: response.data.data,
      }
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: error.response?.data?.error?.code || 'VERIFY_ERROR',
          message: error.response?.data?.error?.message || 'Failed to verify code',
        },
      }
    }
  },

  // Helper to format phone for display
  formatForDisplay: (phone: string): string => {
    const formatted = formatPhoneNumber(phone)
    if (formatted.length === 12) {
      return `+${formatted.slice(0, 3)} ${formatted.slice(3, 5)} ${formatted.slice(5, 8)} ${formatted.slice(8, 10)} ${formatted.slice(10)}`
    }
    return phone
  },

  // Validate phone number
  isValidPhone: isValidUkrainianPhone,

  // Format phone number
  formatPhone: formatPhoneNumber,
}
