import { BoatInfo, Reservoir, Point, Delivery, Distributor, UserAccessSettings, SharedReservoirData } from './models'

// Базовый ответ API
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

// Запрос с авторизацией кораблика
export interface AuthenticatedRequest {
  boatId: string
  boatPassword: string
}

// === Аутентификация кораблика ===

export interface BoatVerifyRequest {
  boatId: string
  password: string
}

export interface BoatVerifyResponse {
  valid: boolean
  boatInfo?: BoatInfo
}

// === Водоемы ===

export interface GetReservoirsRequest extends AuthenticatedRequest {}

export interface GetReservoirsResponse {
  reservoirs: Reservoir[]
}

export interface RenameReservoirRequest extends AuthenticatedRequest {
  reservoirNumber: number
  newName: string
}

// === Точки ===

export interface GetPointsRequest extends AuthenticatedRequest {
  reservoirId: string
}

export interface GetPointsResponse {
  points: Point[]
}

export interface CreatePointRequest extends AuthenticatedRequest {
  reservoirId: string
  name: string
  coordinates: {
    lat: number
    lng: number
  }
  depth?: number
}

export interface ImportReservoirRequest extends AuthenticatedRequest {
  shareKey: string
}

// === История завозов ===

export interface GetDeliveriesRequest extends AuthenticatedRequest {
  pointId: string
}

export interface GetDeliveriesResponse {
  deliveries: Delivery[]
}

// === Шаринг ===

export interface ShareReservoirRequest extends AuthenticatedRequest {
  reservoirId: string
}

export interface ShareReservoirResponse {
  shareKey: string
  expiresAt: string
}

export interface GetSharedReservoirResponse {
  data: SharedReservoirData
}

// === Дистрибьюторы и доступ ===

export interface GetDistributorsResponse {
  distributors: Distributor[]
}

export interface GetUserAccessResponse {
  access: UserAccessSettings
}

export interface UpdateUserAccessRequest extends AuthenticatedRequest {
  distributorId: string
  permissions: {
    viewSettings: boolean
    editSettings: boolean
    viewReservoirs: boolean
  }
}

// === Синхронизация пользователей ===

export interface UserSyncRequest {
  apiKey: string
  users: Array<{
    id: string
    email: string
    boatId?: string
    createdAt: string
    lastLogin: string
  }>
}
