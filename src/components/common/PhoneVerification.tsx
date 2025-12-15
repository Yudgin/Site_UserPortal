import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  InputAdornment,
  Collapse,
} from '@mui/material'
import {
  Phone as PhoneIcon,
  Send as SendIcon,
  CheckCircle as CheckIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material'
import { serviceApi } from '@/api/endpoints/service'

interface PhoneVerificationProps {
  initialPhone?: string
  onVerified: (phone: string) => void
  onCancel?: () => void
}

type Step = 'phone' | 'code' | 'verified'

// Phone formatting helpers
const formatPhone = (phone: string): string => {
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '')

  // Handle Ukrainian numbers
  if (digits.startsWith('380')) {
    return '+' + digits
  }
  if (digits.startsWith('80') && digits.length >= 10) {
    return '+3' + digits
  }
  if (digits.startsWith('0') && digits.length >= 10) {
    return '+38' + digits
  }

  return '+' + digits
}

const formatForDisplay = (phone: string): string => {
  const formatted = formatPhone(phone)
  // Format: +380 XX XXX XX XX
  if (formatted.length === 13 && formatted.startsWith('+380')) {
    return `${formatted.slice(0, 4)} ${formatted.slice(4, 6)} ${formatted.slice(6, 9)} ${formatted.slice(9, 11)} ${formatted.slice(11)}`
  }
  return formatted
}

const isValidPhone = (phone: string): boolean => {
  const formatted = formatPhone(phone)
  // Ukrainian mobile: +380XXXXXXXXX (13 chars)
  return /^\+380\d{9}$/.test(formatted)
}

export default function PhoneVerification({ initialPhone = '', onVerified, onCancel }: PhoneVerificationProps) {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState(initialPhone)
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [expectedCode, setExpectedCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)

  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Countdown timer for resend
  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [countdown])

  // Format phone input
  const handlePhoneChange = (value: string) => {
    // Allow only digits, +, spaces, and dashes
    const cleaned = value.replace(/[^\d+\s-]/g, '')
    setPhone(cleaned)
    setError(null)
  }

  // Send verification code
  const handleSendCode = async () => {
    if (!isValidPhone(phone)) {
      setError(t('phone.invalidFormat'))
      return
    }

    setLoading(true)
    setError(null)

    const result = await serviceApi.sendSmsCode(phone)

    setLoading(false)

    if (result.success && result.data) {
      setExpectedCode(result.data.code)
      setStep('code')
      setCountdown(60) // 60 seconds before resend allowed
      // Focus first code input
      setTimeout(() => codeInputRefs.current[0]?.focus(), 100)
    } else {
      setError(result.error?.message || t('phone.sendFailed'))
    }
  }

  // Handle code input
  const handleCodeChange = (index: number, value: string) => {
    // Only allow digits
    const digit = value.replace(/\D/g, '').slice(-1)

    const newCode = [...code]
    newCode[index] = digit
    setCode(newCode)
    setError(null)

    // Auto-focus next input
    if (digit && index < 5) {
      codeInputRefs.current[index + 1]?.focus()
    }

    // Auto-verify when all digits entered
    if (digit && index === 5) {
      const fullCode = [...newCode.slice(0, 5), digit].join('')
      if (fullCode.length === 6) {
        verifyCode(fullCode)
      }
    }
  }

  // Handle backspace
  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      codeInputRefs.current[index - 1]?.focus()
    }
  }

  // Handle paste
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (pasted.length === 6) {
      const newCode = pasted.split('')
      setCode(newCode)
      verifyCode(pasted)
    }
  }

  // Verify entered code
  const verifyCode = async (fullCode: string) => {
    setLoading(true)
    setError(null)

    // Compare with expected code (client-side verification)
    const isValid = expectedCode && fullCode === expectedCode

    setLoading(false)

    if (isValid) {
      setStep('verified')
      setTimeout(() => {
        onVerified(formatPhone(phone))
      }, 1000)
    } else {
      setError(t('phone.wrongCode'))
      setCode(['', '', '', '', '', ''])
      codeInputRefs.current[0]?.focus()
    }
  }

  // Resend code
  const handleResend = () => {
    setCode(['', '', '', '', '', ''])
    handleSendCode()
  }

  // Go back to phone input
  const handleChangePhone = () => {
    setStep('phone')
    setCode(['', '', '', '', '', ''])
    setError(null)
    setExpectedCode(null)
  }

  return (
    <Box>
      {/* Step 1: Phone Input */}
      <Collapse in={step === 'phone'}>
        <Box>
          <TextField
            fullWidth
            label={t('phone.enterPhone')}
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="+380 XX XXX XX XX"
            error={!!error}
            helperText={error || t('phone.ukrainianOnly')}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <PhoneIcon color="primary" />
                </InputAdornment>
              ),
            }}
            sx={{ mb: 2 }}
          />

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="contained"
              onClick={handleSendCode}
              disabled={loading || !phone}
              startIcon={loading ? <CircularProgress size={20} /> : <SendIcon />}
              fullWidth
            >
              {t('phone.sendCode')}
            </Button>
            {onCancel && (
              <Button variant="outlined" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            )}
          </Box>
        </Box>
      </Collapse>

      {/* Step 2: Code Input */}
      <Collapse in={step === 'code'}>
        <Box>
          <Alert severity="info" sx={{ mb: 3 }}>
            {t('phone.codeSentTo')} <strong>{formatForDisplay(phone)}</strong>
          </Alert>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
            {t('phone.enterCode')}
          </Typography>

          {/* 6-digit code input */}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              gap: 1,
              mb: 3
            }}
            onPaste={handlePaste}
          >
            {code.map((digit, index) => (
              <TextField
                key={index}
                inputRef={(el) => (codeInputRefs.current[index] = el)}
                value={digit}
                onChange={(e) => handleCodeChange(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
                inputProps={{
                  maxLength: 1,
                  style: {
                    textAlign: 'center',
                    fontSize: '1.5rem',
                    fontWeight: 600,
                    padding: '12px',
                  },
                }}
                sx={{
                  width: 45,
                  '& .MuiOutlinedInput-root': {
                    borderRadius: 2,
                  },
                }}
                error={!!error}
                disabled={loading}
              />
            ))}
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button
              size="small"
              onClick={handleChangePhone}
              disabled={loading}
            >
              {t('phone.changePhone')}
            </Button>

            <Button
              size="small"
              onClick={handleResend}
              disabled={loading || countdown > 0}
              startIcon={<RefreshIcon />}
            >
              {countdown > 0
                ? `${t('phone.resendIn')} ${countdown}${t('common.seconds')}`
                : t('phone.resendCode')
              }
            </Button>
          </Box>
        </Box>
      </Collapse>

      {/* Step 3: Verified */}
      <Collapse in={step === 'verified'}>
        <Box sx={{ textAlign: 'center', py: 3 }}>
          <CheckIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
          <Typography variant="h6" color="success.main">
            {t('phone.verified')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatForDisplay(phone)}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  )
}
