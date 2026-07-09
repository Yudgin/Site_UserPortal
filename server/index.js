import express from 'express'
import cors from 'cors'
import axios from 'axios'
import dotenv from 'dotenv'
import jsonServer from 'json-server'
import Anthropic from '@anthropic-ai/sdk'
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import path from 'path'
import { fileURLToPath } from 'url'
import { registerTelegramBot } from './telegram.js'
import { registerViberBot } from './viber.js'
import { registerManagerReply } from './managerReply.js'
import { registerPayments } from './payments.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// firebase-admin для серверной записи в Firestore (Telegram-бот пишет chatSessions/
// clientProfiles напрямую как доверенный backend). Креды — через ADC (в деплое —
// сервис-аккаунт рантайма; локально — gcloud application-default). Ленивая инициализация:
// если ADC нет, adminDb-операции упадут и будут пойманы, бот просто не сохранит сессию.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry'
let adminDb = null
try {
  const firebaseApp = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: applicationDefault(), projectId: FIREBASE_PROJECT_ID })
  adminDb = getFirestore(firebaseApp)
  // Как и на клиенте: не бросать на undefined-полях, а игнорировать их (иначе .set падает).
  adminDb.settings({ ignoreUndefinedProperties: true })
} catch (e) {
  console.warn('⚠️  firebase-admin init failed — Telegram bot persistence disabled:', e.message)
}

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
// rawBody сохраняем для проверки подписи Viber-/monobank-вебхуков (HMAC-SHA256 сырого тела).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
// LiqPay шлёт вебхук form-urlencoded (поля data + signature)
app.use(express.urlencoded({ extended: true }))

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

// Settings API configuration — credentials come from environment only (see .env.example)
const SETTINGS_API = {
  host: process.env.SETTINGS_API_HOST,
  port: process.env.SETTINGS_API_PORT || '8812',
  basePath: process.env.SETTINGS_API_PATH || '/InfoBase1/hs/ad',
  username: process.env.SETTINGS_API_USER,
  password: process.env.SETTINGS_API_PASS,
}

if (!SETTINGS_API.host || !SETTINGS_API.username || !SETTINGS_API.password) {
  console.warn('⚠️  SETTINGS_API_HOST/USER/PASS are not set — settings endpoints will fail (see .env.example)')
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

// ============ Nova Poshta Proxy Endpoints ============
// API key lives on the server only (NP_API_KEY); the frontend calls these endpoints.
const NP_API_URL = 'https://api.novaposhta.ua/v2.0/json/'
const NP_API_KEY = process.env.NP_API_KEY || ''

if (!NP_API_KEY) {
  console.warn('⚠️  NP_API_KEY is not set — Nova Poshta endpoints will fail (see .env.example)')
}

const npRequest = async (modelName, calledMethod, methodProperties) => {
  const response = await axios.post(NP_API_URL, {
    apiKey: NP_API_KEY,
    modelName,
    calledMethod,
    methodProperties,
  }, { timeout: 15000 })
  return response.data
}

// Search cities by name
app.post('/api/novaposhta/cities', async (req, res) => {
  try {
    const { query } = req.body
    if (!query) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_QUERY', message: 'query is required' },
      })
    }
    const data = await npRequest('Address', 'searchSettlements', { CityName: query, Limit: 20 })
    res.json(data)
  } catch (error) {
    console.error('Nova Poshta cities error:', error.message)
    res.status(500).json({
      success: false,
      error: { code: 'NP_FAILED', message: 'Failed to search cities' },
    })
  }
})

// Get warehouses by city Ref
app.post('/api/novaposhta/warehouses', async (req, res) => {
  try {
    const { cityRef, searchQuery } = req.body
    if (!cityRef) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_CITY_REF', message: 'cityRef is required' },
      })
    }
    const data = await npRequest('Address', 'getWarehouses', {
      CityRef: cityRef,
      FindByString: searchQuery || '',
      Limit: 50,
    })
    res.json(data)
  } catch (error) {
    console.error('Nova Poshta warehouses error:', error.message)
    res.status(500).json({
      success: false,
      error: { code: 'NP_FAILED', message: 'Failed to get warehouses' },
    })
  }
})

