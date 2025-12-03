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
import { smsApi } from '@/api/endpoints/sms'

interface PhoneVerificationProps {
  initialPhone?: string
  onVerified: (phone: string) => void
  onCancel?: () => void
}

type Step = 'phone' | 'code' | 'verified'

export default function PhoneVerification({ initialPhone = '', onVerified, onCancel }: PhoneVerificationProps) {
  const { t } = useTranslation()

  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState(initialPhone)
  const [code, setCode] = useState(['', '', '', ''])
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
    if (!smsApi.isValidPhone(phone)) {
      setError(t('phone.invalidFormat'))
      return
    }

    setLoading(true)
    setError(null)

    const result = await smsApi.sendVerificationCode(phone)

    setLoading(false)

    if (result.success) {
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
    if (digit && index < 3) {
      codeInputRefs.current[index + 1]?.focus()
    }

    // Auto-verify when all digits entered
    if (digit && index === 3) {
      const fullCode = [...newCode.slice(0, 3), digit].join('')
      if (fullCode.length === 4) {
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
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
    if (pasted.length === 4) {
      const newCode = pasted.split('')
      setCode(newCode)
      verifyCode(pasted)
    }
  }

  // Verify entered code
  const verifyCode = async (fullCode: string) => {
    setLoading(true)
    setError(null)

    const result = await smsApi.verifyCode(phone, fullCode)

    setLoading(false)

    if (result.success && result.data?.verified) {
      setStep('verified')
      setTimeout(() => {
        onVerified(smsApi.formatPhone(phone))
      }, 1000)
    } else if (result.error?.code === 'CODE_EXPIRED') {
      setError(t('phone.codeExpired'))
      setCode(['', '', '', ''])
    } else {
      setError(t('phone.wrongCode'))
      setCode(['', '', '', ''])
      codeInputRefs.current[0]?.focus()
    }
  }

  // Resend code
  const handleResend = () => {
    setCode(['', '', '', ''])
    handleSendCode()
  }

  // Go back to phone input
  const handleChangePhone = () => {
    setStep('phone')
    setCode(['', '', '', ''])
    setError(null)
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
            {t('phone.codeSentTo')} <strong>{smsApi.formatForDisplay(phone)}</strong>
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
                  width: 50,
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
            {smsApi.formatForDisplay(phone)}
          </Typography>
        </Box>
      </Collapse>
    </Box>
  )
}
