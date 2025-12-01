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