// Track parcel by TTN
app.post('/api/novaposhta/track', async (req, res) => {
  try {
    const { ttn } = req.body
    if (!ttn) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TTN', message: 'ttn is required' },
      })
    }
    const data = await npRequest('TrackingDocument', 'getStatusDocuments', {
      Documents: [{ DocumentNumber: ttn }],
    })
    res.json(data)
  } catch (error) {
    console.error('Nova Poshta tracking error:', error.message)
    res.status(500).json({
      success: false,
      error: { code: 'NP_FAILED', message: 'Failed to track parcel' },
    })
  }
})

// ============ AI Text Assistant (Claude) ============
// Улучшение/переписывание текстовых сообщений по промпту пользователя.
// Ключ живёт только на сервере. Переиспользуется для соглашения, диагностики и т.д.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null

if (!ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY is not set — AI text endpoints will fail (see .env.example)')
}

// Модель и тарифы Claude ($/1M токенов) — для учёта стоимости коммуникации
const AI_MODEL = 'claude-opus-4-8'
const AI_PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

// Собрать сведения об использовании токенов и стоимости из ответа Claude
const buildUsage = (usage = {}) => {
  const inputTokens = usage.input_tokens || 0
  const outputTokens = usage.output_tokens || 0
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheWrite = usage.cache_creation_input_tokens || 0
  const costUsd =
    (inputTokens * AI_PRICE.input +
      outputTokens * AI_PRICE.output +
      cacheRead * AI_PRICE.cacheRead +
      cacheWrite * AI_PRICE.cacheWrite) /
    1e6
  return {
    model: AI_MODEL,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    costUsd: Math.round(costUsd * 10000) / 10000, // до 4 знаков
  }
}

// Anthropic Messages API требует чередования ролей user/assistant. В нашем диалоге
// подряд могут идти сообщения от ИИ и менеджера (оба → assistant) — их нужно слить
// в одно, иначе API отклонит запрос (400 roles must alternate).
const mergeConsecutiveMessages = (msgs) =>
  msgs.reduce((acc, m) => {
    const last = acc[acc.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else acc.push({ role: m.role, content: m.content })
    return acc
  }, [])

// Краткая инструкция по типу текста (контекст задаётся клиентом)
const AI_CONTEXTS = {
  terms: 'Це текст угоди про використання сервісу з ремонту (умови обслуговування) для клієнтів рибальських прикормочних корабликів.',
  diagnostics: 'Це результати технічної діагностики несправності, які пише майстер сервісного центру для клієнта.',
  knowledge: 'Це стаття бази знань сервісного центру — інструкція з експлуатації або самостійного обслуговування прикормочних рибальських корабликів. Пиши зрозуміло, покроково.',
  generic: 'Це текст повідомлення для клієнта сервісного центру.',
}

app.post('/api/ai/improve-text', async (req, res) => {
  try {
    const { currentText = '', userPrompt = '', history = [], context = 'generic', lang = 'uk' } = req.body

    if (!anthropic) {
      return res.status(503).json({
        success: false,
        error: { code: 'AI_NOT_CONFIGURED', message: 'AI не налаштовано (ANTHROPIC_API_KEY відсутній)' },
      })
    }
    if (!userPrompt || !String(userPrompt).trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PROMPT', message: 'Опишіть, що потрібно змінити' },
      })
    }

    const contextNote = AI_CONTEXTS[context] || AI_CONTEXTS.generic
    const historyText = (Array.isArray(history) ? history : [])
      .slice(-10)
      .map((h, i) => `${i + 1}. Запит: ${h.prompt}${h.resultPreview ? `\n   Результат: ${h.resultPreview}` : ''}`)
      .join('\n')

    const system = [
      'Ти — редактор ділових текстів для українського сервісного центру.',
      contextNote,
      'Пиши завжди УКРАЇНСЬКОЮ мовою, незалежно від мови запиту користувача (навіть якщо запит російською). ' +
        'Це вимога законодавства України; мультимовність буде додано згодом.',
      'Повертай ЛИШЕ готовий новий текст — без пояснень, без лапок, без markdown-обгортки.',
      'Зберігай діловий стиль і зміст; змінюй саме те, про що просить користувач, і не додавай зайвого.',
    ].join('\n')
    void lang // мова відповіді завжди українська; параметр lang — на майбутнє (мультимовність)

    const userContent = [
      historyText ? `Історія попередніх правок (для наступності):\n${historyText}\n` : '',
      `Поточний текст:\n"""\n${currentText}\n"""\n`,
      `Що потрібно змінити:\n${userPrompt}`,
    ].filter(Boolean).join('\n')

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    res.json({ success: true, data: { text, usage: buildUsage(message.usage) } })
  } catch (error) {
    console.error('AI improve-text error:', error?.message || error)
    res.status(500).json({
      success: false,
      error: { code: 'AI_FAILED', message: 'Не вдалося обробити запит ІІ' },
    })
  }
})

