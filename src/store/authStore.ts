import { create } from 'zustand'
import { User } from '@/types/auth'
import { UserRole } from '@/types/models'

interface AuthState {
  user: User | null
  isLoading: boolean
  error: string | null

  setUser: (user: User | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  logout: () => void
  isAuthenticated: () => boolean
  getUserRole: () => UserRole
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  isLoading: false,
  error: null,

  setUser: (user) => set({ user, error: null }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  logout: () => {
    set({ user: null, error: null })
  },

  isAuthenticated: () => get().user !== null,
  getUserRole: () => get().user?.role || 'user',
}))

// Re-export ConnectedBoat from boatStore for backward compatibility
export type { ConnectedBoat } from './boatStore'
