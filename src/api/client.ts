import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios'
import { useBoatStore } from '@/store/boatStore'

const USE_MOCK = import.meta.env.VITE_USE_MOCK_API === 'true'
const API_BASE_URL = USE_MOCK
  ? (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001')
  : import.meta.env.VITE_API_BASE_URL || 'https://portal.runferry.com/api/hs/'

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor to add boat credentials
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const selectedBoat = useBoatStore.getState().getSelectedBoat()

    if (selectedBoat) {
      // Add boat credentials only to non-GET requests
      // For GET requests, boatId is added manually where needed (e.g., reservoirs)
      // This avoids breaking json-server filtering on endpoints like /points
      if (config.method !== 'get') {
        config.data = {
          ...config.data,
          boatId: selectedBoat.credentials.boatId,
          boatPassword: selectedBoat.credentials.boatPassword,
        }
      }
    }

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response) => {
    return response
  },
  (error) => {
    if (error.response) {
      const { status } = error.response

      if (status === 401) {
        // Boat credentials invalid - could clear them if needed
        console.error('Unauthorized - invalid credentials')
      }

      if (status === 403) {
        // Forbidden - user doesn't have access
        console.error('Access forbidden')
      }

      if (status >= 500) {
        console.error('Server error:', error.response.data)
      }
    } else if (error.request) {
      console.error('Network error:', error.message)
    }

    return Promise.reject(error)
  }
)

export default apiClient
