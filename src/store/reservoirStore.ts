import { create } from 'zustand'
import { Reservoir, Point } from '@/types/models'

interface ReservoirState {
  reservoirs: Reservoir[]
  selectedReservoir: Reservoir | null
  points: Point[]
  selectedPoint: Point | null
  isLoading: boolean
  error: string | null

  // Actions
  setReservoirs: (reservoirs: Reservoir[]) => void
  setSelectedReservoir: (reservoir: Reservoir | null) => void
  updateReservoir: (id: string, updates: Partial<Reservoir>) => void
  setPoints: (points: Point[]) => void
  setSelectedPoint: (point: Point | null) => void
  addPoint: (point: Point) => void
  removePoint: (pointId: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearPoints: () => void
}

export const useReservoirStore = create<ReservoirState>((set) => ({
  reservoirs: [],
  selectedReservoir: null,
  points: [],
  selectedPoint: null,
  isLoading: false,
  error: null,

  setReservoirs: (reservoirs) => set({ reservoirs, error: null }),

  setSelectedReservoir: (reservoir) => set({
    selectedReservoir: reservoir,
    points: [],
    selectedPoint: null
  }),

  updateReservoir: (id, updates) => set((state) => ({
    reservoirs: state.reservoirs.map((r) =>
      r.id === id ? { ...r, ...updates } : r
    ),
    selectedReservoir: state.selectedReservoir?.id === id
      ? { ...state.selectedReservoir, ...updates }
      : state.selectedReservoir,
  })),

  setPoints: (points) => set({ points, error: null }),

  setSelectedPoint: (point) => set({ selectedPoint: point }),

  addPoint: (point) => set((state) => ({
    points: [...state.points, point],
  })),

  removePoint: (pointId) => set((state) => ({
    points: state.points.filter((p) => p.id !== pointId),
    selectedPoint: state.selectedPoint?.id === pointId ? null : state.selectedPoint,
  })),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  clearPoints: () => set({ points: [], selectedPoint: null }),
}))
