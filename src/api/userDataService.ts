import { db, auth } from './firebase'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import { ConnectedBoat } from '@/store/boatStore'

// Types for user data stored in Firestore
export interface UserBoatsData {
  boats: ConnectedBoat[]
  selectedBoatId: string | null
}

export interface SavedServiceRequest {
  id: string
  number: string
}

export interface UserSettingsData {
  language: string
  mapType: 'satellite' | 'street'
  phoneNumber: string | null
  serviceRequests: SavedServiceRequest[]
}

export interface UserData {
  boats: UserBoatsData
  settings: UserSettingsData
  updatedAt: string
}

// Default values
const DEFAULT_BOATS_DATA: UserBoatsData = {
  boats: [],
  selectedBoatId: null,
}

const DEFAULT_SETTINGS_DATA: UserSettingsData = {
  language: 'uk',
  mapType: 'satellite',
  phoneNumber: null,
  serviceRequests: [],
}

// Get current user ID
const getCurrentUserId = (): string | null => {
  return auth?.currentUser?.uid || null
}

// User data service for Firestore operations
export const userDataService = {
  // Get user document reference
  getUserDocRef: (userId: string) => {
    if (!db) throw new Error('Firestore not configured')
    return doc(db, 'users', userId)
  },

  // Load all user data from Firestore
  loadUserData: async (): Promise<UserData | null> => {
    const userId = getCurrentUserId()
    if (!userId || !db) return null

    try {
      const userDocRef = doc(db, 'users', userId)
      const userDoc = await getDoc(userDocRef)

      if (userDoc.exists()) {
        return userDoc.data() as UserData
      }

      // Create default user data if not exists
      const defaultData: UserData = {
        boats: DEFAULT_BOATS_DATA,
        settings: DEFAULT_SETTINGS_DATA,
        updatedAt: new Date().toISOString(),
      }

      await setDoc(userDocRef, defaultData)
      return defaultData
    } catch (error) {
      console.error('Error loading user data:', error)
      return null
    }
  },

  // Save boats data
  saveBoatsData: async (boatsData: UserBoatsData): Promise<boolean> => {
    const userId = getCurrentUserId()
    if (!userId || !db) return false

    try {
      const userDocRef = doc(db, 'users', userId)
      await updateDoc(userDocRef, {
        boats: boatsData,
        updatedAt: new Date().toISOString(),
      }).catch(async () => {
        // If document doesn't exist, create it
        await setDoc(userDocRef, {
          boats: boatsData,
          settings: DEFAULT_SETTINGS_DATA,
          updatedAt: new Date().toISOString(),
        })
      })
      return true
    } catch (error) {
      console.error('Error saving boats data:', error)
      return false
    }
  },

  // Save settings data
  saveSettingsData: async (settingsData: UserSettingsData): Promise<boolean> => {
    const userId = getCurrentUserId()
    if (!userId || !db) return false

    try {
      const userDocRef = doc(db, 'users', userId)
      await updateDoc(userDocRef, {
        settings: settingsData,
        updatedAt: new Date().toISOString(),
      }).catch(async () => {
        // If document doesn't exist, create it
        await setDoc(userDocRef, {
          boats: DEFAULT_BOATS_DATA,
          settings: settingsData,
          updatedAt: new Date().toISOString(),
        })
      })
      return true
    } catch (error) {
      console.error('Error saving settings data:', error)
      return false
    }
  },

  // Check if user is authenticated
  isAuthenticated: (): boolean => {
    return !!auth?.currentUser
  },
}

export default userDataService