// Системный промпт диалогового консультанта (оценка стоимости с эскалацией)
const CHAT_SYSTEM = [
  'Ти — консультант сервісного центру RunFerry, що обслуговує прикормочні рибальські кораблики.',
  'Завдання: допомогти клієнту зрозуміти орієнтовну вартість ремонту або апгрейду на основі наданого прайсу.',
  'Відповідай ЛИШЕ українською мовою, навіть якщо клієнт пише російською. Якщо клієнт звертається російською — у першій відповіді ввічливо додай: «Розумію російську, але за вимогами законодавства спілкуюся державною мовою.»',
  'Оцінюй вартість ТІЛЬКИ на основі наданого прайсу; не вигадуй цін і робіт. Це орієнтовна оцінка — точний кошторис складе майстер після діагностики.',
  'Якщо точної позиції немає, але є близька або сумісна — назви орієнтовну вартість за найсуміснішою позицією прайсу, чітко зазначивши, що це приблизно і знадобиться діагностика. Не поспішай з ескалацією.',
  'Сезон: до ремонту застосовується сезонна націнка; до апгрейдів (встановлення обладнання, оновлення ПЗ) націнка високого сезону НЕ застосовується. Критичні роботи (не працює мотор, заміна сервоприводу керма чи бункера) також йдуть БЕЗ націнки високого сезону.',
  'Про високий сезон говори м’яко й чесно: наша мета — не заробити на клієнті якнайбільше, а розумно розподілити ресурси сервісу, щоб допомогти якомога більшій кількості клієнтів у стислі строки. Якщо кораблик справний — підкажи, що ремонт можна зробити вигідніше в міжсезоння або додати пільгові позиції.',
  'Якщо проблему реально усунути самостійно (є відповідна самодопомога в контексті) — спершу доброзичливо запропонуй це рішення, і лише потім платний ремонт. Ми допомагаємо, а не витягуємо гроші.',
  'ГАРАНТІЯ (1 рік з дати продажу; статус гарантії буває вказаний в описі кораблика). Якщо кораблик НА ГАРАНТІЇ і йдеться про механічну частину — запропонуй клієнту на вибір ДВА варіанти: (1) ми зробимо це БЕЗКОШТОВНО за гарантією — надішліть кораблик нам, транспортні витрати теж покриває фірма; або (2) якщо він хоче зробити самостійно — ми БЕЗКОШТОВНО надішлемо потрібні комплектуючі (доставку теж оплачуємо ми). Пиши «надішліть», а не «принесіть». НЕ пиши, що самостійна заміна позбавляє гарантії. Якщо статус гарантії невідомий — спершу ввічливо уточни у клієнта, чи кораблик на гарантії.',
  'Якщо для симптому є типовий шаблон з варіантами ремонту — покажи «можливо це, або це» з орієнтовними сумами (кращий/гірший випадок) і зазнач, що точний варіант визначить діагностика.',
  'КОЛИ НАЗИВАЄШ ВАРТІСТЬ набору чи ремонту — завжди показуй розбивку по окремих операціях (список позицій з цінами), а не лише загальну суму: так клієнту видно, з чого складається ціна, і сума не виглядає лякаючою.',
  'Не забувай додати до підсумку загальні роботи (приймання, підготовка, тест на воді, сушіння, пакування), якщо вони ще не входять у обраний набір — вони супроводжують будь-який ремонт.',
  'Пропонуй підключити менеджера (needsManager=true) ЛИШЕ якщо питання зовсім поза межами оцінки вартості (гарантія, претензії, повернення коштів, юридичні питання) або клієнт прямо просить людину. Тоді повідом, що менеджер долучиться протягом 48 годин у робочі дні.',
  'Тон стриманий і чесний; сервіс покращується, точних строків не обіцяй.',
  'М’яко зазнач, що це орієнтовна автоматична оцінка, яка може бути неточною — ми наповнюємо базу знань і працюємо над її коректністю.',
  'ПОЛЯ ВІДПОВІДІ: offeredSelfRepair=true ЛИШЕ якщо ти реально запропонував клієнту виконати ремонт САМОСТІЙНО із заміною деталі (тобто потрібні комплектуючі); якщо йдеться лише про налаштування без деталей або про ремонт у нас — offeredSelfRepair=false. warranty: постав yes/no/unknown за контекстом розмови (опис кораблика, слова клієнта).',
  'ПОЛЕ parts: якщо offeredSelfRepair=true — заповни список комплектуючих, потрібних для самостійного ремонту (реальні назви деталей/матеріалів із прайсу, з кількістю). Якщо offeredSelfRepair=false — залиш порожній масив [].',
  'ПОЛЕ estimate: якщо ти назвав клієнту конкретні ціни — продублюй їх структуровано: lines (позиція + ціна за наведеною розбивкою) і total (підсумок у грн). Якщо конкретної суми не називав — lines=[] і total=0.',
].join('\n')

