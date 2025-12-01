import apiClient from '../client'
import { ApiResponse, BoatVerifyRequest, BoatVerifyResponse } from '@/types/api'
import { DistributorBoat } from '@/types/models'

export const boatsApi = {
  // Verify boat credentials
  verify: async (data: BoatVerifyRequest): Promise<ApiResponse<BoatVerifyResponse>> => {
    try {
      // For mock server, we need to find the boat and check password
      const response = await apiClient.get('/boats', {
        params: { id: data.boatId }
      })

      const boats = response.data
      const boat = Array.isArray(boats) ? boats.find((b: { id: string }) => b.id === data.boatId) : null

      if (boat && boat.password === data.password) {
        return {
          success: true,
          data: {
            valid: true,
            boatInfo: {
              id: boat.id,
              name: boat.name,
              firmware: boat.firmware,
            },
          },
        }
      }

      return {
        success: true,
        data: {
          valid: false,
        },
      }
    } catch (error) {
      console.error('Boat verification failed:', error)
      throw error // Re-throw to show network error in UI
    }
  },

  // Get boats available to distributor
  getDistributorBoats: async (distributorId: string): Promise<ApiResponse<DistributorBoat[]>> => {
    try {
      const response = await apiClient.get('/distributorBoats', {
        params: { distributorId }
      })

      const boats = Array.isArray(response.data)
        ? response.data.filter((b: DistributorBoat) => b.distributorId === distributorId)
        : []

      return {
        success: true,
        data: boats,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch distributor boats',
        },
      }
    }
  },
}
