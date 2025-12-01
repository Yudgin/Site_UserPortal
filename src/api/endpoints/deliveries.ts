import apiClient from '../client'
import { Delivery } from '@/types/models'
import { ApiResponse } from '@/types/api'

export const deliveriesApi = {
  // Get deliveries for a point
  getByPoint: async (pointId: string): Promise<ApiResponse<{ deliveries: Delivery[] }>> => {
    try {
      const response = await apiClient.get('/deliveries', {
        params: { pointId }
      })

      const deliveries = Array.isArray(response.data)
        ? response.data.filter((d: Delivery) => d.pointId === pointId)
        : []

      // Sort by timestamp descending (newest first)
      deliveries.sort((a: Delivery, b: Delivery) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )

      return {
        success: true,
        data: { deliveries },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch deliveries',
        },
      }
    }
  },

  // Get all deliveries for a reservoir (all points)
  getByReservoir: async (reservoirId: string): Promise<ApiResponse<{ deliveries: Delivery[] }>> => {
    try {
      // First get all points for the reservoir
      const pointsResponse = await apiClient.get('/points', {
        params: { reservoirId }
      })

      const points = Array.isArray(pointsResponse.data)
        ? pointsResponse.data.filter((p: { reservoirId: string }) => p.reservoirId === reservoirId)
        : []

      const pointIds = points.map((p: { id: string }) => p.id)

      // Get all deliveries
      const deliveriesResponse = await apiClient.get('/deliveries')

      const deliveries = Array.isArray(deliveriesResponse.data)
        ? deliveriesResponse.data.filter((d: Delivery) => pointIds.includes(d.pointId))
        : []

      // Sort by timestamp descending
      deliveries.sort((a: Delivery, b: Delivery) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )

      return {
        success: true,
        data: { deliveries },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch deliveries',
        },
      }
    }
  },
}