app.post('/api/ai/estimate-chat', async (req, res) => {
  try {
    const { messages = [], priceContext = '', knowledgeContext = '', corrections = [] } = req.body

    if (!anthropic) {
      return res.status(503).json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI не налаштовано' } })
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_MESSAGES', message: 'Порожній діалог' } })
    }

    // Внутренние заметки менеджера в промпт не идут; client → user, ai/manager → assistant
    const chatMessages = mergeConsecutiveMessages(
      messages
        .filter((m) => !m.internal && m.text)
        .map((m) => ({ role: m.role === 'client' ? 'user' : 'assistant', content: String(m.text) }))
    )
    if (chatMessages.length === 0 || chatMessages[0].role !== 'user') {
      return res.status(400).json({ success: false, error: { code: 'BAD_DIALOG', message: 'Діалог має починатися з повідомлення клієнта' } })
    }

    const corrText = Array.isArray(corrections) && corrections.length
      ? `\n\nВРАХУЙ ЦІ ПРАВИЛА (корекції поведінки від адміністратора):\n${corrections.map((c) => `- ${c}`).join('\n')}`
      : ''
    const selfHelp = knowledgeContext
      ? `\n\nСАМОДОПОМОГА (безкоштовні рішення з бази знань). ЯКЩО проблема клієнта збігається з якимось матеріалом — СПЕРШУ доброзичливо запропонуй це безкоштовне рішення (стисло, по кроках), і лише потім платний ремонт:\n${knowledgeContext}`
      : ''
    const system = CHAT_SYSTEM + corrText + (priceContext ? `\n\nПРАЙС (лише ці позиції можна використовувати для оцінки):\n${priceContext}` : '') + selfHelp

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system,
      messages: chatMessages,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reply: { type: 'string', description: 'Відповідь клієнту українською' },
              needsManager: { type: 'boolean', description: 'Чи потрібно підключити менеджера' },
              offeredSelfRepair: { type: 'boolean', description: 'true, якщо у відповіді ти запропонував клієнту виконати ремонт САМОСТІЙНО (для якого потрібні комплектуючі)' },
              warranty: { type: 'string', enum: ['yes', 'no', 'unknown'], description: 'Статус гарантії кораблика за контекстом розмови' },
              parts: {
                type: 'array',
                description: 'Комплектуючі для самостійного ремонту (лише коли offeredSelfRepair=true, інакше [])',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', description: 'Назва деталі/комплектуючої' },
                    qty: { type: 'number', description: 'Кількість' },
                  },
                  required: ['name', 'qty'],
                },
              },
              estimate: {
                type: 'object',
                additionalProperties: false,
                description: 'Структурована попередня оцінка, якщо названо конкретні ціни (інакше lines=[] і total=0)',
                properties: {
                  lines: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        label: { type: 'string', description: 'Назва позиції/роботи' },
                        price: { type: 'number', description: 'Ціна позиції, грн' },
                        workCode: { type: 'string', description: 'Код роботи з ПРАЙСУ (те, що в дужках [код] у прайсі, БЕЗ дужок), ЯКЩО ця позиція відповідає конкретній роботі з прайсу. Якщо позиція не відповідає жодній роботі прайсу — НЕ додавай це поле і не вигадуй код.' },
                      },
                      required: ['label', 'price'],
                    },
                  },
                  total: { type: 'number', description: 'Підсумкова сума, грн' },
                },
                required: ['lines', 'total'],
              },
            },
            required: ['reply', 'needsManager', 'offeredSelfRepair', 'warranty', 'parts', 'estimate'],
          },
        },
      },
    })

    const raw = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { reply: raw, needsManager: false, offeredSelfRepair: false, warranty: 'unknown', parts: [], estimate: { lines: [], total: 0 } }
    }

    const parts = Array.isArray(parsed.parts)
      ? parsed.parts
          .filter((p) => p && p.name)
          .map((p) => ({ name: String(p.name).trim(), qty: Number(p.qty) > 0 ? Number(p.qty) : 1 }))
      : []

    const estLines = parsed.estimate && Array.isArray(parsed.estimate.lines)
      ? parsed.estimate.lines
          .filter((l) => l && l.label)
          .map((l) => ({ label: String(l.label).trim(), price: Number(l.price) || 0, ...(l.workCode ? { workCode: String(l.workCode).trim() } : {}) }))
      : []
    const estimate = { lines: estLines, total: Number(parsed.estimate?.total) || 0 }

    res.json({
      success: true,
      data: {
        reply: parsed.reply || '',
        needsManager: !!parsed.needsManager,
        offeredSelfRepair: !!parsed.offeredSelfRepair,
        warranty: ['yes', 'no', 'unknown'].includes(parsed.warranty) ? parsed.warranty : 'unknown',
        parts,
        estimate,
        usage: buildUsage(message.usage),
      },
    })
  } catch (error) {
    console.error('AI estimate-chat error:', error?.message || error)
    res.status(500).json({ success: false, error: { code: 'AI_FAILED', message: 'Не вдалося обробити запит ІІ' } })
  }
})

