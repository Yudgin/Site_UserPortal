// Водоем (озеро, пруд и т.д.)
export interface Reservoir {
  id: string
  number: number
  name: string
  basePoint: {
    lat: number
    lng: number
  }
  pointsCount: number
}

// Точка на водоеме
export interface Point {
  id: string
  reservoirId: string
  number: number
  name: string
  coordinates: {
    lat: number
    lng: number
  }
  depth?: number
  createdAt: string
}

// История завоза
export interface Delivery {
  id: string
  pointId: string
  timestamp: string
  duration: number // в секундах
  distance: number // в метрах
  status: 'completed' | 'aborted' | 'failed'
}

// Информация о кораблике
export interface BoatInfo {
  id: string
  name: string
  firmware: string
}

// Дистрибьютор
export interface Distributor {
  id: string
  name: string
  region: string
}

// Настройки доступа пользователя
export interface UserAccessSettings {
  distributorId?: string
  permissions: {
    viewSettings: boolean
    editSettings: boolean
    viewReservoirs: boolean
  }
}

// Роль пользователя
export type UserRole = 'user' | 'distributor' | 'developer'

// Кораблик, доступный дистрибьютору
export interface DistributorBoat {
  id: string
  distributorId: string
  boatId: string
  boatName: string
  ownerEmail: string
  permissions: {
    viewSettings: boolean
    editSettings: boolean
    viewReservoirs: boolean
  }
}

// Данные для шаринга водоема
export interface SharedReservoirData {
  name: string
  basePoint: { lat: number; lng: number }
  points: Array<{
    name: string
    coordinates: { lat: number; lng: number }
  }>
}

// Настройки кораблика
export interface BoatSettingParameter {
  ID: number
  Name: string
  Value: Record<string, string> // ключ - числовое значение, значение - текстовое описание
}

export interface BoatSettingGroup {
  group_name: string
  parameters: BoatSettingParameter[]
}

// Текущие значения настроек кораблика (ID -> значение)
export type BoatSettingsValues = Record<number, number>
