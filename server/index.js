import express from 'express'
import cors from 'cors'
import axios from 'axios'
import dotenv from 'dotenv'
import jsonServer from 'json-server'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json())

// TurboSMS API configuration
const TURBOSMS_API_URL = 'https://api.turbosms.ua'
const TURBOSMS_TOKEN = process.env.TURBOSMS_TOKEN || ''
const TURBOSMS_SENDER = process.env.TURBOSMS_SENDER || 'RUNFERRY'

// Store verification codes in memory (in production, use Redis/DB)
const verificationCodes = new Map()

// Generate random 4-digit code
const generateCode = () => {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

// Format phone number to international format (380XXXXXXXXX)
const formatPhoneNumber = (phone) => {
  let cleaned = phone.replace(/\D/g, '')
  if (cleaned.startsWith('0')) {
    cleaned = '38' + cleaned
  } else if (cleaned.startsWith('8') && cleaned.length === 10) {
    cleaned = '38' + cleaned
  } else if (!cleaned.startsWith('380') && cleaned.length === 9) {
    cleaned = '380' + cleaned
  }
  return cleaned
}

// Validate Ukrainian phone number
const isValidUkrainianPhone = (phone) => {
  const formatted = formatPhoneNumber(phone)
  return /^380\d{9}$/.test(formatted)
}

// Settings API configuration
const SETTINGS_API = {
  host: process.env.SETTINGS_API_HOST || '160baf.cube-host.online',
  port: process.env.SETTINGS_API_PORT || '8812',
  basePath: process.env.SETTINGS_API_PATH || '/InfoBase1/hs/ad',
  username: process.env.SETTINGS_API_USER || 'iis',
  password: process.env.SETTINGS_API_PASS || 'sas',
}

// Create axios instance for settings API
const settingsClient = axios.create({
  baseURL: `http://${SETTINGS_API.host}:${SETTINGS_API.port}${SETTINGS_API.basePath}`,
  timeout: 30000,
  auth: {
    username: SETTINGS_API.username,
    password: SETTINGS_API.password,
  },
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Get settings schema
app.get('/api/settings/schema', async (req, res) => {
  try {
    const { localization = 'en_US', email = '', chipId, chipType = 'chip_type' } = req.query

    if (!chipId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_CHIP_ID', message: 'chipId is required' },
      })
    }

    const response = await settingsClient.get('/RTL/', {
      params: {
        Localization: localization,
        Email: email,
        chipId,
        chipType,
      },
    })

    res.json({
      success: true,
      data: response.data,
    })
  } catch (error) {
    console.error('Settings API error:', error.message)
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_FAILED',
        message: 'Failed to fetch settings schema',
        details: error.message,
      },
    })
  }
})

// Get current settings values for a boat
app.get('/api/settings/values/:boatId', async (req, res) => {
  try {
    const { boatId } = req.params
    res.json({
      success: true,
      data: {},
    })
  } catch (error) {
    console.error('Settings values error:', error.message)
    res.status(500).json({
      success: false,
      error: {
        code: 'FETCH_FAILED',
        message: 'Failed to fetch settings values',
      },
    })
  }
})

// Update a setting value
app.put('/api/settings/:boatId/:settingId', async (req, res) => {
  try {
    const { boatId, settingId } = req.params
    const { value } = req.body
    console.log(`Updating setting ${settingId} to ${value} for boat ${boatId}`)
    res.json({ success: true })
  } catch (error) {
    console.error('Settings update error:', error.message)
    res.status(500).json({
      success: false,
      error: {
        code: 'UPDATE_FAILED',
        message: 'Failed to update setting',
      },
    })
  }
})

// ============ SMS Verification Endpoints ============

// Send verification code
app.post('/api/sms/send-code', async (req, res) => {
  try {
    const { phone } = req.body

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PHONE', message: 'Phone number is required' },
      })
    }

    if (!isValidUkrainianPhone(phone)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'Invalid Ukrainian phone number format' },
      })
    }

    const formattedPhone = formatPhoneNumber(phone)
    const code = generateCode()

    // Store code with 5-minute expiration
    verificationCodes.set(formattedPhone, {
      code,
      expires: Date.now() + 5 * 60 * 1000,
    })

    // Check if we have API token
    if (!TURBOSMS_TOKEN) {
      console.log(`[DEV] Verification code for ${formattedPhone}: ${code}`)
      return res.json({
        success: true,
        data: { success: true, messageId: 'dev-mode' },
      })
    }

    // Send SMS via TurboSMS
    const response = await axios.post(
      `${TURBOSMS_API_URL}/message/send.json`,
      {
        recipients: [formattedPhone],
        sms: {
          sender: TURBOSMS_SENDER,
          text: `Ваш код підтвердження: ${code}\nYour verification code: ${code}`,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TURBOSMS_TOKEN}`,
        },
      }
    )

    console.log('TurboSMS response:', response.data)

    // TurboSMS returns response_code 0 or status containing "SUCCESS" on success
    const isSuccess = response.data.response_code === 0 ||
                      (response.data.response_status && response.data.response_status.includes('SUCCESS'))

    if (isSuccess) {
      res.json({
        success: true,
        data: {
          success: true,
          messageId: response.data.response_result?.[0]?.message_id,
        },
      })
    } else {
      verificationCodes.delete(formattedPhone)
      res.status(400).json({
        success: false,
        error: {
          code: 'SMS_SEND_FAILED',
          message: response.data.response_status || 'Failed to send SMS',
        },
      })
    }
  } catch (error) {
    console.error('TurboSMS error:', error.response?.data || error.message)
    res.status(500).json({
      success: false,
      error: {
        code: 'SMS_ERROR',
        message: error.response?.data?.response_status || error.message || 'Failed to send SMS',
      },
    })
  }
})

// Verify code
app.post('/api/sms/verify-code', (req, res) => {
  const { phone, code } = req.body

  if (!phone || !code) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_PARAMS', message: 'Phone and code are required' },
    })
  }

  const formattedPhone = formatPhoneNumber(phone)
  const stored = verificationCodes.get(formattedPhone)

  if (!stored) {
    return res.json({
      success: true,
      data: { verified: false },
    })
  }

  // Check if code expired
  if (Date.now() > stored.expires) {
    verificationCodes.delete(formattedPhone)
    return res.status(400).json({
      success: false,
      error: { code: 'CODE_EXPIRED', message: 'Verification code has expired' },
    })
  }

  // Check if code matches
  if (stored.code === code) {
    verificationCodes.delete(formattedPhone)
    return res.json({
      success: true,
      data: { verified: true },
    })
  }

  res.json({
    success: true,
    data: { verified: false },
  })
})

// JSON Server for mock API
const router = jsonServer.router(path.join(__dirname, 'db.json'))
const middlewares = jsonServer.defaults({ noCors: true })

app.use(middlewares)
app.use(router)

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📡 Settings API: http://${SETTINGS_API.host}:${SETTINGS_API.port}${SETTINGS_API.basePath}`)
  console.log(`📦 Mock API endpoints: /boats, /reservoirs, /points, /deliveries, /shares, /distributors`)
})
