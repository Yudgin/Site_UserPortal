// Proxy endpoint - works in development (Vite proxy) and production (Firebase Functions)
const API_BASE = '/api/firmware'

export interface Firmware {
  id: string
  Name: string
  lang: string
  branch: string
  brand: string
  device: string
  win?: string // ID for Windows version download (optional)
  mac?: string // ID for Mac version download (optional)
}

export interface FirmwareListResponse {
  List: Firmware[]
}

export const firmwareService = {
  // Get list of available firmwares
  getFirmwareList: async (email: string): Promise<Firmware[]> => {
    try {
      const response = await fetch(`${API_BASE}/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Email: email }),
      })

      if (!response.ok) {
        console.error('Failed to fetch firmware list:', response.status)
        return []
      }

      const data: FirmwareListResponse = await response.json()
      return data.List || []
    } catch (error) {
      console.error('Error fetching firmware list:', error)
      return []
    }
  },

  // Download firmware file (.bin)
  downloadFirmware: async (email: string, firmwareId: string, firmwareName: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Email: email, id: firmwareId }),
      })

      if (!response.ok) {
        console.error('Failed to download firmware:', response.status)
        return false
      }

      // Get the file as blob
      const blob = await response.blob()

      // Create download link
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${firmwareName}.bin`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      return true
    } catch (error) {
      console.error('Error downloading firmware:', error)
      return false
    }
  },

  // Download Windows executable
  downloadFirmwareWin: async (email: string, firmwareId: string, firmwareName: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/download-win`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Email: email, id: firmwareId }),
      })

      if (!response.ok) {
        console.error('Failed to download Windows firmware:', response.status)
        return false
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${firmwareName}.exe`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      return true
    } catch (error) {
      console.error('Error downloading Windows firmware:', error)
      return false
    }
  },

  // Download Mac application
  downloadFirmwareMac: async (email: string, firmwareId: string, firmwareName: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/download-mac`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ Email: email, id: firmwareId }),
      })

      if (!response.ok) {
        console.error('Failed to download Mac firmware:', response.status)
        return false
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${firmwareName}.dmg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)

      return true
    } catch (error) {
      console.error('Error downloading Mac firmware:', error)
      return false
    }
  },
}
