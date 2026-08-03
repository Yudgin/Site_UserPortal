import axios from 'axios'

// Nova Poshta requests go through our backend proxy — the API key never reaches the browser.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3002'

const npClient = axios.create({
  baseURL: `${BACKEND_URL}/api/novaposhta`,
  timeout: 20000,
})

export interface NPCity {
  Ref: string // DeliveryCity Ref (для отделений)
  SettlementRef?: string // Settlement Ref (для поиска улиц)
  Description: string
  DescriptionRu: string
  Area: string
  AreaDescription: string
}

export interface NPStreet {
  Ref: string
  Description: string
}

export interface NPWarehouse {
  Ref: string
  Description: string
  DescriptionRu: string
  Number: string
  CityRef: string
  CityDescription: string
  TypeOfWarehouse: string
}

// Search cities by name
export const searchCities = async (query: string): Promise<NPCity[]> => {
  try {
    const response = await npClient.post('/cities', { query })

    if (response.data.success && response.data.data?.[0]?.Addresses) {
      return response.data.data[0].Addresses.map((addr: any) => ({
        Ref: addr.DeliveryCity,
        SettlementRef: addr.Ref,
        Description: addr.Present,
        DescriptionRu: addr.Present,
        Area: addr.Area,
        AreaDescription: addr.Area,
      }))
    }
    return []
  } catch (error) {
    console.error('Error searching cities:', error)
    return []
  }
}

// Поиск улиц населённого пункта (для адресной/курьерской доставки). settlementRef — Ref населённого
// пункта (NPCity.SettlementRef), НЕ DeliveryCity.
export const searchStreets = async (settlementRef: string, query: string): Promise<NPStreet[]> => {
  try {
    const response = await npClient.post('/streets', { settlementRef, query })
    if (response.data.success && response.data.data?.[0]?.Addresses) {
      return response.data.data[0].Addresses.map((s: any) => ({ Ref: s.SettlementStreetRef || s.Ref, Description: s.Present || s.Description }))
    }
    return []
  } catch (error) {
    console.error('Error searching streets:', error)
    return []
  }
}

// Get warehouses by city Ref
// Поштомати ВИКЛЮЧАЄМО всюди (рішення власника): сервіс приймає/відправляє кораблики лише
// через відділення (габарити/оформлення). Розпізнаємо і за назвою, і за типом відділення.
const POSTOMAT_TYPE_REF = '95dc212d-479c-4ffb-a8ab-8c1b9073d0bc'
const isPostomat = (wh: any): boolean =>
  String(wh?.TypeOfWarehouse || '') === POSTOMAT_TYPE_REF ||
  /поштомат|почтомат/i.test(`${wh?.Description || ''} ${wh?.DescriptionRu || ''}`)

export const getWarehouses = async (cityRef: string, searchQuery?: string): Promise<NPWarehouse[]> => {
  try {
    const response = await npClient.post('/warehouses', { cityRef, searchQuery: searchQuery || '' })

    if (response.data.success && response.data.data) {
      return response.data.data.filter((wh: any) => !isPostomat(wh)).map((wh: any) => ({
        Ref: wh.Ref,
        Description: wh.Description,
        DescriptionRu: wh.DescriptionRu,
        Number: wh.Number,
        CityRef: wh.CityRef,
        CityDescription: wh.CityDescription,
        TypeOfWarehouse: wh.TypeOfWarehouse,
      }))
    }
    return []
  } catch (error) {
    console.error('Error getting warehouses:', error)
    return []
  }
}

// Батч-статуси ТТН: {ттн → {status, code}}. Використовується списками заявок/замовлень.
export const trackParcels = async (ttns: string[]): Promise<Record<string, { status: string; code: string }>> => {
  try {
    const clean = [...new Set(ttns.map((t) => String(t).replace(/\D/g, '')).filter(Boolean))]
    if (!clean.length) return {}
    const response = await npClient.post('/track-batch', { ttns: clean })
    return response.data.success && response.data.data ? response.data.data : {}
  } catch (error) {
    console.error('Error batch tracking:', error)
    return {}
  }
}

// Track parcel by TTN
export const trackParcel = async (ttn: string): Promise<any> => {
  try {
    const response = await npClient.post('/track', { ttn })

    if (response.data.success && response.data.data?.[0]) {
      return response.data.data[0]
    }
    return null
  } catch (error) {
    console.error('Error tracking parcel:', error)
    return null
  }
}
