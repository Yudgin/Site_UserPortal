import { UserRole } from './models'

export interface User {
  id: string
  email: string
  displayName: string | null
  photoURL: string | null
  phoneNumber: string | null
  role: UserRole
  createdAt: string
  lastLogin: string
}

export interface BoatCredentials {
  boatId: string
  boatPassword: string
}

export interface AuthState {
  user: User | null
  boatCredentials: BoatCredentials | null
  isAuthenticated: boolean
  isBoatConnected: boolean
  isLoading: boolean
  error: string | null
}
