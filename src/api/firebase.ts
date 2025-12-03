import { initializeApp } from 'firebase/app'
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  FacebookAuthProvider,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth'
import { getFirestore, Firestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// Initialize Firebase only if config is available
const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null
export const auth = app ? getAuth(app) : null
export const db: Firestore | null = app ? getFirestore(app) : null

const googleProvider = new GoogleAuthProvider()
const facebookProvider = new FacebookAuthProvider()

export const firebaseAuth = {
  // Sign in with email and password
  signInWithEmail: async (email: string, password: string) => {
    if (!auth) throw new Error('Firebase not configured')
    return signInWithEmailAndPassword(auth, email, password)
  },

  // Register with email and password
  registerWithEmail: async (email: string, password: string) => {
    if (!auth) throw new Error('Firebase not configured')
    return createUserWithEmailAndPassword(auth, email, password)
  },

  // Sign in with Google
  signInWithGoogle: async () => {
    if (!auth) throw new Error('Firebase not configured')
    return signInWithPopup(auth, googleProvider)
  },

  // Sign in with Facebook
  signInWithFacebook: async () => {
    if (!auth) throw new Error('Firebase not configured')
    return signInWithPopup(auth, facebookProvider)
  },

  // Sign out
  signOut: async () => {
    if (!auth) throw new Error('Firebase not configured')
    return signOut(auth)
  },

  // Subscribe to auth state changes
  onAuthStateChanged: (callback: (user: FirebaseUser | null) => void) => {
    if (!auth) {
      callback(null)
      return () => {}
    }
    return onAuthStateChanged(auth, callback)
  },

  // Get current user
  getCurrentUser: () => {
    if (!auth) return null
    return auth.currentUser
  },
}

export default firebaseAuth
