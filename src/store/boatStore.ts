import { create } from 'zustand'
import { BoatCredentials } from '@/types/auth'
import { BoatInfo } from '@/types/models'
import { userDataService } from '@/api/userDataService'

export interface ConnectedBoat {
  credentials: BoatCredentials
  info: BoatInfo
}

interface BoatState {
  boats: ConnectedBoat[]
  selectedBoatId: string | null
  isLoading: boolean
  isSynced: boolean

  addBoat: (credentials: BoatCredentials, info: BoatInfo) => Promise<void>
  removeBoat: (boatId: string) => Promise<void>
  selectBoat: (boatId: string | null) => Promise<void>
  getSelectedBoat: () => ConnectedBoat | null
  clearBoats: () => Promise<void>

  // Sync methods
  loadFromServer: () => Promise<void>
  syncToServer: () => Promise<void>
}

// Helper to save to server
const saveToServer = async (boats: ConnectedBoat[], selectedBoatId: string | null) => {
  if (userDataService.isAuthenticated()) {
    await userDataService.saveBoatsData({ boats, selectedBoatId })
  }
}

export const useBoatStore = create<BoatState>()((set, get) => ({
  boats: [],
  selectedBoatId: null,
  isLoading: false,
  isSynced: false,

  addBoat: async (credentials, info) => {
    const boats = get().boats
    const exists = boats.some(b => b.credentials.boatId === credentials.boatId)

    let newBoats: ConnectedBoat[]
    let newSelectedId: string | null

    if (!exists) {
      newBoats = [...boats, { credentials, info }]
      newSelectedId = get().selectedBoatId || credentials.boatId
    } else {
      newBoats = boats.map(b =>
        b.credentials.boatId === credentials.boatId
          ? { credentials, info }
          : b
      )
      newSelectedId = get().selectedBoatId
    }

    set({ boats: newBoats, selectedBoatId: newSelectedId })
    await saveToServer(newBoats, newSelectedId)
  },

  removeBoat: async (boatId) => {
    const boats = get().boats.filter(b => b.credentials.boatId !== boatId)
    const selectedBoatId = get().selectedBoatId === boatId
      ? boats[0]?.credentials.boatId || null
      : get().selectedBoatId

    set({ boats, selectedBoatId })
    await saveToServer(boats, selectedBoatId)
  },

  selectBoat: async (boatId) => {
    set({ selectedBoatId: boatId })
    await saveToServer(get().boats, boatId)
  },

  getSelectedBoat: () => {
    const selectedId = get().selectedBoatId
    return get().boats.find(b => b.credentials.boatId === selectedId) || null
  },

  clearBoats: async () => {
    set({ boats: [], selectedBoatId: null })
    await saveToServer([], null)
  },

  // Load boats from server
  loadFromServer: async () => {
    if (!userDataService.isAuthenticated()) {
      set({ isSynced: true }) // Mark as synced even if not authenticated
      return
    }

    set({ isLoading: true })
    try {
      const userData = await userDataService.loadUserData()
      const serverBoats = userData?.boats?.boats || []
      const serverSelectedId = userData?.boats?.selectedBoatId || null

      // Check if we need to migrate from localStorage
      if (serverBoats.length === 0) {
        const localData = localStorage.getItem('boats-v1')
        if (localData) {
          try {
            const parsed = JSON.parse(localData)
            if (parsed.state?.boats?.length > 0) {
              // Migrate localStorage data to server
              const localBoats = parsed.state.boats
              const localSelectedId = parsed.state.selectedBoatId
              await userDataService.saveBoatsData({
                boats: localBoats,
                selectedBoatId: localSelectedId,
              })
              set({
                boats: localBoats,
                selectedBoatId: localSelectedId,
                isSynced: true,
              })
              // Clear old localStorage after migration
              localStorage.removeItem('boats-v1')
              console.log('Migrated boats from localStorage to Firestore')
              return
            }
          } catch (e) {
            console.error('Error migrating localStorage:', e)
          }
        }
      }

      set({
        boats: serverBoats,
        selectedBoatId: serverSelectedId,
        isSynced: true,
      })
    } catch (error) {
      console.error('Error loading boats from server:', error)

      // Fallback to localStorage if Firestore fails
      const localData = localStorage.getItem('boats-v1')
      if (localData) {
        try {
          const parsed = JSON.parse(localData)
          if (parsed.state?.boats) {
            set({
              boats: parsed.state.boats,
              selectedBoatId: parsed.state.selectedBoatId,
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
    const { boats, selectedBoatId } = get()
    await saveToServer(boats, selectedBoatId)
    set({ isSynced: true })
  },
}))
