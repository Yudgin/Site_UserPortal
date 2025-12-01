import apiClient from '../client'
import { Point } from '@/types/models'
import { ApiResponse, CreatePointRequest } from '@/types/api'

export const pointsApi = {
  // Get all points for a reservoir
  getByReservoir: async (reservoirId: string): Promise<ApiResponse<{ points: Point[] }>> => {
    try {
      // json-server uses query params for filtering
      const response = await apiClient.get(`/points?reservoirId=${reservoirId}`)

      const points = Array.isArray(response.data) ? response.data : []

      return {
        success: true,
        data: { points },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch points',
        },
      }
    }
  },

  // Create a new point
  create: async (data: CreatePointRequest): Promise<ApiResponse<Point>> => {
    try {
      // Get existing points to determine the next number
      const existingResponse = await apiClient.get(`/points?reservoirId=${data.reservoirId}`)

      const existingPoints = Array.isArray(existingResponse.data) ? existingResponse.data : []

      const nextNumber = existingPoints.length > 0
        ? Math.max(...existingPoints.map((p: Point) => p.number)) + 1
        : 1

      const newPoint: Point = {
        id: `pt-${Date.now()}`,
        reservoirId: data.reservoirId,
        number: nextNumber,
        name: data.name,
        coordinates: data.coordinates,
        depth: data.depth,
        createdAt: new Date().toISOString(),
      }

      const response = await apiClient.post('/points', newPoint)

      // Update reservoir points count
      const reservoirResponse = await apiClient.get(`/reservoirs/${data.reservoirId}`)
      if (reservoirResponse.data) {
        await apiClient.patch(`/reservoirs/${data.reservoirId}`, {
          pointsCount: (reservoirResponse.data.pointsCount || 0) + 1,
        })
      }

      return {
        success: true,
        data: response.data,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'CREATE_FAILED',
          message: 'Failed to create point',
        },
      }
    }
  },

  // Delete a point
  delete: async (pointId: string): Promise<ApiResponse<void>> => {
    try {
      // Get point first to know reservoir
      const pointResponse = await apiClient.get(`/points/${pointId}`)
      const point = pointResponse.data

      await apiClient.delete(`/points/${pointId}`)

      // Update reservoir points count
      if (point?.reservoirId) {
        const reservoirResponse = await apiClient.get(`/reservoirs/${point.reservoirId}`)
        if (reservoirResponse.data) {
          await apiClient.patch(`/reservoirs/${point.reservoirId}`, {
            pointsCount: Math.max(0, (reservoirResponse.data.pointsCount || 1) - 1),
          })
        }
      }

      return {
        success: true,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DELETE_FAILED',
          message: 'Failed to delete point',
        },
      }
    }
  },

  // Update a point
  update: async (pointId: string, data: Partial<Point>): Promise<ApiResponse<Point>> => {
    try {
      const response = await apiClient.patch(`/points/${pointId}`, data)

      return {
        success: true,
        data: response.data,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: 'Failed to update point',
        },
      }
    }
  },
}
