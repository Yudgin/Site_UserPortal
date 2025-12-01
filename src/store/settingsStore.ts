import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Distributor, UserAccessSettings } from '@/types/models'

interface SettingsState {
  language: string
  mapType: 'satellite' | 'street'
  distributors: Distributor[]
  userAccess: UserAccessSettings | null
  isLoading: boolean
  error: string | null

  // Actions
  setLanguage: (language: string) => void
  setMapType: (type: 'satellite' | 'street') => void
  setDistributors: (distributors: Distributor[]) => void
  setUserAccess: (access: UserAccessSettings | null) => void
  updatePermissions: (permissions: Partial<UserAccessSettings['permissions']>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'en',
      mapType: 'satellite',
      distributors: [],
      userAccess: null,
      isLoading: false,
      error: null,

      setLanguage: (language) => set({ language }),

      setMapType: (type) => set({ mapType: type }),

      setDistributors: (distributors) => set({ distributors }),

      setUserAccess: (access) => set({ userAccess: access }),

      updatePermissions: (permissions) => set((state) => ({
        userAccess: state.userAccess
          ? {
              ...state.userAccess,
              permissions: { ...state.userAccess.permissions, ...permissions },
            }
          : null,
      })),

      setLoading: (loading) => set({ isLoading: loading }),

      setError: (error) => set({ error }),
    }),
    {
      name: 'settings-storage',
      partialize: (state) => ({
        language: state.language,
        mapType: state.mapType,
      }),
    }
  )
)
