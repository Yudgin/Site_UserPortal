import { db } from './firebase'
import {
  collection,
  doc,
  getDoc,
  setDoc,
  getDocs,
  writeBatch,
} from 'firebase/firestore'

export interface FirmwareBrand {
  id: string // brand name as ID
  name: string
  publicAccess: boolean // available to all users
  createdAt: string
  updatedAt: string
}

export interface FirmwareBranch {
  id: string // branch name as ID
  name: string
  publicAccess: boolean // available to all users
  createdAt: string
  updatedAt: string
}

const BRANDS_COLLECTION = 'firmwareBrands'
const BRANCHES_COLLECTION = 'firmwareBranches'

export const firmwareCatalogService = {
  // Get all brands
  getAllBrands: async (): Promise<FirmwareBrand[]> => {
    if (!db) return []

    try {
      const snapshot = await getDocs(collection(db, BRANDS_COLLECTION))
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<FirmwareBrand, 'id'>),
      }))
    } catch (error) {
      console.error('Error getting brands:', error)
      return []
    }
  },

  // Get all branches
  getAllBranches: async (): Promise<FirmwareBranch[]> => {
    if (!db) return []

    try {
      const snapshot = await getDocs(collection(db, BRANCHES_COLLECTION))
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<FirmwareBranch, 'id'>),
      }))
    } catch (error) {
      console.error('Error getting branches:', error)
      return []
    }
  },

  // Sync brands from firmware list (add new, remove missing)
  syncBrands: async (brandNames: string[]): Promise<void> => {
    if (!db) return

    try {
      const existingBrands = await firmwareCatalogService.getAllBrands()
      const existingBrandNames = new Set(existingBrands.map((b) => b.name))
      const newBrandNames = new Set(brandNames)

      const batch = writeBatch(db)
      const now = new Date().toISOString()

      // Add new brands
      for (const name of brandNames) {
        if (!existingBrandNames.has(name)) {
          const docRef = doc(db, BRANDS_COLLECTION, name)
          batch.set(docRef, {
            name,
            publicAccess: false, // default: not public
            createdAt: now,
            updatedAt: now,
          })
        }
      }

      // Remove brands that no longer exist in API
      for (const brand of existingBrands) {
        if (!newBrandNames.has(brand.name)) {
          const docRef = doc(db, BRANDS_COLLECTION, brand.name)
          batch.delete(docRef)
        }
      }

      await batch.commit()
    } catch (error) {
      console.error('Error syncing brands:', error)
    }
  },

  // Sync branches from firmware list (add new, remove missing)
  syncBranches: async (branchNames: string[]): Promise<void> => {
    if (!db) return

    try {
      const existingBranches = await firmwareCatalogService.getAllBranches()
      const existingBranchNames = new Set(existingBranches.map((b) => b.name))
      const newBranchNames = new Set(branchNames)

      const batch = writeBatch(db)
      const now = new Date().toISOString()

      // Add new branches
      for (const name of branchNames) {
        if (!existingBranchNames.has(name)) {
          const docRef = doc(db, BRANCHES_COLLECTION, name)
          batch.set(docRef, {
            name,
            publicAccess: false, // default: not public
            createdAt: now,
            updatedAt: now,
          })
        }
      }

      // Remove branches that no longer exist in API
      for (const branch of existingBranches) {
        if (!newBranchNames.has(branch.name)) {
          const docRef = doc(db, BRANCHES_COLLECTION, branch.name)
          batch.delete(docRef)
        }
      }

      await batch.commit()
    } catch (error) {
      console.error('Error syncing branches:', error)
    }
  },

  // Update brand public access
  updateBrandPublicAccess: async (brandName: string, publicAccess: boolean): Promise<boolean> => {
    if (!db) return false

    try {
      const docRef = doc(db, BRANDS_COLLECTION, brandName)
      await setDoc(docRef, { publicAccess, updatedAt: new Date().toISOString() }, { merge: true })
      return true
    } catch (error) {
      console.error('Error updating brand:', error)
      return false
    }
  },

  // Update branch public access
  updateBranchPublicAccess: async (branchName: string, publicAccess: boolean): Promise<boolean> => {
    if (!db) return false

    try {
      const docRef = doc(db, BRANCHES_COLLECTION, branchName)
      await setDoc(docRef, { publicAccess, updatedAt: new Date().toISOString() }, { merge: true })
      return true
    } catch (error) {
      console.error('Error updating branch:', error)
      return false
    }
  },

  // Get public brands
  getPublicBrands: async (): Promise<string[]> => {
    const brands = await firmwareCatalogService.getAllBrands()
    return brands.filter((b) => b.publicAccess).map((b) => b.name)
  },

  // Get public branches
  getPublicBranches: async (): Promise<string[]> => {
    const branches = await firmwareCatalogService.getAllBranches()
    return branches.filter((b) => b.publicAccess).map((b) => b.name)
  },

  // Персональный доступ пользователя к прошивкам (бренды/ветки сверх публичных). Хранится в
  // отдельной коллекции firmwareUserAccess/{email} — НЕ в users (там RBAC по uid), чтобы не пересекаться.
  getUserFirmwareAccess: async (email: string): Promise<{ brands: string[]; branches: string[] }> => {
    if (!db || !email) return { brands: [], branches: [] }
    try {
      const snap = await getDoc(doc(db, 'firmwareUserAccess', email.toLowerCase()))
      if (!snap.exists()) return { brands: [], branches: [] }
      const d = snap.data() as { allowedBrands?: string[]; allowedBranches?: string[] }
      return { brands: d.allowedBrands || [], branches: d.allowedBranches || [] }
    } catch (error) {
      console.error('Error getting user firmware access:', error)
      return { brands: [], branches: [] }
    }
  },
}
