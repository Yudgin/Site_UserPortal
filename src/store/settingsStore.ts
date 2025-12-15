import { create } from 'zustand'
import { Distributor, UserAccessSettings } from '@/types/models'
import { userDataService, SavedServiceRequest, UserProfileData } from '@/api/userDataService'

interface SettingsState {
  language: string
  mapType: 'satellite' | 'street'
  distributors: Distributor[]
  userAccess: UserAccessSettings | null
  phoneNumber: string | null
  profile: UserProfileData | null
  serviceRequests: SavedServiceRequest[]
  isLoading: boolean
  isSynced: boolean
  error: string | null

  // Actions
  setLanguage: (language: string) => Promise<void>
  setMapType: (type: 'satellite' | 'street') => Promise<void>
  setDistributors: (distributors: Distributor[]) => void
  setUserAccess: (access: UserAccessSettings | null) => void
  updatePermissions: (permissions: Partial<UserAccessSettings['permissions']>) => void
  setPhoneNumber: (phoneNumber: string | null) => Promise<void>
  setProfile: (profile: UserProfileData | null) => Promise<void>
  addServiceRequest: (id: string, number: string) => Promise<void>
  removeServiceRequest: (id: string) => Promise<void>
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void

  // Sync methods
  loadFromServer: () => Promise<void>
  syncToServer: () => Promise<void>
}

// Helper to save to server
const saveSettingsToServer = async (state: {
  language: string
  mapType: 'satellite' | 'street'
  phoneNumber: string | null
  profile: UserProfileData | null
  serviceRequests: SavedServiceRequest[]
}) => {
  if (userDataService.isAuthenticated()) {
    await userDataService.saveSettingsData({
      language: state.language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests: state.serviceRequests,
    })
  }
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  language: 'uk',
  mapType: 'satellite',
  distributors: [],
  userAccess: null,
  phoneNumber: null,
  profile: null,
  serviceRequests: [],
  isLoading: false,
  isSynced: false,
  error: null,

  setLanguage: async (language) => {
    set({ language })
    const state = get()
    await saveSettingsToServer({
      language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests: state.serviceRequests,
    })
  },

  setMapType: async (type) => {
    set({ mapType: type })
    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: type,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests: state.serviceRequests,
    })
  },

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

  setPhoneNumber: async (phoneNumber) => {
    set({ phoneNumber })
    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: state.mapType,
      phoneNumber,
      profile: state.profile,
      serviceRequests: state.serviceRequests,
    })
  },

  setProfile: async (profile) => {
    set({ profile })
    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile,
      serviceRequests: state.serviceRequests,
    })
  },

  addServiceRequest: async (id, number) => {
    const exists = get().serviceRequests.some(r => r.id === id)
    if (exists) return

    const serviceRequests = [...get().serviceRequests, { id, number }]
    set({ serviceRequests })

    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests,
    })
  },

  removeServiceRequest: async (id) => {
    const serviceRequests = get().serviceRequests.filter((r) => r.id !== id)
    set({ serviceRequests })

    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests,
    })
  },

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  // Load settings from server
  loadFromServer: async () => {
    if (!userDataService.isAuthenticated()) {
      set({ isSynced: true }) // Mark as synced even if not authenticated
      return
    }

    set({ isLoading: true })
    try {
      const userData = await userDataService.loadUserData()

      // Check if server has settings data
      if (userData?.settings && (userData.settings.language || userData.settings.phoneNumber || userData.settings.profile || userData.settings.serviceRequests?.length)) {
        set({
          language: userData.settings.language || 'uk',
          mapType: userData.settings.mapType || 'satellite',
          phoneNumber: userData.settings.phoneNumber || null,
          profile: userData.settings.profile || null,
          serviceRequests: userData.settings.serviceRequests || [],
          isSynced: true,
        })
      } else {
        // Check if we need to migrate from localStorage
        const localData = localStorage.getItem('settings-v1')
        if (localData) {
          try {
            const parsed = JSON.parse(localData)
            if (parsed.state) {
              const localSettings = {
                language: parsed.state.language || 'uk',
                mapType: parsed.state.mapType || 'satellite',
                phoneNumber: parsed.state.phoneNumber || null,
                profile: parsed.state.profile || null,
                serviceRequests: parsed.state.serviceRequests || [],
              }
              // Migrate localStorage data to server
              await userDataService.saveSettingsData(localSettings)
              set({
                ...localSettings,
                isSynced: true,
              })
              // Clear old localStorage after migration
              localStorage.removeItem('settings-v1')
              console.log('Migrated settings from localStorage to Firestore')
              return
            }
          } catch (e) {
            console.error('Error migrating settings from localStorage:', e)
          }
        }
        set({ isSynced: true }) // Mark as synced even if no data
      }
    } catch (error) {
      console.error('Error loading settings from server:', error)

      // Fallback to localStorage if Firestore fails
      const localData = localStorage.getItem('settings-v1')
      if (localData) {
        try {
          const parsed = JSON.parse(localData)
          if (parsed.state) {
            set({
              language: parsed.state.language || 'uk',
              mapType: parsed.state.mapType || 'satellite',
              phoneNumber: parsed.state.phoneNumber || null,
              profile: parsed.state.profile || null,
              serviceRequests: parsed.state.serviceRequests || [],
              isSynced: true,
            })
            return
          }
        } catch (e) {
          // ignore parse error
        }
      }

      set({ isSynced: true }) // Mark as synced to prevent infinite retry
    } finally {
      set({ isLoading: false })
    }
  },

  // Sync current state to server
  syncToServer: async () => {
    const state = get()
    await saveSettingsToServer({
      language: state.language,
      mapType: state.mapType,
      phoneNumber: state.phoneNumber,
      profile: state.profile,
      serviceRequests: state.serviceRequests,
    })
    set({ isSynced: true })
  },
}))
