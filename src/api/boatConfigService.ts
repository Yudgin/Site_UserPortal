import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, deleteDoc, limit } from 'firebase/firestore'

export interface SavedBoatConfig {
  id: string
  userId: string
  userEmail: string | null
  name: string
  code: string // 9-character configuration code
  createdAt: string
  updatedAt: string
}

// Generate short unique ID
const generateConfigId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export const boatConfigService = {
  // Save configuration to Firestore
  saveConfig: async (code: string, name: string = ''): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) {
      console.error('Firestore not configured or user not authenticated')
      return null
    }

    try {
      const configId = generateConfigId()
      const userId = auth.currentUser.uid
      const userEmail = auth.currentUser.email

      const config: SavedBoatConfig = {
        id: configId,
        userId,
        userEmail,
        name: name || `Конфигурация ${new Date().toLocaleDateString()}`,
        code,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await setDoc(doc(db, 'boatConfigs', configId), config)
      console.log('Config saved successfully:', configId)
      return { id: configId }
    } catch (error: any) {
      console.error('Error saving config:', error)
      return null
    }
  },

  // Load configuration by ID
  loadConfig: async (configId: string): Promise<SavedBoatConfig | null> => {
    if (!db) {
      console.error('Firestore not configured')
      return null
    }

    try {
      const configDoc = await getDoc(doc(db, 'boatConfigs', configId))
      if (configDoc.exists()) {
        return configDoc.data() as SavedBoatConfig
      }
      return null
    } catch (error) {
      console.error('Error loading config:', error)
      return null
    }
  },

  // Get user's configurations
  getUserConfigs: async (): Promise<SavedBoatConfig[]> => {
    if (!db || !auth?.currentUser) {
      console.log('getUserConfigs: no db or user', { db: !!db, user: !!auth?.currentUser })
      return []
    }

    try {
      console.log('Loading configs for user:', auth.currentUser.uid)
      const q = query(
        collection(db, 'boatConfigs'),
        where('userId', '==', auth.currentUser.uid),
        limit(50)
      )
      const snapshot = await getDocs(q)
      console.log('Found configs:', snapshot.docs.length)
      const configs = snapshot.docs.map(doc => doc.data() as SavedBoatConfig)
      // Sort by createdAt manually to avoid requiring composite index
      return configs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    } catch (error: any) {
      console.error('Error loading user configs:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      return []
    }
  },

  // Delete configuration
  deleteConfig: async (configId: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) {
      return false
    }

    try {
      const configDoc = await getDoc(doc(db, 'boatConfigs', configId))
      if (configDoc.exists()) {
        const config = configDoc.data() as SavedBoatConfig
        // Only owner can delete
        if (config.userId === auth.currentUser.uid) {
          await deleteDoc(doc(db, 'boatConfigs', configId))
          return true
        }
      }
      return false
    } catch (error) {
      console.error('Error deleting config:', error)
      return false
    }
  },

  // Update configuration name
  updateConfigName: async (configId: string, name: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) {
      return false
    }

    try {
      const configDoc = await getDoc(doc(db, 'boatConfigs', configId))
      if (configDoc.exists()) {
        const config = configDoc.data() as SavedBoatConfig
        // Only owner can update
        if (config.userId === auth.currentUser.uid) {
          await setDoc(doc(db, 'boatConfigs', configId), {
            ...config,
            name,
            updatedAt: new Date().toISOString(),
          })
          return true
        }
      }
      return false
    } catch (error) {
      console.error('Error updating config:', error)
      return false
    }
  },
}
