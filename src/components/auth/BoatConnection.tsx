import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  TextField,
  Button,
  Alert,
  Typography,
  IconButton,
  InputAdornment,
} from '@mui/material'
import { Visibility, VisibilityOff, DirectionsBoat } from '@mui/icons-material'
import { useBoatStore } from '@/store/boatStore'
import { boatsApi } from '@/api/endpoints/boats'

interface BoatConnectionProps {
  onSuccess?: () => void
}

export default function BoatConnection({ onSuccess }: BoatConnectionProps) {
  const { t } = useTranslation()
  const { addBoat } = useBoatStore()

  const [boatId, setBoatId] = useState('')
  const [boatPassword, setBoatPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const result = await boatsApi.verify({
        boatId,
        password: boatPassword,
      })

      if (result.success && result.data?.valid && result.data.boatInfo) {
        addBoat({ boatId, boatPassword }, result.data.boatInfo)
        setBoatId('')
        setBoatPassword('')
        onSuccess?.()
      } else {
        setError(t('boat.invalidCredentials'))
      }
    } catch (err: unknown) {
      console.error('Boat connection error:', err)
      const errorMessage = err instanceof Error ? err.message : 'Connection failed'
      setError(t('errors.networkError') + ': ' + errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box component="form" onSubmit={handleConnect}>
      <Box sx={{ textAlign: 'center', mb: 3 }}>
        <DirectionsBoat sx={{ fontSize: 64, color: 'primary.main' }} />
        <Typography variant="h5" sx={{ mt: 2 }}>
          {t('boat.connect')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Enter your boat ID and password to connect
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        label={t('boat.boatId')}
        value={boatId}
        onChange={(e) => setBoatId(e.target.value.toUpperCase())}
        margin="normal"
        required
        placeholder="e.g., BOAT001"
        inputProps={{ style: { textTransform: 'uppercase' } }}
      />

      <TextField
        fullWidth
        label={t('boat.boatPassword')}
        type={showPassword ? 'text' : 'password'}
        value={boatPassword}
        onChange={(e) => setBoatPassword(e.target.value)}
        margin="normal"
        required
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
        sx={{ mt: 3 }}
      >
        {t('boat.connect')}
      </Button>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
        For testing use: BOAT001 / test123
      </Typography>
    </Box>
  )
}