// ============ AI-консультант (эксплуатация + самопомощь) ============
const KNOWLEDGE_SYSTEM = [
  'Ти — консультант сервісного центру RunFerry (прикормочні рибальські кораблики).',
  'Допомагай клієнту з питаннями експлуатації (як зарядити акумулятор, налаштувати автопілот тощо) на основі наданої бази знань.',
  'Якщо проблему можна вирішити самостійно і безкоштовно — ОБОВ’ЯЗКОВО запропонуй це першим (матеріали самодопомоги, відео/статті). Покажи, що наша мета — допомогти, а не заробити. Лише якщо самостійно складно — згадай про платний сервіс (offeredSelfHelp=true, якщо запропонував самодопомогу).',
  'Відповідай ЛИШЕ українською. Якщо клієнт пише російською — у першій відповіді додай: «Розумію російську, але за вимогами законодавства спілкуюся державною мовою.»',
  'Якщо в базі знань Є релевантний матеріал — ОБОВ’ЯЗКОВО використай його у відповіді, навіть якщо він короткий; переказуй кроки з бази своїми словами, дай посилання на відео/статті, якщо вони вказані. Не кажи «матеріалу немає», якщо він насправді є в базі. Не вигадуй інструкцій поза базою. Менеджера (needsManager=true) пропонуй ЛИШЕ коли в базі справді немає нічого релевантного.',
  'М’яко попереджай: відповіді автоматизовані й можуть бути неточними — ми наповнюємо базу знань і працюємо над її коректністю.',
].join('\n')

