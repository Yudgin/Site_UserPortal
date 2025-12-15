import axios from 'axios'

const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/'
const NP_API_KEY = '7017b9e350e0c2d9fd515a5d0d76560c'

export interface NPCity {
  Ref: string
  Description: string
  DescriptionRu: string
  Area: string
  AreaDescription: string
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
    const response = await axios.post(NP_API_URL, {
      apiKey: NP_API_KEY,
      modelName: 'Address',
      calledMethod: 'searchSettlements',
      methodProperties: {
        CityName: query,
        Limit: 20,
      },
    })

    if (response.data.success && response.data.data?.[0]?.Addresses) {
      return response.data.data[0].Addresses.map((addr: any) => ({
        Ref: addr.DeliveryCity,
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

// Get warehouses by city Ref
export const getWarehouses = async (cityRef: string, searchQuery?: string): Promise<NPWarehouse[]> => {
  try {
    const response = await axios.post(NP_API_URL, {
      apiKey: NP_API_KEY,
      modelName: 'Address',
      calledMethod: 'getWarehouses',
      methodProperties: {
        CityRef: cityRef,
        FindByString: searchQuery || '',
        Limit: 50,
      },
    })

    if (response.data.success && response.data.data) {
      return response.data.data.map((wh: any) => ({
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

// Track parcel by TTN
export const trackParcel = async (ttn: string): Promise<any> => {
  try {
    const response = await axios.post(NP_API_URL, {
      apiKey: NP_API_KEY,
      modelName: 'TrackingDocument',
      calledMethod: 'getStatusDocuments',
      methodProperties: {
        Documents: [{ DocumentNumber: ttn }],
      },
    })

    if (response.data.success && response.data.data?.[0]) {
      return response.data.data[0]
    }
    return null
  } catch (error) {
    console.error('Error tracking parcel:', error)
    return null
  }
}
