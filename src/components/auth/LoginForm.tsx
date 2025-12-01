import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  TextField,
  Button,
  Typography,
  Divider,
  Alert,
  IconButton,
  InputAdornment,
} from '@mui/material'
import {
  Google as GoogleIcon,
  Facebook as FacebookIcon,
  Visibility,
  VisibilityOff,
} from '@mui/icons-material'
import { firebaseAuth } from '@/api/firebase'
import { useAuthStore } from '@/store/authStore'

interface LoginFormProps {
  onSuccess?: () => void
  onRegisterClick?: () => void
}

export default function LoginForm({ onSuccess, onRegisterClick }: LoginFormProps) {
  const { t } = useTranslation()
  const { setError } = useAuthStore()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setLocalError] = useState<string | null>(null)

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    setLoading(true)

    try {
      await firebaseAuth.signInWithEmail(email, password)
      onSuccess?.()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Login failed'
      setLocalError(errorMessage)
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setLocalError(null)
    setLoading(true)

    try {
      await firebaseAuth.signInWithGoogle()
      onSuccess?.()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Google login failed'
      setLocalError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleFacebookLogin = async () => {
    setLocalError(null)
    setLoading(true)

    try {
      await firebaseAuth.signInWithFacebook()
      onSuccess?.()
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Facebook login failed'
      setLocalError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box component="form" onSubmit={handleEmailLogin}>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

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
        autoComplete="current-password"
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

      <Button
        type="submit"
        fullWidth
        variant="contained"
        size="large"
        disabled={loading}
        sx={{ mt: 3, mb: 2 }}
      >
        {t('auth.login')}
      </Button>

      <Divider sx={{ my: 2 }}>
        <Typography variant="body2" color="text.secondary">
          or
        </Typography>
      </Divider>

      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<GoogleIcon />}
          onClick={handleGoogleLogin}
          disabled={loading}
        >
          Google
        </Button>
        <Button
          fullWidth
          variant="outlined"
          startIcon={<FacebookIcon />}
          onClick={handleFacebookLogin}
          disabled={loading}
          sx={{ bgcolor: '#1877f2', color: 'white', '&:hover': { bgcolor: '#166fe5' } }}
        >
          Facebook
        </Button>
      </Box>

      {onRegisterClick && (
        <Box sx={{ mt: 3, textAlign: 'center' }}>
          <Typography variant="body2">
            {t('auth.noAccount')}{' '}
            <Button variant="text" onClick={onRegisterClick}>
              {t('auth.signUp')}
            </Button>
          </Typography>
        </Box>
      )}
    </Box>
  )
}
