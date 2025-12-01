import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { BoatCredentials } from '@/types/auth'
import { BoatInfo } from '@/types/models'

export interface ConnectedBoat {
  credentials: BoatCredentials
  info: BoatInfo
}

interface BoatState {
  boats: ConnectedBoat[]
  selectedBoatId: string | null

  addBoat: (credentials: BoatCredentials, info: BoatInfo) => void
  removeBoat: (boatId: string) => void
  selectBoat: (boatId: string | null) => void
  getSelectedBoat: () => ConnectedBoat | null
  clearBoats: () => void
}

export const useBoatStore = create<BoatState>()(
  persist(
    (set, get) => ({
      boats: [],
      selectedBoatId: null,

      addBoat: (credentials, info) => {
        const boats = get().boats
        const exists = boats.some(b => b.credentials.boatId === credentials.boatId)

        if (!exists) {
          set({
            boats: [...boats, { credentials, info }],
            selectedBoatId: get().selectedBoatId || credentials.boatId,
          })
        } else {
          set({
            boats: boats.map(b =>
              b.credentials.boatId === credentials.boatId
                ? { credentials, info }
                : b
            ),
          })
        }
      },

      removeBoat: (boatId) => {
        const boats = get().boats.filter(b => b.credentials.boatId !== boatId)
        const selectedBoatId = get().selectedBoatId === boatId
          ? boats[0]?.credentials.boatId || null
          : get().selectedBoatId
        set({ boats, selectedBoatId })
      },

      selectBoat: (boatId) => set({ selectedBoatId: boatId }),

      getSelectedBoat: () => {
        const selectedId = get().selectedBoatId
        return get().boats.find(b => b.credentials.boatId === selectedId) || null
      },

      clearBoats: () => set({ boats: [], selectedBoatId: null }),
    }),
    {
      name: 'boats-v1',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
