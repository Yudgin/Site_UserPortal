import apiClient from '../client'
import { Reservoir } from '@/types/models'
import { ApiResponse, RenameReservoirRequest, ShareReservoirResponse } from '@/types/api'

export const reservoirsApi = {
  // Get all reservoirs for a boat
  getAll: async (boatId: string): Promise<ApiResponse<{ reservoirs: Reservoir[] }>> => {
    try {
      const response = await apiClient.get('/reservoirs', {
        params: { boatId }
      })

      const reservoirs = response.data.filter(
        (r: Reservoir & { boatId: string }) => r.boatId === boatId
      )

      return {
        success: true,
        data: { reservoirs },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch reservoirs',
        },
      }
    }
  },

  // Rename a reservoir
  rename: async (data: RenameReservoirRequest): Promise<ApiResponse<Reservoir>> => {
    try {
      // Find the reservoir first
      const response = await apiClient.get('/reservoirs', {
        params: { number: data.reservoirNumber }
      })

      const reservoirs = response.data
      const reservoir = Array.isArray(reservoirs)
        ? reservoirs.find((r: Reservoir) => r.number === data.reservoirNumber)
        : null

      if (!reservoir) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Reservoir not found',
          },
        }
      }

      // Update the reservoir
      const updateResponse = await apiClient.patch(`/reservoirs/${reservoir.id}`, {
        name: data.newName,
      })

      return {
        success: true,
        data: updateResponse.data,
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: 'Failed to rename reservoir',
        },
      }
    }
  },

  // Generate share link
  share: async (reservoirId: string): Promise<ApiResponse<ShareReservoirResponse>> => {
    try {
      const shareKey = Math.random().toString(36).substring(2, 15)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

      // Save to mock server
      await apiClient.post('/shares', {
        shareKey,
        reservoirId,
        expiresAt,
      })

      return {
        success: true,
        data: {
          shareKey,
          expiresAt,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'SHARE_FAILED',
          message: 'Failed to generate share link',
        },
      }
    }
  },

  // Import shared reservoir to a specific boat
  importShared: async (
    shareKey: string,
    boatId: string,
    boatPassword: string
  ): Promise<ApiResponse<{ reservoir: Reservoir }>> => {
    try {
      // First get the shared data
      const sharesResponse = await apiClient.get('/shares', {
        params: { shareKey }
      })

      const share = Array.isArray(sharesResponse.data)
        ? sharesResponse.data.find((s: { shareKey: string }) => s.shareKey === shareKey)
        : null

      if (!share) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Share link not found or expired',
          },
        }
      }

      // Get original reservoir and points
      const reservoirResponse = await apiClient.get(`/reservoirs/${share.reservoirId}`)
      const pointsResponse = await apiClient.get('/points', {
        params: { reservoirId: share.reservoirId }
      })

      const originalReservoir = reservoirResponse.data
      const originalPoints = pointsResponse.data

      // Create new reservoir for the target boat
      const newReservoir = await apiClient.post('/reservoirs', {
        boatId,
        boatPassword,
        name: originalReservoir.name,
        number: Date.now(), // Generate unique number
        basePoint: originalReservoir.basePoint,
        pointsCount: originalPoints.length,
      })

      // Copy all points to the new reservoir
      for (const point of originalPoints) {
        await apiClient.post('/points', {
          reservoirId: newReservoir.data.id,
          name: point.name,
          coordinates: point.coordinates,
          number: point.number,
        })
      }

      return {
        success: true,
        data: {
          reservoir: newReservoir.data,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'IMPORT_FAILED',
          message: 'Failed to import reservoir',
        },
      }
    }
  },

  // Get shared reservoir by key
  getShared: async (shareKey: string): Promise<ApiResponse<{ reservoir: Reservoir; points: unknown[] }>> => {
    try {
      const sharesResponse = await apiClient.get('/shares', {
        params: { shareKey }
      })

      const share = Array.isArray(sharesResponse.data)
        ? sharesResponse.data.find((s: { shareKey: string }) => s.shareKey === shareKey)
        : null

      if (!share) {
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Share link not found or expired',
          },
        }
      }

      const reservoirResponse = await apiClient.get(`/reservoirs/${share.reservoirId}`)
      const pointsResponse = await apiClient.get('/points', {
        params: { reservoirId: share.reservoirId }
      })

      return {
        success: true,
        data: {
          reservoir: reservoirResponse.data,
          points: pointsResponse.data,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch shared reservoir',
        },
      }
    }
  },
}
