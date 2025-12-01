import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  TextField,
  Button,
  Alert,
  IconButton,
  InputAdornment,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material'
import { Visibility, VisibilityOff } from '@mui/icons-material'
import { firebaseAuth } from '@/api/firebase'
import { languages } from '@/i18n'
import { useSettingsStore } from '@/store/settingsStore'

interface RegisterFormProps {
  onSuccess?: () => void
  onLoginClick?: () => void
}

export default function RegisterForm({ onSuccess, onLoginClick }: RegisterFormProps) {
  const { t, i18n } = useTranslation()
  const { setLanguage } = useSettingsStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language || 'en')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLanguageChange = (code: string) => {
    setSelectedLanguage(code)
    setLanguage(code)
    i18n.changeLanguage(code)
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)

    try {
      await firebaseAuth.registerWithEmail(email, password)
      onSuccess?.()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Registration failed'
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box component="form" onSubmit={handleRegister}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Language Selection */}
      <FormControl fullWidth margin="normal">
        <InputLabel>{t('settings.language')}</InputLabel>
        <Select
          value={selectedLanguage}
          label={t('settings.language')}
          onChange={(e) => handleLanguageChange(e.target.value)}
        >
          {languages.map((lang) => (
            <MenuItem key={lang.code} value={lang.code}>
              {lang.flag} {lang.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        fullWidth
        label={t('auth.email')}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        margin="normal"
        required
        autoComplete="email"
      />

      <TextField
        fullWidth
        label={t('auth.password')}
        type={showPassword ? 'text' : 'password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        margin="normal"
        required
        autoComplete="new-password"
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowPassword(!showPassword)} edge="end">
                {showPassword ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        }}
      />

      <TextField
        fullWidth
        label={t('auth.confirmPassword')}
        type={showPassword ? 'text' : 'password'}
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        margin="normal"
        required
        autoComplete="new-password"
      />

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={loading}
        sx={{ mt: 3, mb: 2 }}
      >
        {t('auth.register')}
      </Button>

      {onLoginClick && (
        <Box sx={{ mt: 2, textAlign: 'center' }}>
          <Typography variant="body2">
            {t('auth.hasAccount')}{' '}
            <Button variant="text" onClick={onLoginClick}>
              {t('auth.signIn')}
            </Button>
          </Typography>
        </Box>
      )}
    </Box>
  )
}
