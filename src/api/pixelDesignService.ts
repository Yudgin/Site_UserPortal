import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, deleteDoc, limit } from 'firebase/firestore'

export interface PixelDesign {
  id: string
  userId: string | null
  userEmail: string | null
  name: string
  pixels: string // Base64 encoded pixel data
  width: number
  height: number
  createdAt: string
  updatedAt: string
}

// Encode pixels to base64 string
export const encodePixels = (pixels: boolean[][]): string => {
  const height = pixels.length
  const width = pixels[0]?.length || 0

  // Convert boolean array to bytes (8 pixels per byte)
  const bytes: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 8) {
      let byte = 0
      for (let bit = 0; bit < 8 && x + bit < width; bit++) {
        if (pixels[y][x + bit]) {
          byte |= (1 << bit)
        }
      }
      bytes.push(byte)
    }
  }

  // Convert to base64
  const uint8Array = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i])
  }
  return btoa(binary)
}

// Decode base64 string to pixels
export const decodePixels = (encoded: string, width: number, height: number): boolean[][] => {
  // Decode base64
  const binary = atob(encoded)
  const bytes: number[] = []
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i))
  }

  // Convert bytes to boolean array
  const pixels: boolean[][] = []
  let byteIndex = 0

  for (let y = 0; y < height; y++) {
    const row: boolean[] = []
    for (let x = 0; x < width; x += 8) {
      const byte = bytes[byteIndex++] || 0
      for (let bit = 0; bit < 8 && x + bit < width; bit++) {
        row.push((byte & (1 << bit)) !== 0)
      }
    }
    pixels.push(row)
  }

  return pixels
}

// Generate short unique ID
const generateDesignId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export const pixelDesignService = {
  // Save design to Firestore
  saveDesign: async (pixels: boolean[][], name: string = ''): Promise<{ id: string } | null> => {
    if (!db) {
      console.error('Firestore not configured')
      return null
    }

    try {
      const designId = generateDesignId()
      const userId = auth?.currentUser?.uid || null
      const userEmail = auth?.currentUser?.email || null
      const width = pixels[0]?.length || 128
      const height = pixels.length || 64

      console.log('Saving design:', { designId, userId, userEmail, width, height })
      console.log('Auth state:', auth?.currentUser ? 'logged in' : 'not logged in')

      const design: PixelDesign = {
        id: designId,
        userId,
        userEmail,
        name: name || `Design ${new Date().toLocaleDateString()}`,
        pixels: encodePixels(pixels),
        width,
        height,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      await setDoc(doc(db, 'pixelDesigns', designId), design)
      console.log('Design saved successfully:', designId)
      return { id: designId }
    } catch (error: any) {
      console.error('Error saving design:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      return null
    }
  },

  // Load design by ID
  loadDesign: async (designId: string): Promise<PixelDesign | null> => {
    if (!db) {
      console.error('Firestore not configured')
      return null
    }

    try {
      const designDoc = await getDoc(doc(db, 'pixelDesigns', designId))
      if (designDoc.exists()) {
        return designDoc.data() as PixelDesign
      }
      return null
    } catch (error) {
      console.error('Error loading design:', error)
      return null
    }
  },

  // Get user's designs
  getUserDesigns: async (): Promise<PixelDesign[]> => {
    if (!db || !auth?.currentUser) {
      console.log('getUserDesigns: no db or user', { db: !!db, user: !!auth?.currentUser })
      return []
    }

    try {
      console.log('Loading designs for user:', auth.currentUser.uid)
      const q = query(
        collection(db, 'pixelDesigns'),
        where('userId', '==', auth.currentUser.uid),
        limit(50)
      )
      const snapshot = await getDocs(q)
      console.log('Found designs:', snapshot.docs.length)
      const designs = snapshot.docs.map(doc => doc.data() as PixelDesign)
      // Sort by createdAt manually to avoid requiring composite index
      return designs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    } catch (error: any) {
      console.error('Error loading user designs:', error)
      console.error('Error code:', error.code)
      console.error('Error message:', error.message)
      return []
    }
  },

  // Delete design
  deleteDesign: async (designId: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) {
      return false
    }

    try {
      const designDoc = await getDoc(doc(db, 'pixelDesigns', designId))
      if (designDoc.exists()) {
        const design = designDoc.data() as PixelDesign
        // Only owner can delete
        if (design.userId === auth.currentUser.uid) {
          await deleteDoc(doc(db, 'pixelDesigns', designId))
          return true
        }
      }
      return false
    } catch (error) {
      console.error('Error deleting design:', error)
      return false
    }
  },

  // Update design
  updateDesign: async (designId: string, pixels: boolean[][], name?: string): Promise<boolean> => {
    if (!db || !auth?.currentUser) {
      return false
    }

    try {
      const designDoc = await getDoc(doc(db, 'pixelDesigns', designId))
      if (designDoc.exists()) {
        const design = designDoc.data() as PixelDesign
        // Only owner can update
        if (design.userId === auth.currentUser.uid) {
          await setDoc(doc(db, 'pixelDesigns', designId), {
            ...design,
            pixels: encodePixels(pixels),
            name: name || design.name,
            updatedAt: new Date().toISOString(),
          })
          return true
        }
      }
      return false
    } catch (error) {
      console.error('Error updating design:', error)
      return false
    }
  },
}