app.post('/api/ai/knowledge-chat', async (req, res) => {
  try {
    const { messages = [], knowledgeContext = '', corrections = [] } = req.body

    if (!anthropic) {
      return res.status(503).json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI не налаштовано' } })
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_MESSAGES', message: 'Порожній діалог' } })
    }

    const chatMessages = mergeConsecutiveMessages(
      messages
        .filter((m) => !m.internal && m.text)
        .map((m) => ({ role: m.role === 'client' ? 'user' : 'assistant', content: String(m.text) }))
    )
    if (chatMessages.length === 0 || chatMessages[0].role !== 'user') {
      return res.status(400).json({ success: false, error: { code: 'BAD_DIALOG', message: 'Діалог має починатися з повідомлення клієнта' } })
    }

    // Правки поведения ИИ (behaviorCorrections) инжектятся как дополнительные правила
    const correctionText = Array.isArray(corrections) && corrections.length
      ? `\n\nДОДАТКОВІ ПРАВИЛА (корекції поведінки, дотримуйся їх):\n${corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : ''
    const knowledgeText = knowledgeContext ? `\n\nБАЗА ЗНАНЬ (використовуй лише ці матеріали):\n${knowledgeContext}` : ''
    const system = KNOWLEDGE_SYSTEM + knowledgeText + correctionText

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system,
      messages: chatMessages,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reply: { type: 'string', description: 'Відповідь клієнту українською' },
              needsManager: { type: 'boolean' },
              offeredSelfHelp: { type: 'boolean', description: 'Чи запропоновано самостійне вирішення' },
            },
            required: ['reply', 'needsManager', 'offeredSelfHelp'],
          },
        },
      },
    })

    const raw = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { reply: raw, needsManager: false, offeredSelfHelp: false }
    }

    res.json({
      success: true,
      data: {
        reply: parsed.reply || '',
        needsManager: !!parsed.needsManager,
        offeredSelfHelp: !!parsed.offeredSelfHelp,
        usage: buildUsage(message.usage),
      },
    })
  } catch (error) {
    console.error('AI knowledge-chat error:', error?.message || error)
    res.status(500).json({ success: false, error: { code: 'AI_FAILED', message: 'Не вдалося обробити запит ІІ' } })
  }
})

// ============ AI-конструктор услуг прайса ============
// Владелец описывает услугу словами — ИИ разбивает её на детальні підпослуги
// (роботи в нормо-годинах, матеріали, набір), спираючись на наявний каталог.
const BUILD_PRICING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Коротке пояснення, що зроблено (українською)' },
    materials: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          name: { type: 'string', description: 'Назва українською' },
          unit: { type: 'string', description: 'Одиниця (шт, мл, компл.)' },
          price: { type: 'number' },
        },
        required: ['code', 'name', 'unit', 'price'],
      },
    },
    works: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string' },
          name: { type: 'string', description: 'Назва українською' },
          categoryId: { type: 'string', description: 'id категорії з наданого каталогу' },
          laborHours: { type: 'number' },
          dedupe: { type: 'string', enum: ['once', 'perComplaint'] },
          materials: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { materialCode: { type: 'string' }, qty: { type: 'number' } },
              required: ['materialCode', 'qty'],
            },
          },
          reused: { type: 'boolean', description: 'true, якщо це наявна робота (code вже є в каталозі)' },
        },
        required: ['code', 'name', 'categoryId', 'laborHours', 'dedupe', 'materials', 'reused'],
      },
    },
    kit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        name: { type: 'string', description: 'Назва українською' },
        serviceKind: { type: 'string', enum: ['repair', 'upgrade'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { workCode: { type: 'string' }, qty: { type: 'number' } },
            required: ['workCode', 'qty'],
          },
        },
      },
      required: ['code', 'name', 'serviceKind', 'items'],
    },
  },
  required: ['summary', 'materials', 'works', 'kit'],
}

app.post('/api/ai/build-pricing', async (req, res) => {
  try {
    const { instruction = '', catalogContext = '', laborRate = 0 } = req.body

    if (!anthropic) {
      return res.status(503).json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI не налаштовано' } })
    }
    if (!String(instruction).trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_INSTRUCTION', message: 'Опишіть послугу' } })
    }

    const system = [
      'Ти — помічник з формування прайсу сервісного центру RunFerry (прикормочні рибальські кораблики).',
      'Розбий описану власником послугу на детальні позиції: роботи (у нормо-годинах), матеріали (запчастини/витратні) та, за потреби, набір (kit).',
      `Ставка нормо-години: ${laborRate} грн. Якщо власник вказує ЦІНУ роботи (напр. «за роботу 4000»), розподіли нормо-години по підроботах так, щоб їх сума × ставку приблизно дорівнювала цій ціні.`,
      'Матеріали (деталі, напр. ехолот) — окремі позиції з вказаною ціною, прив’язані до відповідної роботи.',
      'ПЕРЕВИКОРИСТОВУЙ наявні спільні роботи з каталогу (приймання, транспортування, пакування тощо): для reused=true став ТОЧНИЙ code з наданого каталогу (напр. w-receive) і НЕ змінюй їх нормо-години. Не вигадуй нові коди для наявних робіт і не дублюй їх. Нові роботи — reused=false, з новими кодами у стилі наявних.',
      'Обирай categoryId лише з наданого каталогу. serviceKind: repair (поломка) або upgrade (встановлення обладнання/оновлення ПЗ — без сезонної націнки).',
      'Усі назви — українською. Повертай лише структуру за схемою.',
    ].join('\n')

    const userContent = [
      catalogContext ? `Наявний каталог (для контексту, стилю та перевикористання):\n${catalogContext}\n` : '',
      `Опис послуги від власника:\n${instruction}`,
    ].filter(Boolean).join('\n')

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: BUILD_PRICING_SCHEMA } },
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const raw = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return res.status(502).json({ success: false, error: { code: 'AI_PARSE_FAILED', message: 'ІІ повернув некоректну структуру' } })
    }

    res.json({ success: true, data: { ...parsed, usage: buildUsage(message.usage) } })
  } catch (error) {
    console.error('AI build-pricing error:', error?.message || error)
    res.status(500).json({ success: false, error: { code: 'AI_FAILED', message: 'Не вдалося сформувати послугу' } })
  }
})

// ============ AI: шаблон жалобы из описания выполненного ремонта ============
const BUILD_COMPLAINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symptom: { type: 'string', description: 'Як клієнт описує проблему (симптом), українською' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Ключові слова для співставлення опису клієнта з шаблоном' },
    diagnosticWorkCodes: { type: 'array', items: { type: 'string' }, description: 'Коди робіт діагностики (потрібні в будь-якому разі) — ЛИШЕ з наданого каталогу' },
    variants: {
      type: 'array',
      description: 'Варіанти ремонту (кращий/ймовірний/гірший)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Що робимо, українською' },
          severity: { type: 'string', enum: ['best', 'likely', 'worst'] },
          workCodes: { type: 'array', items: { type: 'string' }, description: 'Коди робіт цього варіанта — ЛИШЕ з наданого каталогу' },
        },
        required: ['label', 'severity', 'workCodes'],
      },
    },
  },
  required: ['symptom', 'keywords', 'diagnosticWorkCodes', 'variants'],
}

app.post('/api/ai/build-complaint', async (req, res) => {
  try {
    const { description = '', catalogContext = '' } = req.body
    if (!anthropic) {
      return res.status(503).json({ success: false, error: { code: 'AI_NOT_CONFIGURED', message: 'AI не налаштовано' } })
    }
    if (!String(description).trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DESCRIPTION', message: 'Опишіть ремонт' } })
    }

    const system = [
      'Ти — помічник сервісного центру RunFerry (прикормочні рибальські кораблики).',
      'На основі опису ВИКОНАНОГО ремонту сформуй шаблон скарги: симптом (як це описав би клієнт), ключові слова, роботи діагностики (потрібні завжди) та варіанти ремонту (кращий/ймовірний/гірший випадок).',
      'ВАЖЛИВО: у diagnosticWorkCodes та workCodes використовуй ЛИШЕ точні коди робіт із наданого каталогу. Якщо потрібної роботи в каталозі немає — не вигадуй код, а пропусти її.',
      'Усі тексти — українською. Повертай лише структуру за схемою.',
    ].join('\n')

    const userContent = [
      catalogContext ? `Каталог робіт (код — назва):\n${catalogContext}\n` : '',
      `Опис виконаного ремонту:\n${description}`,
    ].filter(Boolean).join('\n')

    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: BUILD_COMPLAINT_SCHEMA } },
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const raw = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return res.status(502).json({ success: false, error: { code: 'AI_PARSE_FAILED', message: 'ІІ повернув некоректну структуру' } })
    }

    res.json({ success: true, data: { ...parsed, usage: buildUsage(message.usage) } })
  } catch (error) {
    console.error('AI build-complaint error:', error?.message || error)
    res.status(500).json({ success: false, error: { code: 'AI_FAILED', message: 'Не вдалося сформувати шаблон' } })
  }
})

// ============ Мессенджер-боты (агрегатор: Telegram, Viber) ============
// Бот в мессенджере — это «фронт-деск»: клиент может написать про что угодно (сервис,
// покупка кораблика, другое). Поэтому даём боту консьерж-преамбулу поверх сервисного
// CHAT_SYSTEM: он определяет тему (intent) и действует соответственно. Сервисные правила
// применяются, когда intent=service; по продажам — помощь с моделями + менеджер.
const MESSENGER_PREAMBLE = [
  'Ти — онлайн-помічник (консьєрж) сервісного центру та магазину RunFerry (прикормочні рибальські кораблики) у месенджері. Клієнт може написати про що завгодно — спершу визнач ТЕМУ звернення й далі дій відповідно.',
  '• СЕРВІС/РЕМОНТ (не працює, зламалось, налаштування, зарядка, помилка тощо) → intent=service. Працюй за сервісними правилами нижче: спершу безкоштовна самодопомога (якщо є в контексті), потім орієнтовна вартість ремонту за прайсом.',
  '• ПОКУПКА/ПРОДАЖ (хоче купити кораблик, ціна нового, які є моделі, комплектація, наявність) → intent=sales. Доброзичливо допоможи: наші моделі — Камарад, Solo V2, Solo V3, Mini, Optima, R3, R2, R1, RM, RS. Запропонуй підібрати конфігурацію в конструкторі на сайті runferry.de та ЗАПРОПОНУЙ підключити менеджера з продажу (needsManager=true) для точної ціни, наявності й замовлення. НЕ вигадуй цін на купівлю нового кораблика — їх підтвердить менеджер.',
  '• ІНШЕ (доставка, гарантія, співпраця, загальні питання) → intent=other. Коротко допоможи або підключи менеджера, якщо поза твоєю компетенцією.',
  'ЗАВЖДИ став поле intent (service | sales | other) за темою повідомлення клієнта. Прайс і база знань нижче стосуються САМЕ сервісних запитів.',
  '',
  '=== Правила для СЕРВІСНИХ запитів (intent=service): ===',
].join('\n')
const MESSENGER_SYSTEM = MESSENGER_PREAMBLE + '\n' + CHAT_SYSTEM

// Канальные отправители (заполняются транспортами) — для доставки ответа менеджера клиенту.
const messengerSenders = {}
const messengerDeps = { adminDb, anthropic, AI_MODEL, CHAT_SYSTEM: MESSENGER_SYSTEM, mergeConsecutiveMessages, buildUsage, senders: messengerSenders }
registerTelegramBot(app, messengerDeps)
registerViberBot(app, messengerDeps)
// Ответ менеджера из веб-инбокса → доставка в канал + возврат бота при упоминании.
registerManagerReply(app, messengerDeps)

// Оплаты (LiqPay/monobank Частини) + авто-чеки Checkbox, мульти-ФОП
registerPayments(app, { adminDb })

// JSON Server for mock API (данные карты-портала: boats/reservoirs/…).
// Изолируем: сбой mock-роутера (напр. отсутствует db.json) НЕ должен ронять сервер ботов/AI.
// Прим.: на Cloud Run записи в db.json эфемерны (не переживают рестарт) — сервис-центр и боты
// используют Firestore, поэтому на них это не влияет.
try {
  const router = jsonServer.router(path.join(__dirname, 'db.json'))
  const middlewares = jsonServer.defaults({ noCors: true })
  app.use(middlewares)
  app.use(router)
} catch (e) {
  console.warn('⚠️  json-server mock API disabled:', e.message)
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`📡 Settings API: http://${SETTINGS_API.host}:${SETTINGS_API.port}${SETTINGS_API.basePath}`)
  console.log(`📦 Mock API endpoints: /boats, /reservoirs, /points, /deliveries, /shares, /distributors`)
})
